// Cockpit view-model: derives the home surface's auto-resolving inbox — the
// decisions parked on the user, the things that broke, and a short tail of what
// resolved on its own. Zero DOM.
//
// Every item is open because a predicate over live state holds and disappears when
// it stops holding, so nothing here is persisted and nothing is ever "marked read".
// That is why the surface can be a pure derivation over snapshots the client
// already loads.

import { stepNeedsYou, hasUnapprovedDraft, isTerminalJob } from './work-predicates.js';
import { implementAwaitingPush } from './tracked.js';

// stepNeedsYou flags three shapes: a step parked on an explicit voluntary gate, a step (or
// one of its dispatches) holding an unapproved write draft, and an indefinite meta.wait
// hold. All three are hard stops the user alone can clear. `state === 'gate_pending_approval'`
// alone would miss a dispatch-raised draft — see hasUnapprovedDraft's own doc comment — so
// it's checked explicitly rather than relying on state.
export function stepWaitPill(s) {
  if (s.state === 'gate_pending_approval' || hasUnapprovedDraft(s)) {
    return { label: s.type === 'orchestrated' ? 'Approve move' : 'Approve write', variant: 'gate' };
  }
  return { label: 'On hold', variant: 'gate' };
}

function jobRef(j) {
  return j.externalRef?.issueIdentifier ?? null;
}

function jobTitle(j) {
  return j.title ?? '(untitled job)';
}

function approvalItem(a) {
  return {
    key: `approval:${a.approvalId}`,
    kind: 'approval',
    tone: 'hot',
    title: a.sessionTitle || a.toolName || 'Approval needed',
    ref: null,
    detail: a.toolName ?? 'tool',
    time: a.enqueuedAt ?? 0,
    open: { surface: 'sessions', id: a.sessionId },
  };
}

function planReviewItem(j) {
  return {
    key: `plan:${j.id}`,
    kind: 'plan-review',
    tone: 'hot',
    title: jobTitle(j),
    ref: jobRef(j),
    detail: 'Plan review',
    time: j.updatedAt ?? 0,
    open: { surface: 'tracked', id: j.id },
  };
}

function stepGateItems(j) {
  return (j.steps ?? [])
    .filter((s) => !s.cancelled && stepNeedsYou(s))
    .map((s) => ({
      key: `gate:${j.id}:${s.id}`,
      kind: 'step-gate',
      tone: 'hot',
      title: jobTitle(j),
      ref: jobRef(j),
      detail: stepWaitPill(s).label,
      time: s.updatedAt ?? j.updatedAt ?? 0,
      open: { surface: 'tracked', id: j.id },
    }));
}

// The Library surface's registry key is 'skills', not 'library' (shell/surfaces.js).
// An unnamed edit is the new-action flow before the skill has picked a name, which that
// surface addresses as `new:<sessionId>` rather than by action name.
function proposalItem(e) {
  const named = !!e.actionName;
  return {
    key: `proposal:${named ? e.actionName : e.sessionId}`,
    kind: 'action-proposal',
    tone: 'hot',
    title: named ? e.actionName : (e.proposal.summary ?? 'New action'),
    ref: null,
    detail: e.author === 'improver'
      ? 'meta.improve-actions proposed a revision'
      : 'Proposal ready for review',
    time: e.proposal.postedAt ?? 0,
    open: { surface: 'skills', id: named ? e.actionName : `new:${e.sessionId}` },
  };
}

// A builder-session draft is addressed as `__new__:sess:<sessionId>` (schedules/draft.js) —
// a bare sessionId selects nothing.
function scheduleProposalItem(sessionId, draft) {
  return {
    key: `sched-proposal:${sessionId}`,
    kind: 'schedule-proposal',
    tone: 'hot',
    title: draft.name || 'New schedule',
    ref: null,
    detail: 'Schedule ready to save',
    time: draft.postedAt ?? 0,
    open: { surface: 'schedules', id: `__new__:sess:${sessionId}` },
  };
}

function awaitingPushItem(j, step) {
  return {
    key: `push:${j.id}:${step.id}`,
    kind: 'awaiting-push',
    tone: 'hot',
    title: jobTitle(j),
    ref: jobRef(j),
    detail: 'Review the diff and push',
    time: step.updatedAt ?? j.updatedAt ?? 0,
    open: { surface: 'tracked', id: j.id },
  };
}

