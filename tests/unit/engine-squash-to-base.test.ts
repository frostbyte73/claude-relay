import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { OpenPrStep } from '../../src/work/work-types.js';

export function makeEngine(dir = mkdtempSync(join(tmpdir(), 'squash-'))) {
  const queue = new JobQueue(dir);
  const resumed: Array<{ sessionId: string; env: Record<string, string> }> = [];
  const archived: Array<{ stepId: string }> = [];
  const sessionManager = {
    spawnDetached() {}, send() {}, isWorking() { return false; },
    sendOrResume(sessionId: string, _cwd: string, _msg: unknown, env: Record<string, string>) { resumed.push({ sessionId, env }); },
    close() {}, archive() {},
  } as never;
  const worktreeManager = {
    provision: async () => ({ path: dir }),
    get: () => ({ projectCwd: '/tmp/repo', worktreePath: dir, branch: 'feat/x', baseBranch: 'main' }),
    archive: async (stepId: string) => { archived.push({ stepId }); },
  } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter, actionsStore: {} as never,
    jobsDir: join(dir, 'jobs'), newId: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => 1,
  });
  return { engine, queue, resumed, archived, dir };
}

export function seedStep(engine: WorkEngine, queue: JobQueue, over: Partial<OpenPrStep> = {}) {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  const step: OpenPrStep = {
    id: 'step-1', title: 't', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    goal: 'g', approach: 'a', state: 'pr_open', sessionId: 'sess-1',
    createdAt: 1, updatedAt: 1, ...over,
  };
  queue.upsert({ ...queue.get(job.id)!, steps: [step], state: 'executing' });
  return job.id;
}

describe('applyOpenPrPatch archives the worktree on →merged', () => {
  it('archives when a step transitions into merged', async () => {
    const { engine, queue, archived } = makeEngine();
    const jobId = seedStep(engine, queue, { state: 'pr_open' });
    engine.applyOpenPrPatch(jobId, 'step-1', { state: 'merged' }, 'user');
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget archive run
    expect(archived).toEqual([{ stepId: 'step-1' }]);
  });

  it('does not archive when the step was already merged', async () => {
    const { engine, queue, archived } = makeEngine();
    const jobId = seedStep(engine, queue, { state: 'merged' });
    engine.applyOpenPrPatch(jobId, 'step-1', { ciState: 'success' }, 'user');
    await new Promise((r) => setTimeout(r, 0));
    expect(archived).toEqual([]);
  });
});

// Reads the single envelope the engine wrote for the step, to inspect its round.
function readEnvelopeRound(dir: string, jobId: string) {
  const base = join(dir, 'jobs', jobId, 'steps', 'step-1');
  const file = readdirSync(base).find((f) => f.endsWith('.json'))!;
  return JSON.parse(readFileSync(join(base, file), 'utf8')).typePayload.round;
}

describe('tickOne lifts a stale halt when the failing step recovers', () => {
  // Regression: reconcileInterruptedSteps marks an `implementing` open-pr step failed
  // on every daemon restart, which halts the job (state=failed). Merging the step later
  // (squash-to-base) clears the step failure but historically left the job stuck in
  // `failed`. The un-halt in tickOne must resume it so it can settle to done.
  it('a failed job whose only step then merges → resumes and settles to done', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedStep(engine, queue, {
      state: 'implementing', reviewed: true,
      failure: { reason: 'implement session interrupted by daemon restart', at: 1 },
    });
    queue.upsert({ ...queue.get(jobId)!, state: 'failed' });

    engine.applyOpenPrPatch(jobId, 'step-1', { state: 'merged' }, 'user');
    await new Promise((r) => setTimeout(r, 0));

    const j = queue.get(jobId)!;
    expect((j.steps[0] as OpenPrStep).failure).toBeUndefined();
    expect(j.state).toBe('done');
  });

  it('leaves a genuinely-failed job halted while its step still carries a failure', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedStep(engine, queue, {
      state: 'implementing', reviewed: true, failure: { reason: 'real failure', at: 1 },
    });
    queue.upsert({ ...queue.get(jobId)!, state: 'failed' });

    await engine.tick(jobId);

    expect(queue.get(jobId)!.state).toBe('failed');
  });
});

