import { describe, expect, it, vi } from 'vitest';
import {
  applyMove, deliverInbox, pushInbox, resolveGate, type OrchestratedHost,
} from '../../src/work/orchestrated-runner.js';
import { MAX_CONSECUTIVE_SELF_ROUNDS, MAX_ROUNDS } from '../../src/steps/orchestrated-policy.js';
import { EXTERNAL_QUIET_MS } from '../../src/steps/orchestrated-inbox.js';
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
  let clock = 1000;
  const h: OrchestratedHost = {
    getStep: () => cur,
    mutateStep: (_j, _s, fn) => { cur = fn(cur); },
    sessionWorking: () => working,
    resumeController: vi.fn(),
    spawnDispatch: vi.fn(),
    resolveStep: vi.fn(),
    failStep: vi.fn(),
    scheduleDelivery: vi.fn(),
    actionInfo: {
      sideEffects: (a) => ({
        'code.implement': 'worktree-edit', 'code.fix-ci': 'external-write',
        'code.review-diff': 'none', 'code.spec': 'none', 'code.plan': 'none',
      } as Record<string, 'none' | 'worktree-edit' | 'external-write'>)[a],
    },
    newId: () => `n${++ids}`,
    now: () => clock,
  };
  return { h, get: () => cur, advance: (ms: number) => { clock += ms; } };
}

