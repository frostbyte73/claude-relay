import { describe, it, expect } from 'vitest';
import { decideJobTransitions, owesStepReview } from '../../src/jobs/lifecycle.js';
import type { JobRecord, Step } from '../../src/work/work-types.js';

function actionStep(id: string, over: Partial<Step> = {}): Step {
  return {
    id, type: 'action', action: 'read.investigate', title: id, description: '',
    goal: '', state: 'resolved', workspace: { kind: 'none' },
    createdAt: 1, updatedAt: 1, ...over,
  } as Step;
}
function job(steps: Step[], over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j', source: 'manual', title: 't', description: 'd', state: 'executing',
    steps, createdAt: 1, updatedAt: 1, ...over,
  } as JobRecord;
}

describe('owesStepReview', () => {
  it('returns the step id of a settled, unreviewed solo group', () => {
    expect(owesStepReview(job([actionStep('a')]))).toBe('a');
  });

  it('returns null once the settled group is marked reviewed', () => {
    expect(owesStepReview(job([actionStep('a', { reviewed: true })]))).toBeNull();
  });

  it('returns null while a sibling in the same parallel group is still running', () => {
    const steps = [
      actionStep('a', { parallelGroup: 'g1' }),
      actionStep('b', { parallelGroup: 'g1', state: 'running' }),
    ];
    expect(owesStepReview(job(steps))).toBeNull();
  });

  it('advances to a later settled+unreviewed group after the first is reviewed', () => {
    const steps = [actionStep('a', { reviewed: true }), actionStep('b')];
    expect(owesStepReview(job(steps))).toBe('b');
  });

  it('returns null when any step has a failure (job halts instead)', () => {
    const steps = [actionStep('a'), actionStep('b', { failure: { reason: 'x', at: 1 } })];
    expect(owesStepReview(job(steps))).toBeNull();
  });

  it('returns null when the job is not executing', () => {
    expect(owesStepReview(job([actionStep('a')], { state: 'planning' }))).toBeNull();
  });

  it('skips cancelled members and reviews the group on its live member', () => {
    const steps = [
      actionStep('a', { parallelGroup: 'g1', cancelled: true }),
      actionStep('b', { parallelGroup: 'g1' }),
    ];
    expect(owesStepReview(job(steps))).toBe('b');
  });
});

describe('decideJobTransitions (post-overhaul)', () => {
  it('marks done when all steps resolved (no auto-replan gate)', () => {
    const t = decideJobTransitions(job([actionStep('a'), actionStep('b')]));
    expect(t.some((x) => x.kind === 'mark-done')).toBe(true);
    expect(t.some((x) => (x as { kind: string }).kind === 'auto-replan')).toBe(false);
  });

  it('marks failed when a step failed', () => {
    const steps = [actionStep('a', { failure: { reason: 'x', at: 1 } })];
    expect(decideJobTransitions(job(steps))).toEqual([{ kind: 'mark-failed' }]);
  });

  // mark-done lands before mark-linear-state in the same batch, so a throw on the
  // Linear call leaves an already-done job owing the write. Re-emitting for `done`
  // is the only thing that makes the retry-next-tick path reachable.
  it('re-emits the Linear done-write for an already-done job that never got one', () => {
    const j = job([actionStep('a')], {
      state: 'done', source: 'linear', externalRef: { url: 'https://linear.app/x', linearUuid: 'u' },
    });
    expect(decideJobTransitions(j)).toEqual([{ kind: 'mark-linear-state', state: 'done' }]);
  });

  it('emits nothing for a done job whose Linear state already landed', () => {
    const j = job([actionStep('a')], {
      state: 'done', source: 'linear', externalRef: { url: 'https://linear.app/x', linearUuid: 'u' },
      linearStateMarked: { done: true },
    });
    expect(decideJobTransitions(j)).toEqual([]);
  });

  it('emits nothing for terminal jobs that owe Linear nothing', () => {
    for (const state of ['done', 'failed', 'abandoned'] as const) {
      expect(decideJobTransitions(job([actionStep('a')], { state }))).toEqual([]);
    }
  });
});
