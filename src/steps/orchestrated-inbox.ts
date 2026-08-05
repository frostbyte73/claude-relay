import type { InboxItem, OrchestratedStep } from '../work/work-types.js';

export function hasUserMessage(step: OrchestratedStep): boolean {
  return step.inbox.some((i) => i.kind === 'user-message');
}

export function waitSatisfied(step: OrchestratedStep, now: number): boolean {
  const w = step.waitingOn;
  if (!w) return true;
  if (w.resumeAt !== undefined && now >= w.resumeAt) return true;

  for (const i of step.inbox) {
    // A gate resolution or a policy rejection is always the controller's turn: one is
    // the answer it parked for, the other is its one corrective turn.
    if (i.kind === 'gate-resolved' || i.kind === 'policy-rejection') return true;
    if (i.kind === 'external' && i.events.some((e) => w.events?.includes(e))) return true;
    if (i.kind === 'dispatch-done') {
      if (w.untilAllDispatchesDone) {
        if (step.dispatches.every((d) => d.status !== 'queued' && d.status !== 'running')) return true;
      } else if (w.events?.includes('dispatches')) {
        return true;
      }
    }
  }
  return false;
}

export function shouldDeliver(step: OrchestratedStep, sessionWorking: boolean, now: number): boolean {
  if (sessionWorking) return false;
  if (step.inbox.length === 0) return false;
  if (step.state === 'resolved' || step.state === 'failed') return false;
  // A gated step is the user's turn, not the controller's — except that a message may
  // be the instruction to abandon the gate entirely.
  if (step.state === 'gate_pending_approval') return hasUserMessage(step);
  return hasUserMessage(step) || waitSatisfied(step, now);
}

export function drainForDelivery(step: OrchestratedStep): { step: OrchestratedStep; items: InboxItem[] } {
  const items = step.inbox;
  return {
    items,
    step: {
      ...step,
      inbox: [],
      lastDelivered: items,
      waitingOn: undefined,
      state: 'running',
      roundsSpent: step.roundsSpent + 1,
      consecutiveSelfRounds: 0,
    },
  };
}

// Delivers specific inbox items right now, out of band from the normal shouldDeliver/
// drainForDelivery pull cycle — for corrective feedback on the controller's own just-attempted
// move (a policy rejection, a declined gate), not a fresh async event. Moves only the named
// items into `lastDelivered` (anything else already queued in `inbox` stays there for the next
// natural delivery) and spends a round (MAX_ROUNDS is the backstop against an endless declined-
// gate loop), but deliberately does NOT touch `consecutiveSelfRounds` — resetting it here would
// let a controller dodge the "N self-rounds in a row" cap by tripping an unrelated rejection
// between rounds.
export function deliverImmediate(step: OrchestratedStep, items: InboxItem[]): OrchestratedStep {
  const ids = new Set(items.map((i) => i.id));
  return {
    ...step,
    inbox: step.inbox.filter((i) => !ids.has(i.id)),
    lastDelivered: items,
    waitingOn: undefined,
    state: 'running',
    roundsSpent: step.roundsSpent + 1,
  };
}
