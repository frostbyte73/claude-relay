// Minimal shape of the account usage snapshot this controller needs — mirrors
// `AccountUsageSnapshot` (src/integrations/usage-poller.ts) without importing it, keeping
// src/schedules/ dependency-free. `resets_at` is unix epoch *seconds* (claude's convention).
export interface TokenWindowUsage {
  used_percentage: number;
  resets_at: number;
}
export interface TokenUsageSnapshot {
  five_hour?: TokenWindowUsage;
  seven_day?: TokenWindowUsage;
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// How far behind pace the 7d window must be before we spend on backlog. `headroom` is
// (fraction of window elapsed − fraction of budget used); a positive value means we've used
// proportionally less budget than time. The margin keeps us conservative early in a window
// (elapsed≈0, used≈0 → headroom≈0 → wait) while the pace signal itself grows more permissive
// as the window drains, so near a reset with budget to spare it launches aggressively.
const PACE_MARGIN = 0.05;
// Hard ceiling on the short window: never launch into a nearly-spent 5h bucket, so a burst of
// backlog jobs can't blow the short limit even when the 7d window looks healthy.
const FIVE_HOUR_CEILING = 80;

export type HeadroomCode = 'no-data' | 'five-hour-ceiling' | 'ahead-of-pace' | 'ok';

export interface HeadroomDecision {
  launch: boolean;
  reason: string;
  code: HeadroomCode;
}

// Coarse duration label for the status strings the schedules UI shows ("3d to reset",
// "next in 22h"). Shared with token-scheduler.ts's debounce reason.
export function humanizeMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// Fails closed: any missing/stale signal yields `launch: false`. Never launches on partial data.
export function evaluateHeadroom(snapshot: TokenUsageSnapshot | undefined, now: number): HeadroomDecision {
  const seven = snapshot?.seven_day;
  const five = snapshot?.five_hour;
  if (!seven || !five || !Number.isFinite(seven.resets_at) || seven.resets_at <= 0) {
    return { launch: false, reason: 'Waiting — no usage data yet', code: 'no-data' };
  }
  if (five.used_percentage >= FIVE_HOUR_CEILING) {
    return { launch: false, reason: `Waiting — 5h usage at ${Math.round(five.used_percentage)}%`, code: 'five-hour-ceiling' };
  }
  const msUntilReset = seven.resets_at * 1000 - now;
  if (msUntilReset <= 0) return { launch: false, reason: 'Waiting — awaiting usage refresh', code: 'no-data' };

  const elapsedFrac = Math.min(1, Math.max(0, (SEVEN_DAY_MS - msUntilReset) / SEVEN_DAY_MS));
  const usedFrac = Math.min(1, Math.max(0, seven.used_percentage / 100));
  const headroom = elapsedFrac - usedFrac;
  const used = Math.round(seven.used_percentage);
  const until = humanizeMs(msUntilReset);
  if (headroom < PACE_MARGIN) {
    return { launch: false, reason: `Waiting — 7d usage ahead of pace (${used}% used, ${until} to reset)`, code: 'ahead-of-pace' };
  }
  return { launch: true, reason: `Headroom — 7d at ${used}% used, ${until} to reset`, code: 'ok' };
}
