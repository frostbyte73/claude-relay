import { describe, it, expect, afterEach } from 'vitest';
import { Cron } from 'croner';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulesStore, type CreateScheduleInput } from '../../src/schedules/schedules-store.js';
import { Scheduler, SkipRun, type SchedulerDeps } from '../../src/schedules/scheduler.js';
import type { GuardProviders } from '../../src/schedules/guards.js';
import type { RoutingDeps } from '../../src/schedules/routing.js';
import type { What } from '../../src/schedules/types.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sched-')), 'index.json');
}

function input(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    name: 'Nightly triage',
    enabled: true,
    trigger: { kind: 'cron', expr: '0 0 * * *' },
    what: { kind: 'skill', skill: 'read.investigate', repos: ['acme/web'] },
    guards: [],
    routing: {},
    ...overrides,
  };
}

function noopGuards(): GuardProviders {
  return { getUsageSnapshot: () => undefined, getRepoLastChange: () => null };
}

let activeSchedulers: Scheduler[] = [];
function makeScheduler(store: SchedulesStore, overrides: Partial<SchedulerDeps> = {}): Scheduler {
  const s = new Scheduler({
    store,
    guardProviders: noopGuards(),
    spawn: {},
    ...overrides,
  });
  activeSchedulers.push(s);
  return s;
}

afterEach(() => {
  for (const s of activeSchedulers) s.stop();
  activeSchedulers = [];
});

describe('Scheduler — cron next-run computation', () => {
  it('computes nextRunAt matching a directly-constructed croner Cron for the same pattern', () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ trigger: { kind: 'cron', expr: '0 0 * * *' } }));
    const scheduler = makeScheduler(store);
    scheduler.start();

    const expected = new Cron('0 0 * * *').nextRun()!.getTime();
    expect(scheduler.nextRunAt(created.id)).toBe(expected);
  });

  it('returns null for a disabled schedule', () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ enabled: false }));
    const scheduler = makeScheduler(store);
    scheduler.start();
    expect(scheduler.nextRunAt(created.id)).toBeNull();
  });

  it('returns null for an event-kind schedule', () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ trigger: { kind: 'event', descriptor: 'pr.opened' } }));
    const scheduler = makeScheduler(store);
    scheduler.start();
    expect(scheduler.nextRunAt(created.id)).toBeNull();
  });

  it('onScheduleChanged re-arms after enabling, disarms after disabling', () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ enabled: false }));
    const scheduler = makeScheduler(store);
    scheduler.start();
    expect(scheduler.nextRunAt(created.id)).toBeNull();

    store.setEnabled(created.id, true);
    scheduler.onScheduleChanged(created.id);
    expect(scheduler.nextRunAt(created.id)).not.toBeNull();

    store.setEnabled(created.id, false);
    scheduler.onScheduleChanged(created.id);
    expect(scheduler.nextRunAt(created.id)).toBeNull();
  });

  it('onScheduleDeleted stops the timer', () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input());
    const scheduler = makeScheduler(store);
    scheduler.start();
    store.remove(created.id);
    scheduler.onScheduleDeleted(created.id);
    expect(scheduler.nextRunAt(created.id)).toBeNull();
  });
});

