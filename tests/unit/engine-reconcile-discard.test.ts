import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord, ProposedStep } from '../../src/work/work-types.js';

const actionRegistry = {
  getAction() { return { frontmatter: { outpost: { runner: 'claude' } } }; },
  listActions() { return []; },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-discard-'));
  const queue = new JobQueue(dir);
  const resumed: Array<{ sessionId: string; text: string; env: Record<string, string> }> = [];
  const engine = new WorkEngine({
    queue,
    sessionManager: {
      spawnDetached() {}, send() {}, isWorking() { return false; },
      sendOrResume(sessionId: string, _cwd: string, msg: never, env: Record<string, string>) {
        resumed.push({ sessionId, text: (msg as { message: { content: string } }).message.content, env });
      },
    } as never,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `new-${++n}`; })(),
    now: () => 1000,
  });
  return { engine, queue, resumed };
}

function step(id: string, state: ActionStep['state'] = 'running'): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g',
    action: 'read.investigate', inputs: {}, state,
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000,
  };
}

function fresh(title: string): ProposedStep {
  return { type: 'action', title, description: 'd', goal: 'g', action: 'read.investigate', inputs: {} } as ProposedStep;
}

function seed(queue: JobQueue, engine: WorkEngine, proposed: ProposedStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({
    ...j,
    state: 'plan_pending_review',
    orchestratorSessionId: 'sess-1',
    steps: [step('a', 'resolved'), step('b')],
    pendingReconciliation: { proposed, drops: [], feedback: 'earlier note', proposedAt: 1000 },
  }));
  return job.id;
}

describe('WorkEngine.onReconciliationDiscarded', () => {
  it('drops the amendment silently when no reason is given', () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seed(queue, engine, [fresh('replacement')]);

    engine.onReconciliationDiscarded(jobId);

    const j = queue.get(jobId)!;
    expect(j.pendingReconciliation).toBeUndefined();
    expect(j.state).toBe('executing');
    expect(j.plan?.iterationsRejected ?? []).toEqual([]);
    expect(resumed).toHaveLength(0);
  });

  it('hands the refused amendment back to the orchestrator with the reason', () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seed(queue, engine, [fresh('replacement')]);

    engine.onReconciliationDiscarded(jobId, '  step 2 is the wrong repo  ');

    const j = queue.get(jobId)!;
    expect(j.pendingReconciliation).toBeUndefined();
    // reopenOrchestrator parks the job back in planning while the orchestrator re-amends.
    expect(j.state).toBe('planning');

    const rejected = j.plan!.iterationsRejected!;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.feedback).toBe('step 2 is the wrong repo');
    expect(rejected[0]!.steps.map((s) => s.title)).toEqual(['replacement']);

    expect(j.events?.some((e) => e.kind === 'plan_rejected' && e.body === 'step 2 is the wrong repo')).toBe(true);

    // The reason has to reach the session, not just the job record — a rejection the
    // orchestrator never hears about gets reproposed verbatim.
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.sessionId).toBe('sess-1');
    expect(resumed[0]!.text).toContain('step 2 is the wrong repo');

    const env = JSON.parse(readFileSync(resumed[0]!.env.OUTPOST_ENVELOPE!, 'utf8'));
    expect(env.mode).toBe('replan');
    expect(env.userFeedback).toBe('step 2 is the wrong repo');
    expect(env.rejectedIterations).toHaveLength(1);
    // The steps it re-amends against are the ones still on the job, not the refused proposal.
    expect(env.currentSteps.map((s: { id: string }) => s.id)).toEqual(['a', 'b']);
  });

  it('marks settled steps reviewed either way, so no redundant step-review fires', () => {
    const { engine, queue } = makeEngine();
    const jobId = seed(queue, engine, [fresh('replacement')]);

    engine.onReconciliationDiscarded(jobId, 'not this');

    expect(queue.get(jobId)!.steps.find((s) => s.id === 'a')!.reviewed).toBe(true);
  });
});
