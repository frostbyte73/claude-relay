import { describe, it, expect } from 'vitest';
import { reconcile, validateDispositions } from '../../src/work/reconcile.js';
import type { ProposedStep, Step } from '../../src/work/work-types.js';

// Defaults to `running`: the disposition-bookkeeping cases below are about keep/drop
// accounting, and a `resolved` step is immutable (see the completed-step describe block), which
// would reject them for an unrelated reason.
function actionStep(id: string, title = id, cancelled = false, state: 'running' | 'resolved' | 'failed' | 'declined' = 'running'): Step {
  return {
    id,
    type: 'action',
    action: 'read.investigate',
    title,
    description: '',
    goal: '',
    workspace: { kind: 'none' },
    state,
    cancelled: cancelled || undefined,
    createdAt: 0,
    updatedAt: 0,
  } as Step;
}

function proposedAction(title: string, keepId?: string): ProposedStep {
  return {
    type: 'action',
    action: 'read.investigate',
    title,
    description: '',
    goal: '',
    workspace: { kind: 'none' },
    ...(keepId ? { keepId } : {}),
  } as ProposedStep;
}

describe('validateDispositions', () => {
  it('accepts a plan that keeps every non-cancelled step', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    const proposed = [proposedAction('s1 kept', 's1'), proposedAction('s2 kept', 's2')];
    expect(validateDispositions(current, proposed, [])).toEqual({ ok: true });
  });

  it('accepts a plan that drops every non-cancelled step', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    expect(validateDispositions(current, [], ['s1', 's2'])).toEqual({ ok: true });
  });

  it('accepts a mixed keep/drop/add plan', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    const proposed = [proposedAction('s1 kept', 's1'), proposedAction('fresh')];
    expect(validateDispositions(current, proposed, ['s2'])).toEqual({ ok: true });
  });

  it('ignores cancelled steps in the disposition check', () => {
    const current = [actionStep('s1'), actionStep('s2', 's2', true)];
    const proposed = [proposedAction('s1 kept', 's1')];
    expect(validateDispositions(current, proposed, [])).toEqual({ ok: true });
  });

  it('rejects a plan that omits a non-cancelled step', () => {
    const current = [actionStep('s1'), actionStep('s2')];
    const result = validateDispositions(current, [proposedAction('s1 kept', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Missing.*s2/);
  });

  it('rejects overlap between keepId and drops', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('s1 kept', 's1')], ['s1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/both kept and dropped/);
  });

  it('rejects an unknown keepId', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('ghost', 'nope'), proposedAction('s1 kept', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/keepId.*nope.*does not match/);
  });

  it('rejects an unknown drop id', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('s1 kept', 's1')], ['nope']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/drop id.*nope.*does not match/);
  });

  it('rejects duplicate keepId across proposed steps', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [proposedAction('a', 's1'), proposedAction('b', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/referenced by more than one/);
  });

  it('rejects duplicate drop ids', () => {
    const current = [actionStep('s1')];
    const result = validateDispositions(current, [], ['s1', 's1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/listed more than once/);
  });
});

describe('validateDispositions — a completed step is history', () => {
  const done = (id: string, title = id) => actionStep(id, title, false, 'resolved');

  it('accepts a resolved step restated verbatim', () => {
    const current = [done('s1')];
    expect(validateDispositions(current, [proposedAction('s1', 's1')], [])).toEqual({ ok: true });
  });

  it('accepts a resolved step whose object-valued fields are restated equal', () => {
    // The planner re-emits `inputs` off fresh JSON every replan, so a reference compare would
    // read every verbatim restatement as a rewrite and there'd be no way to satisfy the guard.
    const current = [{ ...done('s1'), inputs: { subject: 'x', depth: 2 } } as Step];
    const proposed = [{ ...proposedAction('s1', 's1'), inputs: { subject: 'x', depth: 2 } } as ProposedStep];
    expect(validateDispositions(current, proposed, [])).toEqual({ ok: true });
  });

  it('rejects a patch that rewords a resolved step', () => {
    const result = validateDispositions([done('s1', 'Investigate the drop')], [proposedAction('Investigate something else', 's1')], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already completed/);
    expect(result.error).toMatch(/title/);
  });

  it('rejects a patch that swaps a resolved step\'s action', () => {
    const proposed = [{ ...proposedAction('s1', 's1'), action: 'code.review-diff' } as ProposedStep];
    const result = validateDispositions([done('s1')], proposed, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already completed.*action/s);
  });

  it('rejects dropping a resolved step', () => {
    const result = validateDispositions([done('s1'), actionStep('s2')], [proposedAction('s2', 's2')], ['s1']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already completed and cannot be dropped/);
  });

  it('still allows patching and dropping failed / declined steps', () => {
    const current = [actionStep('s1', 'flaky', false, 'failed'), actionStep('s2', 'vetoed', false, 'declined')];
    expect(validateDispositions(current, [proposedAction('retried differently', 's1')], ['s2'])).toEqual({ ok: true });
  });
});

describe('reconcile', () => {
  it('splits proposed into kept + added and passes drops through', () => {
    const current = [actionStep('s1', 'old title'), actionStep('s2')];
    const proposed = [proposedAction('new title', 's1'), proposedAction('brand new')];
    const r = reconcile(current, proposed, ['s2']);
    expect(r.kept).toEqual([{ stepId: 's1', patch: { title: 'new title' } }]);
    expect(r.added).toHaveLength(1);
    expect(r.added[0]!.title).toBe('brand new');
    expect(r.cancelled).toEqual(['s2']);
  });

  it('compares object-valued fields structurally, so a verbatim restatement is not a patch', () => {
    const current = [{ ...actionStep('s1'), inputs: { subject: 'x' } } as Step];
    const proposed = [{ ...proposedAction('s1', 's1'), inputs: { subject: 'x' } } as ProposedStep];
    expect(reconcile(current, proposed, []).kept).toEqual([{ stepId: 's1', patch: {} }]);
  });

  it('does not silently keep a step by matchKey when keepId is missing', () => {
    // In the old world a proposed action step with the same action+title would
    // implicitly match an existing step. In the new world that has to be
    // explicit — same shape without keepId is treated as an addition.
    const current = [actionStep('s1', 'same title')];
    const proposed = [proposedAction('same title')];
    const r = reconcile(current, proposed, ['s1']);
    expect(r.kept).toEqual([]);
    expect(r.added).toHaveLength(1);
    expect(r.cancelled).toEqual(['s1']);
  });
});
