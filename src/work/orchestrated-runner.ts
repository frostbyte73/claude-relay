import { validateNext, type ActionInfo } from '../steps/orchestrated-policy.js';
import { drainForDelivery, shouldDeliver } from '../steps/orchestrated-inbox.js';
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
  if (!step) return;
  host.mutateStep(jobId, stepId, (s) => recordProgress(s, p));

  const verdict = validateNext(host.getStep(jobId, stepId)!, p.next, host.actionInfo);

  if (verdict.kind === 'reject') {
    // One corrective turn. A controller that violates policy twice running is not
    // going to recover on a third try.
    const had = step.inbox.some((i) => i.kind === 'policy-rejection');
    if (had) {
      host.failStep(jobId, stepId, `controller violated policy twice: ${verdict.reason}`);
      return;
    }
    // Corrective feedback on the SAME round, not a fresh one — push directly and resume
    // rather than through pushInbox/deliverInbox, whose drainForDelivery resets
    // consecutiveSelfRounds and would erase the "twice in a row" signal checked above.
    host.mutateStep(jobId, stepId, (s) => ({
      ...s, inbox: [...s.inbox, stamp(host, { kind: 'policy-rejection', reason: verdict.reason })],
    }));
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
  switch (move.kind) {
    case 'self-round':
      host.mutateStep(jobId, stepId, (s) => ({
        ...s, state: 'running', waitingOn: undefined,
        consecutiveSelfRounds: s.consecutiveSelfRounds + 1,
      }));
      host.resumeController(jobId, stepId, move.action, move.note);
      return;

    case 'dispatch': {
      const created: Dispatch[] = move.dispatches.map((d) => ({
        id: host.newId(),
        action: d.action,
        brief: d.brief,
        ...(d.inputs ? { inputs: d.inputs } : {}),
        ...(d.workspace ? { workspace: d.workspace } : {}),
        status: 'queued',
        attempts: 1,
      }));
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

  host.mutateStep(jobId, stepId, (s) => ({
    ...s,
    gate: undefined,
    state: 'running',
    ...(approved ? { gateApproved: true } : {}),
    ...(feedback ? { gateFeedback: [...(s.gateFeedback ?? []), feedback] } : {}),
    inbox: [...s.inbox, stamp(host, { kind: 'gate-resolved', approved, ...(feedback ? { feedback } : {}) })],
  }));

  if (approved && deferred) {
    // Executed verbatim, WITHOUT re-validating: re-running policy here would
    // force-gate the same write again, forever.
    host.mutateStep(jobId, stepId, (s) => ({ ...s, inbox: [] }));
    runMove(host, jobId, stepId, deferred);
    return;
  }
  // A decline (or an approval with no deferred move) resumes the controller directly
  // with its feedback still in `inbox` — not through deliverInbox, whose
  // drainForDelivery would spend a round and reset consecutiveSelfRounds for what is
  // feedback on the same round, not a fresh one.
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
