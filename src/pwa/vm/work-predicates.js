// Shared job/step "does this need the user's attention" predicates. Moved out of
// components/work/ticket-row.js so Cockpit, Tracked, and the jobs list all consume
// the same definition (D2 of the UX redesign plan).

export function stepNeedsYou(s) {
  // Both step kinds park here for an explicit approval: a human_gate action before an
  // external write, an orchestrated step before the move its controller gated.
  return s.state === 'gate_pending_approval'
    // An indefinite meta.wait hold only clears when the user resumes; a timed soak
    // (resumeAt set) auto-resumes, so it's waiting on the clock, not on you. An
    // orchestrated step's `waiting` is on CI/review/dispatches, never on you.
    || (s.type === 'action' && s.state === 'waiting' && s.resumeAt == null)
    || (s.type === 'orchestrated' && s.phase === 'pr_open'
      && s.pr?.reviewState === 'approved' && s.pr?.ciState === 'success');
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
