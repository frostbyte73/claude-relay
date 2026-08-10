import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord, ProposedStep } from '../../src/work/work-types.js';

const actionRegistry = {
  getAction() { return { frontmatter: { outpost: { runner: 'claude' } } }; },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-recon-'));
  const queue = new JobQueue(dir);
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `new-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue };
}

function step(id: string): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g',
    action: 'read.investigate', inputs: {}, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000,
  };
}

function keep(id: string): ProposedStep {
  return { type: 'action', keepId: id, title: id, description: 'd', goal: 'g', action: 'read.investigate', inputs: {} } as ProposedStep;
}

function fresh(title: string): ProposedStep {
  return { type: 'action', title, description: 'd', goal: 'g', action: 'read.investigate', inputs: {} } as ProposedStep;
}

function seed(queue: JobQueue, engine: WorkEngine, steps: ActionStep[], proposed: ProposedStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({
    ...j,
    state: 'executing',
    steps,
    pendingReconciliation: { proposed, drops: [], feedback: '', proposedAt: 1000 },
  }));
  return job.id;
}

const titles = (queue: JobQueue, jobId: string) => queue.get(jobId)!.steps.map((s) => s.title);

describe('WorkEngine.onReconciliationApproved — added-step placement', () => {
  it('materializes a mid-plan insertion at its proposed position', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(
      queue, engine,
      [step('a'), step('b'), step('c')],
      [keep('a'), fresh('INSERTED'), keep('b'), keep('c')],
    );

    engine.onReconciliationApproved(jobId);

    expect(titles(queue, jobId)).toEqual(['a', 'INSERTED', 'b', 'c']);
  });

  it('keeps two insertions at their own proposed positions', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(
      queue, engine,
      [step('a'), step('b'), step('c')],
      [fresh('FIRST'), keep('a'), keep('b'), fresh('MIDDLE'), keep('c')],
    );

    engine.onReconciliationApproved(jobId);

    expect(titles(queue, jobId)).toEqual(['FIRST', 'a', 'b', 'MIDDLE', 'c']);
  });
});
