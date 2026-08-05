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

export function applyMove(host: OrchestratedHost, jobId: string, stepId: string, p: ProgressPayload): void {
  const step = host.getStep(jobId, stepId);
  // A controller's turn can outlive the step: mark-resolved (or any other force-settle) can
  // land while a round is in flight, and its submit_step_progress call arrives after. Without
  // this guard, the reject branch below runs deliverImmediate — which sets state back to
  // 'running' — and resumes the controller, resurrecting a step the user just closed out.
  // `.failure` is checked too, not just `state === 'failed'` — some failure paths land
  // `.failure` without (yet) updating `state`, and this must hold even then.
  if (!step || step.state === 'resolved' || step.state === 'failed' || step.failure) return;
  host.mutateStep(jobId, stepId, (s) => recordProgress(s, p));

  const verdict = validateNext(host.getStep(jobId, stepId)!, p.next, host.actionInfo);

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

  if (verdict.kind === 'force-gate') {
    openGate(host, jobId, stepId, {
      draft: describeMove(verdict.move),
      question: verdict.question,
      deferredMove: verdict.move,
    });
    return;
  }

  runMove(host, jobId, stepId, verdict.move);
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
  }));
}

function runMove(host: OrchestratedHost, jobId: string, stepId: string, move: NextMove): void {
  // An accepted move is what earns forgiveness — clear before acting, whether this move was
  // immediately allowed or is a force-gated move running now on the user's approval.
  host.mutateStep(jobId, stepId, (s) => ({ ...s, pendingPolicyStrike: false }));
  switch (move.kind) {
    case 'self-round':
      host.mutateStep(jobId, stepId, (s) => ({
        ...s, state: 'running', waitingOn: undefined,
        consecutiveSelfRounds: s.consecutiveSelfRounds + 1,
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
    // Executed verbatim, WITHOUT re-validating: re-running policy here would
    // force-gate the same write again, forever. The gate-resolved marker isn't needed —
    // the deferred move is about to run immediately, nothing to explain.
    host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: [] }));
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
  const step = host.getStep(jobId, stepId);
  if (!step) return;
  const working = step.sessionId ? host.sessionWorking(step.sessionId) : false;
  if (!shouldDeliver(step, working, host.now())) return;
  host.mutateStep(jobId, stepId, (s) => drainForDelivery(s).step);
  host.resumeController(jobId, stepId, undefined, undefined);
}
