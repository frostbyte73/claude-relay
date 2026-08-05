import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { JournalStore } from '../../src/storage/journal-store.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';

const actionRegistry = {
  getAction: () => ({ frontmatter: { outpost: { runner: 'claude' } } }),
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-journal-'));
  const queue = new JobQueue(dir);
  const journalStore = new JournalStore(join(dir, 'journal'));
  const engine = new WorkEngine({
    queue,
    sessionManager: { spawnDetached() {}, send() {}, isWorking: () => false, sendOrResume() {} } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    journalStore,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue, journalStore };
}

function seed(queue: JobQueue, engine: WorkEngine, action: string): { jobId: string; stepId: string } {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  const step: ActionStep = {
    id: 's1', type: 'action', title: 's1', description: 'd', goal: 'g',
    action, inputs: {}, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000,
  };
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps: [step] }));
  return { jobId: job.id, stepId: step.id };
}

describe('WorkEngine — blockers always reach the action journal', () => {
  it('journals a failed step so the action\'s lessons are never empty', () => {
    const { engine, queue, journalStore } = makeEngine();
    const { jobId, stepId } = seed(queue, engine, 'write.add-project');

    engine.onStepFailed(jobId, stepId, 'gh repo clone denied — no clone rule in this action\'s allowlist');

    const entries = journalStore.recent('write.add-project');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'write.add-project', jobId, stepId, outcome: 'blocked' });
    expect(entries[0]!.lesson).toContain('gh repo clone denied');
  });

  it('defers to a lesson the session wrote itself rather than duplicating it', () => {
    const { engine, queue, journalStore } = makeEngine();
    const { jobId, stepId } = seed(queue, engine, 'write.add-project');

    journalStore.append({ action: 'write.add-project', jobId, stepId, outcome: 'blocked', lesson: 'session-authored' });
    engine.onStepFailed(jobId, stepId, 'raw failure reason');

    const entries = journalStore.recent('write.add-project');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lesson).toBe('session-authored');
  });

  it('skips failures the action did not cause', () => {
    const { engine, queue, journalStore } = makeEngine();
    const { jobId, stepId } = seed(queue, engine, 'write.add-project');

    engine.onStepFailed(jobId, stepId, 'workspace provision failed: bad base ref', { journal: false });

    expect(journalStore.recent('write.add-project')).toEqual([]);
  });
});
