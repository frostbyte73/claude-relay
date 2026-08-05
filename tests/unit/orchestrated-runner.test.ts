import { describe, expect, it, vi } from 'vitest';
import {
  applyMove, deliverInbox, pushInbox, resolveGate, type OrchestratedHost,
} from '../../src/work/orchestrated-runner.js';
import { MAX_CONSECUTIVE_SELF_ROUNDS } from '../../src/steps/orchestrated-policy.js';
import type { InboxItem, OrchestratedStep } from '../../src/work/work-types.js';

function step(over: Partial<OrchestratedStep> = {}): OrchestratedStep {
  return {
    id: 's1', title: 't', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'running', createdAt: 0, updatedAt: 0, sessionId: 'sess1', ...over,
  } as OrchestratedStep;
}

function host(initial: OrchestratedStep, working = false) {
  let cur = initial;
  let ids = 0;
  const h: OrchestratedHost = {
    getStep: () => cur,
    mutateStep: (_j, _s, fn) => { cur = fn(cur); },
    sessionWorking: () => working,
    resumeController: vi.fn(),
    spawnDispatch: vi.fn(),
    resolveStep: vi.fn(),
    failStep: vi.fn(),
    actionInfo: {
      sideEffects: (a) => ({
        'code.implement': 'worktree-edit', 'code.fix-ci': 'external-write',
        'code.review-diff': 'none',
      } as Record<string, 'none' | 'worktree-edit' | 'external-write'>)[a],
      humanGate: () => false,
    },
    newId: () => `n${++ids}`,
    now: () => 1000,
  };
  return { h, get: () => cur };
}

