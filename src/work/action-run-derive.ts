import type { JobRecord, OpenPrStep, Step } from './work-types.js';
import { actionNameForStep } from './engine.js';
import type { ActionRunOutcome } from '../storage/action-runs-store.js';

// Derives per-action run boundaries by diffing two consecutive JobRecord snapshots.
//
// The engine already answers "which action is running on this step right now" —
// actionNameForStep, a pure function of step state. The attribution the run ledger
// needs was never a missing field, only a missing *sample*: evaluate it once per
// mutation instead of once at read time and the whole round history falls out. So
// this module is the only place round semantics live, and the engine stays untouched.
//
// Emission order within a unit is load-bearing: close → verdict → open. rejectSpec
// appends to specFeedback and flips state back to `speccing` in a single mutate, so
// a verdict emitted after the open would land on the wrong attempt.

export interface RunKey { jobId: string; stepId?: string }

export type RunEvent =
  | { t: 'open'; key: RunKey; action: string; round: string; sessionId?: string; at: number }
  | { t: 'close'; key: RunKey; outcome: ActionRunOutcome; at: number; failureReason?: string }
  | { t: 'verdict'; key: RunKey; round?: string; outcome: ActionRunOutcome; at: number; feedbackChars?: number };

export interface DeriveOpts {
  now: number;
  isHumanGate: (action: string) => boolean;
}

// Round in flight for a step, or null when nothing is dispatched. Flags outrank
// state for the same reason actionNameForStep checks them first: a conflict or
// ci-fix round runs on top of whatever durable state the step is parked in.
function roundOf(s: Step, opts: DeriveOpts): string | null {
  if (s.cancelled || s.failure || !s.sessionId) return null;
  if (s.type === 'open-pr') {
    if (s.conflictResolving || s.state === 'conflicting') return 'conflict';
    if (s.ciFixing) return 'ci-fix';
    if ((s.editQueue ?? []).some((e) => e.status === 'running')) return 'edit';
    switch (s.state) {
      case 'speccing': return 'spec';
      case 'planning': return 'plan';
      case 'implementing': return 'implement';
      case 'comment_pending_response':
      case 'reply_pending_review':
        return (s.iterations ?? []).some((it) => it.status === 'in_progress' && !it.postedAt)
          ? 'pr-comments'
          : null;
      default: return null;
    }
  }
  // A meta.wait hold parks in `waiting` and never binds a session, so it never
  // opens a run — a builtin hold is not a run of anything.
  if (s.state !== 'running') return null;
  if (!opts.isHumanGate(s.action)) return 'run';
  if (s.gateApproved) return 'commit';
  return (s.gateFeedback ?? []).length > 0 ? 'redraft' : 'draft';
}

// An orchestrator round is in flight while the job is parked in `planning` (initial /
// replan) or while a step-review holds the gate — a review runs on top of `executing`,
// so the state alone can't see it.
function orchestratorRound(j: JobRecord): string | null {
  if (!j.orchestratorSessionId) return null;
  if (j.state !== 'planning' && !j.reviewingStepId) return null;
  const started = [...(j.events ?? [])].reverse().find((e) => e.kind === 'orchestrator_started');
  return started?.body ?? 'initial';
}

function editJustFailed(prev: OpenPrStep, next: OpenPrStep): boolean {
  const before = new Map((prev.editQueue ?? []).map((e) => [e.id, e.status]));
  return (next.editQueue ?? []).some((e) => e.status === 'failed' && before.get(e.id) === 'running');
}

// `submitted` means a verdict is still owed — by a user gate, or by the PR itself.
// Rounds that reach a terminal state with nobody left to rule on them are scored
// here and never sit pending.
function closeOutcome(round: string, prev: Step, next: Step): ActionRunOutcome {
  switch (round) {
    case 'spec':
    case 'implement':
    case 'pr-comments':
    case 'draft':
    case 'redraft':
      return 'submitted';
    case 'ci-fix':
      return next.type === 'open-pr' && next.ciFixGaveUp ? 'gave_up' : 'accepted';
    case 'conflict':
      return next.type === 'open-pr' && next.state === 'conflict_unresolved' ? 'gave_up' : 'accepted';
    case 'edit':
      return prev.type === 'open-pr' && next.type === 'open-pr' && editJustFailed(prev, next)
        ? 'failed'
        : 'accepted';
    case 'plan':
    case 'commit':
    case 'run':
      return 'accepted';
    default:
      return 'submitted';
  }
}

