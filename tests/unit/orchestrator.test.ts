import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { LaunchGovernor } from '../../src/work/launch-governor.js';
import { OUTPOST_MCP_TOOLS } from '../../src/mcp-server.js';
import { orchestratedHandler } from '../../src/steps/orchestrated.js';
import type { Finding, JobRecord, OrchestratedStep, ProposedStep, Step, WorkspaceRef } from '../../src/work/work-types.js';

function makeEngine(dir = mkdtempSync(join(tmpdir(), 'orch-'))) {
  const queue = new JobQueue(dir);
  const spawned: Array<{ sessionId: string; env: Record<string, string>; action?: string; kick?: string }> = [];
  const resumed: Array<{ sessionId: string; env: Record<string, string> }> = [];
  const sessionManager = {
    spawnDetached(sessionId: string, _cwd: string, env: Record<string, string>) {
      spawned.push({ sessionId, env });
    },
    send(sessionId: string, msg: { message: { content: string } }) {
      const entry = spawned.find((s) => s.sessionId === sessionId);
      if (entry) entry.kick = msg.message.content;
    },
    isWorking() { return false; },
    sendOrResume(sessionId: string, _cwd: string, _msg: unknown, env: Record<string, string>) {
      resumed.push({ sessionId, env });
    },
  } as never;
  // Mirrors WorktreeManager closely enough for the editability rules: `kind: 'none'` records
  // nothing, every other kind records under the key it was provisioned with, and a second
  // provision for a live key returns the FIRST worktree regardless of the ref passed in —
  // which is the whole reason editStepManually has to pin the workspace of a provisioned step.
  const worktrees = new Map<string, { worktreePath: string; projectCwd: string; baseRef?: string; archivedAt?: number }>();
  const worktreeManager = {
    provision: async (key: string, ref: WorkspaceRef) => {
      if (!ref || ref.kind === 'none') return { path: null };
      const existing = worktrees.get(key);
      if (existing && !existing.archivedAt) return { path: existing.worktreePath };
      worktrees.set(key, {
        worktreePath: join(dir, key),
        projectCwd: ref.repoCwd,
        baseRef: ref.kind === 'readonly' ? ref.ref : ref.branch,
      });
      return { path: join(dir, key) };
    },
    get: (key: string) => worktrees.get(key),
  } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const actionsStore = {} as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter, actionsStore,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
  });
  const orig = engine.bindAction.bind(engine);
  engine.bindAction = (sid: string, name: string) => {
    const entry = spawned.find((s) => s.sessionId === sid);
    if (entry) entry.action = name;
    orig(sid, name);
  };
  return { engine, queue, spawned, resumed, dir, worktrees };
}

describe('Orchestrator.launchOrchestrator', () => {
  it('spawns meta.orchestrate for a manual-source job', async () => {
    const { engine, queue, spawned } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await engine.launchOrchestrator(job.id);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.action).toBe('meta.orchestrate');
    expect(spawned[0]!.kick).toBe(`/meta.orchestrate ${job.id}`);
    expect(queue.get(job.id)?.orchestratorAction).toBe('meta.orchestrate');
  });

  it('spawns meta.orchestrate for a linear-source job', async () => {
    const { engine, spawned } = makeEngine();
    const job = engine.createJob({
      source: 'linear',
      title: 't',
      description: 'd',
      externalRef: { url: 'x', issueIdentifier: 'ABC-1', linearUuid: 'uuid' },
    });
    await engine.launchOrchestrator(job.id);
    expect(spawned[0]!.action).toBe('meta.orchestrate');
  });

  it('writes launchContext into the orchestrator envelope when provided', async () => {
    const { engine, dir } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await engine.launchOrchestrator(job.id, '  focus on the retry path  ');
    const env = JSON.parse(
      readFileSync(join(dir, 'jobs', job.id, 'orchestrator', 'envelope.json'), 'utf8'),
    );
    expect(env.launchContext).toBe('focus on the retry path');
  });

  it('omits launchContext when context is empty or absent', async () => {
    const { engine, dir } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await engine.launchOrchestrator(job.id, '   ');
    const env = JSON.parse(
      readFileSync(join(dir, 'jobs', job.id, 'orchestrator', 'envelope.json'), 'utf8'),
    );
    expect('launchContext' in env).toBe(false);
  });

});

describe('Orchestrator.reopenOrchestrator', () => {
  it('rebinds the orchestrator action on resume after a restart drops the in-memory maps', async () => {
    // First engine launches the orchestrator, persisting orchestratorSessionId to disk.
    const first = makeEngine();
    const job = first.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await first.engine.launchOrchestrator(job.id);
    const orchestratorSessionId = first.queue.get(job.id)!.orchestratorSessionId!;
    expect(orchestratorSessionId).toBeTruthy();

    // Second engine over the same dir simulates a daemon restart: the job
    // (with orchestratorSessionId) reloads from disk, but the in-memory action binding is gone.
    const second = makeEngine(first.dir);
    expect(second.engine.actionForSession(orchestratorSessionId)).toBeUndefined();

    second.engine.reopenOrchestrator(job.id, 'please revise');

    // Resume path must re-establish the binding so the hook-handler auto-allows the
    // orchestrator's reads instead of treating it as an interactive session.
    expect(second.resumed.map((r) => r.sessionId)).toEqual([orchestratorSessionId]);
    expect(second.engine.actionForSession(orchestratorSessionId)).toBe('meta.orchestrate');
  });
});

describe('Orchestrator.rehydrateSessionBindings', () => {
  it('rebinds persisted orchestrator and step sessions after a restart', async () => {
    const first = makeEngine();
    const job = first.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await first.engine.launchOrchestrator(job.id);
    const orchestratorSessionId = first.queue.get(job.id)!.orchestratorSessionId!;

    // Give the job an executing orchestrated step with a live session id, as a running
    // step would have persisted.
    const step = addOrchestratedStep(first.engine, job.id);
    first.queue.mutate(job.id, (j) => ({
      ...j,
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'step-sess-1' } : s)),
    }));

    // Fresh engine over the same dir — simulates the daemon restart.
    const second = makeEngine(first.dir);
    expect(second.engine.actionForSession(orchestratorSessionId)).toBeUndefined();
    expect(second.engine.actionForSession('step-sess-1')).toBeUndefined();

    second.engine.rehydrateSessionBindings();

    expect(second.engine.actionForSession(orchestratorSessionId)).toBe('meta.orchestrate');
    // An orchestrated step's session rebinds to its controller — the controller then picks
    // which action's hat to wear per round via submit_step_progress, rather than the engine
    // deriving an action from step state.
    expect(second.engine.actionForSession('step-sess-1')).toBe('code.orchestrate-pr');
  });
});

function addActionStep(engine: WorkEngine, jobId: string): Step {
  const proposed: ProposedStep = {
    type: 'action',
    title: 'investigate',
    description: 'd',
    goal: 'g',
    action: 'read.investigate',
    workspace: { kind: 'readonly', repoCwd: '/tmp' },
  };
  return engine.addStepManually(jobId, proposed) as Step;
}

describe('Orchestrator.reconcileInterruptedSteps', () => {
  it('re-spawns an orphaned running action step by clearing its dead sessionId', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addActionStep(engine, job.id);
    // Simulate a session that was in flight when the previous daemon died.
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'dead-sess' } : s)),
    }));

    engine.reconcileInterruptedSteps();

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === step.id)!;
    expect(reloaded.sessionId).toBeUndefined();
    expect(reloaded.state).toBe('running');
    expect(reloaded.failure).toBeUndefined();
    expect(queue.get(job.id)!.events!.some((e) => e.kind === 'step_retried' && e.who === 'system')).toBe(true);
  });

  it('leaves steps without a sessionId untouched (never spawned, not orphaned)', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addActionStep(engine, job.id);

    engine.reconcileInterruptedSteps();

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === step.id)!;
    expect(reloaded.state).toBe('running');
    expect(reloaded.failure).toBeUndefined();
    expect(queue.get(job.id)!.events?.some((e) => e.kind === 'step_retried')).toBeFalsy();
  });
});

