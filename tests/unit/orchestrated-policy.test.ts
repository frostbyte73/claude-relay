import { describe, expect, it } from 'vitest';
import {
  validateNext, briefKey, MAX_ROUNDS, MAX_CONSECUTIVE_SELF_ROUNDS, MAX_DISPATCH_ATTEMPTS,
  type ActionInfo,
} from '../../src/steps/orchestrated-policy.js';
import type { Dispatch, NextMove, OrchestratedStep } from '../../src/work/work-types.js';

const info: ActionInfo = {
  sideEffects: (a) => ({
    'code.review-diff': 'none',
    'code.implement': 'worktree-edit',
    'code.fix-ci': 'external-write',
    'write.linear-comment': 'gated-write',
  } as Record<string, ReturnType<ActionInfo['sideEffects']>>)[a],
  humanGate: (a) => a === 'write.linear-comment',
};

function step(over: Partial<OrchestratedStep> = {}): OrchestratedStep {
  return {
    id: 's1', title: 't', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'running', createdAt: 0, updatedAt: 0, ...over,
  } as OrchestratedStep;
}

function dispatch(over: Partial<Dispatch> = {}): Dispatch {
  return { id: 'd1', action: 'code.review-diff', brief: 'b', status: 'done', attempts: 1, ...over };
}

describe('validateNext', () => {
  it('allows a plain self-round', () => {
    expect(validateNext(step(), { kind: 'self-round' }, info))
      .toEqual({ kind: 'allow', move: { kind: 'self-round' } });
  });

  it('rejects any move once the step is terminal', () => {
    for (const state of ['resolved', 'failed'] as const) {
      const v = validateNext(step({ state }), { kind: 'self-round' }, info);
      expect(v.kind).toBe('reject');
    }
  });

  it('rejects when the round budget is spent', () => {
    const v = validateNext(step({ roundsSpent: MAX_ROUNDS }), { kind: 'self-round' }, info);
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/round budget/i);
  });

  it('rejects consecutive self-rounds past the cap but still allows a dispatch', () => {
    const s = step({ consecutiveSelfRounds: MAX_CONSECUTIVE_SELF_ROUNDS });
    expect(validateNext(s, { kind: 'self-round' }, info).kind).toBe('reject');
    expect(validateNext(s, { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'x' }] }, info).kind)
      .toBe('allow');
  });

  it('rejects a dispatch to an unknown action', () => {
    const v = validateNext(step(), { kind: 'dispatch', dispatches: [{ action: 'nope.nope', brief: 'x' }] }, info);
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/unknown action/i);
  });

  it('rejects re-dispatching an identical (action, brief) pair', () => {
    const prior = dispatch({ action: 'code.review-diff', brief: 'same' });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'same' }] },
      info,
    );
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/already dispatched/i);
  });

  it('allows the same action with a different brief', () => {
    const prior = dispatch({ action: 'code.review-diff', brief: 'first' });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'second' }] },
      info,
    );
    expect(v.kind).toBe('allow');
  });

  it('rejects a dispatch that has burned its attempts', () => {
    const prior = dispatch({ brief: 'same', status: 'failed', attempts: MAX_DISPATCH_ATTEMPTS });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'same' }] },
      info,
    );
    expect(v).toMatchObject({ kind: 'reject' });
  });

  it('force-gates a self-round bound to an external-write action', () => {
    const move = { kind: 'self-round', action: 'code.fix-ci' } as const;
    const v = validateNext(step(), move, info);
    expect(v).toMatchObject({ kind: 'force-gate', move });
    expect((v as { question: string }).question).toMatch(/code\.fix-ci/);
  });

  it('force-gates a dispatch to a human_gate action', () => {
    const move: NextMove = { kind: 'dispatch', dispatches: [{ action: 'write.linear-comment', brief: 'x' }] };
    expect(validateNext(step(), move, info).kind).toBe('force-gate');
  });

  it('does not gate a worktree-edit or read-only action', () => {
    expect(validateNext(step(), { kind: 'self-round', action: 'code.implement' }, info).kind).toBe('allow');
    expect(validateNext(step(), { kind: 'self-round', action: 'code.review-diff' }, info).kind).toBe('allow');
  });

  it('allows resolve and fail regardless of round budget', () => {
    const s = step({ roundsSpent: MAX_ROUNDS });
    expect(validateNext(s, { kind: 'resolve', output: 'done' }, info).kind).toBe('allow');
    expect(validateNext(s, { kind: 'fail', reason: 'nope' }, info).kind).toBe('allow');
  });
});

