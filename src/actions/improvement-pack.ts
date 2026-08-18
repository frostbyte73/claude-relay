import { ADJUDICATED_OUTCOMES, type ActionRunRecord } from '../storage/action-runs-store.js';
import type { ActionDenial } from '../storage/denials-store.js';
import type { ActionEvent } from '../storage/action-revisions-store.js';
import type { JournalEntry } from '../storage/journal-store.js';
import { buildScorecard, type Scorecard } from './scorecard.js';

// Picks the one action most worth improving right now and assembles the evidence for it.
//
// Deliberately one action per cycle rather than a sweep: the review pipeline holds exactly one
// proposal per action, and handing a model a dozen skills' traces at once splits its attention
// for no gain. Curated traces beat a query API — the improver gets this pack and nothing else.
//
// Pure: every read arrives through ImprovementPackDeps, which is what makes the eligibility
// rules testable without a daemon.

const DEFAULT_MIN_RUNS = 20;
const DEFAULT_MAX_PENDING = 2;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LIST_CAP = 15;

// Excluded from improvement, both self-referential. The improver rewriting its own rubric has
// no fixed point; meta.build-action is the authoring mechanism the user needs in order to fix
// a bad improvement, so it must not be able to break itself.
export const EXCLUDED_ACTIONS = ['meta.improve-actions', 'meta.build-action'];

const IMPROVER_REVIEW_KINDS = new Set<ActionEvent['kind']>(['reviewed', 'proposed', 'applied']);

export interface ImprovementPackDeps {
  listActionNames: () => string[];
  runsFor: (action: string) => ActionRunRecord[];
  denialsFor: (action: string) => ActionDenial[];
  revisionsFor: (action: string) => ActionEvent[];
  lessonsFor: (action: string) => JournalEntry[];
  skillMdFor: (action: string) => string;
  pendingEdits: () => Array<{ actionName: string | null; authorAction?: string }>;
  now: () => number;
}

export interface ImprovementPackOpts {
  minRuns?: number;
  maxPending?: number;
  exclude?: string[];
  windowMs?: number;
}

export interface ImprovementPack {
  action: string;
  whySelected: string;
  currentSkillMd: string;
  currentLineCount: number;
  scorecard: Scorecard;
  failures: Array<{ runId: string; at: number; round: string; attempt: number; jobId: string; stepId?: string; reason?: string }>;
  revisions: Array<{ runId: string; at: number; round: string; attempt: number; feedbackChars?: number; jobId: string }>;
  denials: Array<{ id: string; toolName: string; suggested: ActionDenial['suggested']; count: number; at: number }>;
  rejectedProposals: Array<{ at: number; rationale?: string; feedback?: string }>;
  lessons: JournalEntry[];
  history: Array<{ at: number; kind: ActionEvent['kind']; author: ActionEvent['author']; bodyBytes?: number; rationale?: string }>;
  previousReview?: { at: number; rationale?: string };
}

// A schedule's `what.args` is user input from POST /api/schedules, so a bad override falls back
// to the default rather than reaching the comparisons below as a string.
export function parsePackOpts(args: unknown): ImprovementPackOpts {
  const a = (args ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const exclude = Array.isArray(a.exclude) ? a.exclude.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    ...(num(a.minRuns) !== undefined ? { minRuns: num(a.minRuns) } : {}),
    ...(num(a.maxPending) !== undefined ? { maxPending: num(a.maxPending) } : {}),
    ...(num(a.windowMs) !== undefined ? { windowMs: num(a.windowMs) } : {}),
    ...(exclude?.length ? { exclude } : {}),
  };
}

export function lastImproverReviewAt(events: ActionEvent[]): number | undefined {
  const ats = events
    .filter((e) => e.author === 'improver' && IMPROVER_REVIEW_KINDS.has(e.kind))
    .map((e) => e.at);
  return ats.length > 0 ? Math.max(...ats) : undefined;
}

function adjudicatedSince(runs: ActionRunRecord[], since: number): ActionRunRecord[] {
  return runs.filter((r) => r.startedAt > since && r.outcome && ADJUDICATED_OUTCOMES.has(r.outcome));
}

// A denial seen more than once is a standing signal that the action's permissions or its
// instructions are wrong — worth a review even below the run threshold. A verdicted denial is
// excluded regardless of disposition (Ship 6 Ruling P2: presence, not disposition) — an
// applied `promote` is as resolved as a `never`, and re-surfacing either would have the
// improver re-propose a grant that already exists every cycle.
function recurringDenials(denials: ActionDenial[], since = -Infinity): ActionDenial[] {
  return denials.filter((d) => d.count > 1 && d.at > since && !d.verdict);
}