describe('Scheduler — once triggers', () => {
  it('arms a future one-shot and reports its exact nextRunAt', () => {
    const store = new SchedulesStore(tmpPath());
    const at = Date.now() + 60_000;
    const created = store.create(input({ trigger: { kind: 'once', at } }));
    const scheduler = makeScheduler(store);
    scheduler.start();
    expect(scheduler.nextRunAt(created.id)).toBe(at);
  });

  it('auto-pauses a one-shot whose time already passed instead of arming it', () => {
    const store = new SchedulesStore(tmpPath());
    const at = 1_000_000;
    const created = store.create(input({ trigger: { kind: 'once', at } }));
    const scheduler = makeScheduler(store, { now: () => at + 60_000 });
    scheduler.start();
    expect(store.get(created.id)?.enabled).toBe(false);
    expect(scheduler.nextRunAt(created.id)).toBeNull();
  });

  it('fires a one-shot exactly once, then disables it and drops the timer', async () => {
    const store = new SchedulesStore(tmpPath());
    const at = Date.now() + 50;
    const created = store.create(input({ trigger: { kind: 'once', at } }));
    let spawnCount = 0;
    const scheduler = makeScheduler(store, {
      spawn: { spawnSkillSession: () => { spawnCount++; return { sessionId: 'once-1' }; } },
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(spawnCount).toBe(1);
    expect(store.get(created.id)?.enabled).toBe(false);
    expect(scheduler.nextRunAt(created.id)).toBeNull();
    const runs = store.listRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.refs?.sessionId).toBe('once-1');
  });
});

describe('Scheduler — run-now / guards / spawn dispatch', () => {
  it('runNow bypasses the enabled flag and guards', async () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ enabled: false, guards: [{ kind: 'usage-threshold', window: '7d', op: '>', value: 0 }] }));
    const scheduler = makeScheduler(store, {
      guardProviders: { getUsageSnapshot: () => ({ seven_day: { used_percentage: 99 } }), getRepoLastChange: () => null },
      spawn: { spawnSkillSession: () => ({ sessionId: 'sess-1' }) },
    });
    const run = await scheduler.runNow(created.id);
    expect(run.outcome).toBe('running');
    expect(run.refs?.sessionId).toBe('sess-1');
  });

  it('records a skip when a guard fails on a non-forced fire', async () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({
      trigger: { kind: 'event', descriptor: 'nightly' },
      guards: [{ kind: 'usage-threshold', window: '7d', op: '>', value: 90 }],
    }));
    let spawnCalled = false;
    const scheduler = makeScheduler(store, {
      guardProviders: { getUsageSnapshot: () => ({ seven_day: { used_percentage: 96 } }), getRepoLastChange: () => null },
      spawn: { spawnSkillSession: () => { spawnCalled = true; return { sessionId: 'x' }; } },
    });
    const [run] = await scheduler.registerEventFiring('nightly');
    expect(run!.outcome).toBe('skipped');
    expect(run!.skipReason).toBe('Skipped — 7d usage was at 96%');
    expect(spawnCalled).toBe(false);
  });

  it('dispatches to createJob for a code.* skill and spawnSkillSession otherwise', async () => {
    const store = new SchedulesStore(tmpPath());
    const codeSchedule = store.create(input({
      trigger: { kind: 'event', descriptor: 'a' },
      what: { kind: 'skill', skill: 'code.implement' },
    }));
    const readSchedule = store.create(input({
      trigger: { kind: 'event', descriptor: 'b' },
      what: { kind: 'skill', skill: 'read.investigate' },
    }));
    const scheduler = makeScheduler(store, {
      spawn: {
        createJob: () => ({ jobId: 'job-1' }),
        spawnSkillSession: () => ({ sessionId: 'sess-1' }),
      },
    });
    const [codeRun] = await scheduler.registerEventFiring('a');
    const [readRun] = await scheduler.registerEventFiring('b');
    expect(codeRun!.refs).toEqual({ jobId: 'job-1' });
    expect(readRun!.refs).toEqual({ sessionId: 'sess-1' });
  });

  it('dispatches prompt schedules to createJob (never a session)', async () => {
    const store = new SchedulesStore(tmpPath());
    store.create(input({ trigger: { kind: 'event', descriptor: 'p' }, what: { kind: 'prompt', prompt: 'summarize PRs', cwd: '/repo' } }));
    const seen: What[] = [];
    let sessionCalled = false;
    const scheduler = makeScheduler(store, {
      spawn: {
        createJob: (i) => { seen.push(i.what); return { jobId: `job-${i.what.kind}` }; },
        spawnSkillSession: () => { sessionCalled = true; return { sessionId: 'x' }; },
      },
    });
    const [promptRun] = await scheduler.registerEventFiring('p');
    expect(promptRun!.refs).toEqual({ jobId: 'job-prompt' });
    expect(seen.map((w) => w.kind)).toEqual(['prompt']);
    expect(sessionCalled).toBe(false);
  });

  it('dispatches a script schedule inline via runScript, never spawning a job', async () => {
    const store = new SchedulesStore(tmpPath());
    store.create(input({
      trigger: { kind: 'event', descriptor: 's' },
      what: { kind: 'script', script: 'npm test', cwd: '/repo' },
    }));
    let createJobCalled = false;
    const scheduler = makeScheduler(store, {
      spawn: { createJob: () => { createJobCalled = true; return { jobId: 'job-x' }; } },
      inline: { runScript: async () => ({ outcome: 'ok', verdict: { summary: 'ran' } }) },
    });
    const [run] = await scheduler.registerEventFiring('s');
    expect(run!.outcome).toBe('ok');
    expect(run!.verdict?.summary).toBe('ran');
    expect(run!.refs).toBeUndefined();
    expect(createJobCalled).toBe(false);
    expect(store.getRun(run!.id)?.finishedAt).toBeDefined();
  });

  it('dispatches a native schedule inline via runNative with its handler id', async () => {
    const store = new SchedulesStore(tmpPath());
    store.create(input({
      trigger: { kind: 'event', descriptor: 'n' },
      what: { kind: 'native', handler: 'pr-watcher' },
    }));
    let seenHandler: string | undefined;
    const scheduler = makeScheduler(store, {
      inline: { runNative: async (handler) => { seenHandler = handler; return { outcome: 'ok' }; } },
    });
    const [run] = await scheduler.registerEventFiring('n');
    expect(run!.outcome).toBe('ok');
    expect(seenHandler).toBe('pr-watcher');
  });

  it('records outcome error when inline deps are missing for a script schedule', async () => {
    const store = new SchedulesStore(tmpPath());
    store.create(input({ trigger: { kind: 'event', descriptor: 'x' }, what: { kind: 'script', script: 'true', cwd: '/repo' } }));
    const scheduler = makeScheduler(store);
    const [run] = await scheduler.registerEventFiring('x');
    expect(run!.outcome).toBe('error');
    expect(run!.verdict?.summary).toBe('inline deps not wired');
  });

  it('records outcome error when the spawn dependency is missing', async () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ trigger: { kind: 'event', descriptor: 'x' } }));
    const scheduler = makeScheduler(store, { spawn: {} });
    const [run] = await scheduler.registerEventFiring('x');
    expect(run!.outcome).toBe('error');
    expect(run!.verdict?.summary).toMatch(/spawnSkillSession dependency not wired/);
  });

  it('turns a SkipRun from the spawn dep into one skipped run, not an error', async () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ trigger: { kind: 'event', descriptor: 'x' } }));
    const scheduler = makeScheduler(store, {
      spawn: { spawnSkillSession: () => { throw new SkipRun('Skipped — nothing due'); } },
    });

    const [run] = await scheduler.registerEventFiring('x');
    expect(run!.outcome).toBe('skipped');
    expect(run!.skipReason).toBe('Skipped — nothing due');
    // startRun already opened this row — a second one would double-count in the runs list.
    expect(store.listRuns(created.id)).toHaveLength(1);
  });
});

