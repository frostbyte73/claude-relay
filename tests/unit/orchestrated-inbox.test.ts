import { describe, expect, it } from 'vitest';
import {
  deliverImmediate, drainForDelivery, hasUserMessage, shouldDeliver, waitSatisfied,
} from '../../src/steps/orchestrated-inbox.js';
import type { Dispatch, InboxItem, OrchestratedStep } from '../../src/work/work-types.js';

let n = 0;
const item = (over: Partial<InboxItem> & Pick<InboxItem, 'kind'>): InboxItem =>
  ({ id: `i${++n}`, at: 100, ...over } as InboxItem);

function step(over: Partial<OrchestratedStep> = {}): OrchestratedStep {
  return {
    id: 's1', title: 't', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'waiting', createdAt: 0, updatedAt: 0, ...over,
  } as OrchestratedStep;
}

const done = (over: Partial<Dispatch> = {}): Dispatch =>
  ({ id: 'd1', action: 'a', brief: 'b', status: 'done', attempts: 1, ...over });

describe('waitSatisfied', () => {
  it('is satisfied when nothing is being waited on', () => {
    expect(waitSatisfied(step({ waitingOn: undefined }), 500)).toBe(true);
  });

  it('is satisfied when resumeAt has elapsed and not before', () => {
    const s = step({ waitingOn: { reason: 'soak', resumeAt: 1000 } });
    expect(waitSatisfied(s, 999)).toBe(false);
    expect(waitSatisfied(s, 1000)).toBe(true);
  });

  it('matches a watched external event', () => {
    const s = step({
      waitingOn: { reason: 'ci', events: ['ci'] },
      inbox: [item({ kind: 'external', source: 'pr-watcher', summary: 'x', events: ['ci'] } as Partial<InboxItem> & { kind: 'external' })],
    });
    expect(waitSatisfied(s, 500)).toBe(true);
  });

  it('ignores an external event it is not watching', () => {
    const s = step({
      waitingOn: { reason: 'ci', events: ['ci'] },
      inbox: [item({ kind: 'external', source: 'pr-watcher', summary: 'x', events: ['pr-comments'] } as Partial<InboxItem> & { kind: 'external' })],
    });
    expect(waitSatisfied(s, 500)).toBe(false);
  });

  it('waits for every dispatch when untilAllDispatchesDone is set', () => {
    const waiting = step({
      waitingOn: { reason: 'fan-out', untilAllDispatchesDone: true },
      dispatches: [done(), done({ id: 'd2', status: 'running' })],
      inbox: [item({ kind: 'dispatch-done', dispatchId: 'd1' } as Partial<InboxItem> & { kind: 'dispatch-done' })],
    });
    expect(waitSatisfied(waiting, 500)).toBe(false);

    const ready = step({
      waitingOn: { reason: 'fan-out', untilAllDispatchesDone: true },
      dispatches: [done(), done({ id: 'd2', status: 'failed' })],
      inbox: [item({ kind: 'dispatch-done', dispatchId: 'd2' } as Partial<InboxItem> & { kind: 'dispatch-done' })],
    });
    expect(waitSatisfied(ready, 500)).toBe(true);
  });

  // Regression: `awaiting_approval` is a dispatch parked on its own write draft, not a settled
  // one — treating it as "done" would resume the controller as if every child had finished
  // while one is still waiting on the user's accept/revise/deny.
  it('does not treat a dispatch parked on its own draft (awaiting_approval) as done', () => {
    const s = step({
      waitingOn: { reason: 'fan-out', untilAllDispatchesDone: true },
      dispatches: [done(), done({ id: 'd2', status: 'awaiting_approval' })],
      inbox: [item({ kind: 'dispatch-done', dispatchId: 'd1' } as Partial<InboxItem> & { kind: 'dispatch-done' })],
    });
    expect(waitSatisfied(s, 500)).toBe(false);
  });

  it('is satisfied by a gate resolution', () => {
    const s = step({
      waitingOn: { reason: 'gate', events: ['ci'] },
      inbox: [item({ kind: 'gate-resolved', approved: true } as Partial<InboxItem> & { kind: 'gate-resolved' })],
    });
    expect(waitSatisfied(s, 500)).toBe(true);
  });

  it('is satisfied by a policy rejection so the controller gets its corrective turn', () => {
    const s = step({
      waitingOn: { reason: 'ci', events: ['ci'] },
      inbox: [item({ kind: 'policy-rejection', reason: 'nope' } as Partial<InboxItem> & { kind: 'policy-rejection' })],
    });
    expect(waitSatisfied(s, 500)).toBe(true);
  });
});

