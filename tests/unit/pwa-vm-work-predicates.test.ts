import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { needsYou, stepNeedsYou, isTerminalStep, isFailureStep } from '../../src/pwa/vm/work-predicates.js';

function step(overrides = {}) {
  return { id: 's1', type: 'action', title: 'Step', state: 'running', cancelled: false, ...overrides };
}

function job(overrides = {}) {
  return { id: 'j1', title: 'Job', state: 'executing', steps: [], ...overrides };
}

describe('stepNeedsYou', () => {
  // Merging is the controller's own move (code.merge-pr) and runs unattended; only a
  // voluntary `gate` move from the controller parks it as the user's turn.
  it('false for an approved, CI-green orchestrated step with its PR open', () => {
    expect(stepNeedsYou(step({
      type: 'orchestrated', state: 'waiting', phase: 'pr_open',
      pr: { reviewState: 'approved', ciState: 'success' },
    }))).toBe(false);
  });

  it('false for an orchestrated step waiting on CI it has no verdict for', () => {
    expect(stepNeedsYou(step({ type: 'orchestrated', state: 'waiting', phase: 'pr_open' }))).toBe(false);
  });

  it('false for a plain running step', () => {
    expect(stepNeedsYou(step({ state: 'running' }))).toBe(false);
  });

  it('true for an action step parked in gate_pending_approval on a write draft', () => {
    expect(stepNeedsYou(step({ type: 'action', state: 'gate_pending_approval' }))).toBe(true);
  });

  it('true for an orchestrated step whose controller gated its move', () => {
    expect(stepNeedsYou(step({ type: 'orchestrated', state: 'gate_pending_approval' }))).toBe(true);
  });

  it('true for an indefinite meta.wait hold, false for a timed soak', () => {
    expect(stepNeedsYou(step({ type: 'action', state: 'waiting' }))).toBe(true);
    expect(stepNeedsYou(step({ type: 'action', state: 'waiting', resumeAt: 1 }))).toBe(false);
  });

  // A dispatch-raised draft leaves the PARENT step's own `state` at `waiting` (only the
  // dispatch's status flips to awaiting_approval) — state alone can't see it, so
  // stepNeedsYou has to check `drafts` directly regardless of who raised it.
  it('true for a step with an unapproved draft raised by the step itself', () => {
    expect(stepNeedsYou(step({ state: 'gate_pending_approval', drafts: [{ id: 'd1', raisedBy: { kind: 'step' } }] }))).toBe(true);
  });

  it('true for an orchestrated step with an unapproved draft raised by its controller', () => {
    expect(stepNeedsYou(step({
      type: 'orchestrated', state: 'gate_pending_approval',
      drafts: [{ id: 'd1', raisedBy: { kind: 'controller' } }],
    }))).toBe(true);
  });

  it('true for an orchestrated step with an unapproved draft raised by a dispatch, even while the parent state is still waiting', () => {
    expect(stepNeedsYou(step({
      type: 'orchestrated', state: 'waiting',
      drafts: [{ id: 'd1', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' } }],
    }))).toBe(true);
  });

  it('false when the step\'s only draft is already approved', () => {
    expect(stepNeedsYou(step({
      state: 'running', drafts: [{ id: 'd1', raisedBy: { kind: 'step' }, approvedAt: 5 }],
    }))).toBe(false);
  });
});

describe('isTerminalStep / isFailureStep', () => {
  // 'declined' (ActionStep-only) is terminal but NOT a failure — the user vetoed the
  // step's write draft; the orchestrator re-plans around it rather than treating it as
  // broken, and the UI renders it as its own neutral outcome, not an error.
  it('declined is terminal but not a failure', () => {
    expect(isTerminalStep(step({ state: 'declined' }))).toBe(true);
    expect(isFailureStep(step({ state: 'declined' }))).toBe(false);
  });

  it('resolved is terminal, a real failure is both terminal and a failure', () => {
    expect(isTerminalStep(step({ state: 'resolved' }))).toBe(true);
    expect(isTerminalStep(step({ failure: { reason: 'boom', at: 1 } }))).toBe(true);
    expect(isFailureStep(step({ failure: { reason: 'boom', at: 1 } }))).toBe(true);
  });

  it('a plain running step is neither', () => {
    expect(isTerminalStep(step({ state: 'running' }))).toBe(false);
    expect(isFailureStep(step({ state: 'running' }))).toBe(false);
  });
});

describe('needsYou', () => {
  it('true when the job itself is pending plan review', () => {
    expect(needsYou(job({ state: 'plan_pending_review', steps: [] }))).toBe(true);
  });

  it('true when any non-cancelled step needs you', () => {
    expect(needsYou(job({
      steps: [step({ state: 'running' }), step({ id: 's2', state: 'gate_pending_approval' })],
    }))).toBe(true);
  });

  it('false when the only needy step is cancelled', () => {
    expect(needsYou(job({
      steps: [step({ state: 'gate_pending_approval', cancelled: true })],
    }))).toBe(false);
  });

  it('false for an executing job with no needy steps', () => {
    expect(needsYou(job({ steps: [step({ state: 'running' })] }))).toBe(false);
  });

  it('handles a job with no steps array', () => {
    expect(needsYou({ id: 'j2', state: 'executing' })).toBe(false);
  });
});
