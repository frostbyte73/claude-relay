// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { stepDurationText, terminalChipVariant, renderTerminalChipHtml } from '../../src/pwa/components/work/session-terminal-chip.js';

const T0 = 1_700_000_000_000;
const SEC = 1000;

function step(overrides: any = {}) {
  return {
    id: 's1',
    type: 'action',
    state: 'running',
    createdAt: T0,
    updatedAt: T0 + 3 * SEC,
    events: [],
    ...overrides,
  };
}

describe('stepDurationText', () => {
  it('sub-minute → "Xs"', () => {
    const s = step({
      events: [
        { kind: 'spawned', at: T0 },
        { kind: 'resolved', at: T0 + 42 * SEC },
      ],
    });
    expect(stepDurationText(s)).toBe('42s');
  });

  it('minute range → "MmSSs"', () => {
    const s = step({
      events: [
        { kind: 'spawned', at: T0 },
        { kind: 'resolved', at: T0 + (3 * 60 + 52) * SEC },
      ],
    });
    expect(stepDurationText(s)).toBe('3m52s');
  });

  it('hour range → "HhMMm"', () => {
    const s = step({
      events: [
        { kind: 'spawned', at: T0 },
        { kind: 'resolved', at: T0 + (60 + 4) * 60 * SEC },
      ],
    });
    expect(stepDurationText(s)).toBe('1h04m');
  });

  it('failed step: uses failure.at as end', () => {
    const s = step({
      state: 'failed',
      failure: { reason: 'x', at: T0 + 10 * SEC },
      events: [{ kind: 'spawned', at: T0 }],
    });
    expect(stepDurationText(s)).toBe('10s');
  });

  it('no spawned event: no duration (createdAt is plan-authoring time, not run start)', () => {
    const s = step({
      events: [{ kind: 'resolved', at: T0 + 5 * SEC }],
    });
    expect(stepDurationText(s)).toBe('');
  });

  it('terminal but no run events: no duration (never createdAt→updatedAt)', () => {
    // A legacy/merged step whose timeline lacks step_started/step_merged: the chip
    // must show a bare "Finished", not a fabricated span from createdAt→updatedAt.
    const s = step({ type: 'open-pr', state: 'merged', events: [], createdAt: T0, updatedAt: T0 + 92 * 3600 * SEC });
    expect(stepDurationText(s)).toBe('');
  });

  it('cancelled with no start: returns empty', () => {
    const s = step({ cancelled: true, events: [], createdAt: 0, updatedAt: 0 });
    expect(stepDurationText(s)).toBe('');
  });
});

describe('terminalChipVariant', () => {
  it('action resolved → finished', () => {
    expect(terminalChipVariant(step({ state: 'resolved' }))).toBe('finished');
  });
  it('orchestrated step whose PR landed → finished (it settles on resolved, phase merged)', () => {
    expect(terminalChipVariant(step({ type: 'orchestrated', state: 'resolved', phase: 'merged' }))).toBe('finished');
  });
  it('failed → failed', () => {
    expect(terminalChipVariant(step({ failure: { reason: 'x', at: T0 } }))).toBe('failed');
  });
  it('cancelled → cancelled', () => {
    expect(terminalChipVariant(step({ cancelled: true }))).toBe('cancelled');
  });
  it('running → null', () => {
    expect(terminalChipVariant(step({ state: 'running' }))).toBeNull();
  });
});

describe('renderTerminalChipHtml', () => {
  it('finished with duration', () => {
    const s = step({
      state: 'resolved',
      events: [
        { kind: 'spawned', at: T0 },
        { kind: 'resolved', at: T0 + 3 * SEC },
      ],
    });
    const html = renderTerminalChipHtml(s);
    expect(html).toContain('data-variant="finished"');
    expect(html).toContain('Finished in 3s');
  });

  it('cancelled without duration', () => {
    const html = renderTerminalChipHtml(step({ cancelled: true, events: [], createdAt: 0, updatedAt: 0 }));
    expect(html).toContain('data-variant="cancelled"');
    expect(html).toContain('Cancelled');
    expect(html).not.toMatch(/in \d/);
  });

  it('non-terminal → empty', () => {
    expect(renderTerminalChipHtml(step({ state: 'running' }))).toBe('');
  });
});
