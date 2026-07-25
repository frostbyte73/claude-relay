import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { OpenPrStep } from '../../src/work/work-types.js';

function makeEngine(dir = mkdtempSync(join(tmpdir(), 'resolve-'))) {
  const queue = new JobQueue(dir);
  const resumed: Array<{ sessionId: string; env: Record<string, string> }> = [];
  const bound: Array<{ sessionId: string; action: string }> = [];
  const sessionManager = {
    spawnDetached() {},
    send() {},
    isWorking() { return false; },
    sendOrResume(sessionId: string, _cwd: string, _msg: unknown, env: Record<string, string>) {
      resumed.push({ sessionId, env });
    },
  } as never;
  const worktreeManager = { provision: async () => ({ path: dir }) } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter, actionsStore: {} as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
  });
  const orig = engine.bindAction.bind(engine);
  engine.bindAction = (sid: string, name: string) => { bound.push({ sessionId: sid, action: name }); orig(sid, name); };
  return { engine, queue, resumed, bound, dir };
}

function seedConflictingStep(engine: WorkEngine, queue: JobQueue, over: Partial<OpenPrStep> = {}) {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  const step: OpenPrStep = {
    id: 'step-1', title: 't', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    goal: 'g', approach: 'a', state: 'conflicting', sessionId: 'sess-1',
    prUrl: 'https://github.com/acme/example/pull/15282',
    createdAt: 1, updatedAt: 1, ...over,
  };
  queue.upsert({ ...queue.get(job.id)!, steps: [step], state: 'executing' });
  return job.id;
}

describe('engine.resolveConflicts', () => {
  it('resumes the shared session with code.resolve-conflicts and marks the flag', async () => {
    const { engine, queue, resumed, bound } = makeEngine();
    const jobId = seedConflictingStep(engine, queue);
    await engine.resolveConflicts(jobId, 'step-1');

    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.sessionId).toBe('sess-1');
    expect(bound.some((b) => b.sessionId === 'sess-1' && b.action === 'code.resolve-conflicts')).toBe(true);
    const s = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(s.conflictResolving).toBe(true);
  });

  it('no-ops when already resolving', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedConflictingStep(engine, queue, { conflictResolving: true });
    await engine.resolveConflicts(jobId, 'step-1');
    expect(resumed).toHaveLength(0);
  });
});

describe('engine.markConflictResolved', () => {
  it('resolved → pr_open, clears flag, resets mergeable to unknown', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedConflictingStep(engine, queue, { conflictResolving: true, mergeable: 'conflicting' });
    engine.markConflictResolved(jobId, 'step-1', { status: 'resolved' });
    const s = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(s.state).toBe('pr_open');
    expect(s.conflictResolving).toBe(false);
    expect(s.mergeable).toBe('unknown');
  });

  it('unresolvable → conflict_unresolved, clears flag', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedConflictingStep(engine, queue, { conflictResolving: true });
    engine.markConflictResolved(jobId, 'step-1', { status: 'unresolvable', failure: 'ambiguous' });
    const s = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(s.state).toBe('conflict_unresolved');
    expect(s.conflictResolving).toBe(false);
  });
});
