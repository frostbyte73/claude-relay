import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecurrenceTracker } from '../../src/storage/recurrence-tracker.js';

describe('RecurrenceTracker', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-06-11T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  const cwd = '/tmp/projX';

  it('countMatches returns 0/0 when nothing recorded', () => {
    const t = new RecurrenceTracker();
    expect(t.countMatches(cwd, 'Bash', { command: 'ls' })).toEqual({ last24h: 0, last7d: 0 });
  });

  it('counts identical (toolName, input) pairs in last 24h and 7d', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 4; i++) {
      t.record({ cwd, toolName: 'Bash', toolInput: { command: 'kubectl get pods' }, decision: 'allow' });
    }
    expect(t.countMatches(cwd, 'Bash', { command: 'kubectl get pods' })).toEqual({ last24h: 4, last7d: 4 });
  });

  it('does not count records from a different cwd', () => {
    const t = new RecurrenceTracker();
    t.record({ cwd: '/tmp/other', toolName: 'Bash', toolInput: { command: 'X' }, decision: 'allow' });
    expect(t.countMatches(cwd, 'Bash', { command: 'X' })).toEqual({ last24h: 0, last7d: 0 });
  });

  it('does not count records with different tool inputs', () => {
    const t = new RecurrenceTracker();
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'A' }, decision: 'allow' });
    expect(t.countMatches(cwd, 'Bash', { command: 'B' })).toEqual({ last24h: 0, last7d: 0 });
  });

  it('only counts allows (not denies)', () => {
    const t = new RecurrenceTracker();
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'X' }, decision: 'allow' });
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'X' }, decision: 'deny' });
    expect(t.countMatches(cwd, 'Bash', { command: 'X' })).toEqual({ last24h: 1, last7d: 1 });
  });

  it('drops records older than 7 days from countMatches', () => {
    const t = new RecurrenceTracker();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'X' }, decision: 'allow' });
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
    expect(t.countMatches(cwd, 'Bash', { command: 'X' })).toEqual({ last24h: 0, last7d: 0 });
  });

  it('records older than 24h count toward 7d window only', () => {
    const t = new RecurrenceTracker();
    vi.setSystemTime(new Date('2026-06-08T12:00:00Z'));
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'X' }, decision: 'allow' });
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'X' }, decision: 'allow' });
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
    expect(t.countMatches(cwd, 'Bash', { command: 'X' })).toEqual({ last24h: 0, last7d: 2 });
  });

  it('suggestionFor: null below threshold', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 2; i++) {
      t.record({ cwd, toolName: 'Bash', toolInput: { command: 'kubectl get pods' }, decision: 'allow' });
    }
    expect(t.suggestionFor(cwd, 'Bash', { command: 'kubectl get pods' })).toBeNull();
  });

  it('suggestionFor: triggers at 3-in-24h', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 3; i++) {
      t.record({ cwd, toolName: 'Bash', toolInput: { command: 'kubectl get pods -n foo' }, decision: 'allow' });
    }
    const s = t.suggestionFor(cwd, 'Bash', { command: 'kubectl get pods -n foo' });
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('bash');
    expect(s!.suggestedValue).toBe('^kubectl get(\\s|$)');
    expect(s!.matchCount).toBe(3);
    expect(s!.triggerWindow).toBe('24h');
  });

  it('suggestionFor: triggers at 5-in-7d when 24h window is below 3', () => {
    const t = new RecurrenceTracker();
    vi.setSystemTime(new Date('2026-06-06T12:00:00Z'));
    for (let i = 0; i < 4; i++) {
      t.record({ cwd, toolName: 'Bash', toolInput: { command: 'git status' }, decision: 'allow' });
    }
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
    t.record({ cwd, toolName: 'Bash', toolInput: { command: 'git status' }, decision: 'allow' });
    const s = t.suggestionFor(cwd, 'Bash', { command: 'git status' });
    expect(s).not.toBeNull();
    expect(s!.triggerWindow).toBe('7d');
    expect(s!.matchCount).toBe(5);
  });

  it('suggestionFor: kind=mcp produces exact-match regex', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 3; i++) {
      t.record({ cwd, toolName: 'mcp__incident-io__schedule_show', toolInput: { id: 'S-1' }, decision: 'allow' });
    }
    const s = t.suggestionFor(cwd, 'mcp__incident-io__schedule_show', { id: 'S-1' });
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('mcp');
    expect(s!.suggestedValue).toBe('^mcp__incident-io__schedule_show$');
  });

  it('suggestionFor: kind=tool produces the tool name unchanged', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 3; i++) {
      t.record({ cwd, toolName: 'WebFetch', toolInput: {}, decision: 'allow' });
    }
    const s = t.suggestionFor(cwd, 'WebFetch', {});
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('tool');
    expect(s!.suggestedValue).toBe('WebFetch');
  });

  it('suggestionFor: refuses a derived rule the lint would refuse to install', () => {
    // A rule `addRule` would refuse must never be offered as a promotion — that was the
    // "Promotion failed, try again" trap: retrying can never work because the rule itself
    // is refused.
    const t = new RecurrenceTracker();
    for (let i = 0; i < 3; i++) {
      t.record({ cwd, toolName: 'NotebookEdit', toolInput: {}, decision: 'allow' });
    }
    expect(t.suggestionFor(cwd, 'NotebookEdit', {})).toBeNull();

    for (let i = 0; i < 3; i++) {
      t.record({ cwd, toolName: 'mcp__incident-io__incident_update', toolInput: { id: 'INC-1' }, decision: 'allow' });
    }
    expect(t.suggestionFor(cwd, 'mcp__incident-io__incident_update', { id: 'INC-1' })).toBeNull();
  });

  it('bash suggestion: empty command returns null', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 3; i++) {
      t.record({ cwd, toolName: 'Bash', toolInput: { command: '' }, decision: 'allow' });
    }
    expect(t.suggestionFor(cwd, 'Bash', { command: '' })).toBeNull();
  });

  it('caps in-memory ring at 1000 entries', () => {
    const t = new RecurrenceTracker();
    for (let i = 0; i < 1200; i++) {
      t.record({ cwd, toolName: 'Bash', toolInput: { command: `cmd ${i}` }, decision: 'allow' });
    }
    expect(t.countMatches(cwd, 'Bash', { command: 'cmd 0' })).toEqual({ last24h: 0, last7d: 0 });
    expect(t.countMatches(cwd, 'Bash', { command: 'cmd 1199' })).toEqual({ last24h: 1, last7d: 1 });
  });
});