describe('applyMove', () => {
  it('resumes the controller on a self-round and charges the counter', () => {
    const { h, get } = host(step({ consecutiveSelfRounds: 1 }));
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.implement', note: 'go' } });
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', 'code.implement', 'go');
    expect(get().consecutiveSelfRounds).toBe(2);
    expect(get().state).toBe('running');
  });

  // The documented phase ladder in code.orchestrate-pr's SKILL.md. Every move here is
  // legitimate work, so none of them may be rejected and the step must never fail.
  it('runs the spec → gate → approve → plan → implement ladder end to end', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { phase: 'spec', next: { kind: 'self-round', action: 'code.spec' } });
    applyMove(h, 'j1', 's1', {
      phase: 'spec', artifacts: { spec: '# Spec' },
      next: { kind: 'gate', draft: '# Spec', question: 'Approve the spec?' },
    });
    resolveGate(h, 'j1', 's1', true);
    applyMove(h, 'j1', 's1', { phase: 'plan', next: { kind: 'self-round', action: 'code.plan' } });
    applyMove(h, 'j1', 's1', {
      phase: 'implement', artifacts: { implPlan: '# Plan' },
      next: { kind: 'self-round', action: 'code.implement' },
    });

    expect(h.failStep).not.toHaveBeenCalled();
    expect(get().lastDelivered?.some((i) => i.kind === 'policy-rejection')).toBeFalsy();
    expect(get().pendingPolicyStrike).toBe(false);
    expect(get().state).toBe('running');
    expect(h.resumeController).toHaveBeenLastCalledWith('j1', 's1', 'code.implement', undefined);
  });

  it('a gate resets the consecutive-self-round count', () => {
    const { h, get } = host(step({ consecutiveSelfRounds: 2 }));
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    expect(get().consecutiveSelfRounds).toBe(0);
  });

  it('rewriting an artifact with new content is productive; resubmitting it verbatim is not', () => {
    const a = host(step({ phase: 'spec', artifacts: { spec: '# v1' }, consecutiveSelfRounds: 2 }));
    applyMove(a.h, 'j1', 's1', {
      phase: 'spec', artifacts: { spec: '# v2' },
      next: { kind: 'self-round', action: 'code.spec' },
    });
    expect(a.get().consecutiveSelfRounds).toBe(0);

    const b = host(step({ phase: 'spec', artifacts: { spec: '# v1' }, consecutiveSelfRounds: 2 }));
    applyMove(b.h, 'j1', 's1', {
      phase: 'spec', artifacts: { spec: '# v1' },
      next: { kind: 'self-round', action: 'code.spec' },
    });
    expect(b.get().consecutiveSelfRounds).toBe(3);
  });

  // MAX_ROUNDS is the backstop that has to hold once every finer guard is evaded. A controller
  // that moves `phase` every round is productive every round, so consecutiveSelfRounds never
  // climbs — the round budget is the only thing left standing.
  it('charges the round budget on every accepted move, so an always-productive loop still ends', () => {
    const { h, get } = host(step());
    for (let i = 0; i < MAX_ROUNDS; i++) {
      applyMove(h, 'j1', 's1', { phase: `p${i}`, next: { kind: 'self-round', action: 'code.implement' } });
    }
    expect(get().roundsSpent).toBe(MAX_ROUNDS);
    expect(get().consecutiveSelfRounds).toBe(0);
    expect(h.failStep).not.toHaveBeenCalled();

    applyMove(h, 'j1', 's1', { phase: 'one-more', next: { kind: 'self-round', action: 'code.implement' } });
    const rejection = get().lastDelivered?.find((i) => i.kind === 'policy-rejection');
    expect(rejection).toBeDefined();
    expect((rejection as { reason: string }).reason).toMatch(/round budget/);
  });

  it('charges a round for a dispatch, a wait, and a gate too — not just self-rounds', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'b' }] } });
    expect(get().roundsSpent).toBe(1);
    applyMove(h, 'j1', 's1', { next: { kind: 'wait', wait: { reason: 'ci', events: ['ci'] } } });
    expect(get().roundsSpent).toBe(2);
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    expect(get().roundsSpent).toBe(3);
  });

  // The cap counts UNPRODUCTIVE self-rounds. A round that moved the phase and wrote a fresh
  // artifact is real work: rejecting it would kill a healthy step, and the second such
  // rejection would fail it outright.
  it('allows a productive self-round taken at the cap, and resets the count', () => {
    const { h, get } = host(step({ phase: 'implement', consecutiveSelfRounds: MAX_CONSECUTIVE_SELF_ROUNDS }));
    applyMove(h, 'j1', 's1', {
      phase: 'review', artifacts: { review: '# Review' },
      next: { kind: 'self-round', action: 'code.review-diff' },
    });
    expect(get().lastDelivered?.some((i) => i.kind === 'policy-rejection')).toBeFalsy();
    expect(get().pendingPolicyStrike).toBe(false);
    expect(get().consecutiveSelfRounds).toBe(0);
    expect(get().state).toBe('running');
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', 'code.review-diff', undefined);
  });

  it('does not fail a step for two productive self-rounds in a row at the cap', () => {
    const { h } = host(step({ phase: 'implement', consecutiveSelfRounds: MAX_CONSECUTIVE_SELF_ROUNDS }));
    applyMove(h, 'j1', 's1', { phase: 'review', next: { kind: 'self-round', action: 'code.review-diff' } });
    applyMove(h, 'j1', 's1', { phase: 'merge', next: { kind: 'self-round', action: 'code.implement' } });
    expect(h.failStep).not.toHaveBeenCalled();
  });

  it('self-rounds that change neither phase nor artifacts still hit the cap', () => {
    const { h, get } = host(step({ phase: 'implement', artifacts: { spec: '# S' } }));
    for (let i = 0; i < MAX_CONSECUTIVE_SELF_ROUNDS; i++) {
      // Same phase, the same artifact resubmitted byte for byte: nothing to show for the round.
      applyMove(h, 'j1', 's1', {
        phase: 'implement', artifacts: { spec: '# S' },
        next: { kind: 'self-round', action: 'code.implement' },
      });
    }
    expect(get().consecutiveSelfRounds).toBe(MAX_CONSECUTIVE_SELF_ROUNDS);

    applyMove(h, 'j1', 's1', { phase: 'implement', next: { kind: 'self-round', action: 'code.implement' } });
    expect(get().lastDelivered?.some((i) => i.kind === 'policy-rejection')).toBe(true);
  });

  it('a self-round that moves the phase or adds an artifact resets the count', () => {
    const a = host(step({ phase: 'spec', consecutiveSelfRounds: 2 }));
    applyMove(a.h, 'j1', 's1', { phase: 'plan', next: { kind: 'self-round', action: 'code.plan' } });
    expect(a.get().consecutiveSelfRounds).toBe(0);

    const b = host(step({ phase: 'spec', artifacts: { spec: '# S' }, consecutiveSelfRounds: 2 }));
    applyMove(b.h, 'j1', 's1', {
      phase: 'spec', artifacts: { implPlan: '# P' },
      next: { kind: 'self-round', action: 'code.implement' },
    });
    expect(b.get().consecutiveSelfRounds).toBe(0);
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

  it('parks on an explicit gate', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: '# Spec', question: 'ok?' } });
    expect(get().state).toBe('gate_pending_approval');
    expect(get().gate).toMatchObject({ draft: '# Spec', question: 'ok?' });
  });

  it('resumes the controller on approval, whatever action it names next, and records the verdict durably', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    resolveGate(h, 'j1', 's1', true);
    expect(get().state).toBe('running');
    expect(get().gate).toBeUndefined();
    // gate-resolved lands in lastDelivered, which the next delivery overwrites — gateApproved
    // is what a controller resuming later (or on a fresh spawn) still reads to know it said yes.
    expect(get().gateApproved).toBe(true);
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', undefined, undefined);
  });

  // Gates parked before the write-draft cutover carry the move the removed force-gate was
  // holding (GateRequest.deferredMove). Approving one used to drop it and resume the controller
  // unbound — the user's Approve ran nothing, and the queued round had to be re-derived by hand.
  it('replays a legacy gate\'s deferred move on approval instead of resuming unbound', () => {
    const { h, get } = host(step({
      state: 'gate_pending_approval',
      gate: {
        draft: 'the reply body', question: 'Approve running code.fix-ci? It writes externally.',
        requestedAt: 1, deferredMove: { kind: 'self-round', action: 'code.fix-ci', note: 'fix the red check' },
      },
    }));
    resolveGate(h, 'j1', 's1', true);
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', 'code.fix-ci', 'fix the red check');
    expect(get().state).toBe('running');
    expect(get().gate).toBeUndefined();
    expect(get().gateApproved).toBe(true);
    // The replayed round still sees why it woke.
    expect(get().lastDelivered?.some((i) => i.kind === 'gate-resolved' && i.approved)).toBe(true);
  });

  it('drops a legacy deferred move when the gate is declined', () => {
    const { h, get } = host(step({
      state: 'gate_pending_approval',
      gate: {
        draft: 'd', question: 'q', requestedAt: 1,
        deferredMove: { kind: 'self-round', action: 'code.fix-ci' },
      },
    }));
    resolveGate(h, 'j1', 's1', false, 'not yet');
    expect(h.resumeController).toHaveBeenCalledWith('j1', 's1', undefined, undefined);
    expect(get().gate).toBeUndefined();
    expect(get().gateApproved).toBeUndefined();
  });

  // The PWA can now approve WITH a note (previously the only way to send words was a decline,
  // so "go ahead and run it" was recorded as a veto). Both halves have to land.
  it('records an approval that carries feedback as approved, keeping the note', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    resolveGate(h, 'j1', 's1', true, 'go ahead and run it');
    expect(get().gateApproved).toBe(true);
    expect(get().gateFeedback).toEqual(['go ahead and run it']);
    expect(get().lastDelivered?.some((i) =>
      i.kind === 'gate-resolved' && i.approved && i.feedback === 'go ahead and run it')).toBe(true);
  });

  // A gated step still accepts inbox pushes (shouldDeliver only refuses to DELIVER), and the
  // pr-watcher pushes on any changed signal. Approving the gate must not eat the wake.
  it('keeps watcher events queued through a gate approval, dropping only the gate marker', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    expect(get().state).toBe('gate_pending_approval');
    pushInbox(h, 'j1', 's1', {
      kind: 'external', source: 'pr-watcher', summary: 'reviewer requested changes', events: ['pr-comments'],
    });
    expect(get().inbox).toHaveLength(1);

    resolveGate(h, 'j1', 's1', true);
    expect(get().inbox.some((i) => i.kind === 'gate-resolved')).toBe(false);
    expect(get().inbox.some((i) => i.kind === 'external')).toBe(true);
  });

  // A second submit_step_progress in one turn would otherwise run the new move, flip state to
  // 'running', and leave `step.gate` behind — resolveGate then early-returns and the user's
  // Approve is a silent no-op.
  it('refuses a second move while parked at a gate, so the gate stays resolvable', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    applyMove(h, 'j1', 's1', { memo: 'sneaking past the gate', next: { kind: 'self-round', action: 'code.implement' } });

    expect(get().state).toBe('gate_pending_approval');
    expect(get().gate).toBeDefined();
    expect(get().memo).toBeUndefined();
    expect(h.resumeController).not.toHaveBeenCalled();

    resolveGate(h, 'j1', 's1', true);
    expect(get().state).toBe('running');
  });

  // The other route out of a gate: a user message is allowed to abandon it. The gate it
  // escapes must go with it, or the PWA keeps rendering buttons that resolve nothing.
  it('clears the gate when a user message delivers through it', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });
    pushInbox(h, 'j1', 's1', { kind: 'user-message', body: 'forget the gate, do X instead' });
    expect(get().state).toBe('running');
    expect(get().gate).toBeUndefined();
  });

  it('a gated move clears the pending strike — policy accepted it', () => {
    const { h } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.unknown-action' } }); // rejected → strike
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd', question: 'q' } });           // accepted → gated
    resolveGate(h, 'j1', 's1', false, 'not like that');
    applyMove(h, 'j1', 's1', { next: { kind: 'self-round', action: 'code.unknown-action' } }); // rejected again
    expect(h.failStep).not.toHaveBeenCalled();
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

  it('a fresh gate clears a stale approval left over from an earlier one', () => {
    const { h, get } = host(step());
    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd1', question: 'q1' } });
    resolveGate(h, 'j1', 's1', true);
    expect(get().gateApproved).toBe(true);

    applyMove(h, 'j1', 's1', { next: { kind: 'gate', draft: 'd2', question: 'q2' } });
    expect(get().gateApproved).toBeUndefined();
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

  // A watcher event parked by the quiet period has nothing else coming to release it: the watcher
  // pushes only when a signal MOVES, and a PR that has gone quiet moves nothing. Without this the
  // batch would sit in the inbox until the next unrelated event, or forever.
  it('arms the wake that ends a held quiet period', () => {
    const { h } = host(step({ state: 'waiting', waitingOn: { reason: 'watching', events: ['ci'] } }));
    pushInbox(h, 'j1', 's1', { kind: 'external', source: 'pr-watcher', summary: 'CI failure', events: ['ci'] });
    expect(h.resumeController).not.toHaveBeenCalled();
    expect(h.scheduleDelivery).toHaveBeenCalledWith('j1', 's1', 1000 + EXTERNAL_QUIET_MS);
  });

  // The turn ending is itself a delivery re-check, so arming here would race it.
  it('does not arm one while the session is mid-turn', () => {
    const { h } = host(step({ state: 'waiting', waitingOn: { reason: 'watching', events: ['ci'] } }), true);
    pushInbox(h, 'j1', 's1', { kind: 'external', source: 'pr-watcher', summary: 'CI failure', events: ['ci'] });
    expect(h.scheduleDelivery).not.toHaveBeenCalled();
  });

  it('arms nothing when there is no hold to end', () => {
    const { h } = host(step({ state: 'waiting', waitingOn: { reason: 'ci', events: ['ci'] } }));
    pushInbox(h, 'j1', 's1', msg);
    expect(h.resumeController).toHaveBeenCalledTimes(1);
    expect(h.scheduleDelivery).not.toHaveBeenCalled();
  });

  it('holds a non-matching watcher event, then delivers both at once on a match', () => {
    const { h, get, advance } = host(step({ state: 'waiting', waitingOn: { reason: 'c', events: ['pr-comments'] } }));
    pushInbox(h, 'j1', 's1', { kind: 'external', source: 'pr-watcher', summary: 'ci red', events: ['ci'] });
    expect(h.resumeController).not.toHaveBeenCalled();
    expect(get().inbox).toHaveLength(1);

    pushInbox(h, 'j1', 's1', { kind: 'external', source: 'pr-watcher', summary: 'new comment', events: ['pr-comments'] });
    // A matching event alone is no longer enough — the burst still sits out its quiet period.
    expect(h.resumeController).not.toHaveBeenCalled();
    expect(get().inbox).toHaveLength(2);

    advance(EXTERNAL_QUIET_MS);
    deliverInbox(h, 'j1', 's1');
    expect(h.resumeController).toHaveBeenCalledTimes(1);
    expect(get().inbox).toEqual([]);
    expect(get().lastDelivered).toHaveLength(2);
  });

  it('deliverInbox is a no-op on an empty inbox', () => {
    const { h } = host(step());
    deliverInbox(h, 'j1', 's1');
    expect(h.resumeController).not.toHaveBeenCalled();
  });

  // A pure timed soak has an empty inbox by construction, so the wake has to materialize the
  // item it delivers — otherwise shouldDeliver drops it and `resumeAt` can never fire.
  it('materializes a timer item when a due soak is delivered', () => {
    const { h, get } = host(step({ state: 'waiting', waitingOn: { reason: 'bake the canary', resumeAt: 900 } }));
    deliverInbox(h, 'j1', 's1');
    expect(h.resumeController).toHaveBeenCalledTimes(1);
    expect(get().lastDelivered?.some((i) => i.kind === 'timer')).toBe(true);
    expect(get().state).toBe('running');
    expect(get().waitingOn).toBeUndefined();
  });

  it('leaves a soak that has not elapsed parked', () => {
    const { h, get } = host(step({ state: 'waiting', waitingOn: { reason: 'bake', resumeAt: 5000 } }));
    deliverInbox(h, 'j1', 's1');
    expect(h.resumeController).not.toHaveBeenCalled();
    expect(get().state).toBe('waiting');
    expect(get().inbox).toEqual([]);
  });
});
