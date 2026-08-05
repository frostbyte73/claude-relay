import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { LaunchGovernor } from '../../src/work/launch-governor.js';
import { OUTPOST_MCP_TOOLS } from '../../src/mcp-server.js';
import type { DraftedReply, Finding, JobRecord, OpenPrStep, OrchestratedStep, ProposedStep, Step } from '../../src/work/work-types.js';

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
  const worktreeManager = { provision: async () => ({ path: dir }) } as never;
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
  return { engine, queue, spawned, resumed, dir };
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

    // Give the job an executing open-pr step with a live session id, as a running step
    // would have persisted.
    const step = addOpenPrStep(first.engine, job.id);
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
    // Loading migrates the persisted open-pr step into an orchestrated step (see
    // src/storage/jobs-migrate.ts), whose session rebinds to its controller — the
    // controller then picks which action's hat to wear per round via submit_step_progress,
    // rather than the engine deriving an action from open-pr round state.
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

  it('marks an orphaned implementing open-pr step failed (partial edits are unresumable)', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    // materialize() now starts open-pr steps in 'speccing' (spec/plan flow); force
    // 'implementing' here since that's the state under test, not the initial one.
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, state: 'implementing', sessionId: 'dead-sess' } as OpenPrStep : s)),
    }));

    engine.reconcileInterruptedSteps();

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === step.id)!;
    expect(reloaded.failure?.reason).toContain('daemon restart');
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

  // A daemon bounce mid-triage leaves the `replies` iteration in_progress/postedAt:null.
  // The open-pr handler's `busy` guard then blocks a fresh triage round forever, so the
  // thread hangs on "Claude is deciding…" with no way to retry. Boot must drop the orphan.
  it('drops an orphaned in-progress triage iteration so a fresh round can dispatch', async () => {
    const { engine, queue, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? {
        ...s,
        state: 'comment_pending_response',
        prState: 'open',
        sessionId: 'dead-sess',
        comments: [{ id: 'c1', author: 'bot', body: 'b', createdAt: 1 }],
        iterations: [{ id: 'it1', kind: 'replies', status: 'in_progress', startedAt: 1 }],
      } as OpenPrStep : s)),
    }));

    engine.reconcileInterruptedEdits();

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === step.id)! as OpenPrStep;
    expect(reloaded.iterations ?? []).toHaveLength(0);

    // With the orphan cleared, the next tick re-dispatches triage onto the shared session.
    await engine.tick(job.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(resumed.some((r) => r.env.STEP_ID === step.id)).toBe(true);
  });
});

function draft(commentId: string, extra: Partial<DraftedReply> = {}): DraftedReply {
  return { commentId, recommendation: 'reply', rationale: 'r', draftReply: 'd', ...extra };
}

function addOpenPrStep(engine: WorkEngine, jobId: string): OpenPrStep {
  const proposed: ProposedStep = {
    type: 'open-pr',
    title: 't',
    description: 'd',
    goal: 'g',
    approach: 'a',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
  };
  return engine.addStepManually(jobId, proposed) as OpenPrStep;
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

describe('Orchestrator.mergeDraftedReplies', () => {
  it('upserts drafts by commentId, adding new ones without touching existing', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { rationale: 'first' })]);
    engine.mergeDraftedReplies(job.id, step.id, [draft('c2', { rationale: 'second' })]);
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.state).toBe('reply_pending_review');
    expect(s.draftedReplies?.map((d) => [d.commentId, d.rationale])).toEqual([
      ['c1', 'first'],
      ['c2', 'second'],
    ]);
  });

  it('preserves userEdited drafts against re-triage', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { draftReply: 'original' })]);
    engine.setDraftUserEdited(job.id, step.id, 'c1', true);
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { draftReply: 'clobbered' })]);
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    const kept = s.draftedReplies?.find((d) => d.commentId === 'c1');
    expect(kept?.draftReply).toBe('original');
    expect(kept?.userEdited).toBe(true);
  });
});

