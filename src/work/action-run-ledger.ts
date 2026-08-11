import type { JobQueue } from './work-queue.js';
import type { JobRecord } from './work-types.js';
import { deriveRunEvents, type RunEvent, type RunKey } from './action-run-derive.js';
import type { ActionRunOutcome, ActionRunRecord, ActionRunsStore } from '../storage/action-runs-store.js';

// Observes the job queue and records one run per action round. Wiring is a single
// subscribe in daemon.ts: JobQueue.upsert already broadcasts the full record on every
// engine mutation, so the ledger reads round boundaries out of the state diff rather
// than needing a call at each of the engine's ~20 spawn/settle seams.
//
// Cost and denials accumulate in memory on the open run and are written once, in the
// close patch — a JSONL line per statusline turn would be far too chatty. Losing them
// to a crash is fine: that run reconciles to `interrupted` anyway.

export interface ActionRunLedgerDeps {
  store: ActionRunsStore;
  now?: () => number;
  onSettled?: (action: string) => void;
}

function keyOf(k: RunKey): string { return `${k.jobId}:${k.stepId ?? '-'}`; }

export class ActionRunLedger {
  private readonly prevByJob = new Map<string, JobRecord>();
  private readonly openByKey = new Map<string, ActionRunRecord>();
  private readonly openBySession = new Map<string, string>();
  private readonly lastCostBySession = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ActionRunLedgerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  attach(queue: JobQueue): void {
    for (const j of queue.list()) this.prevByJob.set(j.id, j);
    queue.subscribe((ev) => {
      try {
        if (ev.kind === 'delete') { this.prevByJob.delete(ev.jobId); return; }
        const prev = this.prevByJob.get(ev.jobId);
        this.prevByJob.set(ev.jobId, ev.job);
        const opts = { now: this.now() };
        for (const e of deriveRunEvents(prev, ev.job, opts)) this.apply(e);
      } catch (e) {
        // JobQueue iterates subscribers unguarded — instrumentation must never be
        // able to fail a job.
        console.warn(`[action-runs] observer: ${(e as Error).message}`);
      }
    });
  }

  // Adopts or retires runs left open by a daemon restart. Call once at boot, before
  // anything can mutate a job.
  reconcileAtBoot(jobs: JobRecord[]): void {
    const byJob = new Map(jobs.map((j) => [j.id, j]));
    for (const run of this.deps.store.openRuns()) {
      const job = byJob.get(run.jobId);
      const live = job ? this.stillRunning(job, run) : false;
      if (live) {
        this.openByKey.set(keyOf({ jobId: run.jobId, stepId: run.stepId }), run);
        if (run.sessionId) this.openBySession.set(run.sessionId, keyOf({ jobId: run.jobId, stepId: run.stepId }));
      } else {
        this.settle(run, { outcome: 'interrupted', endedAt: this.now() });
      }
    }
  }

  private stillRunning(job: JobRecord, run: ActionRunRecord): boolean {
    const opts = { now: this.now() };
    const events = deriveRunEvents(undefined, job, opts);
    return events.some((e) =>
      e.t === 'open' && e.round === run.round && (e.key.stepId ?? e.key.jobId) === (run.stepId ?? run.jobId));
  }

  noteSessionCost(sessionId: string, cumulativeUsd: number): void {
    if (!Number.isFinite(cumulativeUsd)) return;
    const prev = this.lastCostBySession.get(sessionId);
    // A cumulative counter that went backwards means the session id was reused
    // (a /clear, or a respawn) — treat the new value as a fresh baseline.
    const delta = prev !== undefined && cumulativeUsd >= prev ? cumulativeUsd - prev : cumulativeUsd;
    this.lastCostBySession.set(sessionId, cumulativeUsd);
    if (delta <= 0) return;
    const run = this.runForSession(sessionId);
    if (run) run.costUsd = (run.costUsd ?? 0) + delta;
  }

  noteDenial(sessionId: string): string | undefined {
    const run = this.runForSession(sessionId);
    if (!run) return undefined;
    run.denials = (run.denials ?? 0) + 1;
    return run.id;
  }

  // Runs that aren't job-backed — the meta.build-action edit sessions the routes
  // spawn directly, which the queue observer can't see.
  openExternal(input: { action: string; round: string; sessionId: string }): void {
    this.open({
      t: 'open',
      key: { jobId: `action-edit:${input.sessionId}` },
      action: input.action,
      round: input.round,
      sessionId: input.sessionId,
      at: this.now(),
    });
  }

  closeExternal(sessionId: string, outcome: ActionRunOutcome): void {
    const run = this.runForSession(sessionId);
    if (!run) return;
    this.apply({ t: 'close', key: { jobId: run.jobId, stepId: run.stepId }, outcome, at: this.now() });
  }

  verdictExternal(sessionId: string, outcome: ActionRunOutcome): void {
    const key = { jobId: `action-edit:${sessionId}` };
    this.apply({ t: 'verdict', key, outcome, at: this.now() });
  }

  private runForSession(sessionId: string): ActionRunRecord | undefined {
    const key = this.openBySession.get(sessionId);
    return key ? this.openByKey.get(key) : undefined;
  }

  private apply(e: RunEvent): void {
    if (e.t === 'open') { this.open(e); return; }
    if (e.t === 'close') {
      const run = this.openByKey.get(keyOf(e.key));
      if (!run) return;
      this.settle(run, {
        outcome: e.outcome,
        endedAt: e.at,
        durationMs: Math.max(0, e.at - run.startedAt),
        ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
        ...(run.denials !== undefined ? { denials: run.denials } : {}),
        ...(e.failureReason ? { failureReason: e.failureReason } : {}),
      });
      return;
    }
    const scopeId = e.key.stepId ?? e.key.jobId;
    const target = this.deps.store.latestFor(scopeId, e.round);
    if (!target) return;
    this.deps.store.patch(target.id, {
      outcome: e.outcome,
      verdictAt: e.at,
      ...(e.feedbackChars !== undefined ? { feedbackChars: e.feedbackChars } : {}),
    });
    this.deps.onSettled?.(target.action);
  }

  private open(e: Extract<RunEvent, { t: 'open' }>): void {
    const key = keyOf(e.key);
    if (this.openByKey.has(key)) return;
    const scopeId = e.key.stepId ?? e.key.jobId;
    const run = this.deps.store.open({
      action: e.action,
      round: e.round,
      attempt: 1 + this.deps.store.attemptsFor(scopeId, e.round),
      jobId: e.key.jobId,
      stepId: e.key.stepId,
      sessionId: e.sessionId,
      startedAt: e.at,
    });
    this.openByKey.set(key, run);
    if (e.sessionId) this.openBySession.set(e.sessionId, key);
  }

  private settle(run: ActionRunRecord, fields: Partial<ActionRunRecord>): void {
    this.deps.store.patch(run.id, fields);
    const key = keyOf({ jobId: run.jobId, stepId: run.stepId });
    this.openByKey.delete(key);
    if (run.sessionId) this.openBySession.delete(run.sessionId);
    this.deps.onSettled?.(run.action);
  }
}