describe('Scheduler — completeRun / routing', () => {
  function fakeRouting(overrides: Partial<RoutingDeps> = {}): RoutingDeps {
    return {
      getSlackWebhook: () => undefined,
      postGithubComment: async () => ({ url: 'https://github.com/x/y/issues/1#comment' }),
      ...overrides,
    };
  }

  it('finalizes a run and computes cockpit delivery', async () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({
      trigger: { kind: 'event', descriptor: 'x' },
      routing: { cockpit: { confidenceThreshold: 0.5 } },
    }));
    const scheduler = makeScheduler(store, {
      spawn: { spawnSkillSession: () => ({ sessionId: 's1' }) },
      routing: fakeRouting(),
    });
    const [run] = await scheduler.registerEventFiring('x');
    const finalRun = await scheduler.completeRun(run!.id, { outcome: 'ok', verdict: { summary: 'done', confidence: 0.9 } });
    expect(finalRun?.outcome).toBe('ok');
    expect(finalRun?.finishedAt).toBeDefined();
    expect(finalRun?.delivery?.cockpit).toEqual({ surfaced: true });
  });

  it('completeRunByRef looks the run up by its spawned session/job ref', async () => {
    const store = new SchedulesStore(tmpPath());
    const created = store.create(input({ trigger: { kind: 'event', descriptor: 'x' } }));
    const scheduler = makeScheduler(store, { spawn: { spawnSkillSession: () => ({ sessionId: 'sess-42' }) } });
    await scheduler.registerEventFiring('x');
    const finalRun = await scheduler.completeRunByRef({ sessionId: 'sess-42' }, { outcome: 'ok', verdict: { summary: 'done' } });
    expect(finalRun?.scheduleId).toBe(created.id);
    expect(finalRun?.outcome).toBe('ok');
  });

  it('approveGithubPost posts a pending-approval draft and marks it posted', async () => {
    const store = new SchedulesStore(tmpPath());
    store.create(input({
      trigger: { kind: 'event', descriptor: 'x' },
      what: { kind: 'skill', skill: 'read.investigate', repos: ['acme/web'] },
      routing: { github: { approvalBeforePosting: true } },
    }));
    let posted = false;
    const scheduler = makeScheduler(store, {
      spawn: { spawnSkillSession: () => ({ sessionId: 's1' }) },
      routing: fakeRouting({ postGithubComment: async () => { posted = true; return { url: 'https://x/1' }; } }),
    });
    const [run] = await scheduler.registerEventFiring('x');
    const withVerdict = await scheduler.completeRun(run!.id, { outcome: 'ok', verdict: { summary: 'found 2 issues' } });
    expect(withVerdict?.delivery?.github?.status).toBe('pending-approval');
    expect(posted).toBe(false);

    const approved = await scheduler.approveGithubPost(run!.id);
    expect(posted).toBe(true);
    expect(approved?.delivery?.github?.status).toBe('posted');
  });
});
