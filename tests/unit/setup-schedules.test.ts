import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulesStore } from '../../src/schedules/schedules-store.js';
import { seedBuiltinSchedules } from '../../src/schedules/setup-schedules.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'setup-sched-')), 'index.json');
}

describe('seedBuiltinSchedules', () => {
  const originalToken = process.env.LINEAR_API_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.LINEAR_API_TOKEN;
    else process.env.LINEAR_API_TOKEN = originalToken;
  });

  it('seeds the five builtins once and is idempotent', () => {
    delete process.env.LINEAR_API_TOKEN;
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    const ids = store.list().map((s) => s.id).sort();
    expect(ids).toEqual(['action-improver', 'claude-updater', 'linear', 'pr-watcher', 'user-prs-watcher']);
    seedBuiltinSchedules(store, '/tmp');
    expect(store.list().length).toBe(5); // no duplicates
  });

  it('seeds the improver enabled, token-opportunistic, debounced daily and repo-less', () => {
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    const improver = store.get('action-improver')!;
    expect(improver.enabled).toBe(true);
    expect(improver.trigger).toEqual({ kind: 'token-opportunistic', debounceMs: 24 * 60 * 60 * 1000 });
    expect(improver.what).toEqual({ kind: 'skill', skill: 'meta.improve-actions' });
  });

  it('backfills a daily debounce onto an improver row seeded before the field existed', () => {
    const store = new SchedulesStore(tmpPath());
    store.ensureBuiltin({
      id: 'action-improver',
      name: 'Improve actions',
      trigger: { kind: 'token-opportunistic' },
      what: { kind: 'skill', skill: 'meta.improve-actions' },
    });
    seedBuiltinSchedules(store, '/tmp');
    expect(store.get('action-improver')!.trigger).toEqual({ kind: 'token-opportunistic', debounceMs: 24 * 60 * 60 * 1000 });
  });

  it('does not re-impose the debounce on a user who turned it off', () => {
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    store.update('action-improver', { trigger: { kind: 'token-opportunistic', debounceMs: 0 } });
    seedBuiltinSchedules(store, '/tmp');
    expect(store.get('action-improver')!.trigger).toEqual({ kind: 'token-opportunistic', debounceMs: 0 });
  });

  it('does not revive an improver the user paused', () => {
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    store.setEnabled('action-improver', false);
    seedBuiltinSchedules(store, '/tmp');
    expect(store.get('action-improver')!.enabled).toBe(false);
  });

  it('seeds the linear builtin disabled when no LINEAR_API_TOKEN is set', () => {
    delete process.env.LINEAR_API_TOKEN;
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    expect(store.get('linear')!.enabled).toBe(false);
  });

  it('seeds the linear builtin enabled when LINEAR_API_TOKEN is set', () => {
    process.env.LINEAR_API_TOKEN = 'test-token';
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    expect(store.get('linear')!.enabled).toBe(true);
  });

  it('preserves a user edit to a builtin trigger across re-seed', () => {
    delete process.env.LINEAR_API_TOKEN;
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    store.update('linear', { trigger: { kind: 'cron', expr: '*/30 * * * *' } });
    seedBuiltinSchedules(store, '/tmp');
    expect(store.get('linear')!.trigger).toEqual({ kind: 'cron', expr: '*/30 * * * *' });
  });
});
