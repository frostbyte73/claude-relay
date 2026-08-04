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
  it('true for reply_pending_review', () => {
    expect(stepNeedsYou(step({ state: 'reply_pending_review' }))).toBe(true);
  });

  it('false for comment_pending_response (Outpost triages, not the user)', () => {
    expect(stepNeedsYou(step({ state: 'comment_pending_response' }))).toBe(false);
  });

  it('true for an approved, CI-green open PR step', () => {
    expect(stepNeedsYou(step({
      type: 'open-pr', state: 'pr_open', reviewState: 'approved', ciState: 'success',
    }))).toBe(true);
  });

  it('false when reviewState is approved but CI is not green', () => {
    expect(stepNeedsYou(step({
      type: 'open-pr', state: 'pr_open', reviewState: 'approved', ciState: 'pending',
    }))).toBe(false);
  });

  it('false when not an open-pr step even with matching state fields', () => {
    expect(stepNeedsYou(step({
      type: 'action', state: 'pr_open', reviewState: 'approved', ciState: 'success',
    }))).toBe(false);
  });

  it('false for a plain running step', () => {
    expect(stepNeedsYou(step({ state: 'running' }))).toBe(false);
  });

  it('true for a human_gate action parked in gate_pending_approval', () => {
    expect(stepNeedsYou(step({ type: 'action', state: 'gate_pending_approval' }))).toBe(true);
  });
});

describe('needsYou', () => {
  it('true when the job itself is pending plan review', () => {
    expect(needsYou(job({ state: 'plan_pending_review', steps: [] }))).toBe(true);
  });

  it('true when any non-cancelled step needs you', () => {
    expect(needsYou(job({
      steps: [step({ state: 'running' }), step({ id: 's2', state: 'reply_pending_review' })],
    }))).toBe(true);
  });

  it('false when the only needy step is cancelled', () => {
    expect(needsYou(job({
      steps: [step({ state: 'reply_pending_review', cancelled: true })],
    }))).toBe(false);
  });

  it('false for an executing job with no needy steps', () => {
    expect(needsYou(job({ steps: [step({ state: 'running' })] }))).toBe(false);
  });

  it('handles a job with no steps array', () => {
    expect(needsYou({ id: 'j2', state: 'executing' })).toBe(false);
  });
});
