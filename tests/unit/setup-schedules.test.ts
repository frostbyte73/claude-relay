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

  it('seeds the four builtins once and is idempotent', () => {
    delete process.env.LINEAR_API_TOKEN;
    const store = new SchedulesStore(tmpPath());
    seedBuiltinSchedules(store, '/tmp');
    const ids = store.list().map((s) => s.id).sort();
    expect(ids).toEqual(['claude-updater', 'linear', 'pr-watcher', 'user-prs-watcher']);
    seedBuiltinSchedules(store, '/tmp');
    expect(store.list().length).toBe(4); // no duplicates
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
