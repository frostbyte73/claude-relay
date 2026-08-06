import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { LaunchGovernor } from '../../src/work/launch-governor.js';
import type { TokenUsageSnapshot } from '../../src/schedules/headroom.js';
import type { OrchestratedStep, ProposedStep } from '../../src/work/work-types.js';

const NOW_S = Math.floor(Date.now() / 1000);
// Healthy: 7d well behind pace (near reset, barely used), 5h low → headroom ok.
const healthy: TokenUsageSnapshot = {
  five_hour: { used_percentage: 10, resets_at: NOW_S + 3600 },
  seven_day: { used_percentage: 10, resets_at: NOW_S + 3600 },
};
// Blocking: 5h over the hard ceiling → launch:false, code !== 'no-data' (so the gate is on).
const blocking: TokenUsageSnapshot = {
  five_hour: { used_percentage: 95, resets_at: NOW_S + 3600 },
  seven_day: { used_percentage: 10, resets_at: NOW_S + 3600 },
};

function makeHarness(opts: { snapshot?: TokenUsageSnapshot; concurrency?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'launch-int-'));
  const queue = new JobQueue(dir);
  const spawns: string[] = [];
  const resumes: Array<{ sessionId: string; content: string }> = [];
  const working = new Set<string>();
  const sessionManager = {
    spawnDetached(sessionId: string) { spawns.push(sessionId); working.add(sessionId); },
    send() {},
    isWorking(id: string) { return working.has(id); },
    sendOrResume(sessionId: string, _cwd: string, msg: { message: { content: string } }) {
      resumes.push({ sessionId, content: msg.message.content });
      working.add(sessionId);
    },
    close: async () => {},
  } as never;
  const worktreeManager = { provision: async () => ({ path: dir }), get: () => undefined, archive: async () => {} } as never;
  const linearWriter = { setState: async () => undefined } as never;

  let snapshot: TokenUsageSnapshot | undefined = opts.snapshot ?? healthy;
  let concurrency = opts.concurrency ?? 1;
  const governor = new LaunchGovernor({
    getSnapshot: () => snapshot,
    getConcurrency: () => concurrency,
    now: () => Date.now(),
  });
  // Just enough registry for the orchestrated policy to recognise the actions these tests
  // bind rounds to; without it validateNext rejects every named self-round as unknown.
  const actionRegistry = {
    listActions: () => [],
    getAction: (name: string) => ({
      frontmatter: { outpost: { side_effects: name === 'code.fix-pr-comment' ? 'worktree-edit' : 'none' } },
    }),
  } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter, actionsStore: {} as never, governor, actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
  });
  return {
    engine, queue, governor, spawns, resumes, working,
    setSnapshot: (s: TokenUsageSnapshot | undefined) => { snapshot = s; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function actionStep(group?: string): ProposedStep {
  return {
    type: 'action', title: 't', description: 'd', goal: 'g', action: 'read.investigate',
    workspace: { kind: 'readonly', repoCwd: '/tmp' },
    ...(group ? { parallelGroup: group } : {}),
  } as ProposedStep;
}

// Seeds an executing job with the given proposed steps and ticks once so decide() dispatches.
async function seedExecuting(h: ReturnType<typeof makeHarness>, steps: ProposedStep[], over: Record<string, unknown> = {}) {
  const job = h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
  for (const s of steps) h.engine.addStepManually(job.id, s);
  h.queue.mutate(job.id, (j) => ({ ...j, state: 'executing', ...over }));
  await h.engine.tick(job.id);
  await flush();
  return job.id;
}

describe('WorkEngine ↔ LaunchGovernor', () => {
  it('a blocking snapshot parks the first step; healthy + onUsageSnapshot spawns it', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    await seedExecuting(h, [actionStep()]);
    expect(h.spawns).toHaveLength(0);   // parked under token pressure

    h.setSnapshot(healthy);
    h.governor.onUsageSnapshot();
    await flush();
    expect(h.spawns).toHaveLength(1);   // headroom returned → fired
  });

  it('a parallel group of 2 at concurrency 1 spawns one; turnEnded releases the second', async () => {
    const h = makeHarness({ snapshot: healthy, concurrency: 1 });
    const jobId = await seedExecuting(h, [actionStep('g1'), actionStep('g1')]);
    expect(h.spawns).toHaveLength(1);   // slot budget = 1

    const started = h.queue.get(jobId)!.steps.find((s) => s.sessionId)!;
    h.governor.turnEnded(started.sessionId!);
    await flush();
    expect(h.spawns).toHaveLength(2);   // freed slot → second fires
  });

  it('a reactive round (a PR-comment fix) fires immediately under a blocking snapshot', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    const job = h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step: OrchestratedStep = {
      id: 'step-1', title: 't', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr',
      workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
      goal: 'g', state: 'running', sessionId: 'sess-c',
      pr: { prUrl: 'https://example/pull/1', mergeable: 'conflicting' },
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      createdAt: 1, updatedAt: 1,
    };
    h.queue.upsert({ ...h.queue.get(job.id)!, steps: [step], state: 'executing' });
    h.engine.onStepProgress(job.id, 'step-1', {
      phase: 'pr_comments', next: { kind: 'self-round', action: 'code.fix-pr-comment' },
    });
    await flush();
    expect(h.resumes).toEqual([{ sessionId: 'sess-c', content: '/code.fix-pr-comment' }]);
  });

  it('a high-priority job spawns its first step immediately under a blocking snapshot', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    await seedExecuting(h, [actionStep()], { highPriority: true });
    expect(h.spawns).toHaveLength(1);
  });

  it('launchNow force-spawns a parked step', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    const jobId = await seedExecuting(h, [actionStep()]);
    expect(h.spawns).toHaveLength(0);
    const stepId = h.queue.get(jobId)!.steps[0]!.id;
    expect(h.engine.launchNow(jobId, stepId)).toBe(true);
    expect(h.spawns).toHaveLength(1);
  });

  it('setHighPriority(true) fires the job\'s parked launches', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    const jobId = await seedExecuting(h, [actionStep()]);
    expect(h.spawns).toHaveLength(0);
    h.engine.setHighPriority(jobId, true);
    expect(h.spawns).toHaveLength(1);
    expect(h.queue.get(jobId)!.highPriority).toBe(true);
  });

  it('cancelling a parked step frees the slot when the stale launch drains (no leak)', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    const jobId = await seedExecuting(h, [actionStep()]);
    const stepId = h.queue.get(jobId)!.steps[0]!.id;
    expect(h.spawns).toHaveLength(0);   // parked under token pressure

    // User cancels the parked step (allowed precisely because it has no sessionId yet).
    expect(h.engine.cancelStepManually(jobId, stepId)).toBe(true);

    // A second job's step queues behind the (now stale) parked launch.
    const job2 = await seedExecuting(h, [actionStep()]);
    const step2 = h.queue.get(job2)!.steps[0]!.id;

    // Headroom returns → drain fires the stale launch, whose run bails on `cancelled`.
    // The slot must NOT be permanently consumed: job2's step then launches.
    h.setSnapshot(healthy);
    h.governor.onUsageSnapshot();
    await flush();

    expect(h.engine.launchStatusFor(h.queue.get(jobId)!).steps[stepId!]!.state).not.toBe('running');
    expect(h.spawns).toHaveLength(1);   // only job2's step spawned — no leak, no ghost spawn
    expect(h.engine.launchStatusFor(h.queue.get(job2)!).steps[step2!]!.state).toBe('running');
  });

  it('abandoning a job with an active (mid-turn) autonomous session frees its slot', async () => {
    const h = makeHarness({ snapshot: healthy, concurrency: 1 });
    const jobId = await seedExecuting(h, [actionStep()]);
    expect(h.spawns).toHaveLength(1);   // slot now occupied by the live step session

    // A second job's step queues behind the occupied slot.
    const job2 = await seedExecuting(h, [actionStep()]);
    const step2 = h.queue.get(job2)!.steps[0]!.id;
    expect(h.spawns).toHaveLength(1);   // still just the first — slot busy

    // Abandon the first job. Its live session gets SIGTERMed (no Stop hook), so the slot must
    // be released synchronously by terminateJobResources — not leaked until proc exit.
    await h.engine.abandonJob(jobId);
    await flush();
    expect(h.spawns).toHaveLength(2);   // freed slot → job2's step launched
    expect(h.engine.launchStatusFor(h.queue.get(job2)!).steps[step2!]!.state).toBe('running');
  });

  it('releaseLaunchSlot on a dead (crashed) active session frees its slot', async () => {
    const h = makeHarness({ snapshot: healthy, concurrency: 1 });
    const jobId = await seedExecuting(h, [actionStep()]);
    const started = h.queue.get(jobId)!.steps.find((s) => s.sessionId)!;

    const job2 = await seedExecuting(h, [actionStep()]);
    expect(h.spawns).toHaveLength(1);   // job2 parked behind the occupied slot

    // Simulate the daemon onSessionExit path for a crashed session.
    h.engine.releaseLaunchSlot(started.sessionId!);
    await flush();
    expect(h.spawns).toHaveLength(2);   // slot freed → job2 launched
  });

  it('launchOrchestrator fires immediately when the slot is busy (manual runs bypass concurrency)', async () => {
    const h = makeHarness({ snapshot: healthy, concurrency: 1 });
    await seedExecuting(h, [actionStep()]);   // slot occupied by the live step session
    expect(h.spawns).toHaveLength(1);

    const job2 = h.engine.createJob({ source: 'manual', title: 't2', description: 'd' });
    await h.engine.launchOrchestrator(job2.id);
    await flush();
    expect(h.spawns).toHaveLength(2);   // explicit user launch bypassed the busy slot
  });

  it('launchOrchestrator fires immediately under a blocking snapshot (manual runs bypass headroom)', async () => {
    const h = makeHarness({ snapshot: blocking, concurrency: 1 });
    const job = h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await h.engine.launchOrchestrator(job.id);
    await flush();
    expect(h.spawns).toHaveLength(1);   // bypassed the token-headroom gate
  });

  it('reconcilePendingLaunches re-submits a planning job that has no orchestrator session', async () => {
    const h = makeHarness({ snapshot: healthy, concurrency: 1 });
    // A job stuck in planning with no orchestrator session (launch parked when the daemon died).
    h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    expect(h.spawns).toHaveLength(0);
    h.engine.reconcilePendingLaunches();
    await flush();
    expect(h.spawns).toHaveLength(1);   // initial orchestrator re-launched
  });
});
