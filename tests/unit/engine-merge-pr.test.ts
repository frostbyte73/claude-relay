import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Records every execFileSync invocation and models the real gh behaviour: a
// `gh pr merge … --delete-branch` fails because the step's branch is still
// checked out in its worktree ("cannot delete branch … used by worktree"),
// even though the PR merged on GitHub. A merge without --delete-branch succeeds.
const calls: string[][] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh' && args.includes('merge')) {
        if (args.includes('--delete-branch')) {
          throw new Error('failed to delete local branch: used by worktree at /tmp/wt');
        }
        return Buffer.from('');
      }
      if (cmd === 'git' && args.includes('--delete')) {
        // GitHub auto-deleted the head branch already — remote delete is best-effort.
        throw new Error('remote ref does not exist');
      }
      return Buffer.from('');
    }),
  };
});

const { WorkEngine } = await import('../../src/work/engine.js');
const { JobQueue } = await import('../../src/work/work-queue.js');
type OpenPrStep = import('../../src/work/work-types.js').OpenPrStep;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-'));
  const queue = new JobQueue(dir);
  const sessionManager = {
    spawnDetached() {}, send() {}, isWorking() { return false; },
    sendOrResume() {}, close() {}, archive() {},
  } as never;
  const worktreeManager = {
    provision: async () => ({ path: dir }),
    get: () => ({ projectCwd: '/tmp/repo', worktreePath: dir, branch: 'feat/x', baseBranch: 'main' }),
    archive: async () => {},
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never, jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => 1,
  });
  return { engine, queue };
}

function seedMergeReadyStep(engine: InstanceType<typeof WorkEngine>, queue: InstanceType<typeof JobQueue>) {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  const step: OpenPrStep = {
    id: 'step-1', title: 't', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    goal: 'g', approach: 'a', state: 'pr_open', reviewState: 'approved', ciState: 'success',
    prState: 'open', prUrl: 'https://github.com/o/r/pull/1', sessionId: 'sess-1',
    createdAt: 1, updatedAt: 1,
  };
  queue.upsert({ ...queue.get(job.id)!, steps: [step], state: 'executing' });
  return job.id;
}

describe('engine.mergePr advances state on a successful merge', () => {
  beforeEach(() => { calls.length = 0; });

  it('transitions the step to merged even though local-branch cleanup fails', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedMergeReadyStep(engine, queue);

    engine.mergePr(jobId, 'step-1');

    const step = queue.get(jobId)!.steps[0] as OpenPrStep;
    expect(step.state).toBe('merged');
    expect(step.prState).toBe('merged');
  });

  it('does not couple the merge to --delete-branch (branch cleanup is best-effort)', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedMergeReadyStep(engine, queue);

    engine.mergePr(jobId, 'step-1');

    const mergeCall = calls.find((c) => c[0] === 'gh' && c.includes('merge'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall).not.toContain('--delete-branch');
  });
});
