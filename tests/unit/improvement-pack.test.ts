import { describe, it, expect } from 'vitest';
import {
  buildImprovementPack, EXCLUDED_ACTIONS, lastImproverReviewAt, parsePackOpts, selectActionToImprove,
  type ImprovementPackDeps,
} from '../../src/actions/improvement-pack.js';
import type { ActionRunOutcome, ActionRunRecord } from '../../src/storage/action-runs-store.js';
import type { ActionDenial, DenialVerdict } from '../../src/storage/denials-store.js';
import type { ActionEvent } from '../../src/storage/action-revisions-store.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

let runSeq = 0;
function run(overrides: Partial<ActionRunRecord> = {}): ActionRunRecord {
  return {
    id: `r${++runSeq}`,
    action: 'read.investigate',
    round: 'initial',
    attempt: 1,
    jobId: 'j1',
    startedAt: NOW - HOUR,
    outcome: 'accepted',
    ...overrides,
  };
}

function runs(n: number, outcome: ActionRunOutcome = 'accepted', startedAt = NOW - HOUR): ActionRunRecord[] {
  return Array.from({ length: n }, () => run({ outcome, startedAt }));
}

function denial(overrides: Partial<ActionDenial> = {}): ActionDenial {
  return {
    id: 'd1',
    actionName: 'read.investigate',
    sessionId: 's1',
    toolName: 'Bash',
    toolInput: {},
    suggested: { kind: 'bash', value: '^rg ' },
    at: NOW - HOUR,
    count: 3,
    ...overrides,
  };
}

function verdict(overrides: Partial<DenialVerdict> = {}): DenialVerdict {
  return {
    disposition: 'never', reason: 'not a permission gap', decidedAt: NOW - HOUR, decidedBy: 'user',
    ...overrides,
  };
}

function event(overrides: Partial<ActionEvent> = {}): ActionEvent {
  return { id: 'e1', action: 'read.investigate', kind: 'applied', at: NOW - HOUR, author: 'improver', ...overrides };
}

function deps(over: Partial<ImprovementPackDeps> = {}): ImprovementPackDeps {
  return {
    listActionNames: () => ['read.investigate'],
    runsFor: () => [],
    denialsFor: () => [],
    revisionsFor: () => [],
    lessonsFor: () => [],
    skillMdFor: () => 'body\n',
    pendingEdits: () => [],
    now: () => NOW,
    ...over,
  };
}

describe('lastImproverReviewAt', () => {
  it('takes the newest of the improver\'s reviewed / proposed / applied events', () => {
    expect(lastImproverReviewAt([
      event({ kind: 'reviewed', at: 100 }),
      event({ kind: 'applied', at: 300 }),
      event({ kind: 'proposed', at: 200 }),
    ])).toBe(300);
  });

  it('ignores events the user authored', () => {
    expect(lastImproverReviewAt([event({ kind: 'applied', at: 500, author: 'user' })])).toBeUndefined();
  });

  it('ignores improver events that are not a review verdict', () => {
    expect(lastImproverReviewAt([event({ kind: 'rejected', at: 500 })])).toBeUndefined();
  });
});