describe('applyMove', () => {
  it('resumes the controller on a self-round and charges the counter', () => {
    const { h, get } = host(step({ consecutiveSelfRounds: 1 }));
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.implement', note: 'go' } });
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', 'code.implement', 'go');
    expect(get().consecutiveSelfRounds).toBe(2);
    expect(get().state).toBe('running');
  });

  it('persists memo, artifacts, and phase before acting', () => {
    const { h, get } = host(step({ artifacts: { spec: 'old' } }));
    applyMove(h, 'j1', 's1', {
      memo: 'learned', phase: 'implement',
      artifacts: { implPlan: '# P' },
      next: { kind: 'wait', wait: { reason: 'ci', events: ['ci'] } },
    });
    expect(get().memo).toBe('learned');
    expect(get().phase).toBe('implement');
    // artifacts merge rather than replace, so one round can't clobber an earlier one
    expect(get().artifacts).toEqual({ spec: 'old', implPlan: '# P' });
  });

  it('parks on wait', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'wait', wait: { reason: 'ci', events: ['ci'] } } });
    expect(get().state).toBe('waiting');
    expect(get().waitingOn).toEqual({ reason: 'ci', events: ['ci'] });
    expect(h.resumeController).not.toHaveBeenCalled();
  });

  it('queues dispatches, spawns each, and waits for them all', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', {
      next: { kind: 'dispatch', dispatches: [
        { action: 'code.review-diff', brief: 'diff' },
        { action: 'code.review-diff', brief: 'security' },
      ] },
    });
    expect(get().dispatches).toHaveLength(2);
    expect(get().dispatches.map((d) => d.status)).toEqual(['queued', 'queued']);
    expect(get().dispatches[0]!.attempts).toBe(1);
    expect(h.spawnDispatch).toHaveBeenCalledTimes(2);
    expect(get().state).toBe('waiting');
    expect(get().waitingOn?.untilAllDispatchesDone).toBe(true);
    expect(get().consecutiveSelfRounds).toBe(0);
  });

  it('a retry inherits the prior dispatch attempt count plus one', () => {
    const prior = { id: 'd1', action: 'code.review-diff', brief: 'b', status: 'failed' as const, attempts: 1 };
    const { h, get } = host(step({ dispatches: [prior] }));
    applyMove(h, 'j1', 's1', {
      next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'b', retryOf: 'd1' }] },
    });
    const created = get().dispatches.find((d) => d.id !== 'd1')!;
    expect(created.attempts).toBe(2);
    expect(created.retryOf).toBe('d1');
  });

  it('a retry chain terminates at the cap — retrying the second failure creates no third dispatch', () => {
    const d1 = { id: 'd1', action: 'code.review-diff', brief: 'b', status: 'failed' as const, attempts: 1 };
    const d2 = { id: 'd2', action: 'code.review-diff', brief: 'b', retryOf: 'd1', status: 'failed' as const, attempts: 2 };
    const { h, get } = host(step({ dispatches: [d1, d2] }));
    applyMove(h, 'j1', 's1', {
      next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'b', retryOf: 'd2' }] },
    });
    expect(get().dispatches).toHaveLength(2);
    expect(h.spawnDispatch).not.toHaveBeenCalled();
  });

  it('parks on an explicit gate, holding the move that follows it', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: '# Spec', question: 'ok?' } });
    expect(get().state).toBe('gate_pending_approval');
    expect(get().gate).toMatchObject({ draft: '# Spec', question: 'ok?' });
    expect(get().gateApproved).toBeUndefined();
  });

  it('force-gates an external-write self-round and defers it verbatim', () => {
    const { h, get } = host(step());
    const move = { kind: 'self-round', action: 'code.fix-ci' } as const;
    applyMove(h, 'j1', 's1', { next: move });
    expect(get().state).toBe('gate_pending_approval');
    expect(get().gate?.deferredMove).toEqual(move);
    expect(h.resumeController).not.toHaveBeenCalled();
  });

  it('runs the deferred move on approval without re-gating it', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.fix-ci' } });
    resolveGate(h, 'j1', 's1', true);
    expect(get().gateApproved).toBe(true);
    expect(get().state).toBe('running');
    expect(get().gate).toBeUndefined();
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', 'code.fix-ci', undefined);
  });

  it('hands a declined gate back to the controller as delivered feedback, not a queued item', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    resolveGate(h, 'j1', 's1', false, 'not like that');
    expect(get().gateApproved).toBeUndefined();
    expect(get().gateFeedback).toEqual(['not like that']);
    // Delivered immediately (deliverImmediate), not left sitting in inbox — the resumed
    // controller's envelope reads `lastDelivered`, not `inbox`.
    expect(get().inbox.some((i) => i.kind === 'gate-resolved')).toBe(false);
    expect(get().lastDelivered?.some((i) => i.kind === 'gate-resolved')).toBe(true);
    expect(h.resumeController).toHaveBeenCalled();
  });

  it('delivers a policy rejection immediately instead of leaving it queued', () => {
    const { h, get } = host(step({ consecutiveSelfRounds: MAX_CONSECUTIVE_SELF_ROUNDS }));
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round' } });
    expect(get().inbox.find((i) => i.kind === 'policy-rejection')).toBeUndefined();
    expect(get().lastDelivered?.find((i) => i.kind === 'policy-rejection')).toBeDefined();
    expect(get().pendingPolicyStrike).toBe(true);
    expect(h.resumeController).toHaveBeenCalled();
  });

  it('fails the step when a second consecutive move is also invalid', () => {
    const { h } = host(step({ consecutiveSelfRounds: MAX_CONSECUTIVE_SELF_ROUNDS }));
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round' } });
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round' } });
    expect(h.failStep).toHaveBeenCalledWith('j1', 's1', expect.stringMatching(/policy/i));
  });

  it('clears the policy strike on an accepted move, so a later violation gets one more correction', () => {
    const { h } = host(step());
    // Rejected for an unrelated reason (unknown action) — independent of consecutiveSelfRounds,
    // so the accepted `wait` move in between can't accidentally clear the condition itself.
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.unknown-action' } });
    applyMove(h, 'j1', 's1', { next: { kind: 'wait', wait: { reason: 'ci', events: ['ci'] } } });
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.unknown-action' } });
    expect(h.failStep).not.toHaveBeenCalled();
  });

  it('a stale corrective item cannot satisfy a later, unrelated wait', () => {
    const { h, get } = host(step({ consecutiveSelfRounds: MAX_CONSECUTIVE_SELF_ROUNDS }));
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round' } }); // rejected, delivered immediately
    applyMove(h, 'j1', 's1', { next: { kind: 'wait', wait: { reason: 'ci', events: ['ci'] } } }); // accepted, parks
    expect(get().state).toBe('waiting');
    expect(get().inbox).toEqual([]); // no stale rejection left lingering to falsely satisfy the wait

    vi.mocked(h.resumeController).mockClear(); // clear the call from the earlier rejection delivery
    pushInbox(h, 'j1', 's1', { kind: 'timer' }); // an unrelated event — must not wake the wait
    expect(h.resumeController).not.toHaveBeenCalled();
  });

  it('routes resolve and fail to the host', () => {
    const a = host(step());
    applyMove(a.h, 'j1', 's1', { next: { kind: 'resolve', output: 'merged' } });
    expect(a.h.resolveStep).toHaveBeenCalledWith('j1', 's1', 'merged');

    const b = host(step());
    applyMove(b.h, 'j1', 's1', { next: { kind: 'fail', reason: 'stuck' } });
    expect(b.h.failStep).toHaveBeenCalledWith('j1', 's1', 'stuck');
  });

  // A controller's own submit_step_progress call can land after the step has already been
  // force-resolved (mark-resolved) or has failed — the round it belongs to was still in
  // flight when that happened. Without this guard, the reject branch above runs
  // deliverImmediate, which sets state back to 'running' and resumes the controller,
  // undoing the resolve/fail behind the user's back.
  it('is a no-op on an already-resolved step: state, memo, and inbox are untouched, no resume', () => {
    const { h, get } = host(step({ state: 'resolved' }));
    applyMove(h, 'j1', 's1', { memo: 'late memo', next: { kind: 'self-round' } });
    expect(get().state).toBe('resolved');
    expect(get().memo).toBeUndefined();
    expect(get().inbox).toEqual([]);
    expect(h.resumeController).not.toHaveBeenCalled();
  });

  // `state: 'failed'` is now something `WorkEngine.onStepFailed` actually produces (see
  // engine.ts), so that branch is covered end-to-end by the orchestrator.test.ts case that
  // drives it through onStepFailed. What's only reachable in this pure module is the gap
  // that guard closes defensively: `.failure` landing before `state` has caught up to
  // 'failed' — belt and braces, since not every path that sets `.failure` is guaranteed to
  // update `state` in the same breath.
  it('is a no-op once .failure is set, even if state has not caught up to failed yet', () => {
    const { h, get } = host(step({ state: 'running', failure: { reason: 'boom', at: 1 } }));
    applyMove(h, 'j1', 's1', { memo: 'late memo', next: { kind: 'wait', wait: { reason: 'ci', events: ['ci'] } } });
    expect(get().state).toBe('running');
    expect(get().memo).toBeUndefined();
    expect(get().waitingOn).toBeUndefined();
    expect(h.resumeController).not.toHaveBeenCalled();
  });
});

