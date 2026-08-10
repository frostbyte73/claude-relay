import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulesStore } from '../../src/schedules/schedules-store.js';
import {
  evaluateHeadroom,
  TokenScheduler,
  type TokenUsageSnapshot,
} from '../../src/schedules/token-scheduler.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// five_hour.resets_at is irrelevant to the decision (only used_percentage gates it); seven_day
// carries the pace signal via resets_at (epoch seconds) vs `now`.
function snap(sevenUsed: number, msUntilReset: number, fiveUsed = 10): TokenUsageSnapshot {
  return {
    five_hour: { used_percentage: fiveUsed, resets_at: Math.floor((NOW + 5 * 60 * 60 * 1000) / 1000) },
    seven_day: { used_percentage: sevenUsed, resets_at: Math.floor((NOW + msUntilReset) / 1000) },
  };
}

describe('evaluateHeadroom', () => {
  it('fails closed when there is no snapshot', () => {
    expect(evaluateHeadroom(undefined, NOW).launch).toBe(false);
  });

  it('fails closed when the 5h window is missing (can\'t gate the ceiling)', () => {
    const s: TokenUsageSnapshot = { seven_day: { used_percentage: 5, resets_at: Math.floor((NOW + 3 * 60 * 60 * 1000) / 1000) } };
    expect(evaluateHeadroom(s, NOW).launch).toBe(false);
  });

  it('does not launch when 7d spending is ahead of pace (60% used, 5 days left)', () => {
    const decision = evaluateHeadroom(snap(60, 5 * DAY), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.reason).toMatch(/ahead of pace/);
  });

  it('launches near a reset with budget unspent', () => {
    expect(evaluateHeadroom(snap(40, 3 * 60 * 60 * 1000), NOW).launch).toBe(true);
  });

  it('launches when behind pace mid-window', () => {
    expect(evaluateHeadroom(snap(30, 3.5 * DAY), NOW).launch).toBe(true);
  });

  it('stays conservative early in a window even with budget unspent', () => {
    expect(evaluateHeadroom(snap(0, 6.9 * DAY), NOW).launch).toBe(false);
  });

  it('blocks on the 5h hard ceiling even when 7d has headroom', () => {
    const decision = evaluateHeadroom(snap(40, 3 * 60 * 60 * 1000, 85), NOW);
    expect(decision.launch).toBe(false);
    expect(decision.reason).toMatch(/5h usage/);
  });
});

function tmpStore(): SchedulesStore {
  return new SchedulesStore(join(mkdtempSync(join(tmpdir(), 'sched-token-')), 'index.json'));
}

function tokenInput(name: string) {
  return {
    name,
    enabled: true,
    trigger: { kind: 'token-opportunistic' as const },
    what: { kind: 'prompt' as const, prompt: 'work the backlog', cwd: '/repo' },
    guards: [],
    routing: {},
  };
}

describe('TokenScheduler', () => {
  function make(store: SchedulesStore, snapshot: TokenUsageSnapshot | undefined) {
    const fired: string[] = [];
    const controller = new TokenScheduler({
      store,
      getSnapshot: () => snapshot,
      fire: async (id) => { fired.push(id); store.startRun(id, { outcome: 'running' }); },
      now: () => NOW,
    });
    return { controller, fired };
  }

  it('launches the eligible schedule when there is headroom', async () => {
    const store = tmpStore();
    const a = store.create(tokenInput('backlog'));
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([a.id]);
  });

  it('serializes — does not launch while a token run is in flight', async () => {
    const store = tmpStore();
    const a = store.create(tokenInput('a'));
    store.startRun(a.id, { outcome: 'running' });
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([]);
  });

  it('does nothing without headroom', async () => {
    const store = tmpStore();
    store.create(tokenInput('a'));
    const { controller, fired } = make(store, snap(60, 5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([]);
  });

  it('ignores non-token schedules', async () => {
    const store = tmpStore();
    store.create({ ...tokenInput('cron one'), trigger: { kind: 'cron', expr: '0 0 * * *' } });
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([]);
  });

  it('picks the least-recently-run schedule (never-run wins)', async () => {
    const store = tmpStore();
    const a = store.create(tokenInput('a'));
    const b = store.create(tokenInput('b'));
    // a ran (and finished) recently; b has never run → b is picked.
    store.startRun(a.id, { outcome: 'ok', startedAt: NOW - 1000 });
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([b.id]);
  });

  it('holds off inside the debounce window — a skipped run starts the cooldown too', async () => {
    const store = tmpStore();
    const a = store.create({ ...tokenInput('improver'), trigger: { kind: 'token-opportunistic', debounceMs: DAY } });
    store.startRun(a.id, { outcome: 'skipped', skipReason: 'nothing due', startedAt: NOW - 2 * 60 * 60 * 1000 });
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([]);
    // No extra run row for the debounced snapshot — the cooldown is silent, not a skip log.
    expect(store.listRuns(a.id).length).toBe(1);
  });

  it('fires again once the debounce window has passed', async () => {
    const store = tmpStore();
    const a = store.create({ ...tokenInput('improver'), trigger: { kind: 'token-opportunistic', debounceMs: DAY } });
    store.startRun(a.id, { outcome: 'skipped', skipReason: 'nothing due', startedAt: NOW - DAY - 1 });
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([a.id]);
  });

  it('a debounced schedule does not block a sibling token schedule', async () => {
    const store = tmpStore();
    const a = store.create({ ...tokenInput('improver'), trigger: { kind: 'token-opportunistic', debounceMs: DAY } });
    const b = store.create(tokenInput('backlog'));
    store.startRun(a.id, { outcome: 'ok', startedAt: NOW - 1000 });
    const { controller, fired } = make(store, snap(30, 3.5 * DAY));
    await controller.onUsageSnapshot();
    expect(fired).toEqual([b.id]);
  });

  it('describe reports the cooldown ahead of headroom', () => {
    const store = tmpStore();
    const a = store.create({ ...tokenInput('improver'), trigger: { kind: 'token-opportunistic', debounceMs: DAY } });
    store.startRun(a.id, { outcome: 'skipped', startedAt: NOW - 2 * 60 * 60 * 1000 });
    const { controller } = make(store, snap(30, 3.5 * DAY));
    const status = controller.describe(a.id);
    expect(status.state).toBe('waiting');
    expect(status.reason).toBe('Waiting — at most once per 1d (next in 22h)');
  });

  it('describe reports running / gated / eligible / waiting', async () => {
    const store = tmpStore();
    const a = store.create(tokenInput('a'));
    const b = store.create(tokenInput('b'));

    const eligible = make(store, snap(30, 3.5 * DAY));
    expect(eligible.controller.describe(a.id).state).toBe('eligible');

    const noHeadroom = make(store, snap(60, 5 * DAY));
    expect(noHeadroom.controller.describe(a.id).state).toBe('waiting');

    store.startRun(a.id, { outcome: 'running' });
    expect(eligible.controller.describe(a.id).state).toBe('running');
    // b is blocked by a's in-flight run, not by headroom.
    const gated = eligible.controller.describe(b.id);
    expect(gated.state).toBe('waiting');
    expect(gated.reason).toMatch(/another token job/);
  });
});
