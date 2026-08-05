import type { NextMove, OrchestratedStep } from '../work/work-types.js';

export const MAX_ROUNDS = 40;
export const MAX_CONSECUTIVE_SELF_ROUNDS = 3;
export const MAX_DISPATCH_ATTEMPTS = 2;

export type SideEffects = 'none' | 'gated-write' | 'worktree-edit' | 'external-write';

// Narrow lookup instead of the full ActionRegistry: keeps this module pure and
// testable without constructing a registry.
export interface ActionInfo {
  sideEffects(action: string): SideEffects | undefined;
  humanGate(action: string): boolean;
}

export type PolicyVerdict =
  | { kind: 'allow'; move: NextMove }
  | { kind: 'force-gate'; move: NextMove; question: string }
  | { kind: 'reject'; reason: string };

export function briefKey(action: string, brief: string): string {
  let h = 5381;
  for (let i = 0; i < brief.length; i++) h = ((h << 5) + h + brief.charCodeAt(i)) | 0;
  return `${action}#${(h >>> 0).toString(36)}`;
}

function needsGate(action: string, info: ActionInfo): boolean {
  return info.humanGate(action) || info.sideEffects(action) === 'external-write';
}

export function validateNext(step: OrchestratedStep, move: NextMove, info: ActionInfo): PolicyVerdict {
  if (step.state === 'resolved' || step.state === 'failed') {
    return { kind: 'reject', reason: `step is already ${step.state}` };
  }
  if (move.kind === 'resolve' || move.kind === 'fail') return { kind: 'allow', move };

  if (step.roundsSpent >= MAX_ROUNDS) {
    return { kind: 'reject', reason: `round budget exhausted (${MAX_ROUNDS}); resolve or fail the step` };
  }

  if (move.kind === 'self-round') {
    if (step.consecutiveSelfRounds >= MAX_CONSECUTIVE_SELF_ROUNDS) {
      return {
        kind: 'reject',
        reason: `${MAX_CONSECUTIVE_SELF_ROUNDS} self-rounds in a row with no dispatch or new event — `
          + 'dispatch, wait, gate, resolve, or fail instead',
      };
    }
    if (move.action) {
      if (!info.sideEffects(move.action)) {
        return { kind: 'reject', reason: `unknown action ${JSON.stringify(move.action)}` };
      }
      if (needsGate(move.action, info)) {
        return { kind: 'force-gate', move, question: `Approve running ${move.action}? It writes externally.` };
      }
    }
    return { kind: 'allow', move };
  }

  if (move.kind === 'dispatch') {
    if (move.dispatches.length === 0) return { kind: 'reject', reason: 'dispatch with no entries' };
    const byKey = new Map(step.dispatches.map((d) => [briefKey(d.action, d.brief), d]));
    const byId = new Map(step.dispatches.map((d) => [d.id, d]));
    // A target that's already been named by a retry is no longer the most recent attempt —
    // without this, a controller that always retries the same original dispatch never hits
    // the cap check (which reads the NAMED target's frozen attempts, not the chain's length),
    // and the retry loop this task exists to bound would run forever.
    const alreadyRetried = new Set(step.dispatches.filter((d) => d.retryOf).map((d) => d.retryOf!));
    const retriedInThisMove = new Set<string>();
    for (const d of move.dispatches) {
      if (!info.sideEffects(d.action)) {
        return { kind: 'reject', reason: `unknown action ${JSON.stringify(d.action)}` };
      }
      if (d.retryOf) {
        const target = byId.get(d.retryOf);
        if (!target) return { kind: 'reject', reason: `retryOf ${JSON.stringify(d.retryOf)} names no dispatch on this step` };
        if (target.status !== 'failed') {
          return { kind: 'reject', reason: `retryOf must name a failed dispatch; ${d.retryOf} is ${target.status}` };
        }
        if (alreadyRetried.has(d.retryOf) || retriedInThisMove.has(d.retryOf)) {
          return {
            kind: 'reject',
            reason: `${d.retryOf} has already been retried — name the most recent attempt, not the original`,
          };
        }
        if (target.attempts >= MAX_DISPATCH_ATTEMPTS) {
          return { kind: 'reject', reason: `${d.action} already attempted ${target.attempts}× — change the approach or give up` };
        }
        retriedInThisMove.add(d.retryOf);
        continue;
      }
      if (byKey.has(briefKey(d.action, d.brief))) {
        return {
          kind: 'reject',
          reason: `already dispatched ${d.action} with this brief. If it failed for a transient reason `
            + '(an MCP server not authenticated, a network blip, infra), re-dispatch with retryOf set to that '
            + "dispatch's id. Otherwise change the brief — repeating it verbatim will fail the same way.",
        };
      }
    }
    const gated = move.dispatches.find((d) => needsGate(d.action, info));
    if (gated) {
      return { kind: 'force-gate', move, question: `Approve dispatching ${gated.action}? It writes externally.` };
    }
    return { kind: 'allow', move };
  }

  return { kind: 'allow', move };
}
