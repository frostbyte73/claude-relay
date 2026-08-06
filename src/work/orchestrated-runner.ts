import { validateNext, type ActionInfo } from '../steps/orchestrated-policy.js';
import { deliverImmediate, drainForDelivery, shouldDeliver } from '../steps/orchestrated-inbox.js';
import type { Dispatch, InboxItem, NextMove, OrchestratedStep, WatchedEvent } from './work-types.js';

export interface OrchestratedHost {
  getStep(jobId: string, stepId: string): OrchestratedStep | undefined;
  mutateStep(jobId: string, stepId: string, fn: (s: OrchestratedStep) => OrchestratedStep): void;
  sessionWorking(sessionId: string): boolean;
  // Resume the controller's own session. `action` rebinds its allowlist for a work turn;
  // undefined means it keeps the controller's own grant.
  resumeController(jobId: string, stepId: string, action: string | undefined, note: string | undefined): void;
  spawnDispatch(jobId: string, stepId: string, dispatch: Dispatch): void;
  resolveStep(jobId: string, stepId: string, output: string): void;
  failStep(jobId: string, stepId: string, reason: string): void;
  actionInfo: ActionInfo;
  newId(): string;
  now(): number;
}

export interface ProgressPayload {
  memo?: string;
  artifacts?: Record<string, string>;
  phase?: string;
  next: NextMove;
}

// An inbox item before the daemon stamps id/at onto it.
export type NewItem =
  | { kind: 'user-message'; body: string }
  | { kind: 'dispatch-done'; dispatchId: string }
  | { kind: 'external'; source: 'pr-watcher'; summary: string; events: WatchedEvent[] }
  | { kind: 'gate-resolved'; approved: boolean; feedback?: string }
  | { kind: 'timer' }
  | { kind: 'policy-rejection'; reason: string };

function stamp(host: OrchestratedHost, item: NewItem): InboxItem {
  return { id: host.newId(), at: host.now(), ...item } as InboxItem;
}

function recordProgress(s: OrchestratedStep, p: ProgressPayload): OrchestratedStep {
  return {
    ...s,
    ...(p.memo !== undefined ? { memo: p.memo } : {}),
    ...(p.phase !== undefined ? { phase: p.phase } : {}),
    // Merge, don't replace: one round must not clobber an earlier round's artifact.
    ...(p.artifacts ? { artifacts: { ...(s.artifacts ?? {}), ...p.artifacts } } : {}),
  };
}

// Did this round have anything to show for itself? Must be answered against the step as it
// stood BEFORE recordProgress folded the payload in — afterwards the payload's phase and
// artifacts are already stored and every round looks unchanged.
// Content, not keys: redrafting `artifacts.spec` to address a declined gate reuses the key and
// is plainly real work. Only a byte-identical resubmit says the round produced nothing.
function isProductive(before: OrchestratedStep, p: ProgressPayload): boolean {
  if (p.phase !== undefined && p.phase !== before.phase) return true;
  const had = before.artifacts ?? {};
  return Object.entries(p.artifacts ?? {}).some(([k, v]) => had[k] !== v);
}