describe('pushInbox / deliverInbox', () => {
  const msg: Omit<InboxItem, 'id' | 'at'> & { kind: 'user-message'; body: string } =
    { kind: 'user-message', body: 'approve anyway' };

  it('stamps the item and delivers immediately when idle', () => {
    const { h, get } = host(step({ state: 'waiting', waitingOn: { reason: 'ci', events: ['ci'] } }));
    pushInbox(h, 'j1', 's1', msg);
    expect(h.resumeController).toHaveBeenCalledTimes(1);
    expect(get().inbox).toEqual([]);
    expect(get().waitingOn).toBeUndefined();
    expect(get().state).toBe('running');
  });

  it('accumulates without delivering while the session is mid-turn', () => {
    const { h, get } = host(step(), true);
    pushInbox(h, 'j1', 's1', msg);
    pushInbox(h, 'j1', 's1', { kind: 'timer' });
    expect(h.resumeController).not.toHaveBeenCalled();
    expect(get().inbox).toHaveLength(2);
  });

  it('holds a non-matching watcher event, then delivers both at once on a match', () => {
    const { h, get } = host(step({ state: 'waiting', waitingOn: { reason: 'c', events: ['pr-comments'] } }));
    pushInbox(h, 'j1', 's1', { kind: 'external', source: 'pr-watcher', summary: 'ci red', events: ['ci'] });
    expect(h.resumeController).not.toHaveBeenCalled();
    expect(get().inbox).toHaveLength(1);

    pushInbox(h, 'j1', 's1', { kind: 'external', source: 'pr-watcher', summary: 'new comment', events: ['pr-comments'] });
    expect(h.resumeController).toHaveBeenCalledTimes(1);
    expect(get().inbox).toEqual([]);
  });

  it('deliverInbox is a no-op on an empty inbox', () => {
    const { h } = host(step());
    deliverInbox(h, 'j1', 's1');
    expect(h.resumeController).not.toHaveBeenCalled();
  });
});
