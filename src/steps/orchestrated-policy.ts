import type { NextMove, OrchestratedStep } from '../work/work-types.js';
import { workspaceError } from '../work/workspace.js';

// Every accepted move charges one round (see applyMove), and so does every inbox delivery — so
// this bounds the controller's whole loop, including one that keeps every finer guard happy by
// moving `phase` each turn. Generous on purpose: an event-woken cycle costs two, the finer
// guards (the unproductive-self-round cap, the gates, the dispatch attempt cap) do the actual
// policing, and hitting this wall fails a step mid-flight on real work — a far worse outcome
// than a runaway burning some extra tokens.
export const MAX_ROUNDS = 80;
// Counts UNPRODUCTIVE self-rounds in a row — ones that neither moved `phase` nor changed the
// content of any artifact (see isProductive in orchestrated-runner). A productive round is
// allowed however high the counter stands, and resets it: this caps spinning, not working.
export const MAX_CONSECUTIVE_SELF_ROUNDS = 3;
export const MAX_DISPATCH_ATTEMPTS = 2;
// The one round allowed to `resolve` a step whose recorded PR is still open. It re-reads the PR
// from GitHub and only resolves on a confirmed merge, so it holds a fact `step.pr` does not:
// nothing but the pr-watcher writes `prState`, and it has not swept in the seconds between the
// merge landing and this submit. Named here rather than inferred from side_effects because
// `code.fix-ci` is external-write too, and a resolve from a fix-ci round is exactly the bug.
export const MERGE_ACTION = 'code.merge-pr';

export type SideEffects = 'none' | 'gated-write' | 'worktree-edit' | 'external-write';

// Narrow lookup instead of the full ActionRegistry: keeps this module pure and
// testable without constructing a registry.
export interface ActionInfo {
  sideEffects(action: string): SideEffects | undefined;
}

export type PolicyVerdict =
  | { kind: 'allow'; move: NextMove }
  | { kind: 'reject'; reason: string };

// The URL of a PR this step is on the hook for landing and hasn't, or undefined if resolving is
// legitimate. `writable` is what separates owning the PR from reviewing one: a controller holding
// the branch is expected to merge it, while `code.orchestrate-review` works readonly against
// somebody else's PR and settles on a verdict it could never merge — guarding that would strand
// every review step. A step with no `prUrl` never opened one and is free to resolve.
function unmergedOwnPr(step: OrchestratedStep): string | undefined {
  if (step.workspace?.kind !== 'writable') return undefined;
  if (step.boundAction === MERGE_ACTION) return undefined;
  const pr = step.pr;
  if (!pr?.prUrl || pr.prState === 'merged' || pr.prState === undefined) return undefined;
  return pr.prUrl;
}

export function briefKey(action: string, brief: string): string {
  let h = 5381;
  for (let i = 0; i < brief.length; i++) h = ((h << 5) + h + brief.charCodeAt(i)) | 0;
  return `${action}#${(h >>> 0).toString(36)}`;
}