function newestFirst(items) {
  return items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

const FAIL_VERDICT = /fail|error/i;

function jobFailedItem(j) {
  return {
    key: `job-failed:${j.id}`,
    kind: 'job-failed',
    tone: 'warn',
    title: jobTitle(j),
    ref: jobRef(j),
    detail: 'Job failed',
    time: j.updatedAt ?? 0,
    open: { surface: 'tracked', id: j.id },
  };
}

function stepFailedItems(j) {
  const liveIds = new Set(j.live?.stepIds ?? []);
  return (j.steps ?? [])
    .filter((s) => !s.cancelled && s.failure && !liveIds.has(s.id))
    .map((s) => ({
      key: `step-failed:${j.id}:${s.id}`,
      kind: 'step-failed',
      tone: 'warn',
      title: jobTitle(j),
      ref: jobRef(j),
      detail: String(s.failure),
      time: s.updatedAt ?? j.updatedAt ?? 0,
      open: { surface: 'tracked', id: j.id },
    }));
}

function newestSchedRunByScheduleId(runs) {
  const newest = new Map();
  for (const r of runs) {
    const id = r.kind === 'sched' ? r.refs?.scheduleId : undefined;
    if (!id) continue;
    const seen = newest.get(id);
    if (!seen || (r.startedAt ?? 0) > (seen.startedAt ?? 0)) newest.set(id, r);
  }
  return newest;
}

// One item per schedule, from its most recent run only — an older failure that a later
// run already cleared is not something the user still needs.
function routineFailedItems(runs) {
  const items = [];
  for (const [id, r] of newestSchedRunByScheduleId(runs)) {
    if (!FAIL_VERDICT.test(String(r.verdict ?? ''))) continue;
    items.push({
      key: `routine-failed:${id}`,
      kind: 'routine-failed',
      tone: 'warn',
      title: r.title ?? '(schedule)',
      ref: null,
      detail: String(r.verdict),
      time: (r.startedAt ?? 0) + (r.durationMs ?? 0),
      open: { surface: 'schedules', id },
    });
  }
  return items;
}

function brokenItems({ jobs, runs }) {
  return newestFirst([
    ...jobs.filter((j) => j.state === 'failed').map(jobFailedItem),
    // isTerminalJob covers 'failed', so a failed job reports itself once and its steps
    // never restate the same problem.
    ...jobs.filter((j) => !isTerminalJob(j)).flatMap(stepFailedItems),
    ...routineFailedItems(runs),
  ]);
}

function decideItems({ pendingApprovals, jobs, actionEdits, scheduleDrafts }) {
  const live = jobs.filter((j) => !isTerminalJob(j));
  const pushes = [];
  for (const j of live) {
    const step = implementAwaitingPush(j);
    if (step) pushes.push(awaitingPushItem(j, step));
  }
  return newestFirst([
    ...pendingApprovals.map(approvalItem),
    ...live.filter((j) => j.state === 'plan_pending_review').map(planReviewItem),
    ...live.flatMap(stepGateItems),
    ...actionEdits.filter((e) => e.proposal).map(proposalItem),
    ...[...scheduleDrafts.entries()].map(([sessionId, d]) => scheduleProposalItem(sessionId, d)),
    ...pushes,
  ]);
}

const CLEARED_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLEARED_CAP = 12;

// Resolution kinds from JobEventKind (work-types.ts) — the subset that means something
// left the user's plate. `step_failed` and `failed` are excluded: those are still open,
// and brokenItems reports them.
const CLEARED_EVENT_LABEL = {
  plan_approved: 'plan approved',
  plan_rejected: 'plan rejected',
  step_resolved: 'step resolved',
  step_retried: 'step retried',
  step_merged: 'step merged',
  abandoned: 'abandoned',
};

function clearedEventItems(jobs, since) {
  const items = [];
  for (const j of jobs) {
    for (const e of j.events ?? []) {
      const label = CLEARED_EVENT_LABEL[e.kind];
      if (!label || (e.at ?? 0) < since) continue;
      items.push({
        key: `cleared:${j.id}:${e.id}`,
        kind: 'cleared-event',
        tone: 'ok',
        title: jobTitle(j),
        ref: jobRef(j),
        detail: label,
        time: e.at ?? 0,
        open: { surface: 'tracked', id: j.id },
      });
    }
  }
  return items;
}

function clearedRunItems(runs, since) {
  const items = [];
  for (const r of newestSchedRunByScheduleId(runs).values()) {
    if (FAIL_VERDICT.test(String(r.verdict ?? ''))) continue;
    const endedAt = (r.startedAt ?? 0) + (r.durationMs ?? 0);
    if (endedAt < since) continue;
    items.push({
      key: `cleared:run:${r.id}`,
      kind: 'cleared-run',
      tone: 'ok',
      title: r.title ?? '(run)',
      ref: null,
      detail: 'succeeded',
      time: endedAt,
      open: { surface: 'runs', id: r.id },
      // openRunDetail wants the whole record, not an id — carried alongside `open` so
      // `open` stays a uniform {surface, id} across every item kind.
      raw: r,
    });
  }
  return items;
}

function clearedItems({ jobs, runs, now }) {
  const since = now - CLEARED_WINDOW_MS;
  return newestFirst([
    ...clearedEventItems(jobs, since),
    ...clearedRunItems(runs, since),
  ]).slice(0, CLEARED_CAP);
}

export function cockpitInbox({
  pendingApprovals = [],
  jobs = [],
  actionEdits = [],
  scheduleDrafts = new Map(),
  runs = [],
  now = Date.now(),
} = {}) {
  return {
    decide: decideItems({ pendingApprovals, jobs, actionEdits, scheduleDrafts }),
    broken: brokenItems({ jobs, runs }),
    cleared: clearedItems({ jobs, runs, now }),
  };
}