// A daemon bounce (`launchctl kickstart -k` is the documented way to restart) kills every
// spawned Claude process. An orchestrated step in `running` is owed nothing by anyone — no
// inbox item, no timer — so decide() returns null for it forever and the job hangs showing
// "In progress". Every job migrated off the legacy open-pr type lands here on the first boot.
describe('Orchestrator.reconcileInterruptedSteps — orchestrated steps', () => {
  function orchestratedJob(queue: JobQueue, over: Partial<OrchestratedStep>) {
    const step: OrchestratedStep = {
      id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      phase: 'implement', memo: 'what I learned', artifacts: { spec: '# S' },
      dispatches: [], inbox: [], roundsSpent: 3, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: 'dead-sess', ...over,
    } as OrchestratedStep;
    const job: JobRecord = {
      id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    };
    queue.upsert(job);
    return { jobId: job.id, stepId: step.id };
  }

  it('cold-spawns a running controller by clearing the session that died with the daemon', () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = orchestratedJob(queue, {});

    engine.reconcileInterruptedSteps();

    const s = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(s.sessionId).toBeUndefined();
    expect(s.state).toBe('running');
    expect(s.failure).toBeUndefined();
    // phase/memo/artifacts are exactly what makes the cold resume cheap — they must survive.
    expect(s).toMatchObject({ phase: 'implement', memo: 'what I learned', roundsSpent: 3 });
    expect(queue.get(jobId)!.events!.some((e) => e.kind === 'step_retried' && e.who === 'system')).toBe(true);

    // The point of clearing it: decide() now has something to do again.
    expect(orchestratedHandler.decide(
      queue.get(jobId)!.steps[0] as OrchestratedStep, queue.get(jobId)!,
      { jobsDir: '/tmp/jobs', newId: () => 'n', now: () => 2 },
    )).toMatchObject({ kind: 'spawn-session', stepId });
  });

  // A parked controller is NOT stranded: whatever it waits on (a watcher event, a dispatch, the
  // user) resumes it, and sendOrResume respawns a dead session with --resume. Clearing its
  // session here would burn a turn on every bounce for no reason.
  it('leaves a parked controller alone', () => {
    const { engine, queue } = makeEngine();
    const { jobId } = orchestratedJob(queue, {
      state: 'waiting', waitingOn: { reason: 'CI', events: ['ci'] },
    });

    engine.reconcileInterruptedSteps();

    const s = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(s.sessionId).toBe('dead-sess');
    expect(s.state).toBe('waiting');
    expect(queue.get(jobId)!.events?.some((e) => e.kind === 'step_retried')).toBeFalsy();
  });

  // A dispatch child cannot be resumed — it is a one-shot action session. Left `running`, the
  // parent's untilAllDispatchesDone wait can never be satisfied.
  it('fails a dispatch child whose session died, waking the controller that waits on it', () => {
    const { engine, queue } = makeEngine();
    const { jobId } = orchestratedJob(queue, {
      state: 'waiting',
      waitingOn: { reason: 'Running code.review-diff', untilAllDispatchesDone: true },
      dispatches: [
        { id: 'd1', action: 'code.review-diff', brief: 'b', status: 'running', sessionId: 'child-sess', attempts: 1 },
        { id: 'd2', action: 'code.review-ui', brief: 'b2', status: 'done', output: 'ok', attempts: 1 },
      ],
    });

    engine.reconcileInterruptedSteps();

    const s = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(s.dispatches[0]).toMatchObject({ status: 'failed' });
    expect(s.dispatches[0]!.failure).toMatch(/restart/i);
    expect(s.dispatches[1]).toMatchObject({ status: 'done', output: 'ok' });
    // The wake actually happened: the controller was resumed with the done marker in hand.
    expect(s.state).toBe('running');
    expect(s.lastDelivered?.some((i) => i.kind === 'dispatch-done')).toBe(true);
  });
});

function addOrchestratedStep(engine: WorkEngine, jobId: string): OrchestratedStep {
  const proposed: ProposedStep = {
    type: 'orchestrated',
    controller: 'code.orchestrate-pr',
    title: 't',
    description: 'd',
    goal: 'g',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
  };
  return engine.addStepManually(jobId, proposed) as OrchestratedStep;
}

describe('Orchestrator — parallel group dispatch', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function addParallelStep(engine: WorkEngine, jobId: string, title: string, group: string): Step {
    return engine.addStepManually(jobId, {
      type: 'action', action: 'read.investigate', title,
      description: 'd', goal: 'g', workspace: { kind: 'none' }, parallelGroup: group,
    } as ProposedStep)!;
  }

  it('dispatches every ready member of a parallel group in a single tick', async () => {
    const { engine, queue, spawned } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const a = addParallelStep(engine, job.id, 'a', 'g1');
    const b = addParallelStep(engine, job.id, 'b', 'g1');
    const c = addParallelStep(engine, job.id, 'c', 'g1');
    queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));

    await engine.tick(job.id);
    await flush();

    const steps = queue.get(job.id)!.steps;
    expect(steps.find((s) => s.id === a.id)!.sessionId).toBeDefined();
    expect(steps.find((s) => s.id === b.id)!.sessionId).toBeDefined();
    expect(steps.find((s) => s.id === c.id)!.sessionId).toBeDefined();
    expect(spawned).toHaveLength(3);
  });

  it('does not dispatch a later group until the parallel group ahead of it settles', async () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    addParallelStep(engine, job.id, 'a', 'g1');
    addParallelStep(engine, job.id, 'b', 'g1');
    const later = addParallelStep(engine, job.id, 'later', 'g2');
    queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));

    await engine.tick(job.id);
    await flush();

    const steps = queue.get(job.id)!.steps;
    expect(steps.find((s) => s.id === later.id)!.sessionId).toBeUndefined();
  });
});

describe('Orchestrator — a failed step halts the plan', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('does not dispatch the next step and marks the job failed when a prior step fails', async () => {
    const { engine, queue, spawned } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const first = addActionStep(engine, job.id);
    const second = engine.addStepManually(job.id, {
      type: 'action', action: 'read.investigate', title: 'second',
      inputs: {}, workspace: { kind: 'none' },
    } as ProposedStep)!;
    queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));

    engine.onStepFailed(job.id, first.id, 'boom');
    const spawnCountBefore = spawned.length;

    // A kickstart / tick must NOT advance to the second step.
    await engine.tick(job.id);
    await flush();

    const s2 = queue.get(job.id)!.steps.find((s) => s.id === second.id)!;
    expect(s2.sessionId).toBeUndefined();            // next step never started
    expect(spawned.length).toBe(spawnCountBefore);   // nothing new spawned
    expect(queue.get(job.id)!.state).toBe('failed');  // job halted, not silently executing
  });
});

describe('Orchestrator — rerunLatest', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('reruns the failed step, not the trailing step, when an earlier step halted the job', async () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const failed = addActionStep(engine, job.id);
    const trailing = addActionStep(engine, job.id);  // never ran — queued behind `failed`
    queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));

    engine.onStepFailed(job.id, failed.id, 'boom');
    await engine.tick(job.id);
    await flush();
    expect(queue.get(job.id)!.state).toBe('failed');

    const target = engine.rerunLatest(job.id);

    expect(target).toBe(failed.id);                                   // the failed step, not `trailing`
    const j = queue.get(job.id)!;
    expect(j.steps.find((s) => s.id === failed.id)!.failure).toBeUndefined();  // failure cleared
    expect(j.state).toBe('executing');                               // halt lifted, not re-halted
  });
});

const sampleFinding = {
  findings: '## Verified\nNPE reproduces at session.go:142.',
  evidence: [{ kind: 'repo-file', source: 'session.go:142', summary: 'nil deref' }],
} as const;