// `productive` describes the payload submitted alongside this move — whether it moved `phase`
// or changed an artifact's content. It is what keeps the self-round cap from rejecting a
// genuinely progressing round: the counter only ever gates rounds with nothing to show.
export function validateNext(
  step: OrchestratedStep, move: NextMove, info: ActionInfo, productive = false,
): PolicyVerdict {
  // `.failure` is checked alongside `state` — a failure that arrived without (yet) flipping
  // `state` to 'failed' is still terminal; see the matching guard in applyMove.
  if (step.state === 'resolved' || step.state === 'failed' || step.failure) {
    return { kind: 'reject', reason: `step is already ${step.failure ? 'failed' : step.state}` };
  }
  if (move.kind === 'resolve') {
    const unmerged = unmergedOwnPr(step);
    if (unmerged) {
      return {
        kind: 'reject',
        reason: `${unmerged} is still ${step.pr!.prState} and you own it — a resolve here settles the `
          + 'step as done and takes the PR out of the cockpit with work left on it. Merge it (a '
          + `self-round as ${MERGE_ACTION} once CI is green and review is approved), \`gate\` with `
          + 'the current state so the user can take it over, or `fail` with what is outstanding. '
          + 'Running low on rounds is a reason to gate, not to resolve.',
      };
    }
    return { kind: 'allow', move };
  }
  if (move.kind === 'fail') return { kind: 'allow', move };

  // `gate` is exempt alongside resolve/fail. The budget bounds autonomous work, and a gate is the
  // opposite of that — it parks the step and spends nothing until a human acts, so re-gating can
  // only loop as fast as the user unparks it. Barring it here would leave a controller that owns
  // an open PR with `fail` as its only legal exit (the resolve guard above takes the other one),
  // which is how an honest "I ran out of rounds, here is where it landed" became a lost step.
  if (move.kind !== 'gate' && step.roundsSpent >= MAX_ROUNDS) {
    return {
      kind: 'reject',
      reason: `round budget exhausted (${MAX_ROUNDS}); gate the step for the user, or resolve or fail it`,
    };
  }

  if (move.kind === 'self-round') {
    if (!productive && step.consecutiveSelfRounds >= MAX_CONSECUTIVE_SELF_ROUNDS) {
      return {
        kind: 'reject',
        reason: `${MAX_CONSECUTIVE_SELF_ROUNDS} self-rounds in a row that moved neither phase nor `
          + 'artifacts, and this one moved neither either — submit a self-round that reports real '
          + 'progress (a new phase, or an artifact with new content), or dispatch, wait, gate, '
          + 'resolve, or fail instead',
      };
    }
    if (move.action) {
      if (!info.sideEffects(move.action)) {
        return { kind: 'reject', reason: `unknown action ${JSON.stringify(move.action)}` };
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
      // A malformed ref is a dead end past this point: provision() throws on a readonly with no
      // repoCwd, and treats any *unknown* kind as readonly — so a typo silently downgrades the
      // child to a detached checkout instead of being refused.
      const wsErr = workspaceError(d.workspace);
      if (wsErr) return { kind: 'reject', reason: `${d.action}: ${wsErr}` };
      if (d.workspace?.kind === 'writable') {
        return {
          kind: 'reject',
          reason: `${d.action} asks for a writable workspace. A dispatch cannot hold one — the branch `
            + 'belongs to you, and a second worktree on it would move yours out from under your session. '
            + 'Make the edit yourself in a self-round bound to an editing action, or dispatch a read-only '
            + 'child that reports what to change and apply it on a self-round.',
        };
      }
      if (d.retryOf) {
        const target = byId.get(d.retryOf);
        if (!target) return { kind: 'reject', reason: `retryOf ${JSON.stringify(d.retryOf)} names no dispatch on this step` };
        if (target.status !== 'failed') {
          return { kind: 'reject', reason: `retryOf must name a failed dispatch; ${d.retryOf} is ${target.status}` };
        }
        if (target.action !== d.action) {
          return {
            kind: 'reject',
            reason: `retryOf ${d.retryOf} is a ${target.action} dispatch — a retry must name a failed dispatch of the same action`,
          };
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
    return { kind: 'allow', move };
  }

  // A wait naming nothing to wake on can never be satisfied: waitSatisfied has no condition to
  // match, no timer is armed, and the step parks with no gate for the user to resolve. Refuse it
  // at the boundary — a controller reaching for a soak and getting the shape slightly wrong
  // should be told, not hung.
  if (move.kind === 'wait') {
    const w = move.wait;
    if (!w.events?.length && !w.untilAllDispatchesDone && w.resumeAt === undefined) {
      return {
        kind: 'reject',
        reason: 'a wait must name something to wake on: `events` (ci, review-state, pr-state, '
          + 'pr-comments, head-moved, dispatches), `untilAllDispatchesDone: true`, or `resumeAt` '
          + '(epoch ms). To think without parking, take a self-round instead.',
      };
    }
  }

  return { kind: 'allow', move };
}
