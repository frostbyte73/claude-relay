import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { JobQueue } from '../work/work-queue.js';
import type { WorkEngine } from '../work/engine.js';
import type {
  CiCheck, IterationRecord, OrchestratedStep, PrComment, PrFacts, WatchedEvent,
} from '../work/work-types.js';

const execFileP = promisify(execFile);

async function defaultRunGh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('gh', args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
  return stdout.toString();
}

export interface PrWatcherOpts {
  queue: JobQueue;
  engine: WorkEngine;
  runGh?: (cwd: string, args: string[]) => Promise<string>;
}

interface GhPrView {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  statusCheckRollup?: GhCheckRollup[];
  reviews?: Array<{ id: string; author: { login: string }; body: string; createdAt: string; state: string; url?: string }>;
  comments?: Array<{ id: string; author: { login: string }; body: string; createdAt: string; url?: string }>;
}

// A rollup entry is either a CheckRun (GitHub Actions job — name/workflowName/
// status/conclusion/detailsUrl) or a StatusContext (legacy commit status —
// context/state/targetUrl). `gh pr view --json statusCheckRollup` returns the
// full node for each, so we read whichever set of fields is present.
interface GhCheckRollup {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
}

function checkStateOf(c: GhCheckRollup): CiCheck['state'] {
  const conclusion = (c.conclusion ?? '').toUpperCase();
  if (conclusion) {
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'success';
    if (conclusion === 'SKIPPED') return 'skipped';
    return 'failure'; // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
  const state = (c.state ?? '').toUpperCase(); // StatusContext
  if (state === 'SUCCESS') return 'success';
  if (state === 'FAILURE' || state === 'ERROR') return 'failure';
  return 'pending'; // CheckRun QUEUED/IN_PROGRESS, StatusContext PENDING/EXPECTED
}

function ciChecksFrom(view: GhPrView): CiCheck[] {
  const rollup = view.statusCheckRollup;
  if (!rollup?.length) return [];
  return rollup.map((c) => {
    const name = c.workflowName && c.name ? `${c.workflowName} / ${c.name}`
      : c.name ?? c.context ?? 'check';
    const out: CiCheck = { name, state: checkStateOf(c) };
    const url = c.detailsUrl ?? c.targetUrl;
    if (url) out.url = url;
    return out;
  });
}

// Roll the per-check states up into the single badge state, so the badge and the
// per-workflow list can never disagree: any failure fails, else any pending pends.
function ciStateFrom(checks: CiCheck[]): PrFacts['ciState'] {
  if (!checks.length) return undefined;
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

function reviewStateFrom(view: GhPrView): PrFacts['reviewState'] {
  switch (view.reviewDecision) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'REVIEW_REQUIRED': return 'review_required';
    default: return undefined;
  }
}

function mergeableFrom(view: GhPrView): PrFacts['mergeable'] {
  switch (view.mergeable) {
    case 'MERGEABLE': return 'mergeable';
    case 'CONFLICTING': return 'conflicting';
    // UNKNOWN is GitHub still computing mergeability (common right after a push);
    // the re-poll ladder resolves it, so surface it rather than clobbering a prior
    // known value in the UI (which renders only on 'conflicting').
    case 'UNKNOWN': return 'unknown';
    default: return undefined;
  }
}

interface GhInlineComment {
  id: number;
  node_id: string;
  user: { login: string };
  body: string;
  path?: string;
  line?: number;
  diff_hunk?: string;
  created_at: string;
  html_url?: string;
  in_reply_to_id?: number | null;
}

function inlineCommentsFrom(inline: GhInlineComment[]): PrComment[] {
  const nodeIdByInt = new Map<number, string>();
  for (const c of inline) nodeIdByInt.set(c.id, c.node_id);
  return inline.map((c) => {
    const out: PrComment = {
      id: `review:${c.node_id}`,
      author: c.user.login,
      body: c.body,
      createdAt: new Date(c.created_at).getTime(),
    };
    if (c.html_url) out.url = c.html_url;
    if (c.path) out.file = c.path;
    if (c.line !== undefined) out.line = c.line;
    if (c.diff_hunk) out.diffHunk = c.diff_hunk;
    if (c.in_reply_to_id != null) {
      const parentNode = nodeIdByInt.get(c.in_reply_to_id);
      if (parentNode) out.inReplyTo = `review:${parentNode}`;
    }
    return out;
  });
}

function commentsFrom(view: GhPrView, inline: GhInlineComment[]): PrComment[] {
  const out: PrComment[] = [];
  for (const c of view.comments ?? []) {
    const x: PrComment = { id: `issue:${c.id}`, author: c.author.login, body: c.body, createdAt: new Date(c.createdAt).getTime() };
    if (c.url) x.url = c.url;
    out.push(x);
  }
  for (const r of view.reviews ?? []) {
    if (!r.body) continue;
    const x: PrComment = { id: `review:${r.id}`, author: r.author.login, body: r.body, createdAt: new Date(r.createdAt).getTime() };
    if (r.url) x.url = r.url;
    out.push(x);
  }
  out.push(...inlineCommentsFrom(inline));
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function parsePrUrl(url: string): { owner: string; repo: string; number: string } | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1]!, repo: m[2]!, number: m[3]! } : null;
}

