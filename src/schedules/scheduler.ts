import { Cron } from 'croner';
import type { SchedulesStore } from './schedules-store.js';
import { evaluateGuards, type GuardProviders } from './guards.js';
import { routeFindings, approveGithubPost, type RoutingDeps } from './routing.js';
import type { RunVerdict, ScheduleRecord, ScheduleRun, What } from './types.js';

export interface CreateJobInput {
  title: string;
  what: What;
}

export interface SpawnSkillSessionInput {
  skill: string;
  repos?: string[];
  scope?: string;
  model?: string;
  args?: Record<string, unknown>;
}

// Narrow spawn surface the wiring agent maps onto the orchestrator/session-manager. Which one
// is called is decided by `resolveSpawnMode` below — not by a field on the schedule record.
export interface SchedulerSpawnDeps {
  createJob?: (input: CreateJobInput) => Promise<{ jobId: string }> | { jobId: string };
  spawnSkillSession?: (input: SpawnSkillSessionInput) => Promise<{ sessionId: string }> | { sessionId: string };
}

// Script/native schedules never spawn a job or session — `fire()` dispatches them inline via
// these before `resolveSpawnMode`/`spawn()` are even consulted.
export interface SchedulerInlineDeps {
  runScript?: (what: Extract<What, { kind: 'script' }>, opts: { builtin?: boolean }) => Promise<{ outcome: 'ok' | 'error'; verdict?: RunVerdict }>;
  runNative?: (handler: string) => Promise<{ outcome: 'ok' | 'error'; verdict?: RunVerdict }>;
}

export interface SchedulerDeps {
  store: SchedulesStore;
  guardProviders: GuardProviders;
  spawn: SchedulerSpawnDeps;
  // Optional — omit in tests that only exercise guard/spawn logic, not delivery.
  routing?: RoutingDeps;
  // Optional — omit in tests that only exercise skill/prompt spawn logic, not script/native.
  inline?: SchedulerInlineDeps;
  // Wired to the daemon's `notifyAll` (src/daemon.ts). Fired with
  // `{type:'schedule_run_changed', scheduleId, run}` on run start/finish/skip.
  notify?: (message: unknown) => void;
  now?: () => number;
}

// Prompts always run as jobs (the orchestrator plans/executes them in a worktree). `script` and
// `native` are dispatched inline in `fire()` before this is ever consulted, so this only ever
// sees `skill` and `prompt`. For a named skill: `code.*` skills drive the tracked-job/PR
// lifecycle (orchestrator, steps, PR review) so they need a real JobRecord; everything else
// (read/write/human/meta skills) is a single self-contained run and only needs a session.
function resolveSpawnMode(what: What): 'job' | 'session' {
  if (what.kind !== 'skill') return 'job';
  return what.skill.startsWith('code.') ? 'job' : 'session';
}

