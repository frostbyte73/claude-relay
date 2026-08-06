import { describe, it, expect } from 'vitest';
import { deriveRunEvents, type RunEvent } from '../../src/work/action-run-derive.js';
import type { ActionStep, JobRecord, Step } from '../../src/work/work-types.js';

const NOW = 1_700_000_000_000;
const GATED = new Set(['write.linear-comment']);
const OPTS = { now: NOW, isHumanGate: (a: string) => GATED.has(a) };

function job(steps: Step[], over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
    steps, createdAt: 0, updatedAt: 0, ...over,
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

  // The round rule would score a parked draft as `submitted`; a failure landing in the
  // same mutate has to win, and produce exactly one close.
  it('emits exactly one close when a state change and a failure land together', () => {
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });
    const events = diff(
      gated(),
      gated({ state: 'gate_pending_approval', draft: 'body', failure: { reason: 'boom', at: 5 } }),
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

  // A step-review never parks the job in `planning` — it holds reviewingStepId on top of
  // `executing`, so that flag is what opens and closes the round here.
  it('opens and closes a step-review round off reviewingStepId, not the job state', () => {
    const executing = planning({ state: 'executing' });
    const reviewing = planning({
      state: 'executing',
      reviewingStepId: 's1',
      events: [{ id: 'e1', at: 1, kind: 'orchestrator_started', who: 'orchestrator', body: 'step-review' }],
    });
    expect(deriveRunEvents(executing, reviewing, OPTS)).toEqual([
      { t: 'open', key: { jobId: 'j1' }, action: 'meta.orchestrate', round: 'step-review', sessionId: 'orch1', at: NOW },
    ]);
    expect(deriveRunEvents(reviewing, executing, OPTS)).toEqual([
      { t: 'close', key: { jobId: 'j1' }, outcome: 'accepted', at: NOW },
    ]);
  });
});
