import { describe, it, expect } from 'vitest';
import { deriveRunEvents, type RunEvent } from '../../src/work/action-run-derive.js';
import type { ActionStep, JobRecord, OpenPrStep, Step } from '../../src/work/work-types.js';

const NOW = 1_700_000_000_000;
const GATED = new Set(['write.linear-comment']);
const OPTS = { now: NOW, isHumanGate: (a: string) => GATED.has(a) };

function job(steps: Step[], over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
    steps, createdAt: 0, updatedAt: 0, ...over,
  };
}

function openPr(over: Partial<OpenPrStep> = {}): OpenPrStep {
  return {
    id: 's1', type: 'open-pr', title: 'step', description: '',
    workspace: { kind: 'writable', repoCwd: '/r', branch: 'b' },
    goal: 'g', approach: 'a', state: 'speccing', sessionId: 'sess1',
    createdAt: 0, updatedAt: 0, ...over,
  };
}

function action(over: Partial<ActionStep> = {}): ActionStep {
  return {
    id: 's1', type: 'action', title: 'step', description: '',
    workspace: { kind: 'none' }, action: 'read.investigate', goal: 'g',
    state: 'running', sessionId: 'sess1', createdAt: 0, updatedAt: 0, ...over,
  };
}

function diff(prev: Step, next: Step): RunEvent[] {
  return deriveRunEvents(job([prev]), job([next]), OPTS);
}

describe('deriveRunEvents — open-pr rounds', () => {
  it('opens a spec run when the step first binds a session', () => {
    const events = deriveRunEvents(
      job([openPr({ sessionId: undefined })]),
      job([openPr()]),
      OPTS,
    );
    expect(events).toEqual([
      { t: 'open', key: { jobId: 'j1', stepId: 's1' }, action: 'code.spec', round: 'spec', sessionId: 'sess1', at: NOW },
    ]);
  });

  it('closes the spec run as submitted when it parks on the gate', () => {
    const events = diff(openPr(), openPr({ state: 'spec_pending_review' }));
    expect(events).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'submitted', at: NOW },
    ]);
  });

  it('accepts the spec and opens the plan round when the user approves', () => {
    const events = diff(openPr({ state: 'spec_pending_review' }), openPr({ state: 'planning' }));
    expect(events).toEqual([
      { t: 'verdict', key: { jobId: 'j1', stepId: 's1' }, round: 'spec', outcome: 'accepted', at: NOW },
      { t: 'open', key: { jobId: 'j1', stepId: 's1' }, action: 'code.plan', round: 'plan', sessionId: 'sess1', at: NOW },
    ]);
  });

  // rejectSpec appends the note and flips state back in one mutate — the verdict has
  // to land on the attempt that was rejected, not on the one replacing it.
  it('verdicts the rejected spec before reopening the next attempt', () => {
    const events = diff(
      openPr({ state: 'spec_pending_review' }),
      openPr({ state: 'speccing', specFeedback: ['tighten the scope'] }),
    );
    expect(events.map((e) => e.t)).toEqual(['verdict', 'open']);
    expect(events[0]).toMatchObject({ round: 'spec', outcome: 'revised', feedbackChars: 17 });
  });

  it('closes plan as accepted and opens implement', () => {
    const events = diff(openPr({ state: 'planning' }), openPr({ state: 'implementing' }));
    expect(events).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'accepted', at: NOW },
      { t: 'open', key: { jobId: 'j1', stepId: 's1' }, action: 'code.implement', round: 'implement', sessionId: 'sess1', at: NOW },
    ]);
  });

  it('leaves implement pending at PR-open and merges it later', () => {
    const opened = diff(
      openPr({ state: 'implementing' }),
      openPr({ state: 'pr_open', prUrl: 'u', prState: 'open' }),
    );
    expect(opened).toEqual([{ t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'submitted', at: NOW }]);

    const merged = diff(
      openPr({ state: 'pr_open', prState: 'open' }),
      openPr({ state: 'merged', prState: 'merged' }),
    );
    expect(merged).toEqual([
      { t: 'verdict', key: { jobId: 'j1', stepId: 's1' }, round: 'implement', outcome: 'merged', at: NOW },
    ]);
  });

  it('scores a ci-fix round by whether it gave up', () => {
    const fixed = diff(
      openPr({ state: 'pr_open', ciFixing: true }),
      openPr({ state: 'pr_open', ciFixing: false }),
    );
    expect(fixed).toEqual([{ t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'accepted', at: NOW }]);

    const gaveUp = diff(
      openPr({ state: 'pr_open', ciFixing: true }),
      openPr({ state: 'pr_open', ciFixing: false, ciFixGaveUp: true }),
    );
    expect(gaveUp).toEqual([{ t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'gave_up', at: NOW }]);
  });

  it('scores an unresolvable conflict as gave_up', () => {
    const events = diff(
      openPr({ state: 'conflicting', conflictResolving: true }),
      openPr({ state: 'conflict_unresolved', conflictResolving: false }),
    );
    expect(events).toEqual([{ t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'gave_up', at: NOW }]);
  });

  it('tracks a triage round through its iteration', () => {
    const running = openPr({
      state: 'comment_pending_response',
      iterations: [{ id: 'i1', kind: 'replies', status: 'in_progress', startedAt: 1 }],
    });
    const posted = openPr({
      state: 'comment_pending_response',
      iterations: [{ id: 'i1', kind: 'replies', status: 'in_progress', startedAt: 1, postedAt: 2 }],
    });
    expect(diff(running, posted)).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'submitted', at: NOW },
    ]);

    const rejected = openPr({
      state: 'comment_pending_response',
      iterations: [{ id: 'i1', kind: 'replies', status: 'rejected', startedAt: 1, postedAt: 2, feedback: 'no' }],
    });
    expect(diff(posted, rejected)).toEqual([
      { t: 'verdict', key: { jobId: 'j1', stepId: 's1' }, round: 'pr-comments', outcome: 'revised', at: NOW, feedbackChars: 2 },
    ]);
  });
});

