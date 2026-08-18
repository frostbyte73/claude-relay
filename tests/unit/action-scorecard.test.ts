import { describe, it, expect } from 'vitest';
import { buildScorecard } from '../../src/actions/scorecard.js';
import type { ActionRunRecord } from '../../src/storage/action-runs-store.js';
import type { ActionDenial } from '../../src/storage/denials-store.js';

const NOW = 1_700_000_000_000;

let seq = 0;
function run(over: Partial<ActionRunRecord> = {}): ActionRunRecord {
  return {
    id: `r${++seq}`, action: 'code.spec', round: 'spec', attempt: 1,
    jobId: 'j1', stepId: `s${seq}`, startedAt: NOW - 1000, ...over,
  };
}

function card(rows: ActionRunRecord[], denials: ActionDenial[] = []) {
  return buildScorecard('code.spec', rows, denials, { now: NOW });
}

describe('buildScorecard rates', () => {
  it('scores accepts, revisions and first-try share', () => {
    const sc = card([
      run({ outcome: 'accepted', attempt: 1 }),
      run({ outcome: 'accepted', attempt: 3 }),
      run({ outcome: 'revised', attempt: 1 }),
      run({ outcome: 'revised', attempt: 2 }),
      run({ outcome: 'failed', attempt: 1 }),
    ]);
    expect(sc.runs).toBe(5);
    expect(sc.acceptRate).toBeCloseTo(2 / 5);
    expect(sc.firstTryRate).toBeCloseTo(1 / 2);
    expect(sc.avgRevisions).toBeCloseTo(1); // (0 + 2) / 2
    expect(sc.outcomes.accepted).toBe(2);
    expect(sc.outcomes.failed).toBe(1);
  });

  it('counts merged as a success', () => {
    const sc = card([run({ round: 'implement', outcome: 'merged', attempt: 1 })]);
    expect(sc.acceptRate).toBe(1);
    expect(sc.firstTryRate).toBe(1);
  });

  it('keeps pending runs out of every denominator', () => {
    const sc = card([
      run({ outcome: 'accepted' }),
      run({ outcome: 'submitted' }),
      run({}),
    ]);
    expect(sc.runs).toBe(3);
    expect(sc.pending).toBe(2);
    expect(sc.acceptRate).toBe(1);
  });

  it('returns null rather than zero when nothing has been adjudicated', () => {
    const sc = card([run({ outcome: 'submitted' })]);
    expect(sc.acceptRate).toBeNull();
    expect(sc.firstTryRate).toBeNull();
    expect(sc.avgRevisions).toBeNull();
    expect(sc.duration.avgMs).toBeNull();
    expect(sc.cost.avgUsd).toBeNull();
  });
});

describe('buildScorecard grouping', () => {
  it('splits by round, busiest first', () => {
    const sc = card([
      run({ round: 'spec', outcome: 'accepted' }),
      run({ round: 'spec', outcome: 'revised' }),
      run({ round: 'plan', outcome: 'accepted' }),
    ]);
    expect(sc.byRound.map((r) => [r.round, r.runs])).toEqual([['spec', 2], ['plan', 1]]);
    expect(sc.byRound[0]!.acceptRate).toBeCloseTo(0.5);
    expect(sc.byRound[1]!.acceptRate).toBe(1);
  });

  it('excludes rows older than the window', () => {
    const sc = buildScorecard('code.spec', [
      run({ outcome: 'accepted', startedAt: NOW - 1000 }),
      run({ outcome: 'failed', startedAt: NOW - 40 * 24 * 60 * 60 * 1000 }),
    ], [], { now: NOW, windowMs: 30 * 24 * 60 * 60 * 1000 });
    expect(sc.runs).toBe(1);
    expect(sc.outcomes.failed).toBe(0);
  });

  it('summarizes duration and cost over rows that have them', () => {
    const sc = card([
      run({ outcome: 'accepted', durationMs: 1000, costUsd: 0.1 }),
      run({ outcome: 'accepted', durationMs: 3000, costUsd: 0.3 }),
      run({ outcome: 'accepted' }),
    ]);
    expect(sc.duration.avgMs).toBe(2000);
    expect(sc.duration.p50Ms).toBe(1000);
    expect(sc.cost.totalUsd).toBeCloseTo(0.4);
    expect(sc.cost.avgUsd).toBeCloseTo(0.2);
  });

  it('lists the most recurrent denials first', () => {
    const denial = (toolName: string, count: number): ActionDenial => ({
      id: toolName, actionName: 'code.spec', sessionId: 'x', toolName, toolInput: {},
      suggested: { kind: 'bash', value: `^${toolName} ` }, at: NOW, count,
    });
    const sc = card([run({ outcome: 'accepted' })], [denial('cd', 2), denial('npx', 5)]);
    expect(sc.denials).toMatchObject({ total: 7, distinct: 2 });
    expect(sc.denials.top.map((d) => d.toolName)).toEqual(['npx', 'cd']);
  });

  it('excludes a verdicted denial from total/distinct/top, same as the improvement pack', () => {
    const denial = (toolName: string, count: number): ActionDenial => ({
      id: toolName, actionName: 'code.spec', sessionId: 'x', toolName, toolInput: {},
      suggested: { kind: 'bash', value: `^${toolName} ` }, at: NOW, count,
    });
    const resolved: ActionDenial = {
      ...denial('cd', 9),
      verdict: { disposition: 'fix-action', reason: 'shell builtin', decidedAt: NOW, decidedBy: 'improver' },
    };
    const sc = card([run({ outcome: 'accepted' })], [resolved, denial('npx', 3)]);
    expect(sc.denials).toMatchObject({ total: 3, distinct: 1 });
    expect(sc.denials.top.map((d) => d.toolName)).toEqual(['npx']);
  });

  it('surfaces recent failures with their reason', () => {
    const sc = card([
      run({ outcome: 'failed', endedAt: NOW, failureReason: 'boom' }),
      run({ outcome: 'gave_up', endedAt: NOW }),
      run({ outcome: 'accepted' }),
    ]);
    expect(sc.failures).toHaveLength(2);
    expect(sc.failures[0]).toMatchObject({ reason: 'boom' });
  });
});