// A step's own prUrl (stored or supplied by the planner/controller in `inputs`) reaches
// `gh` as a subprocess argument, so it gets the strict, anchored check — unlike the
// permissive `parsePrUrl` above, which only ever runs against a URL `gh pr list` itself
// returned (trusted GitHub output, not attacker-reachable text).
const KNOWN_PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;

// Which watched signals the freshly polled facts actually moved. This is the whole of
// what the watcher tells a controller: what changed, never what it means.
function changedSignals(prev: PrFacts, next: Partial<PrFacts>): WatchedEvent[] {
  const moved = <K extends keyof PrFacts>(k: K) => next[k] !== undefined && next[k] !== prev[k];
  const events: WatchedEvent[] = [];
  if (moved('ciState')) events.push('ci');
  if (moved('reviewState')) events.push('review-state');
  // Mergeability rides on `pr-state`: a PR that just started conflicting is the
  // controller's problem now, and there is no separate signal for it to wait on.
  if (moved('prUrl') || moved('prState') || moved('mergeable')) events.push('pr-state');
  if (next.comments && hashComments(next.comments) !== hashComments(prev.comments ?? [])) {
    events.push('pr-comments');
  }
  return events;
}

// Deliberately not a watched signal: individual checks finish constantly while the
// rollup stays 'pending', and waking the controller for each would burn its round
// budget on nothing. It still re-arms the re-poll ladder — more is coming soon.
function checksMoved(prev: PrFacts, next: Partial<PrFacts>): boolean {
  return !!next.ciChecks && sigChecks(next.ciChecks) !== sigChecks(prev.ciChecks ?? []);
}

function summarize(events: WatchedEvent[], facts: Partial<PrFacts>, fresh: number): string {
  return events.map((e) => {
    switch (e) {
      case 'ci': return `CI ${facts.ciState}`;
      case 'review-state': return `review ${facts.reviewState}`;
      case 'pr-state': return `PR ${facts.prState}${facts.mergeable === 'conflicting' ? ' (conflicting)' : ''}`;
      case 'pr-comments': return fresh ? `${fresh} new comment${fresh === 1 ? '' : 's'}` : 'comment thread updated';
    }
  }).join('; ');
}

// Carry forward the per-comment answers the daemon owns (GitHub knows nothing about
// them), and reopen a thread that gained a reply after we marked it answered.
function mergeComments(prev: PrComment[], fetched: PrComment[]): { comments: PrComment[]; fresh: PrComment[] } {
  const oldById = new Map(prev.map((c) => [c.id, c] as const));
  const fresh = fetched.filter((c) => !oldById.has(c.id));
  const merged = fetched.map((c) => {
    const before = oldById.get(c.id);
    if (!before) return c;
    const out: PrComment = { ...c };
    if (before.respondedAt) out.respondedAt = before.respondedAt;
    if (before.reopenedAt) out.reopenedAt = before.reopenedAt;
    return out;
  });

  const byId = new Map(merged.map((c) => [c.id, c] as const));
  const rootOf = (c: PrComment): PrComment => {
    let cur: PrComment | undefined = c;
    const seen = new Set<string>();
    while (cur?.inReplyTo && byId.has(cur.inReplyTo) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.inReplyTo);
    }
    return cur ?? c;
  };
  const reopened = new Set<string>();
  for (const c of merged) {
    const root = rootOf(c);
    if (!root.respondedAt || c.id === root.id) continue;
    if (c.createdAt > root.respondedAt) reopened.add(root.id);
  }
  if (!reopened.size) return { comments: merged, fresh };
  const now = Date.now();
  return {
    comments: merged.map((c) => reopened.has(c.id) ? { ...c, respondedAt: undefined, reopenedAt: now } : c),
    fresh,
  };
}

// A replies round the daemon restarted out from under can never post. New comments are
// proof it is dead, and nothing else prunes it now that rounds are dispatches.
function withoutUnpostedReplyRounds(iterations: IterationRecord[]): IterationRecord[] {
  return iterations.filter((i) => !(i.kind === 'replies' && i.status === 'in_progress' && !i.postedAt));
}

