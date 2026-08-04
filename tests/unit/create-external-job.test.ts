import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';

const actionRegistry = {
  getAction() { return { frontmatter: { outpost: { runner: 'claude' } } }; },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-external-job-'));
  const queue = new JobQueue(dir);
  const sessionManager = {
    spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {},
  } as never;
  const worktreeManager = { provision: async () => ({ path: dir }) } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue };
}

describe('createExternalJob', () => {
  it('creates a job the first time and no-ops on a repeated dedupeKey', () => {
    const { engine } = makeEngine();
    const a = engine.createExternalJob({ source: 'linear', title: 'T', dedupeKey: 'LIN-1', autoPlan: false });
    expect(a.created).toBe(true);
    const b = engine.createExternalJob({ source: 'linear', title: 'T again', dedupeKey: 'LIN-1', autoPlan: false });
    expect(b.created).toBe(false);
    expect(b.jobId).toBe(a.jobId);
  });

  it('creates distinct jobs when no dedupeKey is given', () => {
    const { engine } = makeEngine();
    const a = engine.createExternalJob({ source: 'x', title: 'A', autoPlan: false });
    const b = engine.createExternalJob({ source: 'x', title: 'B', autoPlan: false });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('rejects a path-traversal dedupeKey', () => {
    const { engine } = makeEngine();
    expect(() => engine.createExternalJob({
      source: 'x', title: 't', dedupeKey: '../../etc/passwd', autoPlan: false,
    })).toThrow(/invalid dedupeKey/);
  });

  it('accepts a real-shaped identifier like ENG-123', () => {
    const { engine } = makeEngine();
    const a = engine.createExternalJob({ source: 'linear', title: 't', dedupeKey: 'ENG-123', autoPlan: false });
    expect(a.created).toBe(true);
    expect(a.jobId).toBe('ENG-123');
  });
});
