import type { SchedulesStore } from './schedules-store.js';
import type { ScheduleRecord } from './types.js';
import { evaluateHeadroom, humanizeMs, type TokenUsageSnapshot } from './headroom.js';

export type { TokenWindowUsage, TokenUsageSnapshot, HeadroomDecision, HeadroomCode } from './headroom.js';
export { evaluateHeadroom } from './headroom.js';

export interface TokenSchedulerDeps {
  store: SchedulesStore;
  getSnapshot: () => TokenUsageSnapshot | undefined;
  // Launches one token schedule. Wired to `Scheduler.fireTokenOpportunistic` in the daemon; the
  // fired run stays `running` until its job/session completes, which is what serializes launches.
  fire: (scheduleId: string) => Promise<unknown>;
  now?: () => number;
}

export type TokenStatus = { state: 'running' | 'eligible' | 'waiting'; reason: string };

// Watches account usage and launches token-opportunistic schedules when there's spare capacity,
// serializing so at most one token-launched job runs at a time. Driven entirely by the daemon's
// usage-snapshot stream — it has no timer of its own.
export class TokenScheduler {
  private evaluating = false;

  constructor(private readonly deps: TokenSchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private tokenSchedules(): ScheduleRecord[] {
    return this.deps.store.list().filter((s) => s.enabled && s.trigger.kind === 'token-opportunistic');
  }

  // True while any token schedule (enabled or not) has a run still in flight — the serialization
  // gate. Includes disabled ones so pausing a schedule mid-run doesn't unblock a second launch.
  private anyInFlight(): boolean {
    return this.deps.store.list()
      .filter((s) => s.trigger.kind === 'token-opportunistic')
      .some((s) => this.deps.store.lastRun(s.id)?.outcome === 'running');
  }

  // Called for each account-usage snapshot. Fire-and-forget from the daemon; the `evaluating`
  // latch drops overlapping snapshots so a slow guard (getRepoLastChange shells out) can't let a
  // second snapshot double-launch before the first fire has written its `running` run row.
  async onUsageSnapshot(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try { await this.evaluate(); }
    finally { this.evaluating = false; }
  }

  // Remaining cooldown in ms for a schedule whose trigger sets `debounceMs`, or null if it's free
  // to run. Measured from the last run's `startedAt` regardless of outcome — a skipped run is an
  // attempt, and suppressing the *retry* of a schedule that keeps finding nothing to do is the
  // whole reason the field exists. Candidates on cooldown are filtered out rather than fired-and-
  // skipped, so a debounce leaves no run rows behind either.
  private cooldownRemaining(schedule: ScheduleRecord): number | null {
    const debounceMs = schedule.trigger.kind === 'token-opportunistic' ? schedule.trigger.debounceMs ?? 0 : 0;
    if (debounceMs <= 0) return null;
    const lastStart = this.deps.store.lastRun(schedule.id)?.startedAt;
    if (lastStart === undefined) return null;
    const remaining = lastStart + debounceMs - this.now();
    return remaining > 0 ? remaining : null;
  }

  private async evaluate(): Promise<void> {
    const schedules = this.tokenSchedules().filter((s) => this.cooldownRemaining(s) === null);
    if (schedules.length === 0) return;
    if (this.anyInFlight()) return;
    if (!evaluateHeadroom(this.deps.getSnapshot(), this.now()).launch) return;
    const target = this.pickNext(schedules);
    if (target) await this.deps.fire(target.id);
  }

  // Least-recently-run first (never-run wins) so multiple token schedules share launches fairly
  // rather than one starving the others.
  private pickNext(schedules: ScheduleRecord[]): ScheduleRecord | undefined {
    return [...schedules].sort((a, b) => {
      const la = this.deps.store.lastRun(a.id)?.startedAt ?? 0;
      const lb = this.deps.store.lastRun(b.id)?.startedAt ?? 0;
      return la - lb;
    })[0];
  }

  // UI status for GET /api/schedules. `eligible` means headroom exists and nothing's in flight —
  // the next snapshot would launch it; `waiting` covers the debounce cooldown, the serialization
  // gate and no-headroom.
  describe(scheduleId: string): TokenStatus {
    if (this.deps.store.lastRun(scheduleId)?.outcome === 'running') return { state: 'running', reason: 'Running now' };
    const schedule = this.deps.store.get(scheduleId);
    const remaining = schedule ? this.cooldownRemaining(schedule) : null;
    // Reported ahead of the shared gates: this schedule's own cooldown is the binding reason
    // even on a snapshot where headroom exists and nothing else is running.
    if (remaining !== null && schedule?.trigger.kind === 'token-opportunistic') {
      return {
        state: 'waiting',
        reason: `Waiting — at most once per ${humanizeMs(schedule.trigger.debounceMs ?? 0)} (next in ${humanizeMs(remaining)})`,
      };
    }
    if (this.anyInFlight()) return { state: 'waiting', reason: 'Waiting — another token job is running' };
    const decision = evaluateHeadroom(this.deps.getSnapshot(), this.now());
    return { state: decision.launch ? 'eligible' : 'waiting', reason: decision.reason };
  }
}