describe('Orchestrator.onPlanReady — findings', () => {
  it('persists findings on the plan for an initial plan', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const proposed: ProposedStep = {
      type: 'orchestrated', controller: 'code.orchestrate-pr', title: 't', description: 'd', goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    };
    engine.onPlanReady(job.id, 'initial', [proposed], undefined, undefined, sampleFinding as unknown as Finding);
    expect(queue.get(job.id)?.plan?.findings).toEqual(sampleFinding);
  });

  it('leaves plan.findings undefined when the orchestrator omits them', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const proposed: ProposedStep = {
      type: 'orchestrated', controller: 'code.orchestrate-pr', title: 't', description: 'd', goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    };
    engine.onPlanReady(job.id, 'initial', [proposed]);
    expect(queue.get(job.id)?.plan?.findings).toBeUndefined();
  });

  it('updates plan.findings on a replan amendment while preserving postedAt', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const first: ProposedStep = {
      type: 'orchestrated', controller: 'code.orchestrate-pr', title: 't', description: 'd', goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    };
    engine.onPlanReady(job.id, 'initial', [first], undefined, undefined, sampleFinding as unknown as Finding);
    const postedAt = queue.get(job.id)!.plan!.postedAt;
    const stepId = queue.get(job.id)!.steps[0]!.id;

    const nextFinding = { findings: '## Updated\nAlso affects worker.go.' } as Finding;
    const keep: ProposedStep = { ...first, keepId: stepId };
    engine.onPlanReady(job.id, 'replan', [keep], [], 'more', nextFinding);

    const j = queue.get(job.id)!;
    expect(j.pendingReconciliation).toBeTruthy();
    expect(j.plan?.findings).toEqual(nextFinding);
    expect(j.plan?.postedAt).toBe(postedAt);
  });

  it('snapshots findings into the rejected iteration', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const proposed: ProposedStep = {
      type: 'orchestrated', controller: 'code.orchestrate-pr', title: 't', description: 'd', goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    };
    engine.onPlanReady(job.id, 'initial', [proposed], undefined, undefined, sampleFinding as unknown as Finding);
    engine.onPlanRejected(job.id, 'not quite');
    const iters = queue.get(job.id)?.plan?.iterationsRejected ?? [];
    expect(iters).toHaveLength(1);
    expect(iters[0]!.findings).toEqual(sampleFinding);
  });
});

describe('submit_plan tool schema', () => {
  it('exposes an optional findings param', () => {
    const tool = OUTPOST_MCP_TOOLS.find((t) => t.name === 'submit_plan')!;
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties.findings).toBeTruthy();
    expect(schema.required ?? []).not.toContain('findings');
  });
});

describe('WorkEngine per-step review', () => {
  async function executingJobWithSteps(h: ReturnType<typeof makeEngine>, steps: ProposedStep[]) {
    const job = h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    await h.engine.launchOrchestrator(job.id);
    h.engine.onPlanReady(job.id, 'initial', steps);
    h.engine.onPlanApproved(job.id);
    return job;
  }
  const investigate = (title: string): ProposedStep => ({
    type: 'action', action: 'read.investigate', title, description: '', goal: 'g',
    workspace: { kind: 'none' },
  } as ProposedStep);
  const envPath = (h: ReturnType<typeof makeEngine>, jobId: string) =>
    join(h.dir, 'jobs', jobId, 'orchestrator', 'envelope.json');
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('runs a step-review orchestrator after a trailing investigation instead of marking done', async () => {
    const h = makeEngine();
    const job = await executingJobWithSteps(h, [investigate('investigate')]);
    const before = h.spawned.filter((s) => s.action === 'meta.orchestrate').length;  // 1 (initial)
    const stepId = h.queue.get(job.id)!.steps[0]!.id;
    h.engine.onStepResolved(job.id, stepId, { output: '{"findings":"bump timeouts"}' });

    expect(h.queue.get(job.id)!.reviewingStepId).toBe(stepId);                        // review in flight
    expect(h.queue.get(job.id)!.state).toBe('executing');                             // NOT 'done'
    const after = h.spawned.filter((s) => s.action === 'meta.orchestrate').length;
    expect(after).toBe(before + 1);                                                   // a review was spawned
    const env = JSON.parse(readFileSync(envPath(h, job.id), 'utf8'));
    expect(env.mode).toBe('step-review');
    expect(env.completedStepId).toBe(stepId);
  });

  // Regression: the review used to park the job in `planning`, which the PWA reads as
  // "no execution yet" — so the whole step timeline vanished every time a step finished.
  // The gate is reviewingStepId now; `executing` has to survive the review, and the next
  // step still must not dispatch behind the orchestrator's back.
  it('holds the next step during a step-review without leaving `executing`', async () => {
    const h = makeEngine();
    const job = await executingJobWithSteps(h, [investigate('first'), investigate('second')]);
    const [first, second] = h.queue.get(job.id)!.steps;
    h.engine.onStepResolved(job.id, first!.id, {});
    await flush();

    expect(h.queue.get(job.id)!.state).toBe('executing');
    expect(h.queue.get(job.id)!.reviewingStepId).toBe(first!.id);
    expect(h.queue.get(job.id)!.steps[1]!.sessionId).toBeUndefined();  // held, not dispatched

    h.engine.onOrchestratorContinue(job.id);
    await flush();
    expect(h.queue.get(job.id)!.reviewingStepId).toBeUndefined();
    expect(h.queue.get(job.id)!.steps[1]!.sessionId).toBeDefined();
    expect(second!.id).toBe(h.queue.get(job.id)!.steps[1]!.id);
  });

  it('drops a step-review gate whose session died with the daemon so the job can recover', async () => {
    const h = makeEngine();
    const job = await executingJobWithSteps(h, [investigate('first'), investigate('second')]);
    const first = h.queue.get(job.id)!.steps[0]!;
    h.engine.onStepResolved(job.id, first.id, {});
    await flush();
    expect(h.queue.get(job.id)!.reviewingStepId).toBe(first.id);

    h.engine.reconcilePendingLaunches();
    expect(h.queue.get(job.id)!.reviewingStepId).toBeUndefined();
  });

  it('onOrchestratorContinue with no remaining steps marks the job done and flags the step reviewed', async () => {
    const h = makeEngine();
    const job = await executingJobWithSteps(h, [investigate('x')]);
    const stepId = h.queue.get(job.id)!.steps[0]!.id;
    h.engine.onStepResolved(job.id, stepId, {});     // → step-review (job stays executing)
    h.engine.onOrchestratorContinue(job.id);         // → mark reviewed + advance
    expect(h.queue.get(job.id)!.state).toBe('done');
    expect(h.queue.get(job.id)!.steps[0]!.reviewed).toBe(true);
  });

  it('rerunning a done+reviewed step clears reviewed so it is re-reviewed on re-resolve', async () => {
    const h = makeEngine();
    const job = await executingJobWithSteps(h, [investigate('x')]);
    const stepId = h.queue.get(job.id)!.steps[0]!.id;
    h.engine.onStepResolved(job.id, stepId, {});     // → step-review (job stays executing)
    h.engine.onOrchestratorContinue(job.id);         // → mark reviewed + advance → done
    expect(h.queue.get(job.id)!.state).toBe('done');
    expect(h.queue.get(job.id)!.steps[0]!.reviewed).toBe(true);

    h.engine.rerunLatest(job.id);
    expect(h.queue.get(job.id)!.steps[0]!.reviewed).toBeFalsy();
    expect(h.queue.get(job.id)!.state).toBe('executing');

    h.engine.onStepResolved(job.id, stepId, { output: 'new findings' });
    expect(h.queue.get(job.id)!.reviewingStepId).toBe(stepId);   // step-review spawned again
    expect(h.queue.get(job.id)!.state).not.toBe('done');
  });

  it('approving a reconciliation marks the already-reviewed settled step reviewed, without a redundant re-review spawn', async () => {
    const h = makeEngine();
    const job = await executingJobWithSteps(h, [investigate('x')]);
    const stepId = h.queue.get(job.id)!.steps[0]!.id;
    h.engine.onStepResolved(job.id, stepId, {});     // → step-review (job stays executing)

    // Orchestrator revises instead of continuing: keep the investigate step, append a follow-up.
    const keep: ProposedStep = { ...investigate('x'), keepId: stepId };
    const followUp = investigate('follow-up');
    h.engine.onPlanReady(job.id, 'replan', [keep, followUp], []);
    expect(h.queue.get(job.id)!.state).toBe('plan_pending_review');

    const before = h.spawned.filter((s) => s.action === 'meta.orchestrate').length;
    h.engine.onReconciliationApproved(job.id);
    const after = h.spawned.filter((s) => s.action === 'meta.orchestrate').length;

    expect(after).toBe(before);                              // no redundant re-review spawned
    const j = h.queue.get(job.id)!;
    expect(j.state).not.toBe('planning');
    const original = j.steps.find((s) => s.id === stepId)!;
    expect(original.reviewed).toBe(true);
  });
});