// All three terms are counts, so they're directly comparable: a failure weighs more than a
// send-back, which weighs more than a blocked call.
function needsAttentionScore(sc: Scorecard, denials: ActionDenial[]): number {
  const failures = sc.outcomes.failed + sc.outcomes.gave_up;
  return 3 * failures + 2 * sc.outcomes.revised + recurringDenials(denials).length;
}

interface Candidate {
  action: string;
  since: number;
  score: number;
  newRuns: number;
  denials: number;
}

export function selectActionToImprove(
  deps: ImprovementPackDeps,
  opts: ImprovementPackOpts = {},
): { action: string; reason: string } | null {
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const exclude = new Set(opts.exclude ?? EXCLUDED_ACTIONS);
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now();

  const pending = deps.pendingEdits();
  // Without this an improver firing while the user is away stacks a review backlog.
  if (pending.filter((e) => e.authorAction === 'meta.improve-actions').length >= maxPending) return null;
  const pendingNames = new Set(pending.map((e) => e.actionName).filter((n): n is string => !!n));

  const candidates: Candidate[] = [];
  for (const action of deps.listActionNames()) {
    if (exclude.has(action) || pendingNames.has(action)) continue;
    const revisions = deps.revisionsFor(action);
    const since = lastImproverReviewAt(revisions) ?? 0;
    const runs = deps.runsFor(action);
    const denials = deps.denialsFor(action);
    const newRuns = adjudicatedSince(runs, since).length;
    const newDenials = recurringDenials(denials, since).length;
    if (newRuns < minRuns && newDenials === 0) continue;
    const sc = buildScorecard(action, runs, denials, { now, windowMs });
    candidates.push({ action, since, score: needsAttentionScore(sc, denials), newRuns, denials: newDenials });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.since - b.since);
  const top = candidates[0]!;
  const parts = [`${top.newRuns} new adjudicated run${top.newRuns === 1 ? '' : 's'}`];
  if (top.denials > 0) parts.push(`${top.denials} recurring denial${top.denials === 1 ? '' : 's'}`);
  parts.push(top.since === 0 ? 'never reviewed' : 'reviewed before');
  return { action: top.action, reason: `${top.action}: ${parts.join(', ')}` };
}

export function buildImprovementPack(
  action: string,
  deps: ImprovementPackDeps,
  opts: ImprovementPackOpts = {},
  whySelected = '',
): ImprovementPack {
  const now = deps.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const runs = deps.runsFor(action);
  const denials = deps.denialsFor(action);
  const events = deps.revisionsFor(action);
  const skillMd = deps.skillMdFor(action);
  const reviewedAt = lastImproverReviewAt(events);
  const previous = reviewedAt !== undefined
    ? events.find((e) => e.at === reviewedAt && e.author === 'improver')
    : undefined;

  return {
    action,
    whySelected,
    currentSkillMd: skillMd,
    currentLineCount: skillMd === '' ? 0 : skillMd.replace(/\n$/, '').split('\n').length,
    scorecard: buildScorecard(action, runs, denials, { now, windowMs }),
    failures: runs
      .filter((r) => r.outcome === 'failed' || r.outcome === 'gave_up')
      .slice(0, LIST_CAP)
      .map((r) => ({
        runId: r.id,
        at: r.endedAt ?? r.startedAt,
        round: r.round,
        attempt: r.attempt,
        jobId: r.jobId,
        stepId: r.stepId,
        reason: r.failureReason,
      })),
    revisions: runs
      .filter((r) => r.outcome === 'revised')
      .slice(0, LIST_CAP)
      .map((r) => ({
        runId: r.id,
        at: r.verdictAt ?? r.startedAt,
        round: r.round,
        attempt: r.attempt,
        feedbackChars: r.feedbackChars,
        jobId: r.jobId,
      })),
    denials: recurringDenials(denials)
      .slice(0, LIST_CAP)
      .map(({ id, toolName, suggested, count, at }) => ({ id, toolName, suggested, count, at })),
    rejectedProposals: events
      .filter((e) => e.kind === 'rejected')
      .slice(0, LIST_CAP)
      .map((e) => ({ at: e.at, rationale: e.rationale, feedback: e.feedback })),
    lessons: deps.lessonsFor(action),
    history: events
      .filter((e) => e.kind === 'applied' || e.kind === 'reverted')
      .slice(0, LIST_CAP)
      .map((e) => ({ at: e.at, kind: e.kind, author: e.author, bodyBytes: e.bodyBytes, rationale: e.rationale })),
    ...(previous ? { previousReview: { at: previous.at, rationale: previous.rationale } } : {}),
  };
}