describe('shouldDeliver', () => {
  const msg = item({ kind: 'user-message', body: 'approve anyway' } as Partial<InboxItem> & { kind: 'user-message' });
  const ci = item({ kind: 'external', source: 'pr-watcher', summary: 'ci', events: ['ci'] } as Partial<InboxItem> & { kind: 'external' });

  it('never delivers while the session is mid-turn — this is the coalescing', () => {
    expect(shouldDeliver(step({ inbox: [msg] }), true, 500)).toBe(false);
  });

  it('does not deliver an empty inbox', () => {
    expect(shouldDeliver(step({ inbox: [] }), false, 500)).toBe(false);
  });

  it('delivers a user message even against an unsatisfied wait', () => {
    const s = step({ waitingOn: { reason: 'ci', events: ['ci'], resumeAt: 9999 }, inbox: [msg] });
    expect(waitSatisfied(s, 500)).toBe(false);
    expect(shouldDeliver(s, false, 500)).toBe(true);
  });

  it('holds a non-matching event until its wait is satisfied', () => {
    const s = step({ waitingOn: { reason: 'comments', events: ['pr-comments'] }, inbox: [ci] });
    expect(shouldDeliver(s, false, 500)).toBe(false);
  });

  it('does not deliver to a terminal step', () => {
    expect(shouldDeliver(step({ state: 'resolved', inbox: [msg] }), false, 500)).toBe(false);
    expect(shouldDeliver(step({ state: 'failed', inbox: [msg] }), false, 500)).toBe(false);
  });

  it('delivers only a user message to a gated step', () => {
    expect(shouldDeliver(step({ state: 'gate_pending_approval', inbox: [ci] }), false, 500)).toBe(false);
    expect(shouldDeliver(step({ state: 'gate_pending_approval', inbox: [msg] }), false, 500)).toBe(true);
  });
});

describe('hasUserMessage', () => {
  it('detects a queued user message', () => {
    expect(hasUserMessage(step({ inbox: [] }))).toBe(false);
    expect(hasUserMessage(step({
      inbox: [item({ kind: 'user-message', body: 'x' } as Partial<InboxItem> & { kind: 'user-message' })],
    }))).toBe(true);
  });
});

describe('drainForDelivery', () => {
  it('empties the inbox, clears the wait, and charges a round', () => {
    const s = step({
      state: 'waiting',
      roundsSpent: 2,
      waitingOn: { reason: 'ci', events: ['ci'] },
      inbox: [item({ kind: 'timer' } as Partial<InboxItem> & { kind: 'timer' })],
    });
    const { step: next, items } = drainForDelivery(s);
    expect(items).toHaveLength(1);
    expect(next.inbox).toEqual([]);
    expect(next.lastDelivered).toEqual(items);
    expect(next.waitingOn).toBeUndefined();
    expect(next.state).toBe('running');
    expect(next.roundsSpent).toBe(3);
  });

  it('resets the consecutive-self-round counter, since a real event arrived', () => {
    const s = step({
      consecutiveSelfRounds: 3,
      inbox: [item({ kind: 'dispatch-done', dispatchId: 'd1' } as Partial<InboxItem> & { kind: 'dispatch-done' })],
    });
    expect(drainForDelivery(s).step.consecutiveSelfRounds).toBe(0);
  });
});

describe('deliverImmediate', () => {
  it('moves only the named items into lastDelivered, leaving unrelated inbox items queued', () => {
    const rejection = item({ kind: 'policy-rejection', reason: 'nope' } as Partial<InboxItem> & { kind: 'policy-rejection' });
    const unrelated = item({ kind: 'timer' } as Partial<InboxItem> & { kind: 'timer' });
    const s = step({
      state: 'running', roundsSpent: 2, consecutiveSelfRounds: 3,
      waitingOn: { reason: 'ci', events: ['ci'] },
      inbox: [rejection, unrelated],
    });
    const next = deliverImmediate(s, [rejection]);
    expect(next.inbox).toEqual([unrelated]);
    expect(next.lastDelivered).toEqual([rejection]);
    expect(next.waitingOn).toBeUndefined();
    expect(next.state).toBe('running');
    expect(next.roundsSpent).toBe(3);
    // Corrective feedback on the same round, not a fresh one — must not reset the
    // "N self-rounds in a row" counter the policy cap depends on.
    expect(next.consecutiveSelfRounds).toBe(3);
  });
});
