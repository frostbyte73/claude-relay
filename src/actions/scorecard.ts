import { ADJUDICATED_OUTCOMES, type ActionRunOutcome, type ActionRunRecord } from '../storage/action-runs-store.js';
import type { ActionDenial } from '../storage/denials-store.js';

// Rolls an action's run rows into the numbers the skills detail pane shows.
//
// Rates return null rather than 0 on an empty denominator so the UI can render "—"
// instead of a zero that reads as failure. Runs still at `submitted` are pending — a
// gate hasn't ruled yet — and are excluded from every denominator rather than being
// silently scored either way.

export interface ScorecardRoundSplit {
  round: string;
  runs: number;
  acceptRate: number | null;
  avgRevisions: number | null;
}

export interface Scorecard {
  action: string;
  windowMs: number | null;
  runs: number;
  pending: number;
  outcomes: Record<ActionRunOutcome, number>;
  acceptRate: number | null;
  firstTryRate: number | null;
  avgRevisions: number | null;
  byRound: ScorecardRoundSplit[];
  duration: { avgMs: number | null; p50Ms: number | null };
  cost: { totalUsd: number; avgUsd: number | null };
  denials: { total: number; distinct: number; top: Array<Pick<ActionDenial, 'toolName' | 'suggested' | 'count'>> };
  failures: Array<{ at: number; jobId: string; stepId?: string; reason?: string }>;
  recent: ActionRunRecord[];
}

export interface ScorecardOpts {
  windowMs?: number;
  now: number;
  recentLimit?: number;
  failureLimit?: number;
}

const SUCCESS: ReadonlySet<ActionRunOutcome> = new Set<ActionRunOutcome>(['accepted', 'merged']);

function emptyOutcomes(): Record<ActionRunOutcome, number> {
  return {
    submitted: 0, accepted: 0, revised: 0, denied: 0, merged: 0,
    abandoned: 0, failed: 0, gave_up: 0, interrupted: 0,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function splitFor(round: string, rows: ActionRunRecord[]): ScorecardRoundSplit {
  const adjudicated = rows.filter((r) => r.outcome && ADJUDICATED_OUTCOMES.has(r.outcome));
  const succeeded = rows.filter((r) => r.outcome && SUCCESS.has(r.outcome));
  return {
    round,
    runs: rows.length,
    acceptRate: rate(succeeded.length, adjudicated.length),
    avgRevisions: mean(succeeded.map((r) => r.attempt - 1)),
  };
}

export function buildScorecard(
  action: string,
  rows: ActionRunRecord[],
  denials: ActionDenial[],
  opts: ScorecardOpts,
): Scorecard {
  const windowMs = opts.windowMs ?? null;
  const cutoff = windowMs === null ? -Infinity : opts.now - windowMs;
  const inWindow = rows.filter((r) => r.startedAt >= cutoff).sort((a, b) => b.startedAt - a.startedAt);

  const outcomes = emptyOutcomes();
  for (const r of inWindow) if (r.outcome) outcomes[r.outcome] += 1;

  const adjudicated = inWindow.filter((r) => r.outcome && ADJUDICATED_OUTCOMES.has(r.outcome));
  const succeeded = inWindow.filter((r) => r.outcome && SUCCESS.has(r.outcome));
  const durations = inWindow.map((r) => r.durationMs).filter((d): d is number => typeof d === 'number');
  const costed = inWindow.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');

  const byRound = [...new Set(inWindow.map((r) => r.round))]
    .map((round) => splitFor(round, inWindow.filter((r) => r.round === round)))
    .sort((a, b) => b.runs - a.runs);

  return {
    action,
    windowMs,
    runs: inWindow.length,
    pending: inWindow.filter((r) => !r.outcome || !ADJUDICATED_OUTCOMES.has(r.outcome)).length,
    outcomes,
    acceptRate: rate(succeeded.length, adjudicated.length),
    firstTryRate: rate(succeeded.filter((r) => r.attempt === 1).length, succeeded.length),
    avgRevisions: mean(succeeded.map((r) => r.attempt - 1)),
    byRound,
    duration: { avgMs: mean(durations), p50Ms: median(durations) },
    cost: { totalUsd: costed.reduce((a, b) => a + b, 0), avgUsd: mean(costed) },
    denials: {
      total: denials.reduce((a, d) => a + d.count, 0),
      distinct: denials.length,
      top: [...denials]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(({ toolName, suggested, count }) => ({ toolName, suggested, count })),
    },
    failures: inWindow
      .filter((r) => r.outcome === 'failed' || r.outcome === 'gave_up')
      .slice(0, opts.failureLimit ?? 5)
      .map((r) => ({ at: r.endedAt ?? r.startedAt, jobId: r.jobId, stepId: r.stepId, reason: r.failureReason })),
    recent: inWindow.slice(0, opts.recentLimit ?? 20),
  };
}
