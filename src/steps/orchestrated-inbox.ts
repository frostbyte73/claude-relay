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
        // `awaiting_approval` is a dispatch parked on its own write draft, not a settled one —
        // counting it as "done" would resume the controller as if every child had finished
        // while one is still waiting on the user's accept/revise/deny.
        if (step.dispatches.every((d) =>
          d.status !== 'queued' && d.status !== 'running' && d.status !== 'awaiting_approval')) return true;
      } else if (w.events?.includes('dispatches')) {
        return true;
      }
    }
  }
  return false;
}

// An external item is a notification that a signal MOVED, not a log entry — the controller
// reads the current value off `pr` in its envelope, and however many are queued it still gets
// exactly one round to react. So a queued item whose events the incoming one also covers is
// re-reporting the same signals with staler facts: drop it rather than hand the controller N
// copies of one wake. Subset, not equality, so `[pr-state]` collapses into a later
// `[pr-state, ci]` too. Untouched items keep their position; the incoming one appends.
//
// Scoped to undelivered items by construction (this runs against `inbox`, and drainForDelivery
// empties it), and to the same `source` — two watchers reporting the same event kind are two
// independent facts, not a repeat.
export function coalesceExternal(inbox: InboxItem[], incoming: InboxItem): InboxItem[] {
  if (incoming.kind !== 'external') return [...inbox, incoming];
  const covered = new Set(incoming.events);
  const kept = inbox.filter((i) =>
    i.kind !== 'external' || i.source !== incoming.source || !i.events.every((e) => covered.has(e)));
  return [...kept, incoming];
}

// How long a batch of watcher events sits before it is handed over. A reviewer leaving four
// comments over two minutes is one piece of news, and each delivery costs the controller a round
// against MAX_ROUNDS — so the wake it gets should describe the whole burst, not its first frame.
export const EXTERNAL_QUIET_MS = 120_000;

// When the currently-held batch of watcher events becomes deliverable, or undefined if nothing is
// being held back. Measured from the OLDEST held item so a PR that keeps churning still gets its
// wake on schedule; deadline-from-newest would let sustained chatter defer it forever.
//
// Only a batch that is ENTIRELY watcher events is ever held. A user message, a settled dispatch, a
// resolved gate, a policy rejection or a due soak timer is somebody actually waiting on the
// controller, and none of them arrive in bursts, so batching them would buy nothing.
export function externalHoldUntil(step: OrchestratedStep, now: number): number | undefined {
  if (!step.inbox.length || !step.inbox.every((i) => i.kind === 'external')) return undefined;
  const resumeAt = step.waitingOn?.resumeAt;
  if (resumeAt !== undefined && now >= resumeAt) return undefined;
  const until = Math.min(...step.inbox.map((i) => i.at)) + EXTERNAL_QUIET_MS;
  return until > now ? until : undefined;
}

export function shouldDeliver(step: OrchestratedStep, sessionWorking: boolean, now: number): boolean {
  if (sessionWorking) return false;
  if (step.inbox.length === 0) return false;
  if (step.state === 'resolved' || step.state === 'failed') return false;
  // A gated step is the user's turn, not the controller's — except that a message may
  // be the instruction to abandon the gate entirely.
  if (step.state === 'gate_pending_approval') return hasUserMessage(step);
  if (hasUserMessage(step)) return true;
  if (!waitSatisfied(step, now)) return false;
  return externalHoldUntil(step, now) === undefined;
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
      // The only delivery a gated step accepts is a user message abandoning the gate
      // (shouldDeliver). The gate goes with it — a `running` step carrying a `gate` renders
      // Approve/Decline buttons that resolveGate refuses to act on.
      gate: undefined,
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
// let a controller dodge the unproductive-self-rounds-in-a-row cap by tripping an unrelated rejection
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
