import { describe, it, expect, beforeEach } from 'vitest';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRunsStore, type ActionRunRecord } from '../../src/storage/action-runs-store.js';
import { ActionRunLedger } from '../../src/work/action-run-ledger.js';
import type { JobRecord, OpenPrStep } from '../../src/work/work-types.js';

const NOW = 1_700_000_000_000;

let path: string;
let seq: number;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'action-runs-')), 'action-runs.jsonl');
  seq = 0;
});

function store(now = NOW): ActionRunsStore {
  return new ActionRunsStore(path, () => `r${++seq}`, () => now);
}

function open(s: ActionRunsStore, over: Partial<ActionRunRecord> = {}): ActionRunRecord {
  return s.open({
    action: 'code.spec', round: 'spec', attempt: 1,
    jobId: 'j1', stepId: 's1', startedAt: NOW, ...over,
  });
}

describe('ActionRunsStore fold', () => {
  it('folds close and verdict patches onto the record, last write winning per field', () => {
    const s = store();
    const run = open(s);
    s.patch(run.id, { endedAt: NOW + 1000, durationMs: 1000, outcome: 'submitted', costUsd: 0.5 });
    s.patch(run.id, { outcome: 'accepted', verdictAt: NOW + 9000 });

    const reloaded = store().listByAction('code.spec');
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      id: run.id,
      outcome: 'accepted',
      verdictAt: NOW + 9000,
      durationMs: 1000,
      costUsd: 0.5,
    });
  });

  it('drops a patch whose base record is gone', () => {
    appendFileSync(path, JSON.stringify({ t: 'patch', id: 'ghost', outcome: 'accepted' }) + '\n');
    expect(store().listByAction('code.spec')).toEqual([]);
  });

  it('skips corrupt lines', () => {
    const s = store();
    open(s);
    appendFileSync(path, 'not json\n');
    expect(store().listByAction('code.spec')).toHaveLength(1);
  });
});

describe('ActionRunsStore retention', () => {
  it('drops rows past the age cutoff and the entry cap', () => {
    const s = store();
    open(s, { startedAt: NOW - 10_000 });
    open(s, { startedAt: NOW - 200 * 24 * 60 * 60 * 1000 });

    const aged = new ActionRunsStore(path, () => 'x', () => NOW, 100, 24 * 60 * 60 * 1000);
    expect(aged.listByAction('code.spec')).toHaveLength(1);

    const capped = new ActionRunsStore(path, () => 'x', () => NOW, 1);
    expect(capped.listByAction('code.spec')).toHaveLength(1);
  });
});

describe('ActionRunsStore queries', () => {
  it('counts attempts per (scope, round) and resolves the latest', () => {
    const s = store();
    open(s, { attempt: 1 });
    open(s, { attempt: 2, startedAt: NOW + 10 });
    open(s, { round: 'plan', action: 'code.plan' });
    open(s, { stepId: 's2' });

    expect(s.attemptsFor('s1', 'spec')).toBe(2);
    expect(s.attemptsFor('s1', 'plan')).toBe(1);
    expect(s.attemptsFor('s2', 'spec')).toBe(1);
    expect(s.latestFor('s1', 'spec')?.attempt).toBe(2);
  });

  it('resolves the newest run of any round when no round is given', () => {
    const s = store();
    open(s, { stepId: undefined, round: 'initial', action: 'meta.orchestrate' });
    const replan = open(s, { stepId: undefined, round: 'replan', action: 'meta.orchestrate', startedAt: NOW + 10 });
    expect(s.latestFor('j1')?.id).toBe(replan.id);
  });

  it('reports runs that never closed', () => {
    const s = store();
    const stale = open(s);
    const done = open(s, { stepId: 's2' });
    s.patch(done.id, { endedAt: NOW + 1 });
    expect(s.openRuns().map((r) => r.id)).toEqual([stale.id]);
  });
});

describe('ActionRunLedger.reconcileAtBoot', () => {
  const step = (id: string, over: Partial<OpenPrStep> = {}): OpenPrStep => ({
    id, type: 'open-pr', title: 't', description: '',
    workspace: { kind: 'writable', repoCwd: '/r', branch: 'b' },
    goal: 'g', approach: 'a', state: 'speccing', sessionId: `sess-${id}`,
    createdAt: 0, updatedAt: 0, ...over,
  });
  const job = (steps: OpenPrStep[]): JobRecord => ({
    id: 'j1', source: 'manual', title: 't', description: '',
    state: 'executing', steps, createdAt: 0, updatedAt: 0,
  });

  function ledgerOver(s: ActionRunsStore) {
    return new ActionRunLedger({ store: s, isHumanGate: () => false, now: () => NOW + 5_000 });
  }

  it('retires a run whose round has moved on', () => {
    const s = store();
    const run = open(s, { stepId: 'a' });
    ledgerOver(s).reconcileAtBoot([job([step('a', { state: 'implementing' })])]);
    expect(s.get(run.id)).toMatchObject({ outcome: 'interrupted', endedAt: NOW + 5_000 });
  });

  it('re-adopts a run whose round is still live', () => {
    const s = store();
    const run = open(s, { stepId: 'a' });
    ledgerOver(s).reconcileAtBoot([job([step('a')])]);
    expect(s.get(run.id)?.outcome).toBeUndefined();
    expect(s.openRuns()).toHaveLength(1);
  });

  it('retires a run whose job is gone entirely', () => {
    const s = store();
    const run = open(s, { stepId: 'a' });
    ledgerOver(s).reconcileAtBoot([]);
    expect(s.get(run.id)?.outcome).toBe('interrupted');
  });
});