describe('Orchestrator.resolveCompletedEditDrafts', () => {
  function setupStepWithComments(engine: WorkEngine) {
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    engine.applyOpenPrPatch(job.id, step.id, {
      comments: [
        { id: 'c1', author: 'a', body: 'edit me', createdAt: 1 },
        { id: 'c2', author: 'a', body: 'reply me', createdAt: 1 },
      ],
    });
    return { job, step };
  }

  it('marks edit-drafts responded on push when their edit job is done', () => {
    const { engine, queue } = makeEngine();
    const { job, step } = setupStepWithComments(engine);
    engine.mergeDraftedReplies(job.id, step.id, [
      draft('c1', { recommendation: 'edit' }),
      draft('c2', { recommendation: 'reply' }),
    ]);
    const edit = engine.enqueueEditJob(job.id, step.id, 'c1')!;
    engine.markEditDone(job.id, step.id, edit.id, { status: 'done' });
    const resolved = engine.resolveCompletedEditDrafts(job.id, step.id);
    expect(resolved).toBe(1);
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.comments?.find((c) => c.id === 'c1')?.respondedAt).toBeDefined();
    expect(s.comments?.find((c) => c.id === 'c2')?.respondedAt).toBeUndefined();
    expect(s.draftedReplies?.map((d) => d.commentId)).toEqual(['c2']);
  });

  it('leaves edit-drafts untouched when the edit job is still running', () => {
    const { engine, queue } = makeEngine();
    const { job, step } = setupStepWithComments(engine);
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { recommendation: 'edit' })]);
    engine.enqueueEditJob(job.id, step.id, 'c1');
    const resolved = engine.resolveCompletedEditDrafts(job.id, step.id);
    expect(resolved).toBe(0);
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.comments?.find((c) => c.id === 'c1')?.respondedAt).toBeUndefined();
    expect(s.draftedReplies?.map((d) => d.commentId)).toEqual(['c1']);
  });
});

describe('Orchestrator open-pr session continuity', () => {
  it('resumes the implementer session for a triage round instead of spawning fresh', async () => {
    const { engine, queue, spawned, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    // Simulate the initial implement round having established the session.
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'impl-sess' } : s)),
    }));
    engine.applyOpenPrPatch(job.id, step.id, {
      state: 'comment_pending_response',
      comments: [{ id: 'c1', author: 'a', body: 'why poll here?', createdAt: 1 }],
    });
    const spawnCountBefore = spawned.length;

    await engine.tick(job.id);

    expect(resumed.map((r) => r.sessionId)).toContain('impl-sess');
    expect(spawned.length).toBe(spawnCountBefore); // no new session minted
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.sessionId).toBe('impl-sess'); // not overwritten
    expect(resumed.find((r) => r.sessionId === 'impl-sess')?.env.OUTPOST_ENVELOPE).toBeTruthy();
  });

  it('resumes the implementer session for an edit round instead of spawning fresh', async () => {
    const { engine, queue, spawned, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'impl-sess' } : s)),
    }));
    engine.applyOpenPrPatch(job.id, step.id, {
      comments: [{ id: 'c1', author: 'a', body: 'log nodes not triedNodes', createdAt: 1 }],
    });
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { recommendation: 'edit' })]);
    const spawnCountBefore = spawned.length;

    engine.enqueueEditJob(job.id, step.id, 'c1');
    await engine.tick(job.id);

    expect(resumed.map((r) => r.sessionId)).toContain('impl-sess');
    expect(resumed.every((r) => r.sessionId === 'impl-sess')).toBe(true);
    expect(spawned.length).toBe(spawnCountBefore); // no new session minted
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.editQueue!.find((e) => e.status === 'running')?.sessionId).toBe('impl-sess');
  });

  it('defers an edit round while a triage iteration is in flight', async () => {
    const { engine, queue, spawned, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'impl-sess' } : s)),
    }));
    engine.applyOpenPrPatch(job.id, step.id, {
      comments: [{ id: 'c1', author: 'a', body: 'x', createdAt: 1 }],
      iterations: [{ id: 'i1', kind: 'replies', status: 'in_progress', startedAt: 0 }],
    });
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { recommendation: 'edit' })]);
    const spawnCountBefore = spawned.length;

    engine.enqueueEditJob(job.id, step.id, 'c1');
    await engine.tick(job.id);

    expect(resumed).toHaveLength(0);
    expect(spawned.length).toBe(spawnCountBefore);
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.editQueue!.find((e) => e.commentId === 'c1')?.status).toBe('queued');
  });

  it('preserves the persistent session id across a replies rejection', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'impl-sess' } : s)),
    }));
    engine.applyOpenPrPatch(job.id, step.id, {
      comments: [{ id: 'c1', author: 'a', body: 'x', createdAt: 1 }],
    });
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1')]);
    engine.rejectReplies(job.id, step.id, 'try again');
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.state).toBe('comment_pending_response');
    expect(s.sessionId).toBe('impl-sess'); // NOT cleared
  });

  it('lets an edit round proceed once the triage round has posted', async () => {
    const { engine, queue, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'impl-sess' } : s)),
    }));
    engine.applyOpenPrPatch(job.id, step.id, {
      comments: [{ id: 'c1', author: 'a', body: 'x', createdAt: 1 }],
      iterations: [{ id: 'i1', kind: 'replies', status: 'in_progress', startedAt: 0, postedAt: 5 }],
    });
    engine.mergeDraftedReplies(job.id, step.id, [draft('c1', { recommendation: 'edit' })]);

    engine.enqueueEditJob(job.id, step.id, 'c1');
    await engine.tick(job.id);

    expect(resumed.map((r) => r.sessionId)).toContain('impl-sess');
    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect(s.editQueue!.find((e) => e.commentId === 'c1')?.status).toBe('running');
  });

  it('starts an in-flight iteration when it dispatches a triage round', async () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === step.id ? { ...s, sessionId: 'impl-sess' } : s)),
    }));
    engine.applyOpenPrPatch(job.id, step.id, {
      state: 'comment_pending_response',
      comments: [{ id: 'c1', author: 'a', body: 'why poll?', createdAt: 1 }],
    });

    await engine.tick(job.id);

    const s = queue.get(job.id)!.steps.find((x) => x.id === step.id) as OpenPrStep;
    expect((s.iterations ?? []).some((it) => it.kind === 'replies' && it.status === 'in_progress' && !it.postedAt)).toBe(true);
  });
});

