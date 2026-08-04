import type { JobRecord } from './work-types.js';
import type { LaunchState } from './launch-governor.js';

export interface JobLiveness {
  orchestrator: boolean;
  stepIds: string[];
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
  for (const s of job.steps) {
    if (s.cancelled) continue;
    const stepLive = isActive(s.sessionId);
    const editLive = s.type === 'open-pr'
      && (s.editQueue ?? []).some((e) => e.status === 'running' && isActive(e.sessionId));
    if (stepLive || editLive) stepIds.push(s.id);
  }
  return { ...job, live: { orchestrator: isActive(job.orchestratorSessionId), stepIds } };
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
