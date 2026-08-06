import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { needsYou, stepNeedsYou } from '../../src/pwa/vm/work-predicates.js';

function step(overrides = {}) {
  return { id: 's1', type: 'action', title: 'Step', state: 'running', cancelled: false, ...overrides };
}

function job(overrides = {}) {
  return { id: 'j1', title: 'Job', state: 'executing', steps: [], ...overrides };
}

describe('stepNeedsYou', () => {
  // Merging is the controller's own move (code.merge-pr), which the policy force-gates
  // into gate_pending_approval — that gate is the user's turn, not the window before it.
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

  it('true for a human_gate action parked in gate_pending_approval', () => {
    expect(stepNeedsYou(step({ type: 'action', state: 'gate_pending_approval' }))).toBe(true);
  });

  it('true for an orchestrated step whose controller gated its move', () => {
    expect(stepNeedsYou(step({ type: 'orchestrated', state: 'gate_pending_approval' }))).toBe(true);
  });

  it('true for an indefinite meta.wait hold, false for a timed soak', () => {
    expect(stepNeedsYou(step({ type: 'action', state: 'waiting' }))).toBe(true);
    expect(stepNeedsYou(step({ type: 'action', state: 'waiting', resumeAt: 1 }))).toBe(false);
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
