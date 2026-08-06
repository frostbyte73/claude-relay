import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

// A controller that parks with `{ kind: 'wait', wait: { resumeAt } }` — "bake the canary 30
// minutes", "CI takes 20" — has to actually wake. Nothing else ticks a parked controller:
// there is no periodic engine tick, and an empty inbox is not deliverable on its own.
function bootedEngine(dir: string) {
  const queue = new JobQueue(dir);
  const resumed: string[] = [];
  const engine = new WorkEngine({
    queue,
    sessionManager: {
      spawnDetached() {}, send() {}, isWorking() { return false; },
      sendOrResume(sessionId: string) { resumed.push(sessionId); },
      close: async () => {},
    } as never,
    worktreeManager: { provision: async () => ({ path: null }), get: () => undefined, archive: async () => {} } as never,
    linearWriter: { setState: async () => undefined } as never,
    jobsDir: join(dir, 'jobs'),
  });
  return { engine, queue, resumed };
}

function seed(dir: string, over: Partial<OrchestratedStep> = {}): { jobId: string; stepId: string } {
  const queue = new JobQueue(dir);
  const step: OrchestratedStep = {
    id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'running', createdAt: 1, updatedAt: 1, sessionId: 'ctrl-sess', ...over,
  } as OrchestratedStep;
  const job: JobRecord = {
    id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
    steps: [step], createdAt: 1, updatedAt: 1,
  };
  queue.upsert(job);
  return { jobId: job.id, stepId: step.id };
}

const settle = async (ms: number) => { await new Promise((r) => setTimeout(r, ms)); };

describe('orchestrated timed wait', () => {
  it('arms a wake when the controller parks on resumeAt, and delivers a timer item when it elapses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-wake-'));
    const { jobId, stepId } = seed(dir);
    const { engine, queue, resumed } = bootedEngine(dir);

    engine.onStepProgress(jobId, stepId, {
      next: { kind: 'wait', wait: { reason: 'bake the canary', resumeAt: Date.now() + 20 } },
    });
    expect((queue.get(jobId)!.steps[0] as OrchestratedStep).state).toBe('waiting');
    expect(resumed).toEqual([]);

    await settle(80);

    const s = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(s.state).toBe('running');
    expect(s.waitingOn).toBeUndefined();
    expect(s.lastDelivered?.some((i) => i.kind === 'timer')).toBe(true);
    expect(resumed).toEqual(['ctrl-sess']);
  });

  it('re-arms a soak that outlived the daemon it was armed in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-wake-'));
    const { jobId } = seed(dir, {
      state: 'waiting', waitingOn: { reason: 'bake', resumeAt: Date.now() - 1_000 },
    });
    // Fresh process: the setTimeout is gone, only the persisted resumeAt survives.
    const { engine, queue, resumed } = bootedEngine(dir);

    engine.reconcileWaits();
    await settle(30);

    const s = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(s.state).toBe('running');
    expect(s.lastDelivered?.some((i) => i.kind === 'timer')).toBe(true);
    expect(resumed).toEqual(['ctrl-sess']);
  });

  it('leaves an event-only wait parked — no timer, no wake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-wake-'));
    const { jobId, stepId } = seed(dir);
    const { engine, queue, resumed } = bootedEngine(dir);

    engine.onStepProgress(jobId, stepId, { next: { kind: 'wait', wait: { reason: 'CI', events: ['ci'] } } });
    await settle(30);

    expect((queue.get(jobId)!.steps[0] as OrchestratedStep).state).toBe('waiting');
    expect(resumed).toEqual([]);
  });
});
