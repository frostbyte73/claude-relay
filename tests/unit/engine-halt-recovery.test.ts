import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { OrchestratedStep } from '../../src/work/work-types.js';

function makeEngine(dir = mkdtempSync(join(tmpdir(), 'halt-'))) {
  const queue = new JobQueue(dir);
  const archived: Array<{ stepId: string }> = [];
  const sessionManager = {
    spawnDetached() {}, send() {}, isWorking() { return false; },
    sendOrResume() {}, close() {}, archive() {},
  } as never;
  const worktreeManager = {
    provision: async () => ({ path: dir }),
    get: () => ({ projectCwd: '/tmp/repo', worktreePath: dir, branch: 'feat/x', baseBranch: 'main' }),
    archive: async (stepId: string) => { archived.push({ stepId }); },
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager,
    linearWriter: { setState: async () => undefined } as never, actionsStore: {} as never,
    jobsDir: join(dir, 'jobs'), newId: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => 1,
  });
  return { engine, queue, archived, dir };
}

function seedStep(engine: WorkEngine, queue: JobQueue, over: Partial<OrchestratedStep> = {}) {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  const step: OrchestratedStep = {
    id: 'step-1', title: 't', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    goal: 'g', state: 'running', sessionId: 'sess-1',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    createdAt: 1, updatedAt: 1, ...over,
  };
  queue.upsert({ ...queue.get(job.id)!, steps: [step], state: 'executing' });
  return job.id;
}

describe('tickOne lifts a stale halt when the failing step recovers', () => {
  // Regression: a daemon restart can fail a step and halt the job (state=failed).
  // Settling the step later clears the step failure but historically left the job
  // stuck in `failed`. The un-halt in tickOne must resume it so it can settle to done.
  it('a failed job whose only step then settles → resumes and settles to done', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedStep(engine, queue, {
      reviewed: true,
      failure: { reason: 'session interrupted by daemon restart', at: 1 },
    });
    queue.upsert({ ...queue.get(jobId)!, state: 'failed' });

    engine.markStepResolved(jobId, 'step-1');
    await new Promise((r) => setTimeout(r, 0));

    const j = queue.get(jobId)!;
    expect(j.steps[0]!.failure).toBeUndefined();
    expect(j.state).toBe('done');
  });

  it('leaves a genuinely-failed job halted while its step still carries a failure', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedStep(engine, queue, {
      reviewed: true, failure: { reason: 'real failure', at: 1 },
    });
    queue.upsert({ ...queue.get(jobId)!, state: 'failed' });

    await engine.tick(jobId);

    expect(queue.get(jobId)!.state).toBe('failed');
  });
});

describe('engine.worktreeRecordForSession', () => {
  // Regression: step sessions run under a minted sessionId while their worktree
  // record is keyed by stepId. A direct worktreeManager.get(sessionId) misses,
  // which blanked the git/status `worktree` field and hid the merge/squash/discard
  // UI for every orchestrator step. The engine must route session → stepId → record.
  function makeKeyedEngine() {
    const dir = mkdtempSync(join(tmpdir(), 'wt-rec-'));
    const queue = new JobQueue(dir);
    const rec = { projectCwd: '/tmp/repo', worktreePath: dir, branch: 'feat/x', baseBranch: 'main' };
    const worktreeManager = {
      provision: async () => ({ path: dir }),
      // Key-sensitive: only the stepId slot holds the record, mirroring provision().
      get: (id: string) => (id === 'step-1' ? rec : undefined),
      archive: async () => {},
    } as never;
    const engine = new WorkEngine({
      queue,
      sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {}, close() {}, archive() {} } as never,
      worktreeManager, linearWriter: { setState: async () => undefined } as never, actionsStore: {} as never,
      jobsDir: join(dir, 'jobs'), newId: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => 1,
    });
    return { engine, queue, rec };
  }

  it('resolves a minted step sessionId to its stepId-keyed worktree record', () => {
    const { engine, queue, rec } = makeKeyedEngine();
    seedStep(engine, queue, { id: 'step-1', sessionId: 'sess-1' });
    engine.rehydrateSessionBindings();
    // sess-1 is not a key in the worktree map; only step-1 is. Direct lookup misses.
    expect(engine.worktreeRecordForSession('sess-1')).toBe(rec);
    expect(engine.worktreeRecordForSession('unknown-session')).toBeUndefined();
  });
});

describe('organic completion reaps the job resources', () => {
  // Regression: only the manual paths (markJobDone / abandon / delete / reset) called
  // terminateJobResources, so a job that finished on its own stranded every worktree whose
  // step didn't exit through the controller's `resolve` move — the leak that left 32
  // worktrees on disk across 9 repos.
  it('a job that settles to done on its own archives its steps worktrees', async () => {
    const { engine, queue, archived } = makeEngine();
    const jobId = seedStep(engine, queue, { reviewed: true });

    engine.markStepResolved(jobId, 'step-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(queue.get(jobId)!.state).toBe('done');
    expect(archived.map((a) => a.stepId)).toEqual(['step-1']);
  });

  // A failed job is a halt, not a grave: tickOne lifts it back to executing once the failure
  // clears, and the retry resumes into the same checkout. Reaping here would delete it.
  it('a job halted at failed keeps its worktrees', async () => {
    const { engine, queue, archived } = makeEngine();
    const jobId = seedStep(engine, queue, {
      reviewed: true, failure: { reason: 'real failure', at: 1 },
    });
    queue.upsert({ ...queue.get(jobId)!, state: 'failed' });

    await engine.tick(jobId);

    expect(queue.get(jobId)!.state).toBe('failed');
    expect(archived).toEqual([]);
  });
});
