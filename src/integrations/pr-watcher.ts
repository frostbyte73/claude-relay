import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { JobQueue } from '../work/work-queue.js';
import type { WorkEngine } from '../work/engine.js';
import type { CiCheck, OpenPrStep, PrComment } from '../work/work-types.js';

const execFileP = promisify(execFile);

async function defaultRunGh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('gh', args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
  return stdout.toString();
}

export interface PrWatcherOpts {
  queue: JobQueue;
  engine: WorkEngine;
  pollMs?: number;
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
function ciStateFrom(checks: CiCheck[]): OpenPrStep['ciState'] | undefined {
  if (!checks.length) return undefined;
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

function reviewStateFrom(view: GhPrView): OpenPrStep['reviewState'] | undefined {
  switch (view.reviewDecision) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'REVIEW_REQUIRED': return 'review_required';
    default: return undefined;
  }
}

function mergeableFrom(view: GhPrView): OpenPrStep['mergeable'] | undefined {
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

// Whether applying `patch` would actually move the step's observable PR state —
// used to decide if the adaptive re-poll ladder should be (re)armed.
function patchChangesStep(prev: OpenPrStep, patch: Partial<OpenPrStep>): boolean {
  for (const k of ['prState', 'state', 'ciState', 'reviewState', 'mergeable'] as const) {
    if (patch[k] !== undefined && patch[k] !== prev[k]) return true;
  }
  if (patch.comments && hashComments(patch.comments) !== hashComments(prev.comments ?? [])) return true;
  if (patch.ciChecks && sigChecks(patch.ciChecks) !== sigChecks(prev.ciChecks ?? [])) return true;
  return false;
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
  readonly description = 'Refreshes CI, review, and comment state for open-PR steps.';
  private readonly pollMs: number;
  private readonly runGh: (cwd: string, args: string[]) => Promise<string>;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private running = false;
  // Adaptive follow-up polling: after a job's PR changes we re-poll at 1m / 5m /
  // 15m so a fresh push (CI back to pending), a new review, etc. surface within
  // a minute instead of on the next hourly sweep. A new change resets the ladder.
  private readonly escalationTimers = new Map<string, NodeJS.Timeout[]>();
  private static readonly ESCALATION_MS = [60_000, 5 * 60_000, 15 * 60_000];

  constructor(private readonly opts: PrWatcherOpts) {
    this.pollMs = opts.pollMs ?? (Number(process.env.OUTPOST_PR_POLL_MS) || 60 * 60_000);
    this.runGh = opts.runGh ?? defaultRunGh;
  }

  start(): void {
    void this.syncNow().catch((e) => console.error('[pr-watcher] initial sync failed:', (e as Error).message));
    this.timer = setInterval(() => {
      void this.syncNow().catch((e) => console.error('[pr-watcher] sync failed:', (e as Error).message));
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const timers of this.escalationTimers.values()) for (const t of timers) clearTimeout(t);
    this.escalationTimers.clear();
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

  get intervalMs(): number | null { return this.pollMs; }

  status(): { lastRunAt: number | null; lastError: string | null; running: boolean } {
    return { lastRunAt: this.lastRunAt, lastError: this.lastError, running: this.running };
  }

  async runNow(): Promise<void> {
    await this.syncNow();
  }

  async syncNow(): Promise<void> {
    this.running = true;
    try {
      for (const j of this.opts.queue.list()) {
        await this.syncJob(j.id);
      }
      this.lastRunAt = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastRunAt = Date.now();
      this.lastError = (e as Error).message;
      throw e;
    } finally {
      this.running = false;
    }
  }

  async syncJob(jobId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    for (const s of j.steps) {
      if (s.type !== 'open-pr' || s.cancelled) continue;
      await this.syncStep(jobId, s).catch((e) => {
        console.error(`[pr-watcher] ${jobId} ${s.id} ${s.prUrl ?? s.workspace.branch}: ${(e as Error).message}`);
      });
    }
  }

  private async syncStep(jobId: string, s: OpenPrStep): Promise<void> {
    const cwd = s.workspace.repoCwd;

    // PR discovery: orchestrator picks the branch, implementer pushes + opens the PR,
    // we find it by branch.
    if (!s.prUrl && s.workspace.branch && (s.state === 'implementing' || s.state === 'pr_open')) {
      try {
        const out = await this.runGh(cwd, ['pr', 'list', '--head', s.workspace.branch, '--json', 'url', '--limit', '1']);
        const arr = JSON.parse(out) as Array<{ url?: string }>;
        const url = arr[0]?.url;
        if (url) {
          this.opts.engine.applyOpenPrPatch(jobId, s.id, { prUrl: url, prState: 'open', state: 'pr_open' });
          s = { ...s, prUrl: url, prState: 'open', state: 'pr_open' };
        }
      } catch (e) {
        console.error(`[pr-watcher] discovery ${jobId} ${s.id} ${s.workspace.branch}: ${(e as Error).message}`);
      }
    }
    if (!s.prUrl) return;
    if (s.state === 'merged') return;

    const view = await this.fetchPr(cwd, s.prUrl);
    const inline = await this.fetchInlineComments(cwd, s.prUrl);
    const patch: Partial<OpenPrStep> = {};
    if (view.state === 'MERGED') {
      patch.prState = 'merged';
      patch.state = 'merged';
    } else if (view.state === 'CLOSED') {
      patch.prState = 'closed';
    } else {
      patch.prState = 'open';
    }
    const checks = ciChecksFrom(view);
    if (checks.length) {
      patch.ciState = ciStateFrom(checks);
      patch.ciChecks = checks;
    } else if (s.ciState === 'success' || s.ciState === 'failure') {
      // Empty rollup on a PR that last had a terminal result means the head moved
      // (a fresh push) and the new head's checks haven't registered yet — clear the
      // stale green/red badge (and its now-stale check list) back to pending rather
      // than leaving them as-is.
      patch.ciState = 'pending';
      patch.ciChecks = [];
    }
    const rv = reviewStateFrom(view);
    if (rv) patch.reviewState = rv;
    const mergeable = mergeableFrom(view);
    if (mergeable) patch.mergeable = mergeable;
    // Only touch comments when the inline fetch actually succeeded. A null here
    // means the GitHub call failed; skip the comment merge so we don't clobber
    // stored comments (and their drafts/edit jobs) with a partial view.
    if (inline !== null) {
      const fetched = commentsFrom(view, inline);
      const oldById = new Map((s.comments ?? []).map((c) => [c.id, c] as const));
      const fresh = fetched.filter((c) => !oldById.has(c.id));
      const merged = fetched.map((c) => {
        const prev = oldById.get(c.id);
        if (!prev) return c;
        const out: PrComment = { ...c };
        if (prev.respondedAt) out.respondedAt = prev.respondedAt;
        if (prev.reopenedAt) out.reopenedAt = prev.reopenedAt;
        return out;
      });
      patch.comments = merged;

      // Reopen any prior-respondedAt thread that gained a new descendant.
      const byIdNext = new Map(merged.map((c) => [c.id, c] as const));
      const rootOf = (c: PrComment): PrComment => {
        let cur: PrComment | undefined = c;
        const seen = new Set<string>();
        while (cur?.inReplyTo && byIdNext.has(cur.inReplyTo) && !seen.has(cur.id)) {
          seen.add(cur.id);
          cur = byIdNext.get(cur.inReplyTo);
        }
        return cur ?? c;
      };
      const reopenedRoots = new Set<string>();
      for (const c of merged) {
        const root = rootOf(c);
        if (!root.respondedAt) continue;
        if (c.id === root.id) continue;
        if (c.createdAt > root.respondedAt) reopenedRoots.add(root.id);
      }

      const drafted = new Set((s.draftedReplies ?? []).map((d) => d.commentId));
      const userLocked = new Set((s.draftedReplies ?? []).filter((d) => d.userEdited).map((d) => d.commentId));
      const editBusy = new Set((s.editQueue ?? [])
        .filter((e) => e.status === 'queued' || e.status === 'running')
        .map((e) => e.commentId));

      // Apply reopen flags into the patch's comments before computing pending.
      if (reopenedRoots.size) {
        patch.comments = merged.map((c) => reopenedRoots.has(c.id)
          ? ({ ...c, respondedAt: undefined, reopenedAt: Date.now() })
          : c);
      }
      const next = patch.comments ?? merged;
      const pending = next.filter((c) =>
        !c.respondedAt
        && !userLocked.has(c.id)
        && !editBusy.has(c.id)
        && (!drafted.has(c.id) || fresh.some((f) => f.id === c.id)),
      );
      if (pending.length && s.state !== 'comment_pending_response' && s.state !== 'reply_pending_review') {
        patch.state = 'comment_pending_response';
        this.opts.engine.dropOrphanIterations(jobId, s.id, 'replies');
      } else if (
        !pending.length
        && (s.state === 'comment_pending_response' || s.state === 'reply_pending_review')
        && drafted.size === 0
        && editBusy.size === 0
        && !(s.iterations ?? []).some((it) => it.kind === 'replies' && it.status === 'in_progress' && !it.postedAt)
      ) {
        // Every comment answered, no drafts awaiting review, no edit/triage round in
        // flight — the step is settled. Nothing else returns a step from the comment
        // states to pr_open, so without this it stays reply_pending_review forever and
        // reads as perpetually needing the user (stepNeedsYou treats that state as
        // needs-you). Hand it back so the reviewState/ciState gates decide what's next.
        patch.state = 'pr_open';
      }
    }
    // A conflicting PR can't merge and reads CI as pending, so it is
    // more blocking than unanswered comments — flip to a dedicated state that drives the
    // resolve-conflicts gate. Placed after the comment block so conflicts win. Skip while a
    // resolve round is mid-flight so we don't disturb it.
    if (!s.conflictResolving) {
      const mergeableNow = (patch.mergeable ?? s.mergeable) as OpenPrStep['mergeable'];
      const postPr = s.state === 'pr_open'
        || s.state === 'comment_pending_response'
        || s.state === 'reply_pending_review';
      if (mergeableNow === 'conflicting' && postPr) {
        patch.state = 'conflicting';
      } else if (mergeableNow === 'mergeable' && s.state === 'conflict_unresolved') {
        patch.state = 'pr_open';
      }
    }
    const changed = patchChangesStep(s, patch);
    this.opts.engine.applyOpenPrPatch(jobId, s.id, patch);
    if (changed) this.noteChanged(jobId);
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