describe('Orchestrator — workspace validation', () => {
  const readonlyStep = (workspace: unknown): ProposedStep => ({
    type: 'action', action: 'read.investigate', title: 'map coverage', description: '', goal: 'g',
    workspace,
  } as unknown as ProposedStep);

  it('rejects a readonly workspace with no repoCwd at the plan boundary', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    expect(() => engine.onPlanReady(job.id, 'initial', [readonlyStep({ kind: 'readonly' })]))
      .toThrow(/step 1 \("map coverage"\).*requires repoCwd/);
    expect(queue.get(job.id)!.steps).toHaveLength(0);
  });

  it('rejects a writable workspace with a blank branch', () => {
    const { engine } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = {
      type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'bump', description: '', goal: 'g',
      workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: '' },
    } as unknown as ProposedStep;
    expect(() => engine.onPlanReady(job.id, 'initial', [step])).toThrow(/requires branch/);
  });

  it('repairs a not-yet-started step workspace through editStepManually', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(job.id, 'initial', [readonlyStep({ kind: 'none' })]);
    const stepId = queue.get(job.id)!.steps[0]!.id;

    expect(engine.editStepManually(job.id, stepId, { workspace: { kind: 'readonly', repoCwd: '/tmp/repo' } })).toBe(true);
    expect(queue.get(job.id)!.steps[0]!.workspace).toEqual({ kind: 'readonly', repoCwd: '/tmp/repo' });

    expect(() => engine.editStepManually(job.id, stepId, { workspace: { kind: 'readonly' } as never }))
      .toThrow(/requires repoCwd/);
  });

  // A step planned before the boundary validated workspaces carries the bad ref in
  // ~/.outpost/jobs/<id>.json. Retry re-provisions it and fails instantly, every time —
  // so retry has to refuse, and repairing the ref has to be enough on its own to re-run.
  describe('a step already carrying an unprovisionable ref', () => {
    async function brokenStep() {
      const h = makeEngine();
      const job = h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
      h.engine.onPlanReady(job.id, 'initial', [readonlyStep({ kind: 'none' })]);
      h.queue.mutate(job.id, (j) => ({
        ...j,
        steps: j.steps.map((s) => ({ ...s, workspace: { kind: 'readonly' } } as Step)),
      }));
      h.engine.onPlanApproved(job.id);
      await new Promise((r) => setTimeout(r, 0));
      return { ...h, job, stepId: h.queue.get(job.id)!.steps[0]!.id };
    }

    it('fails with a reason that names the repair instead of the raw git error', async () => {
      const { queue, job, spawned } = await brokenStep();
      expect(spawned).toHaveLength(0);
      expect(queue.get(job.id)!.steps[0]!.failure?.reason).toMatch(/absolute path to the repo/);
    });

    it('refuses a retry that would just re-provision the same ref', async () => {
      const { engine, queue, job, stepId } = await brokenStep();
      expect(() => engine.onStepRetry(job.id, stepId)).toThrow(/requires repoCwd/);
      expect(queue.get(job.id)!.steps[0]!.failure).toBeTruthy();
    });

    it('re-runs off the workspace edit alone — no second Retry click', async () => {
      const { engine, queue, job, stepId, spawned } = await brokenStep();
      engine.editStepManually(job.id, stepId, { workspace: { kind: 'none' } });
      await new Promise((r) => setTimeout(r, 0));
      expect(queue.get(job.id)!.steps[0]!.failure).toBeUndefined();
      expect(spawned).toHaveLength(1);
    });
  });
});

describe('Orchestrator — orchestrated steps through the plan-rejection round-trip', () => {
  const orchestratedProposal: ProposedStep = {
    type: 'orchestrated', title: 'shepherd the PR', description: 'd', controller: 'code.orchestrate-pr',
    // No dispatches/inbox/roundsSpent/consecutiveSelfRounds: ProposedStep omits pure runtime
    // state, and materialize() seeds it. A planner supplying them is a type error.
    goal: 'ship the fix', inputs: { prUrl: 'https://example.com/pr/1' },
  };

  it('stepToProposed round-trips controller/goal/inputs into the rejected iteration snapshot', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(job.id, 'initial', [orchestratedProposal]);
    expect(queue.get(job.id)!.steps[0]).toMatchObject({ type: 'orchestrated', controller: 'code.orchestrate-pr' });

    engine.onPlanRejected(job.id, 'not quite');

    const iters = queue.get(job.id)?.plan?.iterationsRejected ?? [];
    expect(iters).toHaveLength(1);
    const snapshot = iters[0]!.steps[0] as unknown as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      type: 'orchestrated', controller: 'code.orchestrate-pr', goal: 'ship the fix',
      inputs: { prUrl: 'https://example.com/pr/1' },
    });
    // The rejection also wipes the live plan — the snapshot above is the only surviving record.
    expect(queue.get(job.id)!.steps).toHaveLength(0);
  });

  it('editStepManually never writes an action field onto an orchestrated step', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    engine.onPlanReady(job.id, 'initial', [orchestratedProposal]);
    const stepId = queue.get(job.id)!.steps[0]!.id;

    expect(engine.editStepManually(job.id, stepId, { action: 'code.implement', goal: 'new goal' })).toBe(true);

    const step = queue.get(job.id)!.steps[0]! as unknown as Record<string, unknown>;
    expect(step.action).toBeUndefined();
    expect(step.goal).toBe('new goal');
    expect(step.controller).toBe('code.orchestrate-pr');
  });
});

