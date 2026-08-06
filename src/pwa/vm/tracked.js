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

// An orchestrated step in its implement phase whose session has finished (its id is
// absent from live.stepIds) but no PR exists yet — the uncommitted diff is waiting for
// the user to review and push. This is the one "needs you" case state alone can't tell
// from "still coding", so it lives here (where job.live is available), not in
// the pure stepNeedsYou.
export function implementAwaitingPush(j) {
  const liveIds = liveStepIds(j);
  return (j.steps ?? []).find((s) =>
    !s.cancelled && s.type === 'orchestrated' && s.phase === 'implement'
    && !s.pr?.prUrl && s.sessionId && !liveIds.has(s.id));
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
    if (step.state === 'gate_pending_approval') {
      return {
        title: 'Approval required',
        description: step.type === 'orchestrated'
          ? (step.gate?.question || `${step.title} is holding a move that needs your OK.`)
          : `${step.title} is an external write that needs your OK before it runs.`,
        cta: { label: 'Review', action: 'review-gate', stepId: step.id },
      };
    }
    // The only other thing stepNeedsYou flags is an indefinite meta.wait hold.
    return {
      title: 'On hold',
      description: step.inputs?.reason ? String(step.inputs.reason) : `${step.title} is holding until you resume.`,
      cta: { label: 'Resume', action: 'resume-wait', stepId: step.id },
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

// ── Orchestrated steps ───────────────────────────────────────────────────
// Everything components/work/orchestrated-card.js needs to draw one controller-owned
// step, derived from the raw step snapshot alone. No DOM, no store reads.

// The controller's own phase vocabulary (actions/code/orchestrate-pr/SKILL.md is the
// authority for what a live controller reports; storage/jobs-migrate.ts only for what a
// migrated open-pr step landed on). An unrecognized phase is still shown — a controller
// may coin its own — just without a curated label.
const PHASE_LABEL = {
  spec: 'Spec',
  plan: 'Plan',
  implement: 'Implement',
  pr_open: 'PR open',
  pr_comments: 'PR comments',
  conflict: 'Conflict',
  merged: 'Merged',
  failed: 'Failed',
};

const ARTIFACT_LABEL = { memo: 'Memo', spec: 'Spec', implPlan: 'Implementation plan' };

const DISPATCH_TONE = { running: 'investigate', done: 'ok', failed: 'danger' };

function humanizeKey(k) {
  const spaced = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// An artifact key is whatever string the controller passed to submit_step_progress —
// arbitrary, not a CSS identifier. Derive a safe class token from it so the renderer
// never has to sanitize (or, worse, trust) a key it interpolates into `class="..."`.
// Artifact keys are arbitrary strings the controller supplies, so they reach the DOM as a
// class token only after normalising. Collisions have to be broken too: tracked/detail.js
// keys each <details>'s open/closed state off its className, so two keys normalising to the
// same slug would share one disclosure and toggle each other.
function slugOf(k, taken) {
  const base = String(k).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
  if (!taken) return base;
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

function phaseChipOf(s) {
  if (!s.phase) return null;
  const tone = s.state === 'failed' || s.phase === 'failed' ? 'danger'
    : s.state === 'resolved' || s.phase === 'merged' ? 'ok'
    : s.state === 'gate_pending_approval' ? 'warn'
    : '';
  return { label: PHASE_LABEL[s.phase] ?? humanizeKey(s.phase), tone };
}

export function orchestratedRows(step) {
  const s = step ?? {};
  const artifacts = s.artifacts ?? {};
  const takenSlugs = new Set();
  const artifactRows = [
    ...(s.memo ? [{ key: 'memo', slug: slugOf('memo', takenSlugs), label: ARTIFACT_LABEL.memo, body: s.memo }] : []),
    ...Object.entries(artifacts)
      .filter(([, body]) => typeof body === 'string' && body.trim())
      .map(([key, body]) => ({ key, slug: slugOf(key, takenSlugs), label: ARTIFACT_LABEL[key] ?? humanizeKey(key), body })),
  ];

  return {
    phaseChip: phaseChipOf(s),
    waitingReason: s.state === 'waiting' ? (s.waitingOn?.reason ?? 'Waiting') : null,
    dispatchRows: (s.dispatches ?? []).map((d) => ({
      id: d.id,
      action: d.action,
      brief: d.brief ?? '',
      status: d.status,
      tone: DISPATCH_TONE[d.status] ?? '',
      sessionId: d.sessionId ?? null,
      failure: d.failure ?? null,
    })),
    artifactRows,
    gate: s.state === 'gate_pending_approval'
      ? {
        draft: s.gate?.draft ?? '',
        question: s.gate?.question ?? '',
        feedback: s.gateFeedback ?? [],
      }
      : null,
    // The manual fallback for a controller whose session died mid-step. Never offered
    // once the step has settled — resolving a resolved step is a no-op that reads as a bug.
    canMarkResolved: !s.cancelled && s.state !== 'resolved' && s.state !== 'failed',
  };
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
    for (const d of s.dispatches ?? []) {
      push(d.sessionId, d.action, d.status === 'running');
    }
    const label = s.type === 'orchestrated' ? s.controller : (s.action ?? s.type);
    const running = !!s.sessionId && !s.failure && s.state !== 'resolved' && s.state !== 'failed';
    push(s.sessionId, label, running);
  }
  // A step-review runs the orchestrator while the job stays `executing`, so the
  // review gate counts as running too.
  if (job.orchestratorSessionId) {
    push(job.orchestratorSessionId, 'orchestrator', job.state === 'planning' || !!job.reviewingStepId);
  }
  return out.reverse();
}