export function applyMove(host: OrchestratedHost, jobId: string, stepId: string, p: ProgressPayload): void {
  const step = host.getStep(jobId, stepId);
  // A controller's turn can outlive the step: mark-resolved (or any other force-settle) can
  // land while a round is in flight, and its submit_step_progress call arrives after. Without
  // this guard, the reject branch below runs deliverImmediate — which sets state back to
  // 'running' — and resumes the controller, resurrecting a step the user just closed out.
  // `.failure` is checked too, not just `state === 'failed'` — some failure paths land
  // `.failure` without (yet) updating `state`, and this must hold even then.
  if (!step || step.state === 'resolved' || step.state === 'failed' || step.failure) return;
  // A step parked at a gate is the user's turn. Running a second move here would flip state
  // back to 'running' and strand `step.gate`, which resolveGate then refuses to touch — the
  // user's Approve becomes a silent no-op and the deferred move is lost.
  if (step.state === 'gate_pending_approval') return;
  const productive = isProductive(step, p);
  host.mutateStep(jobId, stepId, (s) => recordProgress(s, p));

  const verdict = validateNext(host.getStep(jobId, stepId)!, p.next, host.actionInfo, productive);

  if (verdict.kind === 'reject') {
    // One corrective turn. A controller that violates policy twice running (with no accepted
    // move in between to earn forgiveness — see runMove) is not going to recover on a third try.
    if (step.pendingPolicyStrike) {
      host.failStep(jobId, stepId, `controller violated policy twice: ${verdict.reason}`);
      return;
    }
    host.mutateStep(jobId, stepId, (s) => {
      const item = stamp(host, { kind: 'policy-rejection', reason: verdict.reason });
      return { ...deliverImmediate({ ...s, inbox: [...s.inbox, item] }, [item]), pendingPolicyStrike: true };
    });
    host.resumeController(jobId, stepId, undefined, undefined);
    return;
  }

  // Every accepted move is a round, whatever its kind. Charging only on inbox deliveries left
  // the self-round loop — the most common move there is — free, so MAX_ROUNDS bounded nothing
  // for a controller that never parked. It is the backstop that has to hold once the finer
  // guards (productivity, the self-round cap) have all been satisfied or evaded.
  host.mutateStep(jobId, stepId, (s) => ({ ...s, roundsSpent: s.roundsSpent + 1 }));

  if (verdict.kind === 'force-gate') {
    openGate(host, jobId, stepId, {
      draft: describeMove(verdict.move),
      question: verdict.question,
      deferredMove: verdict.move,
    });
    return;
  }

  runMove(host, jobId, stepId, verdict.move, productive);
}

function describeMove(move: NextMove): string {
  if (move.kind === 'self-round') return `Run \`${move.action}\` on this step's session.${move.note ? `\n\n${move.note}` : ''}`;
  if (move.kind === 'dispatch') {
    return move.dispatches.map((d) => `**${d.action}**\n\n${d.brief}`).join('\n\n---\n\n');
  }
  return move.kind;
}

function openGate(
  host: OrchestratedHost, jobId: string, stepId: string,
  gate: { draft: string; question: string; deferredMove: NextMove },
): void {
  host.mutateStep(jobId, stepId, (s) => ({
    ...s,
    state: 'gate_pending_approval',
    gate: { ...gate, requestedAt: host.now() },
    gateApproved: undefined,
    // A gated move is a move policy accepted, so it earns the same forgiveness runMove grants —
    // otherwise a strike survives a legitimate move and the next rejection fails the step.
    pendingPolicyStrike: false,
    // A gate is the strongest yield there is — the step parks and a human decides — so it
    // forgives the self-round budget at least as much as a dispatch or a wait does. That holds
    // even harder for a force-gate, which the daemon imposed on a controller that didn't ask.
    consecutiveSelfRounds: 0,
  }));
}

// `productive` is false for a deferred move replayed from a gate: it carries no payload of its
// own — the one that proposed it was folded in when the gate opened — so there is nothing left
// to compare against and the replay counts against the self-round budget.
function runMove(host: OrchestratedHost, jobId: string, stepId: string, move: NextMove, productive = false): void {
  // An accepted move is what earns forgiveness — clear before acting, whether this move was
  // immediately allowed or is a force-gated move running now on the user's approval.
  host.mutateStep(jobId, stepId, (s) => ({ ...s, pendingPolicyStrike: false }));
  switch (move.kind) {
    case 'self-round':
      host.mutateStep(jobId, stepId, (s) => ({
        ...s, state: 'running', waitingOn: undefined,
        consecutiveSelfRounds: productive ? 0 : s.consecutiveSelfRounds + 1,
      }));
      host.resumeController(jobId, stepId, move.action, move.note);
      return;

    case 'dispatch': {
      const priorDispatches = host.getStep(jobId, stepId)!.dispatches;
      const created: Dispatch[] = move.dispatches.map((d) => {
        const prior = d.retryOf ? priorDispatches.find((x) => x.id === d.retryOf) : undefined;
        return {
          id: host.newId(),
          action: d.action,
          brief: d.brief,
          ...(d.inputs ? { inputs: d.inputs } : {}),
          ...(d.workspace ? { workspace: d.workspace } : {}),
          ...(d.retryOf ? { retryOf: d.retryOf } : {}),
          status: 'queued',
          attempts: (prior?.attempts ?? 0) + 1,
        };
      });
      host.mutateStep(jobId, stepId, (s) => ({
        ...s,
        dispatches: [...s.dispatches, ...created],
        state: 'waiting',
        consecutiveSelfRounds: 0,
        waitingOn: {
          reason: `Running ${created.map((d) => d.action).join(', ')}`,
          untilAllDispatchesDone: true,
        },
      }));
      for (const d of created) host.spawnDispatch(jobId, stepId, d);
      return;
    }

    case 'wait':
      host.mutateStep(jobId, stepId, (s) => ({
        ...s, state: 'waiting', waitingOn: move.wait, consecutiveSelfRounds: 0,
      }));
      return;

    case 'gate':
      openGate(host, jobId, stepId, {
        draft: move.draft, question: move.question,
        deferredMove: { kind: 'self-round' },
      });
      return;

    case 'resolve':
      host.resolveStep(jobId, stepId, move.output);
      return;

    case 'fail':
      host.failStep(jobId, stepId, move.reason);
      return;
  }
}