describe('WorkEngine — dispatch worktree provisioning', () => {
  // Mirrors src/git/worktree-manager.ts's SESSION_ID_RE. Not exported (it's a defense-in-depth
  // path-traversal/argv-smuggling check we must never loosen), so pinned here to catch a
  // regression in the id spawnDispatchSession hands to WorktreeManager.provision without
  // touching that file.
  const SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

  // newId is deliberately left at its real-randomUUID() default (not the short counter other
  // tests in this file use) so a compound-id regression (stepId-dispatch.id at 73 chars) can't
  // hide behind an unrealistically short id — see the id-length assertions below.
  function makeDispatchEngine(worktreeManager: unknown, stepWorkspace: WorkspaceRef = { kind: 'none' }) {
    const dir = mkdtempSync(join(tmpdir(), 'orch-dispatch-'));
    const queue = new JobQueue(dir);
    const sessionManager = {
      spawnDetached() { /* no-op */ },
      send() { /* no-op */ },
      isWorking() { return false; },
      sendOrResume() { /* no-op */ },
    } as never;
    const linearWriter = { setState: async () => undefined } as never;
    // validateNext rejects a dispatch action it can't resolve side_effects for; a minimal
    // registry stub is enough to let the move through the policy gate. listActions is also
    // required — resumeControllerRound's buildActionCatalog() calls it unconditionally when
    // the controller gets resumed (e.g. once a dispatch settles), and that call is fire-and-
    // forget from spawnDispatchSession, so a missing method here becomes an unhandled rejection
    // rather than a clean assertion failure.
    const actionRegistry = {
      getAction: () => ({ frontmatter: { outpost: { side_effects: 'none', human_gate: false } } }),
      listActions: () => [],
    } as never;
    const engine = new WorkEngine({
      queue, sessionManager, worktreeManager: worktreeManager as never, linearWriter, actionRegistry,
      jobsDir: join(dir, 'jobs'), now: () => 1,
    });

    const stepId = randomUUID();
    const step: OrchestratedStep = {
      id: stepId, title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: stepWorkspace, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: randomUUID(),
    };
    const job: JobRecord = {
      id: randomUUID(), source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    };
    queue.upsert(job);
    return { engine, queue, jobId: job.id, stepId };
  }

  // spawnDispatchSession is fire-and-forget from applyMove; flush the microtask chain its
  // `await worktreeManager.provision(...)` (and any resulting resumeControllerRound) needs.
  async function flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it('provisions a dispatch with a real workspace using an id that satisfies SESSION_ID_RE', async () => {
    // A `${stepId}-${dispatch.id}` compound key — two real 36-char randomUUID()s joined by a
    // dash — is 73 characters and fails SESSION_ID_RE's 64-char cap, so WorktreeManager.provision
    // throws for any dispatch whose workspace isn't {kind:'none'}. This regresses that.
    const provisionedIds: string[] = [];
    const worktreeManager = {
      provision: async (id: string, workspace: { kind: string }) => {
        provisionedIds.push(id);
        return { path: workspace.kind === 'none' ? null : '/tmp/fake-worktree' };
      },
    };
    const { engine, queue, jobId, stepId } = makeDispatchEngine(worktreeManager);

    engine.onStepProgress(jobId, stepId, {
      next: {
        kind: 'dispatch',
        dispatches: [{
          action: 'code.review-diff', brief: 'review it',
          workspace: { kind: 'readonly', repoCwd: '/tmp/fake-repo' },
        }],
      },
    });
    await flush();

    const updated = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(updated.dispatches).toHaveLength(1);
    const dispatchId = updated.dispatches[0]!.id;

    expect(provisionedIds).toHaveLength(1);
    // The real invariant: whatever id spawnDispatchSession hands to provision() must satisfy
    // WorktreeManager's own gate — a `${stepId}-${dispatch.id}` compound key fails this at 73
    // chars, over the 64-char cap.
    expect(provisionedIds[0]!.length).toBeLessThanOrEqual(64);
    expect(provisionedIds[0]).toMatch(SESSION_ID_RE);
    // And it must still be distinct from the parent step (the collision the compound key was
    // meant to prevent) while being exactly the dispatch's own id (not derived from it).
    expect(provisionedIds[0]).toBe(dispatchId);
    expect(provisionedIds[0]).not.toBe(stepId);
  });

  // Inheriting the controller's writable ref is the default path for code.orchestrate-pr, which
  // runs on a worktree holding the PR branch. Provisioning a second worktree on that branch makes
  // WorktreeManager `git worktree move` the controller's own checkout into the child's slot — its
  // record and its live session's cwd both go stale. The fake below models exactly that relocation.
  it('downgrades an inherited writable workspace to a readonly checkout of the same branch', async () => {
    const pathById = new Map<string, string>();
    const holderByBranch = new Map<string, string>();
    const seen: Array<{ id: string; workspace: WorkspaceRef }> = [];
    const worktreeManager = {
      provision: async (id: string, workspace: WorkspaceRef) => {
        seen.push({ id, workspace });
        if (workspace.kind === 'none') return { path: null };
        const path = `/wt/${id}`;
        if (workspace.kind === 'writable') {
          const holder = holderByBranch.get(workspace.branch);
          if (holder && holder !== id) pathById.set(holder, path);
          holderByBranch.set(workspace.branch, id);
        }
        pathById.set(id, path);
        return { path };
      },
    };
    const parentWorkspace: WorkspaceRef = { kind: 'writable', repoCwd: '/tmp/fake-repo', branch: 'feature/x' };
    const { engine, queue, jobId, stepId } = makeDispatchEngine(worktreeManager, parentWorkspace);
    await worktreeManager.provision(stepId, parentWorkspace);
    const parentPath = pathById.get(stepId);

    engine.onStepProgress(jobId, stepId, {
      next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'review it' }] },
    });
    await flush();

    const updated = queue.get(jobId)!.steps[0] as OrchestratedStep;
    const dispatchId = updated.dispatches[0]!.id;
    const childCall = seen.find((c) => c.id === dispatchId);
    expect(childCall?.workspace).toEqual({ kind: 'readonly', repoCwd: '/tmp/fake-repo', ref: 'feature/x' });
    expect(pathById.get(stepId)).toBe(parentPath);
  });

  it('marks the dispatch failed (not the parent step) when provision() throws', async () => {
    // Only the dispatch's own (non-`none`) workspace should hit the failing path — the
    // controller's own resume-round provision call (its step workspace is `{kind:'none'}`)
    // must keep succeeding, or this test would conflate a dispatch failure with a step failure.
    const worktreeManager = {
      provision: async (_id: string, workspace: { kind: string }) => {
        if (workspace.kind === 'none') return { path: null };
        throw new Error('git blew up');
      },
    };
    const { engine, queue, jobId, stepId } = makeDispatchEngine(worktreeManager);

    engine.onStepProgress(jobId, stepId, {
      next: {
        kind: 'dispatch',
        dispatches: [{
          action: 'code.review-diff', brief: 'review it',
          workspace: { kind: 'readonly', repoCwd: '/tmp/fake-repo' },
        }],
      },
    });
    await flush();

    const updated = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(updated.failure).toBeUndefined();
    expect(updated.dispatches).toHaveLength(1);
    expect(updated.dispatches[0]!.status).toBe('failed');
    expect(updated.dispatches[0]!.failure).toMatch(/git blew up/);
    // The done marker reaches the controller (drained into lastDelivered, per deliverInbox),
    // proving the controller gets to react rather than the failure vanishing silently.
    expect(updated.lastDelivered?.some((i) => i.kind === 'dispatch-done')).toBe(true);
  });
});

describe('WorkEngine.markStepResolved', () => {
  function makeOrchestratedJob(
    queue: JobQueue, dispatches: OrchestratedStep['dispatches'], overrides: Partial<OrchestratedStep> = {},
  ) {
    const stepId = randomUUID();
    const step: OrchestratedStep = {
      id: stepId, title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches, inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: randomUUID(),
      ...overrides,
    };
    const job: JobRecord = {
      id: randomUUID(), source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    };
    queue.upsert(job);
    return { jobId: job.id, stepId };
  }

  it('cancels only queued dispatches, resolves the step, and appends a user-attributed event', () => {
    const { engine, queue } = makeEngine();
    const dispatches: OrchestratedStep['dispatches'] = [
      { id: 'd1', action: 'code.review-diff', brief: 'b1', status: 'queued', attempts: 1 },
      { id: 'd2', action: 'code.review-diff', brief: 'b2', status: 'running', attempts: 1, sessionId: 'sess-d2', startedAt: 1 },
      { id: 'd3', action: 'code.review-diff', brief: 'b3', status: 'done', attempts: 1, output: 'ok', finishedAt: 1 },
    ];
    const { jobId, stepId } = makeOrchestratedJob(queue, dispatches);

    engine.markStepResolved(jobId, stepId);

    const step = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(step.state).toBe('resolved');
    expect(step.dispatches.map((d) => d.status)).toEqual(['cancelled', 'running', 'done']);
    // A dispatch already running or already settled is left exactly as it was — killing a
    // live session would discard real work, and a settled one has nothing left to cancel
    // (its late completion can no longer resurrect the step; see the applyMove guard).
    expect(step.dispatches[1]).toMatchObject({ status: 'running', sessionId: 'sess-d2' });
    expect(step.dispatches[2]).toMatchObject({ status: 'done', output: 'ok' });
    expect(step.events?.at(-1)).toMatchObject({ kind: 'resolved', who: 'user' });
  });

  it('is idempotent — a second call does not re-cancel dispatches, double-append the event, or leave `.failure` set', () => {
    const { engine, queue } = makeEngine();
    const dispatches: OrchestratedStep['dispatches'] = [
      { id: 'd1', action: 'code.review-diff', brief: 'b1', status: 'queued', attempts: 1 },
    ];
    // Seeded already-failed: force-resolving a step that failed must not leave it reading as
    // failed forever after — step-card.js's stateLabel/stateTone and vm/tracked.js give
    // `.failure` priority over `state`, mirroring rerunLatest's retry path and the merge
    // merge path, both of which clear `.failure` on their own recovery.
    const { jobId, stepId } = makeOrchestratedJob(queue, dispatches, { failure: { reason: 'boom', at: 1 } });

    engine.markStepResolved(jobId, stepId);
    const afterFirst = queue.get(jobId)!.steps[0] as OrchestratedStep;
    expect(afterFirst.failure).toBeUndefined();
    const eventsAfterFirst = afterFirst.events?.length ?? 0;

    engine.markStepResolved(jobId, stepId);
    const step = queue.get(jobId)!.steps[0] as OrchestratedStep;

    expect(step.state).toBe('resolved');
    expect(step.failure).toBeUndefined();
    expect(step.dispatches[0]!.status).toBe('cancelled');
    expect(step.events?.length ?? 0).toBe(eventsAfterFirst);
  });
});