function sigChecks(cs: CiCheck[]): string {
  return cs.map((c) => `${c.name}=${c.state}`).sort().join('\0');
}

export function hashComments(cs: PrComment[]): string {
  const h = createHash('sha256');
  for (const c of cs) h.update(`${c.id}\0${c.body.length}\0`);
  return h.digest('hex');
}

export class PrWatcher {
  readonly id = 'pr-watcher';
  readonly name = 'GitHub — tracked PRs';
  readonly description = 'Refreshes CI, review, and comment state for tracked PRs.';
  private readonly runGh: (cwd: string, args: string[]) => Promise<string>;
  // Adaptive follow-up polling: after a job's PR changes we re-poll at 1m / 5m /
  // 15m so a fresh push (CI back to pending), a new review, etc. surface within
  // a minute instead of on the next hourly sweep. A new change resets the ladder.
  private readonly escalationTimers = new Map<string, NodeJS.Timeout[]>();
  private static readonly ESCALATION_MS = [60_000, 5 * 60_000, 15 * 60_000];

  constructor(private readonly opts: PrWatcherOpts) {
    this.runGh = opts.runGh ?? defaultRunGh;
  }

  async runOnce(): Promise<{ outcome: 'ok' | 'error' }> {
    try {
      await this.syncNow();
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'error' };
    }
  }

  // (Re)arm the 1m/5m/15m follow-up ladder for a job. Called from syncStep when a
  // poll detects a real change, and from the git routes right after a push so the
  // badge refreshes without waiting on the hourly sweep. Any prior ladder for the
  // job is cleared first, so a fresh change resets the countdown to 1m.
  noteChanged(jobId: string): void {
    const existing = this.escalationTimers.get(jobId);
    if (existing) for (const t of existing) clearTimeout(t);
    const timers = PrWatcher.ESCALATION_MS.map((ms) => {
      const t = setTimeout(() => {
        void this.syncJob(jobId).catch((e) =>
          console.error(`[pr-watcher] escalated sync ${jobId}: ${(e as Error).message}`));
      }, ms);
      t.unref();
      return t;
    });
    this.escalationTimers.set(jobId, timers);
  }

  async syncNow(): Promise<void> {
    for (const j of this.opts.queue.list()) {
      await this.syncJob(j.id);
    }
  }

  async syncJob(jobId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    for (const s of j.steps) {
      if (s.type !== 'orchestrated' || s.cancelled) continue;
      if (s.state === 'resolved' || s.state === 'failed') continue;
      const ws = s.workspace;
      if (ws.kind === 'writable') {
        // Only a writable workspace can carry a branch, and only a branch can carry a PR.
        await this.syncStep(jobId, s, ws.repoCwd, ws.branch).catch((e) => {
          console.error(`[pr-watcher] ${jobId} ${s.id} ${s.pr?.prUrl ?? ws.branch}: ${(e as Error).message}`);
        });
        continue;
      }
      // A readonly workspace (e.g. a review step, detached at the PR head) has no branch
      // of its own to discover by — its checkout has nothing to do with the PR's source
      // branch — so it only qualifies once it already knows its PR, from either a prior
      // poll (`s.pr.prUrl`) or the planner/controller (`s.inputs.prUrl`). `kind: 'none'`
      // has no repoCwd to run `gh` in at all; rather than guess one (the daemon's own cwd
      // is unrelated to the PR's repo and untested as a `gh` invocation dir), skip it —
      // nothing in the catalog currently produces that combination.
      if (ws.kind !== 'readonly') continue;
      const knownUrl = this.knownPrUrl(s);
      if (!knownUrl) continue;
      await this.syncStep(jobId, s, ws.repoCwd, undefined, knownUrl).catch((e) => {
        console.error(`[pr-watcher] ${jobId} ${s.id} ${knownUrl}: ${(e as Error).message}`);
      });
    }
  }

  private knownPrUrl(s: OrchestratedStep): string | undefined {
    const stored = s.pr?.prUrl;
    if (stored && KNOWN_PR_URL_RE.test(stored)) return stored;
    const input = s.inputs?.prUrl;
    return typeof input === 'string' && KNOWN_PR_URL_RE.test(input) ? input : undefined;
  }

  private async syncStep(
    jobId: string,
    s: OrchestratedStep,
    cwd: string,
    branch: string | undefined,
    knownUrl?: string,
  ): Promise<void> {
    const prev: PrFacts = s.pr ?? {};
    if (prev.prState === 'merged') return;

    const facts: Partial<PrFacts> = {};
    let prUrl = prev.prUrl;
    if (!prUrl && knownUrl) {
      // Already known by URL (a readonly review step) — never run discovery, and never
      // touch the discovery-miss bound below; that bound exists only for steps guessing
      // a PR from a branch, which this step isn't doing.
      prUrl = knownUrl;
      facts.prUrl = prUrl;
    } else if (!prUrl) {
      if (!branch) return;
      // PR discovery: nothing in the catalog opens the PR — code.implement leaves uncommitted
      // edits and the user pushes and opens it by hand — so matching the step's branch is the
      // only way the daemon ever learns the URL.
      //
      // Deliberately unbounded for as long as the step is live. A cap on consecutive misses
      // was tried and reverted: the canonical flow parks the controller on a `wait` for
      // pr-state while the *user* opens the PR, so nothing bumps the step's round count and
      // any miss-based cap expires while that wait is doing exactly what it should. Discovery
      // is then the only path that could ever wake it, and the step waits forever on a PR
      // sitting open on GitHub. The cost this bounds is one `gh pr list` per sweep per live
      // writable step — and every controller that holds one opens a PR, so the population it
      // would save is empty.
      prUrl = await this.discoverPr(cwd, branch);
      if (!prUrl) return;
      facts.prUrl = prUrl;
    }

    const view = await this.fetchPr(cwd, prUrl);
    const inline = await this.fetchInlineComments(cwd, prUrl);
    facts.prState = view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open';
    const checks = ciChecksFrom(view);
    if (checks.length) {
      facts.ciState = ciStateFrom(checks);
      facts.ciChecks = checks;
    } else if (prev.ciState === 'success' || prev.ciState === 'failure') {
      // Empty rollup on a PR that last had a terminal result means the head moved
      // (a fresh push) and the new head's checks haven't registered yet — clear the
      // stale green/red badge (and its now-stale check list) back to pending rather
      // than leaving them as-is.
      facts.ciState = 'pending';
      facts.ciChecks = [];
    }
    const rv = reviewStateFrom(view);
    if (rv) facts.reviewState = rv;
    const mergeable = mergeableFrom(view);
    if (mergeable) facts.mergeable = mergeable;

    // Only touch comments when the inline fetch actually succeeded. A null here
    // means the GitHub call failed; skip the comment merge so we don't clobber
    // stored comments (and the drafts keyed to them) with a partial view.
    let fresh: PrComment[] = [];
    if (inline !== null) {
      const merged = mergeComments(prev.comments ?? [], commentsFrom(view, inline));
      facts.comments = merged.comments;
      fresh = merged.fresh;
    }

    const iterations = s.iterations ?? [];
    const kept = fresh.length ? withoutUnpostedReplyRounds(iterations) : iterations;
    if (kept.length !== iterations.length) this.opts.engine.applyPrFacts(jobId, s.id, facts, kept);
    else this.opts.engine.applyPrFacts(jobId, s.id, facts);

    const events = changedSignals(prev, facts);
    if (events.length) {
      this.opts.engine.pushStepInbox(jobId, s.id, {
        kind: 'external', source: 'pr-watcher', summary: summarize(events, facts, fresh.length), events,
      });
    }
    if (events.length || checksMoved(prev, facts)) this.noteChanged(jobId);
  }

  private async discoverPr(cwd: string, branch: string): Promise<string | undefined> {
    try {
      const out = await this.runGh(cwd, ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1']);
      return (JSON.parse(out) as Array<{ url?: string }>)[0]?.url;
    } catch (e) {
      console.error(`[pr-watcher] discovery ${branch}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async fetchPr(cwd: string, url: string): Promise<GhPrView> {
    const out = await this.runGh(cwd, [
      'pr', 'view', url,
      '--json', 'number,url,state,reviewDecision,mergeable,statusCheckRollup,reviews,comments',
    ]);
    return JSON.parse(out) as GhPrView;
  }

  // Returns null (not []) when the fetch fails — a transient GitHub error
  // (e.g. 503) must not read as "this PR has no inline comments", or syncStep
  // would overwrite s.comments with the reduced set and orphan any drafts /
  // edit jobs still keyed to the dropped comments.
  private async fetchInlineComments(cwd: string, url: string): Promise<GhInlineComment[] | null> {
    const parsed = parsePrUrl(url);
    if (!parsed) return [];
    try {
      const out = await this.runGh(cwd, ['api', `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`, '--paginate']);
      return JSON.parse(out) as GhInlineComment[];
    } catch (e) {
      console.error(`[pr-watcher] inline-comments fetch ${url}: ${(e as Error).message}`);
      return null;
    }
  }
}