function stepEvents(prev: Step | undefined, next: Step | undefined, jobId: string, job: JobRecord, prevJob: JobRecord | undefined, opts: DeriveOpts): RunEvent[] {
  const out: RunEvent[] = [];
  const key: RunKey = { jobId, stepId: (next ?? prev)!.id };
  const prevRound = prev ? roundOf(prev, opts) : null;
  const nextRound = next ? roundOf(next, opts) : null;
  const at = opts.now;

  if (prevRound && prevRound !== nextRound) {
    if (!next) {
      out.push({ t: 'close', key, outcome: 'abandoned', at });
    } else if (next.failure && !prev!.failure) {
      out.push({ t: 'close', key, outcome: 'failed', at, failureReason: next.failure.reason });
    } else if ((next.cancelled && !prev!.cancelled) || (job.state === 'abandoned' && prevJob?.state !== 'abandoned')) {
      out.push({ t: 'close', key, outcome: 'abandoned', at });
    } else {
      out.push({ t: 'close', key, outcome: closeOutcome(prevRound, prev!, next), at });
    }
  }

  if (prev && next) out.push(...verdictEvents(key, prev, next, at));

  if (nextRound && nextRound !== prevRound) {
    out.push({ t: 'open', key, action: actionNameForStep(next!), round: nextRound, sessionId: next!.sessionId, at });
  }
  return out;
}

function verdictEvents(key: RunKey, prev: Step, next: Step, at: number): RunEvent[] {
  const out: RunEvent[] = [];
  if (prev.type === 'open-pr' && next.type === 'open-pr') {
    if (prev.state === 'spec_pending_review' && next.state === 'planning') {
      out.push({ t: 'verdict', key, round: 'spec', outcome: 'accepted', at });
    }
    const specGrew = (next.specFeedback ?? []).length - (prev.specFeedback ?? []).length;
    if (specGrew > 0) {
      const note = (next.specFeedback ?? []).at(-1) ?? '';
      out.push({ t: 'verdict', key, round: 'spec', outcome: 'revised', at, feedbackChars: note.length });
    }
    if (prev.prState !== 'merged' && next.prState === 'merged') {
      out.push({ t: 'verdict', key, round: 'implement', outcome: 'merged', at });
    }
    if (prev.prState !== 'closed' && next.prState === 'closed') {
      out.push({ t: 'verdict', key, round: 'implement', outcome: 'abandoned', at });
    }
    const before = new Map((prev.iterations ?? []).map((it) => [it.id, it.status]));
    for (const it of next.iterations ?? []) {
      if (before.get(it.id) !== 'in_progress') continue;
      if (it.status === 'approved') out.push({ t: 'verdict', key, round: 'pr-comments', outcome: 'accepted', at });
      else if (it.status === 'rejected') {
        out.push({ t: 'verdict', key, round: 'pr-comments', outcome: 'revised', at, feedbackChars: (it.feedback ?? '').length });
      }
    }
    return out;
  }
  if (prev.type === 'action' && next.type === 'action') {
    const prevNotes = (prev.gateFeedback ?? []).length;
    const nextNotes = (next.gateFeedback ?? []).length;
    if (!prev.gateApproved && next.gateApproved) {
      out.push({ t: 'verdict', key, round: nextNotes > 0 ? 'redraft' : 'draft', outcome: 'accepted', at });
    }
    if (nextNotes > prevNotes) {
      const note = (next.gateFeedback ?? []).at(-1) ?? '';
      out.push({
        t: 'verdict', key, round: prevNotes === 0 ? 'draft' : 'redraft',
        outcome: 'revised', at, feedbackChars: note.length,
      });
    }
  }
  return out;
}

function orchestratorEvents(prev: JobRecord | undefined, next: JobRecord, opts: DeriveOpts): RunEvent[] {
  const out: RunEvent[] = [];
  const key: RunKey = { jobId: next.id };
  const prevRound = prev ? orchestratorRound(prev) : null;
  const nextRound = orchestratorRound(next);
  const at = opts.now;

  if (prevRound && prevRound !== nextRound) {
    const outcome: ActionRunOutcome = next.state === 'executing' ? 'accepted'
      : next.state === 'abandoned' ? 'abandoned'
      : next.state === 'failed' ? 'failed'
      : 'submitted';
    out.push({ t: 'close', key, outcome, at });
  }

  if (prev?.state === 'plan_pending_review' && next.state === 'executing') {
    out.push({ t: 'verdict', key, outcome: 'accepted', at });
  }
  const rejectedGrew = (next.plan?.iterationsRejected ?? []).length - (prev?.plan?.iterationsRejected ?? []).length;
  if (rejectedGrew > 0) {
    const note = (next.plan?.iterationsRejected ?? []).at(-1)?.feedback ?? '';
    out.push({ t: 'verdict', key, outcome: 'revised', at, feedbackChars: note.length });
  }

  if (nextRound && nextRound !== prevRound) {
    out.push({
      t: 'open', key, round: nextRound, at,
      action: next.orchestratorAction ?? 'meta.orchestrate',
      sessionId: next.orchestratorSessionId,
    });
  }
  return out;
}

export function deriveRunEvents(prev: JobRecord | undefined, next: JobRecord, opts: DeriveOpts): RunEvent[] {
  const out = orchestratorEvents(prev, next, opts);
  const prevSteps = new Map((prev?.steps ?? []).map((s) => [s.id, s]));
  for (const s of next.steps) {
    out.push(...stepEvents(prevSteps.get(s.id), s, next.id, next, prev, opts));
    prevSteps.delete(s.id);
  }
  for (const gone of prevSteps.values()) {
    out.push(...stepEvents(gone, undefined, next.id, next, prev, opts));
  }
  return out;
}
