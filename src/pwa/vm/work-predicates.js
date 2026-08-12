// Shared job/step "does this need the user's attention" predicates. Moved out of
// components/work/ticket-row.js so Cockpit, Tracked, and the jobs list all consume
// the same definition (D2 of the UX redesign plan).

// 'declined' (ActionStep-only, work-types.ts) is terminal but NOT a failure — the user
// vetoed the step's write draft, and the job orchestrator re-plans around it rather than
// treating the step as broken. Mirrors isTerminal() in write-draft-runner.ts so the client
// and server agree on what "this step is done" means — used by step-card.js's Resolve-
// fallback guard, which would otherwise offer a spurious "Resolve" on an already-settled
// declined step, and by stepNeedsYou/hasUnapprovedDraft below.
export function isTerminalStep(s) {
  return !!s.failure || !!s.cancelled || s.state === 'resolved'
    || (s.type === 'action' && s.state === 'declined');
}

export function isFailureStep(s) {
  return !!s.failure;
}

// A dispatch-raised write draft parks ONLY the dispatch's own `status` at
// `awaiting_approval` — the parent orchestrated step's top-level `state` stays `waiting`
// (submitDraft in write-draft-runner.ts only flips `state` to `gate_pending_approval` for a
// `step`/`controller` raiser, never for `dispatch`). So `stepNeedsYou` can't infer this from
// `state` alone; it has to look at `drafts` directly, whoever raised it.
//
// Guarded by isTerminalStep: an ActionStep's `.failure` and `state` can disagree.
// `onStepFailed` (engine.ts) deliberately leaves an ActionStep's `state` untouched when it
// sets `.failure` ("action steps reach failure only through `.failure`" — only orchestrated
// steps get `state` forced to `'failed'`), and nothing prunes an ActionStep's `drafts` on
// failure the way settleOrchestratedStep does for a controller-owned step. So a draft raised
// before a later provisioning failure can stay `state: 'gate_pending_approval'` with an
// unapproved draft forever, on a step that's actually dead. The server's own `isTerminal()`
// guard in write-draft-runner.ts refuses accept/revise/deny against exactly this — mirroring
// it here (and in stepNeedsYou below) is what keeps the client from inviting a decision that
// will always answer 409, and from stealing the focus card from "Job failed / Retry".
// Exported so tracked.js's `focusAction` and cockpit.js's `stepWaitPill` can tell an actual
// pending-draft approval apart from the other things `stepNeedsYou` flags, without
// re-deriving the same check.
export function hasUnapprovedDraft(s) {
  return !isTerminalStep(s) && (s.drafts ?? []).some((d) => !d.approvedAt);
}

export function stepNeedsYou(s) {
  if (isTerminalStep(s)) return false;
  // Both step kinds park here for an explicit approval: a human_gate action before an
  // external write, an orchestrated step before the move its controller voluntarily gated.
  // A green, approved PR is deliberately NOT listed here. Merging is the controller's own
  // move (code.merge-pr) and runs unattended unless the controller itself asks a question
  // via a `gate` move — flagging the window before that would put the job in "Needs you"
  // with nothing on the card to act on.
  return s.state === 'gate_pending_approval'
    || hasUnapprovedDraft(s)
    // An indefinite meta.wait hold only clears when the user resumes; a timed soak
    // (resumeAt set) auto-resumes, so it's waiting on the clock, not on you. An
    // orchestrated step's `waiting` is on CI/review/dispatches, never on you.
    || (s.type === 'action' && s.state === 'waiting' && s.resumeAt == null);
}

// Has any step actually run? Mirrors the `jobInProgress` check in engine.ts — a session was
// spawned, or the step reached a terminal state on its own merits.
export function planHasRun(j) {
  return (j.steps ?? []).some((s) => !!s.sessionId || isTerminalStep(s));
}

// Whether the job's plan should render as the live timeline rather than the compact review
// index. Job state alone got this wrong: a replan flips an executing job back through
// `planning` → `plan_pending_review`, which hid the timeline — and with it every PR block,
// output and session of the steps that already ran — for the whole amendment cycle, exactly
// when the user needs to see what's already done to judge the amendment. Shared by
// tracked/detail.js (which builds the timeline) and plan-section.js (which lays it out) so the
// two can't disagree about whether one exists.
export function planIsLive(j) {
  return planHasRun(j) || (j.state !== 'planning' && j.state !== 'plan_pending_review');
}

// abandonJob flips job state without rewriting step states, so a terminal job
// can retain steps that still satisfy stepNeedsYou — guard here so dead jobs
// never count as waiting on the user.
export function isTerminalJob(j) {
  return j.state === 'done' || j.state === 'failed' || j.state === 'abandoned';
}

export function needsYou(j) {
  if (isTerminalJob(j)) return false;
  if (j.state === 'plan_pending_review') return true;
  return (j.steps ?? []).some((s) => !s.cancelled && stepNeedsYou(s));
}