describe('deriveRunEvents — action steps', () => {
  it('closes a plain action run as accepted when it resolves', () => {
    const events = diff(action(), action({ state: 'resolved' }));
    expect(events).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'accepted', at: NOW },
    ]);
  });

  it('records no run for a meta.wait hold', () => {
    const parked = action({ action: 'meta.wait', state: 'waiting', sessionId: undefined });
    expect(deriveRunEvents(job([action({ action: 'meta.wait', sessionId: undefined })]), job([parked]), OPTS)).toEqual([]);
    expect(deriveRunEvents(undefined, job([parked]), OPTS)).toEqual([]);
  });

  it('records no run for a step materialized but not yet dispatched', () => {
    expect(deriveRunEvents(undefined, job([action({ sessionId: undefined })]), OPTS)).toEqual([]);
  });

  it('walks a human_gate action through draft → redraft → commit', () => {
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });

    expect(deriveRunEvents(undefined, job([gated()]), OPTS)).toMatchObject([
      { t: 'open', round: 'draft' },
    ]);

    const drafted = gated({ state: 'gate_pending_approval', draft: 'body' });
    expect(diff(gated(), drafted)).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'submitted', at: NOW },
    ]);

    const redrafting = gated({ state: 'running', gateFeedback: ['softer'] });
    expect(diff(drafted, redrafting)).toMatchObject([
      { t: 'verdict', round: 'draft', outcome: 'revised', feedbackChars: 6 },
      { t: 'open', round: 'redraft' },
    ]);

    const redrafted = gated({ state: 'gate_pending_approval', gateFeedback: ['softer'] });
    const committing = gated({ state: 'running', gateFeedback: ['softer'], gateApproved: true });
    expect(diff(redrafted, committing)).toMatchObject([
      { t: 'verdict', round: 'redraft', outcome: 'accepted' },
      { t: 'open', round: 'commit' },
    ]);

    expect(diff(committing, gated({ state: 'resolved', gateFeedback: ['softer'], gateApproved: true }))).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'accepted', at: NOW },
    ]);
  });
});

describe('deriveRunEvents — failure and cancellation', () => {
  it('closes the open round as failed, overriding the round rule', () => {
    const events = diff(action(), action({ state: 'failed', failure: { reason: 'boom', at: 5 } }));
    expect(events).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'failed', at: NOW, failureReason: 'boom' },
    ]);
  });

  it('emits exactly one close when a state change and a failure land together', () => {
    const events = diff(
      openPr({ state: 'implementing' }),
      openPr({ state: 'pr_open', prUrl: 'u', failure: { reason: 'boom', at: 5 } }),
    );
    expect(events).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'failed', at: NOW, failureReason: 'boom' },
    ]);
  });

  it('abandons the run when the step is cancelled or disappears', () => {
    expect(diff(action(), action({ cancelled: true }))).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'abandoned', at: NOW },
    ]);
    expect(deriveRunEvents(job([action()]), job([]), OPTS)).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'abandoned', at: NOW },
    ]);
  });
});

describe('deriveRunEvents — orchestrator', () => {
  const planning = (over: Partial<JobRecord> = {}) => job([], {
    state: 'planning',
    orchestratorSessionId: 'orch1',
    events: [{ id: 'e1', at: 1, kind: 'orchestrator_started', who: 'orchestrator', body: 'initial' }],
    ...over,
  });

  it('opens a run labelled with the mode the orchestrator started in', () => {
    expect(deriveRunEvents(job([]), planning(), OPTS)).toEqual([
      { t: 'open', key: { jobId: 'j1' }, action: 'meta.orchestrate', round: 'initial', sessionId: 'orch1', at: NOW },
    ]);
  });

  it('closes as submitted when the plan posts, then accepts it at the gate', () => {
    const posted = planning({ state: 'plan_pending_review' });
    expect(deriveRunEvents(planning(), posted, OPTS)).toEqual([
      { t: 'close', key: { jobId: 'j1' }, outcome: 'submitted', at: NOW },
    ]);
    expect(deriveRunEvents(posted, planning({ state: 'executing' }), OPTS)).toEqual([
      { t: 'verdict', key: { jobId: 'j1' }, outcome: 'accepted', at: NOW },
    ]);
  });

  it('verdicts a rejected plan as revised', () => {
    const posted = planning({ state: 'plan_pending_review' });
    const rejected = planning({
      state: 'planning',
      plan: {
        postedAt: 1,
        iterationsRejected: [{ id: 'i1', steps: [], feedback: 'wrong order', rejectedAt: 2 }],
      },
    });
    expect(deriveRunEvents(posted, rejected, OPTS)).toMatchObject([
      { t: 'verdict', outcome: 'revised', feedbackChars: 11 },
      { t: 'open', round: 'initial' },
    ]);
  });

  it('closes as accepted when a step-review continues instead of replanning', () => {
    const reviewing = planning({
      events: [{ id: 'e1', at: 1, kind: 'orchestrator_started', who: 'orchestrator', body: 'step-review' }],
    });
    expect(deriveRunEvents(reviewing, planning({ state: 'executing' }), OPTS)).toEqual([
      { t: 'close', key: { jobId: 'j1' }, outcome: 'accepted', at: NOW },
    ]);
  });
});
