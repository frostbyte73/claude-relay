import { describe, it, expect } from 'vitest';
import { deriveRunEvents, type RunEvent } from '../../src/work/action-run-derive.js';
import type { ActionStep, JobRecord, Step } from '../../src/work/work-types.js';
import type { WriteDraft } from '../../src/work/write-draft.js';

const NOW = 1_700_000_000_000;
const OPTS = { now: NOW };

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

  // A step is no longer gated by frontmatter — it's gated by whether it actually raises a
  // draft. So a fresh write.* step opens as an ordinary `run`, exactly like read.investigate,
  // right up until it calls submit_write_draft.
  it('walks a step from a plain run through draft → redraft → commit once it raises one', () => {
    const draft1: WriteDraft = {
      id: 'd1', action: 'write.linear-comment', raisedBy: { kind: 'step' },
      summary: 's', calls: [], requestedAt: 0,
    };
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });

    expect(deriveRunEvents(undefined, job([gated()]), OPTS)).toMatchObject([
      { t: 'open', round: 'run' },
    ]);

    // First draft: the plain `run` closes (accepted — the prep phase went fine) and a
    // `draft` round opens for the payload the user now has to rule on.
    const drafted = gated({ state: 'gate_pending_approval', drafts: [draft1] });
    expect(diff(gated(), drafted)).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'accepted', at: NOW },
      { t: 'open', key: { jobId: 'j1', stepId: 's1' }, action: 'write.linear-comment', round: 'draft', sessionId: 'sess1', at: NOW },
    ]);

    // Propose changes: the draft round closes with a `revised` verdict and a `redraft`
    // round opens for the session's next attempt.
    const redrafting = gated({ state: 'running', drafts: [{ ...draft1, feedback: ['softer'] }] });
    expect(diff(drafted, redrafting)).toMatchObject([
      { t: 'close', outcome: 'submitted' },
      { t: 'verdict', round: 'draft', outcome: 'revised', feedbackChars: 6 },
      { t: 'open', round: 'redraft' },
    ]);

    // The session resubmits the same redraft round (same feedback, so nothing to verdict
    // yet) and parks again — this snapshot feeds the next transition below.
    const redrafted = gated({ state: 'gate_pending_approval', drafts: [{ ...draft1, feedback: ['softer'] }] });

    // Accept: the redraft round closes with an `accepted` verdict and a `commit` round
    // opens for the session to actually perform the write.
    const committing = gated({ state: 'running', drafts: [{ ...draft1, feedback: ['softer'], approvedAt: NOW, calls: [] }] });
    expect(diff(redrafted, committing)).toMatchObject([
      { t: 'close', outcome: 'submitted' },
      { t: 'verdict', round: 'redraft', outcome: 'accepted' },
      { t: 'open', round: 'commit' },
    ]);

    expect(diff(committing, gated({
      state: 'resolved', drafts: [{ ...draft1, feedback: ['softer'], approvedAt: NOW, calls: [] }],
    }))).toEqual([
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'accepted', at: NOW },
    ]);
  });

  it('denies a first draft outright: one close, then a denied verdict, no open', () => {
    const draft1: WriteDraft = {
      id: 'd1', action: 'write.linear-comment', raisedBy: { kind: 'step' },
      summary: 's', calls: [], requestedAt: 0,
    };
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });
    const drafted = gated({ state: 'gate_pending_approval', drafts: [draft1] });
    // denyDraft drops the draft but leaves `state` untouched — declineStep flips it to
    // `declined` in a separate mutation (see engine.ts's denyDraft wiring).
    const denied = gated({ state: 'gate_pending_approval', drafts: [] });
    expect(diff(drafted, denied)).toEqual([
      // The round rule closes first (nothing left pending reads as "submitted"); the
      // verdict lands right after and overwrites that outcome to `denied`.
      { t: 'close', key: { jobId: 'j1', stepId: 's1' }, outcome: 'submitted', at: NOW },
      { t: 'verdict', key: { jobId: 'j1', stepId: 's1' }, round: 'draft', outcome: 'denied', at: NOW },
    ]);
    expect(diff(denied, gated({ state: 'declined', drafts: [] }))).toEqual([]);
  });

  it('denying the SECOND of two gated writes is not misscored as accepted', () => {
    const draft1: WriteDraft = {
      id: 'd1', action: 'write.linear-comment', raisedBy: { kind: 'step' },
      summary: 'first', calls: [], requestedAt: 0, approvedAt: 500,
    };
    const draft2: WriteDraft = {
      id: 'd2', action: 'write.linear-comment', raisedBy: { kind: 'step' },
      summary: 'second', calls: [], requestedAt: 600,
    };
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });
    // draft1 already accepted and sitting around; draft2 is the one pending review.
    const pending = gated({ state: 'gate_pending_approval', drafts: [draft1, draft2] });
    const denied = gated({ state: 'gate_pending_approval', drafts: [draft1] });
    expect(diff(pending, denied)).toMatchObject([
      { t: 'close', outcome: 'submitted' },
      { t: 'verdict', round: 'draft', outcome: 'denied' },
    ]);
  });

  // onStepRetry clears `drafts` unconditionally as part of resetting the step for another
  // attempt — that's an abandoned round (the close path already scores it), not a ruling by
  // the user, so it must not also fabricate a `denied` verdict.
  it('retrying a step parked on a pending draft does not emit a denied verdict', () => {
    const draft1: WriteDraft = {
      id: 'd1', action: 'write.linear-comment', raisedBy: { kind: 'step' },
      summary: 's', calls: [], requestedAt: 0,
    };
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });
    const drafted = gated({ state: 'gate_pending_approval', drafts: [draft1] });
    const retried = gated({ state: 'running', drafts: undefined, sessionId: undefined });
    const events = diff(drafted, retried);
    expect(events.some((e) => e.t === 'verdict')).toBe(false);
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
    const draft1: WriteDraft = {
      id: 'd1', action: 'write.linear-comment', raisedBy: { kind: 'step' },
      summary: 's', calls: [], requestedAt: 0,
    };
    const gated = (over: Partial<ActionStep> = {}) => action({ action: 'write.linear-comment', ...over });
    const events = diff(
      gated(),
      gated({ state: 'gate_pending_approval', drafts: [draft1], failure: { reason: 'boom', at: 5 } }),
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