// `croner` throws synchronously on a malformed pattern. Routes call this before persisting a
// cron trigger so a bad expression 400s instead of getting written to disk and crash-looping
// the daemon on the next `scheduler.start()`.
export function validateCronExpr(expr: string, tz?: string): string | null {
  try {
    new Cron(expr, { timezone: tz });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(private deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // Call once at startup after construction — arms a croner timer for every enabled cron
  // or once schedule currently in the store.
  start(): void {
    for (const schedule of this.deps.store.list()) {
      if (schedule.enabled && (schedule.trigger.kind === 'cron' || schedule.trigger.kind === 'once')) this.arm(schedule);
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  // A malformed `expr` should never have made it past the route validation, but old rows
  // written before that validation existed (or edited directly in index.json) are still
  // possible — catch here too so one bad schedule can't crash-loop the whole daemon on start().
  private arm(schedule: ScheduleRecord): void {
    const trigger = schedule.trigger;
    if (trigger.kind !== 'cron' && trigger.kind !== 'once') return;
    this.jobs.get(schedule.id)?.stop();

    if (trigger.kind === 'once') {
      // A one-shot whose time passed while the daemon was down should not fire late — retire it
      // instead of arming, so it lands inactive rather than firing on the next start().
      if (trigger.at <= this.now()) {
        this.deps.store.setEnabled(schedule.id, false);
        return;
      }
      const job = new Cron(new Date(trigger.at), { protect: true }, () => {
        void this.fire(schedule.id, 'once').catch((e) => {
          console.error(`[scheduler] fire failed for "${schedule.name}" (${schedule.id}):`, (e as Error).message);
        });
      });
      this.jobs.set(schedule.id, job);
      return;
    }

    let job: Cron;
    try {
      job = new Cron(trigger.expr, { timezone: trigger.tz, protect: true }, () => {
        void this.fire(schedule.id, 'cron').catch((e) => {
          console.error(`[scheduler] fire failed for "${schedule.name}" (${schedule.id}):`, (e as Error).message);
        });
      });
    } catch (e) {
      console.error(`[scheduler] skipping schedule "${schedule.name}" (${schedule.id}): invalid cron expression "${trigger.expr}" — ${(e as Error).message}`);
      return;
    }
    this.jobs.set(schedule.id, job);
  }

  // The next computed fire time for an armed cron or once schedule, or null (disabled/event-kind/
  // already-fired one-shot/invalid pattern). Routes call this to compute `nextRunAt` on GET /api/schedules.
  nextRunAt(scheduleId: string): number | null {
    const armed = this.jobs.get(scheduleId)?.nextRun();
    if (armed) return armed.getTime();
    return null;
  }

  // Routes must call this after any create/update/enable/disable of a schedule so the cron
  // timer reflects the new trigger/enabled state.
  onScheduleChanged(scheduleId: string): void {
    this.jobs.get(scheduleId)?.stop();
    this.jobs.delete(scheduleId);
    const schedule = this.deps.store.get(scheduleId);
    if (schedule?.enabled && (schedule.trigger.kind === 'cron' || schedule.trigger.kind === 'once')) this.arm(schedule);
  }

  // Routes must call this after deleting a schedule.
  onScheduleDeleted(scheduleId: string): void {
    this.jobs.get(scheduleId)?.stop();
    this.jobs.delete(scheduleId);
  }

  // Explicit user action — bypasses both the enabled flag and skip-if guards.
  runNow(scheduleId: string): Promise<ScheduleRun> {
    return this.fire(scheduleId, 'manual', { force: true });
  }

  // Called by the TokenScheduler when usage headroom allows. Runs guards normally (unlike runNow)
  // so a usage-threshold hard ceiling still applies on top of the headroom decision.
  fireTokenOpportunistic(scheduleId: string): Promise<ScheduleRun> {
    return this.fire(scheduleId, 'token');
  }

  // No event sources exist yet; this is the hook a future event source calls with whatever
  // descriptor it fired. Fires every enabled event-kind schedule with a matching descriptor.
  async registerEventFiring(descriptor: string): Promise<ScheduleRun[]> {
    const matches = this.deps.store.list().filter((s) => s.enabled && s.trigger.kind === 'event' && s.trigger.descriptor === descriptor);
    return Promise.all(matches.map((s) => this.fire(s.id, 'event')));
  }

  private async fire(scheduleId: string, _trigger: 'cron' | 'once' | 'manual' | 'event' | 'token', opts?: { force?: boolean }): Promise<ScheduleRun> {
    const schedule = this.deps.store.get(scheduleId);
    if (!schedule) throw new Error(`schedule not found: ${scheduleId}`);

    // A one-shot has now fired — retire it (disable + drop the timer) so it doesn't linger armed
    // or re-arm on the next daemon start, regardless of whether this run dispatches or is skipped.
    if (_trigger === 'once') {
      this.jobs.get(scheduleId)?.stop();
      this.jobs.delete(scheduleId);
      this.deps.store.setEnabled(scheduleId, false);
      this.deps.notify?.({ type: 'schedules_changed' });
    }

    if (!opts?.force && !schedule.enabled) {
      return this.recordSkip(schedule, 'Skipped — schedule is paused');
    }

    const lastRun = this.deps.store.lastRun(scheduleId, { excludeSkipped: true });
    const guardResult = opts?.force
      ? ({ ok: true } as const)
      : await evaluateGuards(schedule.guards, { schedule, lastRunAt: lastRun?.startedAt }, this.deps.guardProviders);
    if (!guardResult.ok) return this.recordSkip(schedule, guardResult.reason);

    // evaluateGuards can block for seconds (getRepoLastChange shells out with a 10s timeout), so
    // a DELETE may have landed while we awaited it — store.startRun refuses to create a run row
    // for a scheduleId it no longer has, rather than resurrecting a runOrder bucket for it.
    const run = this.deps.store.startRun(scheduleId, { outcome: 'running' });
    if (!run) throw new Error(`schedule deleted during dispatch: ${scheduleId}`);
    this.notify(scheduleId, run);

    // script/native run synchronously to a terminal outcome here — no job/session is spawned,
    // so there's nothing for `completeRunByRef` to finalize later the way skill/prompt runs are.
    const what = schedule.what;
    if (what.kind === 'script' || what.kind === 'native') {
      try {
        const result = what.kind === 'script'
          ? await this.requireInline('runScript').runScript!(what, { builtin: schedule.builtin })
          : await this.requireInline('runNative').runNative!(what.handler);
        const done = this.deps.store.updateRun(run.id, {
          outcome: result.outcome,
          finishedAt: this.now(),
          verdict: result.verdict,
        }) ?? run;
        this.notify(scheduleId, done);
        return done;
      } catch (e) {
        const failed = this.deps.store.updateRun(run.id, {
          outcome: 'error',
          finishedAt: this.now(),
          verdict: { summary: (e as Error).message },
        }) ?? run;
        this.notify(scheduleId, failed);
        return failed;
      }
    }

    try {
      const refs = await this.spawn(schedule);
      const updated = this.deps.store.updateRun(run.id, { refs }) ?? run;
      this.notify(scheduleId, updated);
      return updated;
    } catch (e) {
      const failed = this.deps.store.updateRun(run.id, {
        outcome: 'error',
        finishedAt: this.now(),
        verdict: { summary: (e as Error).message },
      }) ?? run;
      this.notify(scheduleId, failed);
      return failed;
    }
  }

  private requireInline(dep: keyof SchedulerInlineDeps): SchedulerInlineDeps {
    if (!this.deps.inline?.[dep]) throw new Error('inline deps not wired');
    return this.deps.inline;
  }

  private recordSkip(schedule: ScheduleRecord, reason: string): ScheduleRun {
    const run = this.deps.store.startRun(schedule.id, { outcome: 'skipped', skipReason: reason });
    if (!run) throw new Error(`schedule deleted during dispatch: ${schedule.id}`);
    this.notify(schedule.id, run);
    return run;
  }

  private async spawn(schedule: ScheduleRecord): Promise<{ jobId?: string; sessionId?: string }> {
    const what = schedule.what;
    if (resolveSpawnMode(what) === 'job') {
      if (!this.deps.spawn.createJob) throw new Error('createJob dependency not wired');
      const result = await this.deps.spawn.createJob({ title: `Scheduled: ${schedule.name}`, what });
      return { jobId: result.jobId };
    }
    // Session mode is only reachable for a non-`code.*` skill (see resolveSpawnMode).
    if (what.kind !== 'skill') throw new Error(`cannot spawn a ${what.kind} schedule as a session`);
    if (!this.deps.spawn.spawnSkillSession) throw new Error('spawnSkillSession dependency not wired');
    const result = await this.deps.spawn.spawnSkillSession({
      skill: what.skill,
      repos: what.repos,
      scope: what.scope,
      model: what.model,
      args: what.args,
    });
    return { sessionId: result.sessionId };
  }

  // Called by the wiring layer when the job/session a run spawned actually finishes (e.g. a
  // JobQueue subscriber sees `state === 'done'|'failed'`, or a session-manager exit hook fires)
  // — the scheduler itself has no visibility into job/session completion.
  async completeRun(runId: string, result: { outcome: 'ok' | 'error'; verdict?: RunVerdict }): Promise<ScheduleRun | null> {
    const run = this.deps.store.getRun(runId);
    if (!run) return null;
    const schedule = this.deps.store.get(run.scheduleId);
    let delivery;
    if (schedule && this.deps.routing && result.outcome === 'ok') {
      delivery = await routeFindings(schedule, { ...run, verdict: result.verdict }, this.deps.routing);
    }
    const updated = this.deps.store.updateRun(runId, {
      outcome: result.outcome,
      finishedAt: this.now(),
      verdict: result.verdict,
      delivery,
    });
    if (updated) this.notify(updated.scheduleId, updated);
    return updated;
  }

  // Convenience for the wiring layer: look up the run by the job/session ref it was spawned
  // with instead of needing to have threaded the runId through the job/session lifecycle.
  completeRunByRef(ref: { jobId?: string; sessionId?: string }, result: { outcome: 'ok' | 'error'; verdict?: RunVerdict }): Promise<ScheduleRun | null> {
    const run = this.deps.store.findRunByRef(ref);
    if (!run) return Promise.resolve(null);
    return this.completeRun(run.id, result);
  }

  async approveGithubPost(runId: string): Promise<ScheduleRun | null> {
    if (!this.deps.routing) throw new Error('routing dependency not wired');
    const updated = await approveGithubPost(this.deps.store, runId, this.deps.routing);
    if (updated) this.notify(updated.scheduleId, updated);
    return updated;
  }

  private notify(scheduleId: string, run: ScheduleRun): void {
    this.deps.notify?.({ type: 'schedule_run_changed', scheduleId, run });
  }
}