describe('selectActionToImprove — eligibility', () => {
  it('skips an action below the run threshold with no recurring denial', () => {
    expect(selectActionToImprove(deps({ runsFor: () => runs(19) }), { minRuns: 20 })).toBeNull();
  });

  it('admits an action at exactly the threshold', () => {
    const r = selectActionToImprove(deps({ runsFor: () => runs(20) }), { minRuns: 20 });
    expect(r?.action).toBe('read.investigate');
  });

  it('does not count pending runs toward the threshold', () => {
    // `submitted` means no gate has ruled — it carries no signal about quality yet.
    expect(selectActionToImprove(deps({ runsFor: () => runs(30, 'submitted') }), { minRuns: 20 })).toBeNull();
  });

  it('does not count runs that predate the last review', () => {
    // Otherwise every fire would re-review the same action off the same evidence.
    const d = deps({
      runsFor: () => runs(30, 'accepted', NOW - 10 * HOUR),
      revisionsFor: () => [event({ kind: 'reviewed', at: NOW - 5 * HOUR })],
    });
    expect(selectActionToImprove(d, { minRuns: 20 })).toBeNull();
  });

  it('admits an action below the run threshold when a denial keeps recurring', () => {
    const d = deps({ runsFor: () => runs(2), denialsFor: () => [denial({ count: 4 })] });
    expect(selectActionToImprove(d, { minRuns: 20 })?.action).toBe('read.investigate');
  });

  it('ignores a one-off denial', () => {
    const d = deps({ runsFor: () => runs(2), denialsFor: () => [denial({ count: 1 })] });
    expect(selectActionToImprove(d, { minRuns: 20 })).toBeNull();
  });

  it('ignores a recurring denial last seen before the previous review', () => {
    const d = deps({
      runsFor: () => runs(2),
      denialsFor: () => [denial({ count: 4, at: NOW - 10 * HOUR })],
      revisionsFor: () => [event({ kind: 'reviewed', at: NOW - 5 * HOUR })],
    });
    expect(selectActionToImprove(d, { minRuns: 20 })).toBeNull();
  });
});

describe('selectActionToImprove — exclusions', () => {
  it('never selects either self-referential action', () => {
    const d = deps({ listActionNames: () => EXCLUDED_ACTIONS, runsFor: () => runs(50, 'failed') });
    expect(selectActionToImprove(d, { minRuns: 20 })).toBeNull();
  });

  it('honours a schedule-supplied exclusion list', () => {
    const d = deps({ runsFor: () => runs(50) });
    expect(selectActionToImprove(d, { minRuns: 20, exclude: ['read.investigate'] })).toBeNull();
  });

  it('skips an action the user is already editing', () => {
    const d = deps({
      runsFor: () => runs(50),
      pendingEdits: () => [{ actionName: 'read.investigate' }],
    });
    expect(selectActionToImprove(d, { minRuns: 20 })).toBeNull();
  });

  it('stops entirely once maxPending improver proposals await review', () => {
    const d = deps({
      listActionNames: () => ['code.spec'],
      runsFor: () => runs(50),
      pendingEdits: () => [
        { actionName: 'a.b', authorAction: 'meta.improve-actions' },
        { actionName: 'c.d', authorAction: 'meta.improve-actions' },
      ],
    });
    expect(selectActionToImprove(d, { minRuns: 20, maxPending: 2 })).toBeNull();
  });

  it('does not count a user edit toward the improver backlog cap', () => {
    const d = deps({
      runsFor: () => runs(50),
      pendingEdits: () => [{ actionName: 'other.thing' }],
    });
    expect(selectActionToImprove(d, { minRuns: 20, maxPending: 1 })?.action).toBe('read.investigate');
  });
});

describe('selectActionToImprove — ranking', () => {
  it('weighs a failure above a send-back at equal counts', () => {
    const byAction: Record<string, ActionRunRecord[]> = {
      'code.spec': [...runs(20), ...runs(3, 'failed')],
      'code.plan': [...runs(20), ...runs(3, 'revised')],
    };
    const d = deps({
      listActionNames: () => ['code.plan', 'code.spec'],
      runsFor: (a) => byAction[a] ?? [],
    });
    expect(selectActionToImprove(d, { minRuns: 20 })?.action).toBe('code.spec');
  });

  it('breaks a tie by longest-unreviewed', () => {
    const reviewedAt: Record<string, number> = {
      'code.spec': NOW - 2 * HOUR,
      'code.plan': NOW - 50 * HOUR,
    };
    const d = deps({
      listActionNames: () => ['code.spec', 'code.plan'],
      runsFor: () => runs(30, 'accepted', NOW - HOUR),
      revisionsFor: (a) => [event({ kind: 'reviewed', at: reviewedAt[a]! })],
    });
    expect(selectActionToImprove(d, { minRuns: 20 })?.action).toBe('code.plan');
  });

  it('explains why it picked what it picked', () => {
    const d = deps({ runsFor: () => runs(24) });
    expect(selectActionToImprove(d, { minRuns: 20 })?.reason)
      .toBe('read.investigate: 24 new adjudicated runs, never reviewed');
  });
});