describe('WorkEngine.onStepFailed — orchestrated steps', () => {
  it('sets state to failed (not just .failure), closing the reachable resurrection hazard', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = randomUUID();
    const step: OrchestratedStep = {
      id: stepId, title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: randomUUID(),
    };
    queue.mutate(job.id, (j) => ({ ...j, steps: [step] }));

    engine.onStepFailed(job.id, stepId, 'boom');
    const failed = queue.get(job.id)!.steps[0] as OrchestratedStep;
    expect(failed.state).toBe('failed');
    expect(failed.failure?.reason).toBe('boom');

    // The reachable hazard: a controller's own submit_step_progress landing after the step
    // failed (its round was still in flight) must not resurrect it. This is the actual
    // production path onStepFailed feeds applyMove's guard through — not a hand-set fixture.
    engine.onStepProgress(job.id, stepId, { memo: 'late memo', next: { kind: 'self-round' } });
    const after = queue.get(job.id)!.steps[0] as OrchestratedStep;
    expect(after.state).toBe('failed');
    expect(after.memo).toBeUndefined();
  });
});

// A REAL LaunchGovernor whose concurrency starts at zero, so every queued-priority launch parks
// instead of firing — a dispatch launch is 'queued' priority (see isReactiveAction), so this
// reliably reproduces "parked under token headroom", the case every terminal route must guard.
// A fake governor, or one with headroom, makes these tests vacuous. `openGovernor()` lifts the
// cap and drains, which is how a test proves a dropped launch stays dropped.
function makeGovernedEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cancel-'));
  const queue = new JobQueue(dir);
  const spawned: string[] = [];
  const closed: string[] = [];
  const archived: string[] = [];
  const resumed: string[] = [];
  const sessionManager = {
    spawnDetached(sessionId: string) { spawned.push(sessionId); },
    send() { /* no-op */ },
    isWorking() { return false; },
    sendOrResume(sessionId: string) { resumed.push(sessionId); },
    close(sessionId: string) { closed.push(sessionId); },
  } as never;
  const worktreeManager = {
    provision: async () => ({ path: null }),
    get: (id: string) => ({ projectCwd: '/tmp/repo', worktreePath: `/tmp/wt/${id}`, branch: 'feat/x', baseBranch: 'main' }),
    archive: async (id: string) => { archived.push(id); },
  } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const actionRegistry = {
    getAction: () => ({ frontmatter: { outpost: { side_effects: 'none', human_gate: false } } }),
    listActions: () => [],
  } as never;
  let concurrency = 0;
  const governor = new LaunchGovernor({ getSnapshot: () => undefined, getConcurrency: () => concurrency });
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter, actionRegistry, governor,
    jobsDir: join(dir, 'jobs'), now: () => 1,
  });

  const stepId = randomUUID();
  const controllerSessionId = randomUUID();
  const step: OrchestratedStep = {
    id: stepId, title: 'shepherd', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'running', createdAt: 1, updatedAt: 1, sessionId: controllerSessionId,
  };
  const job: JobRecord = {
    id: randomUUID(), source: 'manual', title: 't', description: 'd', state: 'executing',
    steps: [step], createdAt: 1, updatedAt: 1,
  };
  queue.upsert(job);
  return {
    engine, queue, governor, jobId: job.id, stepId, controllerSessionId, spawned, closed, archived, resumed,
    openGovernor: () => { concurrency = 5; governor.onUsageSnapshot(); },
  };
}

// spawnDispatchSession (and archiveStepResources) are fire-and-forget; flush the microtask chain
// their awaits need before the parked launch — or the archive — exists to observe.
async function flushLaunch(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

async function parkDispatch(h: ReturnType<typeof makeGovernedEngine>): Promise<string> {
  h.engine.onStepProgress(h.jobId, h.stepId, {
    next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'review it' }] },
  });
  await flushLaunch();
  const dispatchId = (h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).dispatches[0]!.id;
  expect(h.governor.describe(`${h.jobId}#${h.stepId}#${dispatchId}`).state).toBe('queued');
  return dispatchId;
}

describe('WorkEngine.markStepResolved — parked dispatch launches', () => {
  it('drops a parked dispatch launch from the governor so it cannot fire after the step is resolved', async () => {
    const h = makeGovernedEngine();
    const dispatchId = await parkDispatch(h);
    const key = `${h.jobId}#${h.stepId}#${dispatchId}`;

    h.engine.markStepResolved(h.jobId, h.stepId);

    expect(h.governor.describe(key).state).toBe('idle');
    expect(h.governor.forceFire(key)).toBe(false);
    const dispatches = (h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).dispatches;
    expect(dispatches.find((d) => d.id === dispatchId)?.status).toBe('cancelled');
  });
});

describe('WorkEngine.onStepFailed — parked dispatch launches', () => {
  it('drops the parked launch and cancels the queued dispatch, so a drain spawns nothing for a dead step', async () => {
    const h = makeGovernedEngine();
    const dispatchId = await parkDispatch(h);
    const key = `${h.jobId}#${h.stepId}#${dispatchId}`;

    h.engine.onStepFailed(h.jobId, h.stepId, 'boom');

    expect(h.governor.describe(key).state).toBe('idle');
    const dispatches = (h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).dispatches;
    expect(dispatches.find((d) => d.id === dispatchId)?.status).toBe('cancelled');

    // The end the whole cancellation exists to prevent: headroom returns, the governor drains,
    // and a real child session spawns for a step that failed while the launch sat parked.
    h.openGovernor();
    await flushLaunch();
    expect(h.spawned).toEqual([]);
    expect((h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).state).toBe('failed');
  });
});

describe('WorkEngine — orchestrated terminal cleanup', () => {
  // The controller's own resolve move is the one terminal that means the work LANDED — the PR
  // merged, nothing is left in the worktree worth keeping.
  it('closes the controller session and archives its worktree on the controller\'s resolve move', async () => {
    const h = makeGovernedEngine();
    h.engine.onStepProgress(h.jobId, h.stepId, { next: { kind: 'resolve', output: 'done' } });
    await flushLaunch();
    expect(h.closed).toEqual([h.controllerSessionId]);
    expect(h.archived).toEqual([h.stepId]);
  });

  // The guard on a deliberate asymmetry: do NOT "unify" these with the resolve move above.
  // WorktreeManager.archive tears the worktree down (`git worktree remove --force` +
  // `branch -D`), which destroys uncommitted work and the local branch. terminateJobResources
  // still reaps it when the job is abandoned/deleted, so holding it here leaks nothing.
  it('keeps a failed step\'s worktree for post-mortem, closing only its session', async () => {
    const h = makeGovernedEngine();
    h.engine.onStepProgress(h.jobId, h.stepId, { next: { kind: 'fail', reason: 'boom' } });
    await flushLaunch();
    expect(h.archived).toEqual([]);
    expect(h.closed).toEqual([h.controllerSessionId]);
    expect((h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).state).toBe('failed');
  });

  // Mark-resolved is the user's escape hatch for a stranded controller — the PWA recommends it
  // for exactly that. The stranded step's worktree holds the uncommitted implementation and its
  // branch has never been pushed, so the escape hatch must not be what destroys them.
  it('keeps the worktree on a user mark-resolved, closing only the session', async () => {
    const h = makeGovernedEngine();
    h.engine.markStepResolved(h.jobId, h.stepId);
    await flushLaunch();
    expect(h.archived).toEqual([]);
    expect(h.closed).toEqual([h.controllerSessionId]);
    expect((h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).state).toBe('resolved');
  });
});

