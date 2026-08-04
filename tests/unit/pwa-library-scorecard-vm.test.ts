import { describe, it, expect } from 'vitest';
// @ts-expect-error — PWA modules are plain ES modules with no type declarations.
import { outcomeTone, scorecardRows, scorecardTiles } from '../../src/pwa/vm/library.js';

const NOW = 1_700_000_000_000;

function tile(sc: unknown, key: string) {
  return scorecardTiles(sc).find((t: { key: string }) => t.key === key);
}

describe('outcomeTone', () => {
  it('maps successes, revisions and failures to distinct tones', () => {
    expect(outcomeTone('accepted')).toBe('ok');
    expect(outcomeTone('merged')).toBe('ok');
    expect(outcomeTone('revised')).toBe('warn');
    expect(outcomeTone('failed')).toBe('hot');
    expect(outcomeTone('gave_up')).toBe('hot');
    expect(outcomeTone('interrupted')).toBe('idle');
    expect(outcomeTone(undefined)).toBe('info');
  });
});

describe('scorecardTiles', () => {
  // A null rate means nothing has been adjudicated — rendering 0% would read as
  // "this action always fails", which is the opposite of the truth.
  it('renders an unscored action as em-dashes, not zeroes', () => {
    const sc = { runs: 2, firstTryRate: null, avgRevisions: null, outcomes: {}, denials: { total: 0 }, cost: {} };
    expect(tile(sc, 'first-try')).toMatchObject({ value: '—', tone: 'idle' });
    expect(tile(sc, 'revisions')?.value).toBe('—');
    expect(tile(sc, 'cost')?.value).toBe('—');
    expect(tile(sc, 'runs')?.value).toBe('2');
  });

  it('formats rates and flags failures and denials', () => {
    const sc = {
      runs: 10, firstTryRate: 0.666, avgRevisions: 0.75,
      outcomes: { failed: 1, gave_up: 2 },
      denials: { total: 4 },
      cost: { avgUsd: 0.25 },
    };
    expect(tile(sc, 'first-try')?.value).toBe('67%');
    expect(tile(sc, 'revisions')).toMatchObject({ value: '0.8', tone: 'warn' });
    expect(tile(sc, 'failures')).toMatchObject({ value: '3', tone: 'hot' });
    expect(tile(sc, 'denials')).toMatchObject({ value: '4', tone: 'warn' });
    expect(tile(sc, 'cost')?.value).toBe('$0.25');
  });

  it('returns nothing without a card', () => {
    expect(scorecardTiles(null)).toEqual([]);
  });
});

describe('scorecardRows', () => {
  it('projects runs into row shapes with tone and formatted metadata', () => {
    const rows = scorecardRows({
      recent: [
        { id: 'r1', round: 'spec', attempt: 2, outcome: 'accepted', durationMs: 65_000, costUsd: 1.5, startedAt: NOW - 3_600_000, jobId: 'j1' },
        { id: 'r2', round: 'implement', attempt: 1, startedAt: NOW, jobId: 'j2' },
      ],
    }, NOW);
    expect(rows[0]).toMatchObject({
      round: 'spec', attempt: 2, outcome: 'accepted', tone: 'ok',
      durationText: '1m 05s', costText: '$1.50', whenText: '1h ago', jobId: 'j1',
    });
    expect(rows[1]).toMatchObject({ outcome: 'submitted', tone: 'info', durationText: '—', costText: '—' });
  });
});
