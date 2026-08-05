import type { JobRecord, OpenPrStep } from '../work/work-types.js';
import { handlerFor } from '../steps/index.js';

// JobTransitions are pure, side-effect-free descriptions of what the orchestrator
// should do next at the job level. The orchestrator turns them into actual writes
// (state mutation, Linear API calls). Keep this file pure — no imports from
// orchestrator, session-manager, linear-writer, etc.

export type JobTransition =
  | { kind: 'mark-done' }
  | { kind: 'mark-failed' }
  | { kind: 'mark-linear-state'; state: 'inProgress' | 'inReview' | 'done' };

function allStepsResolved(j: JobRecord): boolean {
  if (j.steps.length === 0) return false;
  return j.steps.every((s) => handlerFor(s).isResolved(s) || s.cancelled);
}

// The id of a representative step in the earliest fully-settled parallel group
// that still has an unreviewed, non-cancelled member — or null if nothing is
// owed a review. tickOne uses this to run the orchestrator once after each group
// settles, before advancing to the next group or marking the job done. Failures
// halt the job (mark-failed) instead, so we never review over a failed plan.
export function owesStepReview(j: JobRecord): string | null {
  if (j.state !== 'executing') return null;
  if (j.reviewingStepId) return null;  // one already in flight
  if (j.steps.some((s) => !s.cancelled && s.failure)) return null;
  const steps = j.steps;
  let i = 0;
  while (i < steps.length) {
    const groupKey = steps[i]!.parallelGroup ?? `__solo_${i}`;
    let k = i;
    while (k < steps.length && (steps[k]!.parallelGroup ?? `__solo_${k}`) === groupKey) k++;
    const members = steps.slice(i, k);
    const settled = members.every((s) => s.cancelled || handlerFor(s).isResolved(s));
    if (!settled) return null;  // earlier group still running — nothing to review yet
    const unreviewed = members.find((s) => !s.cancelled && !s.reviewed);
    if (unreviewed) return unreviewed.id;
    i = k;
  }
  return null;
}

function linearReady(j: JobRecord): j is JobRecord & { externalRef: { linearUuid: string } } {
  return j.source === 'linear' && !!j.externalRef?.linearUuid;
}

function hasUncancelledOpenPr(j: JobRecord): boolean {
  return j.steps.some((s) => s.type === 'open-pr' && !s.cancelled);
}

function allOpenPrsHaveRemotePr(j: JobRecord): boolean {
  return j.steps
    .filter((s): s is OpenPrStep => s.type === 'open-pr' && !s.cancelled)
    .every((s) => s.prState === 'open' || s.prState === 'merged');
}

// Pure decision: given a job record, what job-level transitions are needed?
// Caller is responsible for executing them in order. Returning multiple
// transitions in one call is fine — they don't conflict (e.g. you can mark a
// job done AND mark Linear done in the same tick).
export function decideJobTransitions(j: JobRecord): JobTransition[] {
  if (j.state === 'failed' || j.state === 'abandoned') return [];

  // An already-done job still owes Linear its done-write if the write hasn't landed:
  // mark-done is emitted before mark-linear-state in the same batch below, so a throw
  // on the Linear call leaves a done job whose ticket never moved. Re-emitting here is
  // what makes the orchestrator's retry-next-tick reachable at all.
  if (j.state === 'done') {
    return linearReady(j) && !j.linearStateMarked?.done
      ? [{ kind: 'mark-linear-state', state: 'done' }]
      : [];
  }

  const out: JobTransition[] = [];

  // A failed step halts the plan: never advance to later steps. Settle the job into
  // the terminal `failed` state so the halt is surfaced (not silently stuck in
  // `executing`). onStepRetry/rerunLatest restore it to `executing` on retry.
  if (j.state === 'executing' && j.steps.some((s) => !s.cancelled && s.failure)) {
    return [{ kind: 'mark-failed' }];
  }

  if (j.state === 'executing' && allStepsResolved(j)) {
    out.push({ kind: 'mark-done' });
    if (linearReady(j) && !j.linearStateMarked?.done) {
      out.push({ kind: 'mark-linear-state', state: 'done' });
    }
    return out;  // terminal — don't double-emit inProgress/inReview when also marking done
  }

  if (j.state === 'executing' && linearReady(j)) {
    if (!j.linearStateMarked?.inProgress) {
      out.push({ kind: 'mark-linear-state', state: 'inProgress' });
    }
    if (!j.linearStateMarked?.inReview && hasUncancelledOpenPr(j) && allOpenPrsHaveRemotePr(j)) {
      out.push({ kind: 'mark-linear-state', state: 'inReview' });
    }
  }

  return out;
}
