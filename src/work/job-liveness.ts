import type { JobRecord } from './work-types.js';
import type { LaunchState } from './launch-governor.js';

export interface JobLiveness {
  orchestrator: boolean;
  stepIds: string[];
  // Every session on this job whose subprocess is alive right now — the orchestrator's, each
  // step's own, and each dispatch child's. `stepIds` deliberately folds a running dispatch
  // INTO its parent step (a controller that has fanned out isn't idle work), which makes it
  // the wrong signal for "is THIS session streaming". The inline feed needs that per-session
  // answer to choose between a transcript tail and a status chip, and can't derive it
  // client-side: the sessions store's `runState` is forced to 'foreground' by the act of
  // mounting the feed at all (recomputeRunState in state/sessions.js).
  sessionIds: string[];
}

export interface JobLaunchStatus {
  job: LaunchState;
  steps: Record<string, LaunchState>;
}

// The job shape sent to the PWA: the persisted record plus derived, never-persisted
// `live` (which sessions currently have a live subprocess) and `launchStatus` (the
// token-launch-queue governor's running/queued/idle view) snapshots.
export type JobWithLiveness = JobRecord & { live: JobLiveness; launchStatus: JobLaunchStatus };

export function withLiveness(
  job: JobRecord,
  isActive: (sessionId?: string) => boolean,
): JobRecord & { live: JobLiveness } {
  const stepIds: string[] = [];
  const alive = new Set<string>();
  const note = (sessionId?: string) => { if (sessionId && isActive(sessionId)) alive.add(sessionId); };
  note(job.orchestratorSessionId);
  for (const s of job.steps) {
    if (s.cancelled) continue;
    note(s.sessionId);
    // A dispatch child's session is the step's work too — without it, a controller that
    // has fanned out and gone quiet reads as idle for the whole fan-out.
    const childLive = s.type === 'orchestrated'
      && s.dispatches.some((d) => d.status === 'running' && isActive(d.sessionId));
    if (s.type === 'orchestrated') for (const d of s.dispatches) note(d.sessionId);
    if (isActive(s.sessionId) || childLive) stepIds.push(s.id);
  }
  return {
    ...job,
    live: {
      orchestrator: isActive(job.orchestratorSessionId),
      stepIds,
      sessionIds: [...alive],
    },
  };
}

// Shared by every place a JobRecord crosses the wire (GET /api/work/jobs[/:id] and the
// WS work_job_changed broadcast) so liveness + launch status can't drift between them.
export function serializeJob(
  job: JobRecord,
  isActive: (sessionId?: string) => boolean,
  launchStatusFor: (job: JobRecord) => JobLaunchStatus,
): JobWithLiveness {
  return { ...withLiveness(job, isActive), launchStatus: launchStatusFor(job) };
}