describe('validateNext — dispatch retries', () => {
  const same = { action: 'code.review-diff', brief: 'same' };

  it('still rejects a bare duplicate, and names retryOf in the reason', () => {
    const prior = dispatch({ id: 'd1', ...same, status: 'failed', attempts: 1 });
    const v = validateNext(step({ dispatches: [prior] }), { kind: 'dispatch', dispatches: [same] }, info);
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/retryOf/);
  });

  it('allows an identical brief when retryOf names a failed dispatch under the cap', () => {
    const prior = dispatch({ id: 'd1', ...same, status: 'failed', attempts: 1 });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }] },
      info,
    );
    expect(v.kind).toBe('allow');
  });

  it('refuses to retry a dispatch that did not fail', () => {
    const prior = dispatch({ id: 'd1', ...same, status: 'done', attempts: 1 });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }] },
      info,
    );
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/failed/i);
  });

  it('refuses once the attempt cap is reached — this is what stops a retry loop', () => {
    const prior = dispatch({ id: 'd1', ...same, status: 'failed', attempts: MAX_DISPATCH_ATTEMPTS });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }] },
      info,
    );
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/attempt/i);
  });

  it('refuses a retryOf naming an unknown dispatch', () => {
    const v = validateNext(step(), { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'nope' }] }, info);
    expect(v).toMatchObject({ kind: 'reject' });
  });

  it('refuses to retry an original that has already been retried — must name the most recent attempt', () => {
    const original = dispatch({ id: 'd1', ...same, status: 'failed', attempts: 1 });
    const retry = dispatch({ id: 'd2', ...same, retryOf: 'd1', status: 'failed', attempts: 2 });
    const v = validateNext(
      step({ dispatches: [original, retry] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }] },
      info,
    );
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/most recent attempt/i);
  });

  it('rejects two entries in the same move naming the same retryOf', () => {
    const prior = dispatch({ id: 'd1', ...same, status: 'failed', attempts: 1 });
    const v = validateNext(
      step({ dispatches: [prior] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }, { ...same, retryOf: 'd1' }] },
      info,
    );
    expect(v).toMatchObject({ kind: 'reject' });
    expect((v as { reason: string }).reason).toMatch(/most recent attempt/i);
  });

  it('a full retry chain terminates at the cap: d1 fails, retry to d2, d2 fails, retrying d2 is rejected', () => {
    const d1 = dispatch({ id: 'd1', ...same, status: 'failed', attempts: 1 });
    const retryD1 = validateNext(step({ dispatches: [d1] }), { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }] }, info);
    expect(retryD1.kind).toBe('allow');

    const d2 = dispatch({ id: 'd2', ...same, retryOf: 'd1', status: 'failed', attempts: MAX_DISPATCH_ATTEMPTS });
    const retryD2 = validateNext(
      step({ dispatches: [d1, d2] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd2' }] },
      info,
    );
    expect(retryD2).toMatchObject({ kind: 'reject' });
    expect((retryD2 as { reason: string }).reason).toMatch(/attempt/i);

    const retryD1Again = validateNext(
      step({ dispatches: [d1, d2] }),
      { kind: 'dispatch', dispatches: [{ ...same, retryOf: 'd1' }] },
      info,
    );
    expect(retryD1Again).toMatchObject({ kind: 'reject' });
    expect((retryD1Again as { reason: string }).reason).toMatch(/most recent attempt/i);
  });
});

describe('briefKey', () => {
  it('is stable and distinguishes briefs', () => {
    expect(briefKey('a', 'one')).toBe(briefKey('a', 'one'));
    expect(briefKey('a', 'one')).not.toBe(briefKey('a', 'two'));
    expect(briefKey('a', 'one')).not.toBe(briefKey('b', 'one'));
  });
});
