import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';

// meta.wait is builtin; read.investigate is a normal claude action. The engine's
// action handler reads runner off this registry at decide time.
const actionRegistry = {
  getAction(name: string) {
    if (name === 'meta.wait') return { frontmatter: { outpost: { runner: 'builtin' } } };
    return { frontmatter: { outpost: { runner: 'claude' } } };
  },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-wait-'));
  const queue = new JobQueue(dir);
  const spawned: string[] = [];
  const clock = { now: 1000 };
  const sessionManager = {
    spawnDetached(sessionId: string) { spawned.push(sessionId); },
    send() {}, isWorking() { return false; }, sendOrResume() {},
  } as never;
  const worktreeManager = { provision: async () => ({ path: dir }) } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => clock.now,
  });
  return { engine, queue, spawned, clock, dir };
}

function actionStep(id: string, action: string, inputs: Record<string, unknown> = {}): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g',
    action, inputs, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000,
  };
}

// Drop a two-step executing job (steps run sequentially — distinct solo groups) onto the queue.
function seedJob(queue: JobQueue, engine: WorkEngine, steps: ActionStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps }));
  return job.id;
}

function stepOf(queue: JobQueue, jobId: string, stepId: string): ActionStep {
  return queue.get(jobId)!.steps.find((s) => s.id === stepId) as ActionStep;
}

describe('WorkEngine meta.wait — timed soak', () => {
  it('parks in waiting with resumeAt, then a tick past the deadline resolves by timer and advances', async () => {
    const { engine, queue, clock } = makeEngine();
    const jobId = seedJob(queue, engine, [
      actionStep('w1', 'meta.wait', { reason: 'bake the deploy', duration_sec: 3600 }),
      actionStep('w2', 'meta.wait', { reason: 'second hold' }),
    ]);

    await engine.tick(jobId);
    const parked = stepOf(queue, jobId, 'w1');
    expect(parked.state).toBe('waiting');
    expect(parked.resumeAt).toBe(1000 + 3600 * 1000);
    // The gated step must not launch while the hold is active.
    expect(stepOf(queue, jobId, 'w2').state).toBe('running');

    // Before the deadline: still parked.
    clock.now = 1000 + 3599 * 1000;
    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'w1').state).toBe('waiting');

    // Past the deadline: resolves by timer and the next step becomes active.
    clock.now = 1000 + 3601 * 1000;
    await engine.tick(jobId);
    const resolved = stepOf(queue, jobId, 'w1');
    expect(resolved.state).toBe('resolved');
    expect(JSON.parse(resolved.output!)).toEqual({ resumed_by: 'timer' });
    expect(stepOf(queue, jobId, 'w2').state).toBe('waiting');
  });
});

describe('WorkEngine meta.wait — indefinite hold + user resume', () => {
  it('holds with no resumeAt and only resolves when the user resumes (with note)', async () => {
    const { engine, queue, clock } = makeEngine();
    const jobId = seedJob(queue, engine, [
      actionStep('w1', 'meta.wait', { reason: 'promote when ready' }),
      actionStep('w2', 'meta.wait', { reason: 'second hold' }),
    ]);

    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'w1').state).toBe('waiting');
    expect(stepOf(queue, jobId, 'w1').resumeAt).toBeUndefined();

    // No timer to elapse — a later tick leaves it parked.
    clock.now += 10_000_000;
    await engine.tick(jobId);
    expect(stepOf(queue, jobId, 'w1').state).toBe('waiting');

    engine.resumeWait(jobId, 'w1', '  looked good  ');
    const resolved = stepOf(queue, jobId, 'w1');
    expect(resolved.state).toBe('resolved');
    expect(JSON.parse(resolved.output!)).toEqual({ resumed_by: 'user', note: 'looked good' });
    expect(stepOf(queue, jobId, 'w2').state).toBe('waiting');
  });

  it('resumeWait is a no-op on a step that is not waiting (stale resume click)', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('w1', 'meta.wait', { reason: 'x' })]);
    // Never ticked → still 'running', not parked.
    engine.resumeWait(jobId, 'w1');
    expect(stepOf(queue, jobId, 'w1').state).toBe('running');
  });
});

describe('WorkEngine.reconcileWaits — restart recovery', () => {
  it('resolves an overdue parked wait and leaves a future one parked', () => {
    const { engine, queue, clock } = makeEngine();
    clock.now = 5_000_000;
    const jobId = seedJob(queue, engine, [
      { ...actionStep('overdue', 'meta.wait', { reason: 'a' }), state: 'waiting', resumeAt: 1_000_000 },
      { ...actionStep('future', 'meta.wait', { reason: 'b' }), state: 'waiting', resumeAt: 9_000_000, parallelGroup: 'g' },
    ]);

    engine.reconcileWaits();

    expect(stepOf(queue, jobId, 'overdue').state).toBe('resolved');
    expect(JSON.parse(stepOf(queue, jobId, 'overdue').output!)).toEqual({ resumed_by: 'timer' });
    expect(stepOf(queue, jobId, 'future').state).toBe('waiting');
  });
});
