import { describe, it, expect } from 'vitest';
import { evaluateHeadroom, type TokenUsageSnapshot } from '../../src/schedules/headroom.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function snap(sevenUsed: number, msUntilReset: number, fiveUsed = 10): TokenUsageSnapshot {
  return {
    five_hour: { used_percentage: fiveUsed, resets_at: Math.floor((NOW + 5 * 60 * 60 * 1000) / 1000) },
    seven_day: { used_percentage: sevenUsed, resets_at: Math.floor((NOW + msUntilReset) / 1000) },
  };
}

describe('evaluateHeadroom codes', () => {
  it('no-data when the snapshot is missing', () => {
    const decision = evaluateHeadroom(undefined, NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('no-data');
  });

  it('no-data when the 7d reset is already in the past (stale snapshot)', () => {
    const decision = evaluateHeadroom(snap(30, -DAY), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('no-data');
  });

  it('five-hour-ceiling when the 5h window is at/over the ceiling', () => {
    const decision = evaluateHeadroom(snap(40, 3 * 60 * 60 * 1000, 80), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('five-hour-ceiling');
  });

  it('ahead-of-pace when 7d spending is ahead of the elapsed fraction', () => {
    const decision = evaluateHeadroom(snap(60, 5 * DAY), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.code).toBe('ahead-of-pace');
  });

  it('ok when there is headroom to launch', () => {
    const decision = evaluateHeadroom(snap(40, 3 * 60 * 60 * 1000), NOW);
    expect(decision.launch).toBe(true);
    expect(decision.code).toBe('ok');
  });
});