export function resolveGate(
  host: OrchestratedHost, jobId: string, stepId: string, approved: boolean, feedback?: string,
): void {
  const step = host.getStep(jobId, stepId);
  if (!step || step.state !== 'gate_pending_approval') return;
  const deferred = step.gate?.deferredMove;
  const item = stamp(host, { kind: 'gate-resolved', approved, ...(feedback ? { feedback } : {}) });

  host.mutateStep(jobId, stepId, (s) => ({
    ...s,
    gate: undefined,
    ...(approved ? { gateApproved: true } : {}),
    ...(feedback ? { gateFeedback: [...(s.gateFeedback ?? []), feedback] } : {}),
    inbox: [...s.inbox, item],
  }));

  if (approved && deferred) {
    // Executed verbatim, WITHOUT re-validating: re-running policy here would force-gate the
    // same write again, forever. Drop ONLY the gate-resolved marker — the deferred move runs
    // immediately, so there is nothing to explain — and leave everything else the watcher or a
    // dispatch queued while the step was parked for the next natural delivery.
    host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: s.inbox.filter((i) => i.id !== item.id) }));
    runMove(host, jobId, stepId, deferred);
    return;
  }
  // A decline (or an approval with no deferred move) is corrective feedback on the same
  // round, not a fresh delivery cycle — deliverImmediate (not deliverInbox/drainForDelivery)
  // so the resumed controller's envelope actually shows why, without spending the
  // consecutive-self-round budget the way a real new event would.
  host.mutateStep(jobId, stepId, (s) => deliverImmediate(s, [item]));
  host.resumeController(jobId, stepId, undefined, undefined);
}

export function pushInbox(host: OrchestratedHost, jobId: string, stepId: string, item: NewItem): void {
  const step = host.getStep(jobId, stepId);
  if (!step) return;
  host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: [...s.inbox, stamp(host, item)] }));
  deliverInbox(host, jobId, stepId);
}

export function deliverInbox(host: OrchestratedHost, jobId: string, stepId: string): void {
  let step = host.getStep(jobId, stepId);
  if (!step) return;
  // A pure timed soak has an empty inbox by construction, and shouldDeliver refuses to deliver
  // an empty one — so the wake has to materialize the item it delivers. This is the producer of
  // the `timer` InboxItem, and the only reason a `wait` carrying just `resumeAt` can ever fire.
  if (step.inbox.length === 0 && step.state === 'waiting'
      && step.waitingOn?.resumeAt !== undefined && host.now() >= step.waitingOn.resumeAt) {
    host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: [...s.inbox, stamp(host, { kind: 'timer' })] }));
    step = host.getStep(jobId, stepId)!;
  }
  const working = step.sessionId ? host.sessionWorking(step.sessionId) : false;
  if (!shouldDeliver(step, working, host.now())) return;
  host.mutateStep(jobId, stepId, (s) => drainForDelivery(s).step);
  host.resumeController(jobId, stepId, undefined, undefined);
}