describe('Orchestrator applyOpenPrPatch — merge advances the plan', () => {
  // Lets a fire-and-forget `void this.tickOne` settle (tickOne awaits worktree provision).
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('reviews before advancing, then dispatches the next step once the review continues, when the watcher observes a merge', async () => {
    const { engine, queue, spawned } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const prStep = addOpenPrStep(engine, job.id);
    const followUp = engine.addStepManually(job.id, {
      type: 'action', action: 'read.investigate', title: 'follow-up',
      inputs: {}, workspace: { kind: 'none' },
    } as ProposedStep)!;
    // State while the PR is open: executing, PR step live at pr_open, follow-up
    // materialized 'running' with no session (exactly the regression's shape).
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => (s.id === prStep.id
        ? ({ ...s, sessionId: 'impl-sess', state: 'pr_open', prUrl: 'http://x', prState: 'open' } as Step)
        : s)),
    }));
    const spawnCountBefore = spawned.length;

    // Watcher observes the merge — no explicit tick, no PWA nudge.
    engine.applyOpenPrPatch(job.id, prStep.id, { state: 'merged', prState: 'merged' });
    await flush();

    const events = queue.get(job.id)!.events ?? [];
    expect(events.some((e) => e.kind === 'step_merged' && e.stepId === prStep.id && e.who === 'pr-watcher')).toBe(true);

    // The merged group is settled but unreviewed, so tickOne runs a step-review
    // instead of dispatching the follow-up directly.
    const s2 = queue.get(job.id)!.steps.find((s) => s.id === followUp.id)!;
    expect(s2.sessionId).toBeUndefined();
    expect(queue.get(job.id)!.reviewingStepId).toBe(prStep.id);
    expect(queue.get(job.id)!.state).toBe('executing');   // a review is not a planning phase
    expect(spawned.length).toBe(spawnCountBefore + 1);          // step-review orchestrator spawned
    expect(spawned[spawned.length - 1]!.action).toBe('meta.orchestrate');

    // Once the orchestrator continues, the follow-up actually starts.
    engine.onOrchestratorContinue(job.id);
    await flush();
    const s2After = queue.get(job.id)!.steps.find((s) => s.id === followUp.id)!;
    expect(s2After.sessionId).toBeDefined();
  });

  it('clears a stale interrupt failure when the watcher advances a live (unmerged) PR, lifting the job halt', async () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const prStep = addOpenPrStep(engine, job.id);
    // Shape of the CS-1552 regression: a daemon bounce marked the implementing step
    // failed and halted the job; the user then opened the PR from the worktree edits,
    // so the step recovered to comment_pending_response with a live PR — but the stale
    // failure lingered, keeping the job permanently `failed` (stranding parallel
    // siblings and the comment-triage round).
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'failed',
      steps: j.steps.map((s) => (s.id === prStep.id
        ? ({
            ...s, state: 'comment_pending_response', prUrl: 'http://x', prState: 'open',
            failure: { reason: 'implement session interrupted by daemon restart', at: 1 },
          } as Step)
        : s)),
    }));

    // A routine watcher poll (CI update, no merge) flows through the choke point.
    engine.applyOpenPrPatch(job.id, prStep.id, { ciState: 'success' });

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === prStep.id)! as OpenPrStep;
    expect(reloaded.failure).toBeUndefined();

    // With the stale failure gone, the next tick lifts the halt.
    await engine.tick(job.id);
    expect(queue.get(job.id)!.state).toBe('executing');
  });

  it('does not re-emit step_merged for a patch on an already-merged step', async () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const prStep = addOpenPrStep(engine, job.id);
    queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));
    engine.applyOpenPrPatch(job.id, prStep.id, { state: 'merged', prState: 'merged' });
    await flush();
    engine.applyOpenPrPatch(job.id, prStep.id, { prState: 'merged' });
    await flush();
    const merges = (queue.get(job.id)!.events ?? []).filter((e) => e.kind === 'step_merged');
    expect(merges).toHaveLength(1);
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
      type: 'open-pr', title: 't', description: 'd', goal: 'g', approach: 'a',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    };
    engine.onPlanReady(job.id, 'initial', [proposed], undefined, undefined, sampleFinding as unknown as Finding);
    expect(queue.get(job.id)?.plan?.findings).toEqual(sampleFinding);
  });

  it('leaves plan.findings undefined when the orchestrator omits them', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const proposed: ProposedStep = {
      type: 'open-pr', title: 't', description: 'd', goal: 'g', approach: 'a',
      workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    };
    engine.onPlanReady(job.id, 'initial', [proposed]);
    expect(queue.get(job.id)?.plan?.findings).toBeUndefined();
  });

  it('updates plan.findings on a replan amendment while preserving postedAt', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const first: ProposedStep = {
      type: 'open-pr', title: 't', description: 'd', goal: 'g', approach: 'a',
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
      type: 'open-pr', title: 't', description: 'd', goal: 'g', approach: 'a',
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

  it('rejects an open-pr workspace with a blank branch', () => {
    const { engine } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const step = {
      type: 'open-pr', title: 'bump', description: '', goal: 'g', approach: 'a',
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
    goal: 'ship the fix', inputs: { prUrl: 'https://example.com/pr/1' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
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
  function makeDispatchEngine(worktreeManager: unknown) {
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
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
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
    // `.failure` priority over `state`, mirroring rerunLatest's retry path and the open-pr
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

describe('WorkEngine.markStepResolved — parked dispatch launches', () => {
  it('drops a parked dispatch launch from the governor so it cannot fire after the step is resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-cancel-'));
    const queue = new JobQueue(dir);
    const sessionManager = {
      spawnDetached() { /* no-op */ },
      send() { /* no-op */ },
      isWorking() { return false; },
      sendOrResume() { /* no-op */ },
    } as never;
    const worktreeManager = { provision: async () => ({ path: null }) } as never;
    const linearWriter = { setState: async () => undefined } as never;
    const actionRegistry = {
      getAction: () => ({ frontmatter: { outpost: { side_effects: 'none', human_gate: false } } }),
      listActions: () => [],
    } as never;
    // Zero concurrency forces every queued-priority launch to park instead of firing — a
    // dispatch launch is 'queued' priority (see isReactiveAction), so this reliably reproduces
    // "parked under token headroom", the real LaunchGovernor case markStepResolved must guard.
    const governor = new LaunchGovernor({ getSnapshot: () => undefined, getConcurrency: () => 0 });
    const engine = new WorkEngine({
      queue, sessionManager, worktreeManager, linearWriter, actionRegistry, governor,
      jobsDir: join(dir, 'jobs'), now: () => 1,
    });

    const stepId = randomUUID();
    const step: OrchestratedStep = {
      id: stepId, title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: randomUUID(),
    };
    const job: JobRecord = {
      id: randomUUID(), source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    };
    queue.upsert(job);

    engine.onStepProgress(job.id, stepId, {
      next: { kind: 'dispatch', dispatches: [{ action: 'code.review-diff', brief: 'review it' }] },
    });
    // spawnDispatchSession is fire-and-forget from applyMove; flush the microtask chain its
    // `await worktreeManager.provision(...)` needs before the parked launch exists to observe.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    const dispatchId = (queue.get(job.id)!.steps[0] as OrchestratedStep).dispatches[0]!.id;
    const key = `${job.id}#${stepId}#${dispatchId}`;
    expect(governor.describe(key).state).toBe('queued');

    engine.markStepResolved(job.id, stepId);

    expect(governor.describe(key).state).toBe('idle');
    expect(governor.forceFire(key)).toBe(false);
    const dispatches = (queue.get(job.id)!.steps[0] as OrchestratedStep).dispatches;
    expect(dispatches.find((d) => d.id === dispatchId)?.status).toBe('cancelled');
  });
});
