// Shared job/step "does this need the user's attention" predicates. Moved out of
// components/work/ticket-row.js so Cockpit, Tracked, and the jobs list all consume
// the same definition (D2 of the UX redesign plan).

export function stepNeedsYou(s) {
  return s.state === 'reply_pending_review' || s.state === 'spec_pending_review'
    // An indefinite meta.wait hold only clears when the user resumes; a timed soak
    // (resumeAt set) auto-resumes, so it's waiting on the clock, not on you.
    || (s.type === 'action' && s.state === 'waiting' && s.resumeAt == null)
    || (s.type === 'open-pr' && s.state === 'pr_open' && s.reviewState === 'approved' && s.ciState === 'success');
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