describe('engine.resolveConflicts with opts', () => {
  it('threads base/push/postAction into the conflict round and records the post-action', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedStep(engine, queue, { state: 'conflicting' });
    await engine.resolveConflicts(jobId, 'step-1', { base: 'main', push: false, postAction: 'squash-to-base' });
    const round = readEnvelopeRound(dir, jobId);
    expect(round).toMatchObject({ kind: 'conflict', base: 'main', push: false, postAction: 'squash-to-base' });
    const s = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(s.conflictPostAction).toBe('squash-to-base');
  });

  it('opts-less call keeps the bare conflict round (PR path unchanged)', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedStep(engine, queue, { state: 'conflicting' });
    await engine.resolveConflicts(jobId, 'step-1');
    expect(readEnvelopeRound(dir, jobId)).toEqual({ kind: 'conflict' });
  });
});

describe('engine.markConflictResolved auto-retry', () => {
  it('resolved + postAction=squash-to-base re-invokes squashMergeToBase and clears the post-action', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedStep(engine, queue, { conflictResolving: true, state: 'conflicting', conflictPostAction: 'squash-to-base' });
    const calls: Array<[string, string]> = [];
    // Stub the git-driven retry to isolate the decision (Task-1/integration cover the real merge).
    (engine as unknown as { squashMergeToBase: (j: string, s: string) => Promise<'merged'> }).squashMergeToBase =
      async (j, s) => { calls.push([j, s]); return 'merged'; };
    engine.markConflictResolved(jobId, 'step-1', { status: 'resolved' });
    expect(calls).toEqual([[jobId, 'step-1']]);
    const s = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(s.conflictPostAction).toBeUndefined();
  });

  it('resolved without a post-action does not retry', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedStep(engine, queue, { conflictResolving: true, state: 'conflicting' });
    let called = false;
    (engine as unknown as { squashMergeToBase: () => Promise<'merged'> }).squashMergeToBase =
      async () => { called = true; return 'merged'; };
    engine.markConflictResolved(jobId, 'step-1', { status: 'resolved' });
    expect(called).toBe(false);
  });
});

describe('engine.squashMergeToBase (real git)', () => {
  it('clean squash → merged and worktree archived', async () => {
    // Build a real parent+worktree and point the mock at it.
    const { makeParentAndWorktree } = await import('./helpers/squash-repo.js');
    const { parent, wt } = makeParentAndWorktree();
    const { engine, queue, archived } = makeEngineWith(parent, wt, 'main');
    const jobId = seedStep(engine, queue, { state: 'pr_open' });
    const outcome = await engine.squashMergeToBase(jobId, 'step-1');
    expect(outcome).toBe('merged');
    expect((queue.get(jobId)!.steps[0] as OpenPrStep).state).toBe('merged');
    await new Promise((r) => setTimeout(r, 0));
    expect(archived).toEqual([{ stepId: 'step-1' }]);
  });

  it('conflicting squash → resolving-conflicts, conflictResolving set, round carries base+postAction', async () => {
    const { makeParentAndWorktree } = await import('./helpers/squash-repo.js');
    const { parent, wt } = makeParentAndWorktree({ mainEdit: 'MAIN DIVERGED\n' });
    const { engine, queue, dir } = makeEngineWith(parent, wt, 'main');
    const jobId = seedStep(engine, queue, { state: 'pr_open' });
    const outcome = await engine.squashMergeToBase(jobId, 'step-1');
    expect(outcome).toBe('resolving-conflicts');
    const s = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(s.conflictResolving).toBe(true);
    expect(s.conflictPostAction).toBe('squash-to-base');
    const round = readEnvelopeRound(dir, jobId);
    expect(round).toMatchObject({ kind: 'conflict', base: 'main', push: false, postAction: 'squash-to-base' });
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
      queue, sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {}, close() {}, archive() {} } as never,
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

export function makeEngineWith(parentCwd: string, wtPath: string, baseBranch: string) {
  const dir = mkdtempSync(join(tmpdir(), 'squash-eng-'));
  const queue = new JobQueue(dir);
  const archived: Array<{ stepId: string }> = [];
  const sessionManager = { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {}, close() {}, archive() {} } as never;
  const worktreeManager = {
    provision: async () => ({ path: wtPath }),
    get: () => ({ projectCwd: parentCwd, worktreePath: wtPath, branch: 'feat/x', baseBranch }),
    archive: async (stepId: string) => { archived.push({ stepId }); },
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never, jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => 1,
  });
  return { engine, queue, archived, dir };
}
