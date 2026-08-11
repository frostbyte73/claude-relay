// Tracked-list view-model: buckets jobs by attention priority, and derives the
// single "what should the user do next" focus action for a job's right rail.

import { needsYou, stepNeedsYou, hasUnapprovedDraft, isTerminalStep } from './work-predicates.js';

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
    // A dispatch-raised draft never sets the PARENT step's `state` to
    // `gate_pending_approval` (only the dispatch's own `status` flips to
    // `awaiting_approval`) — `hasUnapprovedDraft` is what catches that case; the
    // state check alone would fall through to the meta.wait branch below and offer
    // "Resume", which resolveWaitStep flatly refuses for anything but an ActionStep.
    if (step.state === 'gate_pending_approval' || hasUnapprovedDraft(step)) {
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
// code.orchestrate-review's own phase ladder (actions/code/orchestrate-review/SKILL.md §3):
// triage, lenses, synthesis, review_pending, resolutions_checked, resolutions_pending,
// verdict_submitted, verdict_pending, watching. Merged into the same map as code.orchestrate-pr's
// — the two controllers never share a step, so there's no collision risk.
const PHASE_LABEL = {
  spec: 'Spec',
  plan: 'Plan',
  implement: 'Implement',
  pr_open: 'PR open',
  pr_comments: 'PR comments',
  conflict: 'Conflict',
  merged: 'Merged',
  failed: 'Failed',
  triage: 'Triage',
  lenses: 'Review lenses',
  synthesis: 'Synthesis',
  review_pending: 'Review pending',
  resolutions_checked: 'Resolutions checked',
  resolutions_pending: 'Resolutions pending',
  verdict_submitted: 'Verdict submitted',
  verdict_pending: 'Verdict pending',
  watching: 'Watching',
};

// code.orchestrate-review's own artifact keys (SKILL.md §3's `artifacts` row): `lenses` and
// `review` are the controller's own working notes; `postedReview`/`resolutions`/`verdict` are
// written by the bound rounds it dispatches into. "Review" alone reads as ambiguous inside a
// card whose whole subject is reviewing a PR — "Draft review" vs "Posted review" disambiguates
// the synthesized-but-unposted comment set from what actually landed on GitHub.
const ARTIFACT_LABEL = {
  memo: 'Memo',
  spec: 'Spec',
  implPlan: 'Implementation plan',
  lenses: 'Review lenses',
  review: 'Draft review',
  postedReview: 'Posted review',
  resolutions: 'Resolution check',
  verdict: 'Verdict',
};

// 'awaiting_approval' is a dispatch that raised its own write draft and is parked for the
// user — same "your move" semantics as a gate, so it gets the warn tone rather than sitting
// untoned next to running/done/failed.
const DISPATCH_TONE = { running: 'investigate', done: 'ok', failed: 'danger', awaiting_approval: 'warn' };

function humanizeKey(k) {
  const spaced = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// An artifact key is whatever string the controller passed to submit_step_progress —
// arbitrary, not a CSS identifier. Derive a safe class token from it so the renderer never
// has to sanitize (or, worse, trust) a key it interpolates into `class="..."`. Collisions
// have to be broken too: tracked/detail.js keys each <details>'s open/closed state off its
// className, so two keys normalising to the same slug would share one disclosure and toggle
// each other.
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

// "Mark resolved" is one button doing three different jobs, so it reads as an undifferentiated
// "give up" action unless the label/hint names which job applies here:
//  - a FAILED step: correcting it in place is now the first move — Edit and Cancel both accept
//    a failed step (engine.ts's stepAcceptsEdits), and an edit re-runs it automatically. Mark
//    resolved is what's left for a step whose failure isn't in its inputs at all, or whose
//    workspace is pinned to a worktree that already provisioned: it force-clears `.failure`
//    (engine.ts's markStepResolved) and unblocks the group so a replacement can be inserted.
//  - code.orchestrate-review's `until: "closed"` vigil (phase `watching`, SKILL.md row 12):
//    ending it here is the sanctioned way to close out a review the user is satisfied with,
//    not an emergency measure — same button, different meaning.
//  - anything else: the generic rescue for a step whose session died mid-run.
function markResolvedInfo(s) {
  if (s.state === 'failed') {
    return {
      label: 'Mark resolved — skip this step',
      hint: 'Retrying reuses the same inputs — edit the step instead if the inputs were wrong, and it re-runs on its own. Marking it resolved unblocks the plan so you can add a corrected step below.',
    };
  }
  if (s.phase === 'watching') {
    return {
      label: 'Mark resolved — end review',
      hint: 'Ending the watch here is expected once you\'re satisfied with the outcome, not an emergency action.',
    };
  }
  return { label: 'Mark resolved', hint: '' };
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

  const drafts = s.drafts ?? [];
  // isTerminalStep guard is defense-in-depth, not the primary line: settleOrchestratedStep
  // (engine.ts) already drops an orchestrated step's non-approved drafts on every settle
  // path (failed/resolved/cancelled), unlike an ActionStep's own drafts, which nothing
  // prunes (see step-card.js's draftsHtml, which needs this same guard for real). Kept here
  // anyway so this file doesn't silently start relying on that backend invariant holding
  // forever, and so it doesn't look like an asymmetric oversight next to draftsHtml's guard.
  const draftFor = (raisedByKind, dispatchId) => (isTerminalStep(s) ? null : drafts.find((d) =>
    !d.approvedAt && d.raisedBy?.kind === raisedByKind
    && (raisedByKind !== 'dispatch' || d.raisedBy.dispatchId === dispatchId)) ?? null);

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
      // A dispatch parked at `awaiting_approval` raised this itself — rendered inside the
      // dispatch's own row (orchestrated-card.js), never hoisted to the controller's gate.
      draft: draftFor('dispatch', d.id),
    })),
    artifactRows,
    // `s.gate` is the controller's OWN voluntary ask (a `gate` NextMove) — a distinct,
    // still-current mechanism from a write draft, and the two can share `state:
    // 'gate_pending_approval'` (submitDraft sets the same state for a `controller`-raised
    // draft). Gating this purely on `s.gate` being set, not on `state`, is what keeps a
    // controller-raised draft from rendering as a hollow, empty "gate" card here — its real
    // content (calls/summary/evidence) is `controllerDraft` below instead.
    gate: s.gate
      ? {
        draft: s.gate.draft ?? '',
        question: s.gate.question ?? '',
        feedback: s.gateFeedback ?? [],
      }
      : null,
    // The controller's own pending write draft (raisedBy: {kind:'controller'}) — distinct
    // from a dispatch's (folded into dispatchRows above) and from the voluntary `gate` above.
    controllerDraft: draftFor('controller'),
    // The manual fallback for a controller whose session died mid-step — and, since engine.ts's
    // markStepResolved explicitly clears `.failure` on the way to 'resolved', also the escape
    // for a FAILED step that Edit/Cancel can't reach once a session ever ran (see
    // markResolvedInfo above). Never offered once the step has already settled — resolving a
    // resolved step is a no-op that reads as a bug.
    canMarkResolved: !s.cancelled && s.state !== 'resolved',
    markResolved: markResolvedInfo(s),
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