describe('parsePackOpts', () => {
  it('takes valid numeric and list overrides off a schedule\'s args', () => {
    expect(parsePackOpts({ minRuns: 50, maxPending: 1, exclude: ['a.b'] }))
      .toEqual({ minRuns: 50, maxPending: 1, exclude: ['a.b'] });
  });

  it('falls back to defaults rather than letting bad input reach the comparisons', () => {
    expect(parsePackOpts({ minRuns: 'twenty', maxPending: -1, exclude: 'nope', windowMs: NaN })).toEqual({});
    expect(parsePackOpts(undefined)).toEqual({});
  });
});

describe('buildImprovementPack', () => {
  it('carries citable run ids for every failure and send-back', () => {
    const failed = run({ id: 'boom', outcome: 'failed', failureReason: 'timed out' });
    const revised = run({ id: 'sent-back', outcome: 'revised', feedbackChars: 240 });
    const pack = buildImprovementPack('read.investigate', deps({ runsFor: () => [failed, revised] }));

    expect(pack.failures).toHaveLength(1);
    expect(pack.failures[0]).toMatchObject({ runId: 'boom', reason: 'timed out' });
    expect(pack.revisions[0]).toMatchObject({ runId: 'sent-back', feedbackChars: 240 });
  });

  it('includes previously rejected proposals so they are not re-proposed', () => {
    const d = deps({
      revisionsFor: () => [event({ kind: 'rejected', at: NOW - HOUR, rationale: 'add a step', feedback: 'too vague' })],
    });
    const pack = buildImprovementPack('read.investigate', d);
    expect(pack.rejectedProposals[0]).toMatchObject({ rationale: 'add a step', feedback: 'too vague' });
  });

  it('reports the previous review and the current body size', () => {
    const d = deps({
      skillMdFor: () => 'a\nb\nc\n',
      revisionsFor: () => [event({ kind: 'reviewed', at: NOW - 3 * HOUR, rationale: 'all clean' })],
    });
    const pack = buildImprovementPack('read.investigate', d, {}, 'because');
    expect(pack.currentLineCount).toBe(3);
    expect(pack.whySelected).toBe('because');
    expect(pack.previousReview).toEqual({ at: NOW - 3 * HOUR, rationale: 'all clean' });
  });

  it('includes a one-off denial in the pack, newest first', () => {
    // Pack contents and election ask different questions (see selectActionToImprove —
    // ignores a one-off denial, above): a single denial can't elect an action for review, but
    // once an action is already being reviewed it belongs in the evidence.
    const d = deps({
      denialsFor: () => [
        denial({ id: 'once', count: 1, at: NOW - HOUR }),
        denial({ id: 'again', count: 5, at: NOW - 2 * HOUR }),
      ],
    });
    const pack = buildImprovementPack('read.investigate', d);
    expect(pack.denials.map((x) => x.id)).toEqual(['once', 'again']);
  });

  it('caps the denials list and states the cap rather than truncating silently', () => {
    const many = Array.from({ length: 25 }, (_, i) => denial({ id: `d${i}`, count: 1, at: NOW - i * HOUR }));
    const pack = buildImprovementPack('read.investigate', deps({ denialsFor: () => many }));
    expect(pack.denials).toHaveLength(20);
    expect(pack.denials[0]).toMatchObject({ id: 'd0' });
    expect(pack.denialsCap).toBe(20);
    expect(pack.denialsTotal).toBe(25);
  });

  it('excludes a verdicted denial and carries the id of an unresolved one', () => {
    const d = deps({
      denialsFor: () => [
        denial({ id: 'resolved', count: 5, verdict: verdict() }),
        denial({ id: 'open', count: 5 }),
      ],
    });
    const pack = buildImprovementPack('read.investigate', d);
    expect(pack.denials).toHaveLength(1);
    expect(pack.denials[0]).toMatchObject({ id: 'open' });
  });

  it('caps each evidence list so a long-lived action stays a curated trace', () => {
    const d = deps({ runsFor: () => runs(40, 'failed') });
    expect(buildImprovementPack('read.investigate', d).failures).toHaveLength(15);
  });
});
