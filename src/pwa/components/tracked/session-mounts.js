// Generalized inline-session reconciler for the Tracked drill-in (both
// layouts — mobile mounts the same renderTrackedDetail). The timeline can
// show session mounts nested at any depth (a step's own session, or a
// thread's fix-pr-comment edit session inside an inline PR block) — so this
// reconciler keys purely by sessionId across the whole rendered tree and
// re-derives "which step does this belong to" (for terminal-chip rendering)
// from the job on every sync. Each sessionId must appear at most once in the
// rendered tree, or mounts churn every repaint.

import { mountInlineSession } from '../work/inline-session.js';

const mountsByJob = new Map();

const ORCHESTRATOR_START_KINDS = new Set(['orchestrator_started', 'orchestrator_reopened']);
const ORCHESTRATOR_END_KINDS = new Set(['plan_posted', 'orchestrator_reviewed']);
const STEP_START_KINDS = new Set(['step_started']);
const STEP_END_KINDS = new Set(['step_resolved', 'step_merged', 'step_failed']);

// Bounds of the most recent completed run of some unit (the orchestrator, or one
// step) in the job timeline: the last end-event, then the last start-event at or
// before it. `stepId` scopes to a single step's timeline (null = the whole job's,
// used for the orchestrator). Returns {0,0} if no run has completed yet.
function runBounds(events, { startKinds, endKinds, stepId }) {
  const relevant = stepId == null ? events : events.filter((e) => e.stepId === stepId);
  let end = 0;
  for (let i = relevant.length - 1; i >= 0; i -= 1) {
    if (endKinds.has(relevant[i].kind)) { end = relevant[i].at; break; }
  }
  if (!end) return { start: 0, end: 0 };
  let start = end;
  for (let i = relevant.length - 1; i >= 0; i -= 1) {
    if (relevant[i].at <= end && startKinds.has(relevant[i].kind)) { start = relevant[i].at; break; }
  }
  return { start, end };
}

// The orchestrator has no Step record, but the inline-session terminal chip is
// driven off a step-shaped object. Once the orchestrator run has concluded and is
// no longer running (job left `planning`), synthesize a resolved step so its
// mount shows "✓ Finished in …" exactly like a step session does. Bounds come
// from the latest orchestrator run in the job timeline: the most recent
// orchestrator_started/orchestrator_reopened → terminal-event pair, where the
// terminal event is plan_posted (initial plan or a replan) or orchestrator_reviewed
// (a step-review session that called submit_continue, which has no plan_posted).
// While `planning` — or while a step-review holds the gate, which runs on top of
// `executing` — the orchestrator is still live: return null so the mount keeps
// showing the streaming transcript tail.
export function orchestratorStepShim(job) {
  if (job.state === 'planning' || job.reviewingStepId) return null;
  const { start, end } = runBounds(job.events ?? [], {
    startKinds: ORCHESTRATOR_START_KINDS, endKinds: ORCHESTRATOR_END_KINDS, stepId: null,
  });
  if (!end) return null;
  return { state: 'resolved', events: [{ kind: 'spawned', at: start }, { kind: 'resolved', at: end }] };
}

// Legacy fallback for job records written before the engine wrote step.events:
// synthesize the spawned+terminal pair the chip needs from the JOB timeline
// (step_started → step_resolved/step_merged/step_failed). Without it those steps
// fall back to createdAt→updatedAt, and a later plan reconcile bumps every
// surviving step's updatedAt to the same instant, so all of them read one bogus
// multi-day duration.
export function withStepTiming(job, step) {
  if (step.events && step.events.length) return step;
  const { start, end } = runBounds(job.events ?? [], {
    startKinds: STEP_START_KINDS, endKinds: STEP_END_KINDS, stepId: step.id,
  });
  const events = [];
  if (start) events.push({ kind: 'spawned', at: start });
  if (end) {
    const kind = step.failure ? 'failed' : 'resolved';
    events.push({ kind, at: end });
  }
  return events.length ? { ...step, events } : step;
}

function stepForSession(job, sessionId) {
  for (const s of job.steps ?? []) {
    if (s.sessionId === sessionId) return withStepTiming(job, s);
  }
  if (job.orchestratorSessionId === sessionId) return orchestratorStepShim(job);
  return null; // edit-queue sessions render as bare tails — no step chrome to attach
}

export function syncInlineMounts(root, job) {
  const existing = mountsByJob.get(job.id) ?? new Map();
  const seen = new Set();
  // Per-session liveness, re-read on every sync. A job serialized without `live` at all
  // (nothing does today, but the field is derived rather than persisted) falls back to
  // "everything is live", which is the pre-existing behaviour: show the transcript tail.
  const liveIds = job.live ? new Set(job.live.sessionIds ?? []) : null;
  const isLive = (id) => (liveIds ? liveIds.has(id) : true);

  root.querySelectorAll('[data-session-id]').forEach((el) => {
    const sessionId = el.getAttribute('data-session-id');
    if (!sessionId) return;
    seen.add(sessionId);
    const step = stepForSession(job, sessionId);
    const live = isLive(sessionId);
    const prior = existing.get(sessionId);
    if (prior && prior.el === el) {
      prior.handle.updateStep?.(step, live);
      return;
    }
    if (prior) prior.handle.unmount();
    const handle = mountInlineSession(el, sessionId, { jobId: job.id, step, live });
    existing.set(sessionId, { el, handle });
  });

  for (const [sessionId, entry] of Array.from(existing.entries())) {
    if (!seen.has(sessionId)) {
      entry.handle.unmount();
      existing.delete(sessionId);
    }
  }
  if (existing.size === 0) mountsByJob.delete(job.id);
  else mountsByJob.set(job.id, existing);
}

export function teardownInlineMounts(jobId) {
  const map = mountsByJob.get(jobId);
  if (!map) return;
  for (const entry of map.values()) entry.handle.unmount();
  mountsByJob.delete(jobId);
}

export function teardownAllExcept(jobId) {
  for (const otherId of Array.from(mountsByJob.keys())) {
    if (otherId !== jobId) teardownInlineMounts(otherId);
  }
}