// A bound work round runs on the CONTROLLER's own session, under the controller's stepId — so
// an action whose SKILL ends in submit_step_output (code.review-diff, code.review-ui,
// code.security-review all do) reports through onStepResolved with the parent step's id.
// Resolving on its behalf would settle the whole step and archive its worktree
// (`git worktree remove --force` + `branch -D`) — a review round deleting the branch it was
// reviewing. Resolution is the controller's decision, expressed as a `resolve` move.
describe('WorkEngine.onStepResolved — a bound work round is not the controller', () => {
  for (const action of ['code.review-diff', 'code.review-ui', 'code.security-review']) {
    it(`ignores submit_step_output from a round bound to ${action}`, async () => {
      const h = makeGovernedEngine();
      h.engine.onStepProgress(h.jobId, h.stepId, { next: { kind: 'self-round', action } });
      await flushLaunch();

      h.engine.onStepResolved(h.jobId, h.stepId, { output: '3 findings, 1 blocking' });
      await flushLaunch();

      const s = h.queue.get(h.jobId)!.steps[0] as OrchestratedStep;
      expect(s.state).toBe('running');
      expect(h.archived).toEqual([]);
      expect(h.closed).toEqual([]);
    });
  }

  // The other half of the seam: the controller's own resolve move must still settle and
  // archive, and it reaches the same code. Telling them apart by entry point is the fix.
  it('still resolves and archives on the controller\'s resolve move', async () => {
    const h = makeGovernedEngine();
    h.engine.onStepProgress(h.jobId, h.stepId, { next: { kind: 'resolve', output: 'merged' } });
    await flushLaunch();
    expect((h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).state).toBe('resolved');
    expect(h.archived).toEqual([h.stepId]);
  });

  // A dispatch child's own submit_step_output must keep routing to its Dispatch record.
  it('still routes a dispatch child\'s output to the dispatch, not the parent', async () => {
    const h = makeGovernedEngine();
    h.engine.onStepProgress(h.jobId, h.stepId, {
      next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'review it' }] },
    });
    await flushLaunch();
    const dispatchId = (h.queue.get(h.jobId)!.steps[0] as OrchestratedStep).dispatches[0]!.id;

    h.engine.onStepResolved(h.jobId, dispatchId, { output: 'looks good' });
    await flushLaunch();

    const s = h.queue.get(h.jobId)!.steps[0] as OrchestratedStep;
    expect(s.dispatches[0]).toMatchObject({ status: 'done', output: 'looks good' });
    expect(s.state).not.toBe('resolved');
    expect(h.archived).toEqual([]);
  });
});

// resumeControllerRound awaits provision() — real git work, seconds — BEFORE it submits the
// launch, so nothing has been parked yet for settleOrchestratedStep's cancelStep to drop. A
// mark-resolved landing in that window has to be caught by the launch's own fire-time guard,
// which re-reads only `cancelled` (the plan-editor flag, never set here).
// spawnDispatchSession's guard re-reads the dispatch's real status; this one must match it.
describe('WorkEngine.resumeControllerRound — settled while provision() was in flight', () => {
  it('does not resume a step marked resolved while its worktree was still provisioning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-inflight-'));
    const queue = new JobQueue(dir);
    const resumed: string[] = [];
    let releaseProvision!: () => void;
    const provisionGate = new Promise<void>((r) => { releaseProvision = r; });
    const engine = new WorkEngine({
      queue,
      sessionManager: {
        spawnDetached() {}, send() {}, isWorking() { return false; },
        sendOrResume(sessionId: string) { resumed.push(sessionId); },
        close: async () => {},
      } as never,
      worktreeManager: {
        provision: async () => { await provisionGate; return { path: null }; },
        get: () => undefined, archive: async () => {},
      } as never,
      linearWriter: { setState: async () => undefined } as never,
      jobsDir: join(dir, 'jobs'), now: () => 1,
    });
    const step: OrchestratedStep = {
      id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: 'ctrl-sess',
    };
    queue.upsert({
      id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    });

    engine.onStepProgress('job-1', 'step-1', { next: { kind: 'self-round' } });
    expect(resumed).toEqual([]); // still suspended inside provision()

    engine.markStepResolved('job-1', 'step-1');
    releaseProvision();
    await flushLaunch();

    expect(resumed).toEqual([]);
    expect((queue.get('job-1')!.steps[0] as OrchestratedStep).state).toBe('resolved');
  });
});

// Boot rehydration for dispatch children. `roleBySession` is in-memory, but a dispatch's
// sessionId is persisted on its Dispatch record — so after a restart the daemon knew the
// session existed but not that it belonged to a child. Its Stop then fell through to the
// generic step path and settled the PARENT on the child's behalf.
describe('WorkEngine.rehydrateSessionBindings — running dispatches', () => {
  function persistedJobWithRunningDispatch(dir: string) {
    const queue = new JobQueue(dir);
    const step: OrchestratedStep = {
      id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [
        { id: 'disp-1', action: 'code.review-diff', brief: 'review it', status: 'running', sessionId: 'child-sess', attempts: 1 },
        { id: 'disp-2', action: 'code.review-ui', brief: 'settled already', status: 'done', sessionId: 'old-sess', attempts: 1 },
      ],
      inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'waiting', createdAt: 1, updatedAt: 1, sessionId: 'controller-sess',
    };
    queue.upsert({
      id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    });
  }

  function bootedEngine(dir: string, unresolvedGraceMs: number) {
    const queue = new JobQueue(dir);
    const engine = new WorkEngine({
      queue,
      sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {}, close: async () => {} } as never,
      worktreeManager: { provision: async () => ({ path: null }), get: () => undefined, archive: async () => {} } as never,
      linearWriter: { setState: async () => undefined } as never,
      actionsStore: {} as never,
      jobsDir: join(dir, 'jobs'), now: () => 1, unresolvedGraceMs,
    });
    engine.rehydrateSessionBindings();
    return { engine, queue };
  }

  it('rebinds the child session to its action, and only for dispatches still running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rehydrate-disp-'));
    persistedJobWithRunningDispatch(dir);
    const { engine } = bootedEngine(dir, 0);
    expect(engine.actionForSession('child-sess')).toBe('code.review-diff');
    expect(engine.actionForSession('controller-sess')).toBe('code.orchestrate-pr');
    // A settled dispatch's session is history — rebinding it would grant a dead session
    // its action's allowlist for as long as the daemon lives.
    expect(engine.actionForSession('old-sess')).toBeUndefined();
  });

  it('routes a rehydrated child session\'s turn-end to the dispatch, leaving the parent step alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rehydrate-disp-'));
    persistedJobWithRunningDispatch(dir);
    const { engine, queue } = bootedEngine(dir, 0);

    expect(engine.armUnresolvedCheck('child-sess', 'never submitted')).toBe(true);
    await new Promise((r) => setTimeout(r, 5));

    const step = queue.get('job-1')!.steps[0] as OrchestratedStep;
    expect(step.dispatches.find((d) => d.id === 'disp-1')).toMatchObject({
      status: 'failed', failure: 'never submitted',
    });
    expect(step.failure).toBeUndefined();
    expect(step.state).not.toBe('failed');
  });
});

