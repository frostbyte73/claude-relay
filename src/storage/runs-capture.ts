import type { JobRecord } from '../work/work-types.js';
import type { RunRecord, RunsStore } from './runs-store.js';
import type { UsageLedger } from '../integrations/usage-ledger.js';

// Glue between session/job/schedule lifecycles and the runs ledger + usage ledger. Exported
// as a factory; daemon.ts wires each handler to the lifecycle event it corresponds to
// (statusline hook, session exit, job state change). Schedule-spawned sessions/jobs are not a
// separate lifecycle — the caller (daemon.ts) looks up whether a given session/job belongs to
// a schedule (SchedulesStore.findRunByRef) and passes that as `schedule` context, which retags
// the appended row as kind:'sched' instead of appending a second, separate row.

const TERMINAL_JOB_STATES: ReadonlySet<JobRecord['state']> = new Set(['done', 'failed', 'abandoned']);

export interface StatuslinePayload {
  model?: { id?: string; display_name?: string };
  cost?: { total_cost_usd?: number };
}

export interface ScheduleRunContext {
  id: string;
  name: string;
  skill: string;
}

export interface SessionEndInput {
  sessionId: string;
  title: string;
  cwd?: string;
  verdict?: string;
  startedAt?: number;
  durationMs?: number;
  costUsd?: number;
  schedule?: ScheduleRunContext;
}

export interface RunsCaptureDeps {
  runsStore: RunsStore;
  usageLedger: UsageLedger;
  // Fired after every successful append, so the caller can fan it out over WS
  // (e.g. `notifyAll({ type: 'run_appended', run })`) without this module knowing about WS.
  onRunAppended?: (run: RunRecord) => void;
  now?: () => number;
}

export interface RunsCapture {
  onStatusline(sessionId: string, payload: StatuslinePayload): void;
  onSessionEnd(info: SessionEndInput): void;
  onJobEvent(job: JobRecord, schedule?: ScheduleRunContext): void;
}

function jobCwd(job: JobRecord): string | undefined {
  for (const step of job.steps) {
    if (step.workspace.kind === 'writable' || step.workspace.kind === 'readonly') return step.workspace.repoCwd;
  }
  return undefined;
}

function jobPrUrl(job: JobRecord): string | undefined {
  for (const step of [...job.steps].reverse()) {
    if (step.type === 'orchestrated' && step.pr?.prUrl) return step.pr.prUrl;
  }
  return undefined;
}

function jobVerdict(job: JobRecord): string {
  if (job.state === 'failed') return job.failure?.reason ?? 'Failed';
  if (job.state === 'abandoned') return 'Abandoned';
  const prUrl = jobPrUrl(job);
  return prUrl ? 'Done · PR opened' : 'Done';
}

export function createRunsCapture(deps: RunsCaptureDeps): RunsCapture {
  const { runsStore, usageLedger, onRunAppended } = deps;
  const now = deps.now ?? (() => Date.now());

  function append(input: Omit<RunRecord, 'id'>): RunRecord {
    const run = runsStore.append(input);
    onRunAppended?.(run);
    return run;
  }

  return {
    onStatusline(sessionId, payload) {
      const model = payload.model?.id ?? payload.model?.display_name;
      const costUsd = payload.cost?.total_cost_usd;
      if (!model || typeof costUsd !== 'number') return;
      usageLedger.record({ sessionId, model, costUsd, at: now() });
    },

    onSessionEnd(info) {
      // Dedupe against the store: a session can reach onSessionEnd via both an explicit
      // archive/delete and the process-exit lifecycle hook that same close() triggers.
      if (runsStore.existsByRef('sessionId', info.sessionId)) return;
      const { schedule } = info;
      append({
        kind: schedule ? 'sched' : 'sess',
        title: schedule ? `Scheduled: ${schedule.name}` : info.title,
        sub: schedule?.skill,
        cwd: info.cwd,
        verdict: info.verdict,
        startedAt: info.startedAt ?? now() - (info.durationMs ?? 0),
        durationMs: info.durationMs,
        costUsd: info.costUsd,
        refs: { sessionId: info.sessionId, scheduleId: schedule?.id },
      });
    },

    onJobEvent(job, schedule) {
      if (!TERMINAL_JOB_STATES.has(job.state)) return;
      // Dedupe against the store itself (not an in-memory Set) so a daemon restart mid-job
      // doesn't re-append on the next state-change replay once the job is already terminal.
      if (runsStore.existsByRef('jobId', job.id)) return;
      append({
        kind: schedule ? 'sched' : 'track',
        title: schedule ? `Scheduled: ${schedule.name}` : job.title,
        sub: schedule?.skill ?? job.externalRef?.issueIdentifier,
        cwd: jobCwd(job),
        verdict: jobVerdict(job),
        startedAt: job.createdAt,
        durationMs: job.updatedAt - job.createdAt,
        refs: { jobId: job.id, scheduleId: schedule?.id, prUrl: jobPrUrl(job) },
      });
    },
  };
}
