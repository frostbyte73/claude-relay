// Tracked-list view-model: buckets jobs by attention priority, and derives the
// single "what should the user do next" focus action for a job's right rail.

import { needsYou, stepNeedsYou } from './work-predicates.js';

const NO_LIVE = { orchestrator: false, stepIds: [] };

function liveOf(j) { return j.live ?? NO_LIVE; }
function liveStepIds(j) { return new Set(liveOf(j).stepIds); }

function isBacklog(j) {
  return j.state === 'planning' && !j.orchestratorSessionId && (j.steps ?? []).length === 0;
}

function hasLiveSession(j) {
  const l = liveOf(j);
  return l.orchestrator || l.stepIds.length > 0;
}

// An open-pr step whose implement session has finished (its id is absent from
// live.stepIds) but no PR exists yet — the uncommitted diff is waiting for the
// user to review and push. This is the one "needs you" case state alone can't tell
// from "still coding", so it lives here (where job.live is available), not in
// the pure stepNeedsYou.
export function implementAwaitingPush(j) {
  const liveIds = liveStepIds(j);
  return (j.steps ?? []).find((s) =>
    !s.cancelled && s.type === 'open-pr' && s.state === 'implementing'
    && s.sessionId && !liveIds.has(s.id));
}

export function trackedGroups(jobs = []) {
  const running = [], needsYouJobs = [], waiting = [], backlog = [], done = [];
  for (const j of jobs) {
    if (j.state === 'done' || j.state === 'abandoned') { done.push(j); continue; }
    // A failed job is terminal but actionable (Retry) — the ball is in the user's court.
    if (j.state === 'failed') { needsYouJobs.push(j); continue; }
    if (isBacklog(j)) { backlog.push(j); continue; }
    // Running wins over needs-you: a job leaves Running only once its sessions complete.
    if (hasLiveSession(j)) { running.push(j); continue; }
    if (needsYou(j) || implementAwaitingPush(j)) { needsYouJobs.push(j); continue; }
    waiting.push(j);
  }
  return { running, needsYou: needsYouJobs, waiting, backlog, done };
}

function waitingStep(job) {
  return (job.steps ?? []).find((s) => !s.cancelled && stepNeedsYou(s));
}

function liveStep(job) {
  const liveIds = liveStepIds(job);
  return (job.steps ?? []).find((s) => !s.cancelled && liveIds.has(s.id));
}

function failedStep(job) {
  return (job.steps ?? []).find((s) => !s.cancelled && s.failure);
}

export function focusAction(job) {
  if (job.state === 'plan_pending_review') {
    return {
      title: 'Review the plan',
      description: `${(job.steps ?? []).length || 'The'} steps are proposed and waiting for your approval.`,
      cta: { label: 'Review plan', action: 'review-plan' },
    };
  }

  const step = waitingStep(job);
  if (step) {
    if (step.state === 'spec_pending_review') {
      return {
        title: 'Spec ready for review',
        description: `${step.title} has a spec waiting for your review.`,
        cta: { label: 'Review spec', action: 'review-spec', stepId: step.id },
      };
    }
    if (step.state === 'reply_pending_review') {
      return {
        title: 'Reply drafts ready',
        description: `${step.title} has drafted responses waiting for your review.`,
        cta: { label: 'Review replies', action: 'review-replies', stepId: step.id },
      };
    }
    if (step.type === 'action' && step.state === 'gate_pending_approval') {
      return {
        title: 'Approval required',
        description: `${step.title} is an external write that needs your OK before it runs.`,
        cta: { label: 'Review', action: 'review-gate', stepId: step.id },
      };
    }
    if (step.type === 'action' && step.state === 'waiting') {
      return {
        title: 'On hold',
        description: step.inputs?.reason ? String(step.inputs.reason) : `${step.title} is holding until you resume.`,
        cta: { label: 'Resume', action: 'resume-wait', stepId: step.id },
      };
    }
    return {
      title: 'Ready to merge',
      description: `${step.title} is approved and CI is green.`,
      cta: { label: 'Review diff', action: 'review-diff', stepId: step.id },
    };
  }

  const awaiting = implementAwaitingPush(job);
  if (awaiting) {
    return {
      title: 'Review the diff',
      description: `${awaiting.title} finished — review the changes and push.`,
      cta: { label: 'Review diff', action: 'review-diff', stepId: awaiting.id },
    };
  }

  const failed = failedStep(job);
  if (job.state === 'failed' || failed) {
    return {
      title: 'Job failed',
      description: failed?.failure?.reason ?? job.description ?? 'Something went wrong.',
      cta: { label: 'Retry', action: 'retry', stepId: failed?.id },
    };
  }

  const running = liveStep(job);
  if (running) {
    return {
      title: 'In progress',
      description: `${running.title} is running.`,
      cta: { label: 'Watch', action: 'watch', stepId: running.id, sessionId: running.sessionId },
    };
  }

  if (job.state === 'done') {
    return { title: 'Done', description: 'All steps resolved.', cta: { label: 'View', action: 'none' } };
  }

  if (job.state === 'abandoned') {
    return { title: 'Abandoned', description: 'This job was abandoned.', cta: { label: 'View', action: 'none' } };
  }

  return { title: 'Waiting', description: 'Waiting on CI, review, or the orchestrator.', cta: { label: 'View', action: 'none' } };
}

// ── Token-launch queue status ────────────────────────────────────────────
// Pure derivation from a job's server-attached `launchStatus` (routes/jobs.ts's
// serializeJob → engine.launchStatusFor). No DOM, no fetch — callers pass the
// raw job/step LaunchState in.

export function launchBadge(status) {
  if (!status || status.state === 'idle') return null;
  if (status.state === 'running') return { label: 'Running', kind: 'running' };
  return { label: `Queued — ${status.reason}`, kind: 'queued' };
}

export function jobLaunchBadge(job) {
  return launchBadge(job.launchStatus?.job);
}

export function stepLaunchBadge(job, stepId) {
  return launchBadge(job.launchStatus?.steps?.[stepId]);
}

export function isHighPriority(job) {
  return !!job.highPriority;
}

// "Sessions on this job" for the focus rail — every session id the job has ever
// spawned (orchestrator, per-step, per-thread edit), deduped, most-recent-looking
// first. Purely derived from job state; no fetch.
export function sessionsOnJob(job) {
  const out = [];
  const seen = new Set();
  const push = (sessionId, label, running) => {
    if (!sessionId || seen.has(sessionId)) return;
    seen.add(sessionId);
    out.push({ sessionId, label, running });
  };
  for (const s of job.steps ?? []) {
    if (s.cancelled) continue;
    for (const e of s.editQueue ?? []) {
      push(e.sessionId, 'code.fix-pr-comment', e.status === 'running');
    }
    const label = s.type === 'open-pr' ? 'code.implement' : (s.action ?? s.type);
    const running = !!s.sessionId && !s.failure && s.state !== 'resolved' && s.state !== 'merged';
    push(s.sessionId, label, running);
  }
  if (job.orchestratorSessionId) push(job.orchestratorSessionId, 'orchestrator', job.state === 'planning');
  return out.reverse();
}