// resumeControllerRound and spawnDispatchSession are invoked fire-and-forget, and only their
// provision() call is guarded internally. A throw anywhere else — envelope construction, the
// action catalog, lesson augmentation — used to be an unhandled rejection that left the step
// hung or the dispatch stuck `queued`, with no failure event and no global handler to catch it.
describe('WorkEngine — a throw outside provision() still settles the round', () => {
  function makeThrowingEngine(throwFor: string) {
    const dir = mkdtempSync(join(tmpdir(), 'orch-throw-'));
    const queue = new JobQueue(dir);
    const engine = new WorkEngine({
      queue,
      sessionManager: { spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {}, close: async () => {} } as never,
      // provision SUCCEEDS — the point is that the failure is somewhere else.
      worktreeManager: { provision: async () => ({ path: dir }), get: () => undefined, archive: async () => {} } as never,
      linearWriter: { setState: async () => undefined } as never,
      actionRegistry: {
        listActions: () => [],
        getAction: () => ({ frontmatter: { outpost: { side_effects: 'none', human_gate: false } } }),
      } as never,
      journalStore: {
        hasEntryForStep: () => true,
        append: () => {},
        recent: (action: string) => {
          if (action === throwFor) throw new Error('lesson lookup blew up');
          return [];
        },
      } as never,
      jobsDir: join(dir, 'jobs'), newId: (() => { let n = 0; return () => `id-${++n}`; })(), now: () => 1,
    });
    const step: OrchestratedStep = {
      id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: 'controller-sess',
    };
    queue.upsert({
      id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    });
    return { engine, queue };
  }

  it('fails the step when the controller\'s own resume throws before it reaches the session', async () => {
    const { engine, queue } = makeThrowingEngine('code.orchestrate-pr');
    engine.onStepProgress('job-1', 'step-1', { phase: 'spec', next: { kind: 'self-round' } });
    await flushLaunch();

    const step = queue.get('job-1')!.steps[0] as OrchestratedStep;
    expect(step.state).toBe('failed');
    expect(step.failure?.reason).toContain('lesson lookup blew up');
  });

  it('fails the dispatch (not the parent) when a child\'s spawn throws after provision', async () => {
    const { engine, queue } = makeThrowingEngine('code.review-diff');
    engine.onStepProgress('job-1', 'step-1', {
      next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'review it' }] },
    });
    await flushLaunch();

    const step = queue.get('job-1')!.steps[0] as OrchestratedStep;
    expect(step.dispatches[0]).toMatchObject({ status: 'failed' });
    expect(step.dispatches[0]!.failure).toContain('lesson lookup blew up');
    expect(step.failure).toBeUndefined();
  });
});

// A controller that validates its inputs on turn 1 (code.orchestrate-review fails outright on a
// missing/malformed prUrl) leaves a step whose sessionId is set forever. Edit and Cancel used to
// key off sessionId alone, so the only enabled control was Retry — which re-spawns the SAME
// inputs and reproduces the identical failure.
describe('WorkEngine — recovering a step that failed on its first turn', () => {
  const PR_12 = 'https://github.com/acme/widgets/pull/12';
  const PR_99 = 'https://github.com/acme/widgets/pull/99';
  const reviewStep = (
    workspace: unknown,
    inputs: Record<string, unknown>,
  ): ProposedStep => ({
    type: 'orchestrated', controller: 'code.orchestrate-review', title: 'review the PR',
    description: '', goal: 'g', workspace, inputs,
  } as unknown as ProposedStep);

  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function runningReviewStep(opts: { workspace?: unknown; inputs?: Record<string, unknown> } = {}) {
    const h = makeEngine();
    const job = h.engine.createJob({ source: 'manual', title: 't', description: 'd' });
    h.engine.onPlanReady(job.id, 'initial', [reviewStep(
      opts.workspace ?? { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/12/head' },
      opts.inputs ?? { prUrl: PR_12 },
    )]);
    h.engine.onPlanApproved(job.id);
    await flush();
    const stepId = h.queue.get(job.id)!.steps[0]!.id;
    expect(h.queue.get(job.id)!.steps[0]!.sessionId).toBeTruthy();
    return { ...h, job, stepId };
  }

  async function failedReviewStep(opts: { workspace?: unknown; inputs?: Record<string, unknown> } = {}) {
    const h = await runningReviewStep(opts);
    h.engine.onStepFailed(h.job.id, h.stepId, 'inputs.prUrl is missing', { journal: false });
    return h;
  }

  it('edits the inputs of a failed step and re-runs it', async () => {
    const h = await failedReviewStep({ workspace: { kind: 'none' }, inputs: {} });
    const before = h.spawned.length;

    expect(h.engine.editStepManually(h.job.id, h.stepId, { inputs: { prUrl: PR_12 } })).toBe(true);
    await flush();

    const step = h.queue.get(h.job.id)!.steps[0] as OrchestratedStep;
    expect(step.inputs).toEqual({ prUrl: PR_12 });
    expect(step.failure).toBeUndefined();
    expect(h.spawned.length).toBe(before + 1);
  });

  it('cancels a failed step', async () => {
    const h = await failedReviewStep({ workspace: { kind: 'none' } });
    expect(h.engine.cancelStepManually(h.job.id, h.stepId)).toBe(true);
    expect(h.queue.get(h.job.id)!.steps[0]!.cancelled).toBe(true);
  });

  it('still refuses to edit or cancel a step that is mid-turn', async () => {
    const h = await runningReviewStep({ workspace: { kind: 'none' } });
    expect(h.queue.get(h.job.id)!.steps[0]!.failure).toBeUndefined();

    expect(h.engine.editStepManually(h.job.id, h.stepId, { goal: 'different' })).toBe(false);
    expect(h.engine.cancelStepManually(h.job.id, h.stepId)).toBe(false);
    expect((h.queue.get(h.job.id)!.steps[0] as OrchestratedStep).goal).toBe('g');
    expect(h.queue.get(h.job.id)!.steps[0]!.cancelled).toBeFalsy();
  });

  it('pins the workspace of a failed step that already provisioned a worktree', async () => {
    const h = await failedReviewStep();
    expect(h.worktrees.get(h.stepId)).toBeTruthy();

    expect(() => h.engine.editStepManually(h.job.id, h.stepId, {
      workspace: { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/99/head' },
    })).toThrow(/already provisioned/);
    expect(h.queue.get(h.job.id)!.steps[0]!.workspace).toEqual(
      { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/12/head' },
    );
  });

  // The plan editor re-sends every field it renders, so a workspace it didn't change must not
  // read as a repoint — otherwise no provisioned step could ever be edited at all.
  it('accepts an unchanged workspace alongside the edit that matters', async () => {
    const h = await failedReviewStep();
    expect(h.engine.editStepManually(h.job.id, h.stepId, {
      workspace: { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/12/head' },
      goal: 'review it properly',
    })).toBe(true);
    expect((h.queue.get(h.job.id)!.steps[0] as OrchestratedStep).goal).toBe('review it properly');
  });

  it('leaves the workspace editable on a failed step that never provisioned one', async () => {
    const h = await failedReviewStep({ workspace: { kind: 'none' } });
    expect(h.worktrees.get(h.stepId)).toBeUndefined();

    expect(h.engine.editStepManually(h.job.id, h.stepId, {
      workspace: { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/12/head' },
    })).toBe(true);
    expect(h.queue.get(h.job.id)!.steps[0]!.workspace).toEqual(
      { kind: 'readonly', repoCwd: '/tmp/repo', ref: 'refs/pull/12/head' },
    );
  });

  // prUrl and workspace.ref name the same PR. With the workspace pinned, letting prUrl move
  // alone would leave the controller reviewing PR 12's tree while reporting on PR 99.
  it('refuses an inputs edit that repoints prUrl away from the provisioned PR', async () => {
    const h = await failedReviewStep();
    expect(() => h.engine.editStepManually(h.job.id, h.stepId, { inputs: { prUrl: PR_99 } }))
      .toThrow(/refs\/pull\/12\/head/);
    expect((h.queue.get(h.job.id)!.steps[0] as OrchestratedStep).inputs).toEqual({ prUrl: PR_12 });
  });

  it('allows an inputs edit that keeps the provisioned PR', async () => {
    const h = await failedReviewStep();
    expect(h.engine.editStepManually(h.job.id, h.stepId, {
      inputs: { prUrl: PR_12, approach: 'security lens first' },
    })).toBe(true);
    expect((h.queue.get(h.job.id)!.steps[0] as OrchestratedStep).inputs)
      .toEqual({ prUrl: PR_12, approach: 'security lens first' });
  });
});
