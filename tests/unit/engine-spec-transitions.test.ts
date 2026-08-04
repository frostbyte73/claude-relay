import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { OpenPrStep, ProposedStep } from '../../src/work/work-types.js';

// Minimal harness mirroring orchestrator.test.ts's makeEngine, extended to
// capture the resumed message content (not just the sessionId/env) so the
// spec/plan/implement round dispatch can be asserted.
function makeEngine(unresolvedGraceMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-spec-'));
  const queue = new JobQueue(dir);
  const resumed: Array<{ sessionId: string; content: string }> = [];
  // Controls whether the shared session is reported mid-turn at resume time — the signal
  // the engine uses to detect a resume queued behind an in-flight (soon-to-be-stale) turn.
  const working = new Set<string>();
  const sessionManager = {
    spawnDetached() { /* not exercised by these transitions */ },
    send() { /* not exercised by these transitions */ },
    isWorking(sessionId: string) { return working.has(sessionId); },
    sendOrResume(sessionId: string, _cwd: string, msg: { message: { content: string } }) {
      resumed.push({ sessionId, content: msg.message.content });
    },
  } as never;
  const worktreeManager = { provision: async () => ({ path: dir }) } as never;
  const linearWriter = { setState: async () => undefined } as never;
  // bindAction() no-ops without an actionsStore, and onSessionTurnEnded's guard reads
  // the session's bound action — so the harness must configure one for the binding to
  // take, exactly as the real daemon does for every step session.
  const actionsStore = {} as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter, actionsStore,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
    ...(unresolvedGraceMs === undefined ? {} : { unresolvedGraceMs }),
  });
  return { engine, queue, resumed, working };
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

describe('WorkEngine.materialize — initial state derives from the handler registry', () => {
  it('a freshly materialized open-pr step starts in speccing, not implementing', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOpenPrStep(engine, job.id).id;
    const step = queue.get(job.id)!.steps.find((s) => s.id === stepId)!;
    expect(step.state).toBe('speccing');
  });

  it('a freshly materialized action step still starts in running (behavior-preserving)', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const proposed: ProposedStep = {
      type: 'action',
      title: 'investigate',
      description: 'd',
      goal: 'g',
      action: 'read.investigate',
      workspace: { kind: 'readonly', repoCwd: '/tmp' },
    };
    const stepId = engine.addStepManually(job.id, proposed)!.id;
    const step = queue.get(job.id)!.steps.find((s) => s.id === stepId)!;
    expect(step.state).toBe('running');
  });
});

// Flushes the microtask queue so fire-and-forget `void this.dispatchRound(...)`
// calls (async, but only awaiting an in-memory worktreeManager.provision stub)
// have settled before assertions run.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Stand-in for UNRESOLVED_GRACE_MS, injected so the unresolved-check tests don't have to
// drive a five-minute clock.
const GRACE_MS = 60_000;

describe('WorkEngine spec/plan round transitions', () => {
  let engine: WorkEngine;
  let queue: JobQueue;
  let resumed: Array<{ sessionId: string; content: string }>;
  let jobId: string;
  let stepId: string;

  beforeEach(() => {
    ({ engine, queue, resumed } = makeEngine());
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    jobId = job.id;
    stepId = addOpenPrStep(engine, jobId).id;
  });

  function step(): OpenPrStep {
    return queue.get(jobId)!.steps.find((s) => s.id === stepId) as OpenPrStep;
  }

  function seed(state: OpenPrStep['state'], extra: Partial<OpenPrStep> = {}) {
    queue.mutate(jobId, (j) => ({
      ...j,
      steps: j.steps.map((s) => s.id === stepId ? { ...s, state, sessionId: 'sess-1', ...extra } as OpenPrStep : s),
    }));
  }

  it('onSpecReady stores the spec and gates without dispatching', () => {
    seed('speccing');
    engine.onSpecReady(jobId, stepId, '# my spec');
    expect(step().state).toBe('spec_pending_review');
    expect(step().spec).toBe('# my spec');
    expect(resumed).toHaveLength(0);
  });

  it('approveSpec advances to planning and dispatches code.plan', async () => {
    seed('spec_pending_review');
    engine.approveSpec(jobId, stepId);
    expect(step().state).toBe('planning');
    await flush();
    expect(resumed).toEqual([{ sessionId: 'sess-1', content: '/code.plan' }]);
  });

  it('approveSpec is a no-op when the step is not in spec_pending_review (stale gate click)', async () => {
    seed('planning');
    engine.approveSpec(jobId, stepId);
    expect(step().state).toBe('planning');
    await flush();
    expect(resumed).toHaveLength(0);
  });

  it('rejectSpec returns to speccing, accumulates feedback, and dispatches code.spec', async () => {
    seed('spec_pending_review');
    engine.rejectSpec(jobId, stepId, 'add error handling');
    expect(step().state).toBe('speccing');
    expect(step().specFeedback).toEqual(['add error handling']);
    await flush();
    expect(resumed).toEqual([{ sessionId: 'sess-1', content: '/code.spec' }]);
  });

  it('rejectSpec accumulates feedback across multiple revision loops', () => {
    seed('spec_pending_review', { specFeedback: ['first note'] });
    engine.rejectSpec(jobId, stepId, 'second note');
    expect(step().specFeedback).toEqual(['first note', 'second note']);
  });

  it('onImplPlanReady advances to implementing but does NOT dispatch mid-turn', async () => {
    // Drive the real plan round so the shared session is bound to code.plan.
    seed('spec_pending_review');
    engine.approveSpec(jobId, stepId);            // → planning, dispatches /code.plan, binds code.plan
    await flush();
    expect(resumed).toEqual([{ sessionId: 'sess-1', content: '/code.plan' }]);

    engine.onImplPlanReady(jobId, stepId, '# plan');
    expect(step().state).toBe('implementing');
    expect(step().implPlan).toBe('# plan');
    await flush();
    // No new dispatch yet: code.plan's turn is still open. The implement round waits
    // for the Stop hook (onSessionTurnEnded), never fires mid-turn from the submit handler.
    expect(resumed).toEqual([{ sessionId: 'sess-1', content: '/code.plan' }]);
  });

  it('onSessionTurnEnded dispatches code.implement once the plan turn ends, exactly once', async () => {
    seed('spec_pending_review');
    engine.approveSpec(jobId, stepId);
    await flush();
    engine.onImplPlanReady(jobId, stepId, '# plan');
    await flush();
    resumed.length = 0;                           // isolate the turn-end dispatch

    engine.onSessionTurnEnded('sess-1');          // code.plan turn ended, session idle
    await flush();
    expect(resumed).toEqual([{ sessionId: 'sess-1', content: '/code.implement' }]);

    // Exactly once: after code.implement is dispatched the binding is code.implement,
    // so a later turn-end (implement awaiting PR) must NOT re-dispatch.
    resumed.length = 0;
    engine.onSessionTurnEnded('sess-1');
    await flush();
    expect(resumed).toHaveLength(0);
  });

  it('onSessionTurnEnded is a no-op when the step is not yet in implementing', async () => {
    // A turn that ends while the step is still in `planning` (e.g. code.plan ended
    // without submitting) must not dispatch code.implement — only the plan→implement
    // transition (state === implementing, still bound to code.plan) triggers it.
    seed('spec_pending_review');
    engine.approveSpec(jobId, stepId);            // binds code.plan, → planning
    await flush();
    resumed.length = 0;
    engine.onSessionTurnEnded('sess-1');          // still planning, NOT implementing
    await flush();
    expect(resumed).toHaveLength(0);
  });
});

describe('WorkEngine — stale turn-end Stop from a superseded round', () => {
  let engine: WorkEngine;
  let queue: JobQueue;
  let working: Set<string>;
  let jobId: string;
  let stepId: string;

  beforeEach(() => {
    ({ engine, queue, working } = makeEngine());
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    jobId = job.id;
    stepId = addOpenPrStep(engine, jobId).id;
    queue.mutate(jobId, (j) => ({
      ...j,
      steps: j.steps.map((s) => s.id === stepId ? { ...s, state: 'spec_pending_review', sessionId: 'sess-1' } as OpenPrStep : s),
    }));
  });

  function step(): OpenPrStep {
    return queue.get(jobId)!.steps.find((s) => s.id === stepId) as OpenPrStep;
  }

  it('a resume dispatched while the session is still mid-turn owes exactly one stale Stop', async () => {
    working.add('sess-1');                        // spec turn's Stop hasn't landed yet
    engine.approveSpec(jobId, stepId);            // → planning, resumes /code.plan behind the spec turn
    await flush();
    expect(engine.consumeStaleTurnStop('sess-1')).toBe(true);
    expect(engine.consumeStaleTurnStop('sess-1')).toBe(false);
  });

  it('the stale spec Stop does not fail the step, and the plan round still completes', async () => {
    working.add('sess-1');
    engine.approveSpec(jobId, stepId);
    await flush();
    // Mirror the daemon Stop handler's gate: a stale Stop is consumed and skips the check.
    const stale = engine.consumeStaleTurnStop('sess-1');
    if (!stale) engine.armUnresolvedCheck('sess-1', 'x');
    expect(stale).toBe(true);
    expect(step().failure).toBeUndefined();       // step survived the trailing spec Stop
    engine.onImplPlanReady(jobId, stepId, '# plan');
    expect(step().state).toBe('implementing');
  });

  it('when the spec Stop already landed before approval, no stale Stop is owed and a genuine premature Stop still fails', async () => {
    // working NOT set: the spec turn ended before the user approved.
    engine.approveSpec(jobId, stepId);
    await flush();
    expect(engine.consumeStaleTurnStop('sess-1')).toBe(false);
    // A real planning-round turn that ends without submit_impl_plan is failable — the
    // check arms here and lands once the session stays quiet (covered below).
    expect(engine.armUnresolvedCheck('sess-1', 'no submit')).toBe(true);
  });
});

// Regression: job 2808e24e — a code.spec round dispatched three background subagents and
// yielded its turn to wait for them. The Stop hook failed the step on the spot; the session
// was re-invoked when the agents reported and submitted a perfectly good spec six minutes
// later, but the job had already halted on the stale failure.
describe('WorkEngine.armUnresolvedCheck — a turn yielded to background subagents', () => {
  let engine: WorkEngine;
  let queue: JobQueue;
  let jobId: string;
  let stepId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ engine, queue } = makeEngine(GRACE_MS));
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    jobId = job.id;
    stepId = addOpenPrStep(engine, jobId).id;
    queue.mutate(jobId, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => s.id === stepId ? { ...s, state: 'speccing', sessionId: 'sess-1' } as OpenPrStep : s),
    }));
    // Real dispatch path — this is what binds sess-1 to the step (roleBySession).
    engine.reconcileInterruptedSteps();
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => { vi.useRealTimers(); });

  function step(): OpenPrStep {
    return queue.get(jobId)!.steps.find((s) => s.id === stepId) as OpenPrStep;
  }

  it('does not fail the step on the Stop edge', () => {
    expect(engine.armUnresolvedCheck('sess-1', 'no submit')).toBe(true);
    expect(step().failure).toBeUndefined();
  });

  it('a subagent tool call before the grace elapses calls the failure off', async () => {
    engine.armUnresolvedCheck('sess-1', 'no submit');
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    engine.noteSessionActivity('sess-1');       // PreToolUse from a background subagent
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(step().failure).toBeUndefined();
  });

  it('the spec submitted after the round resumes lands on a healthy step', async () => {
    engine.armUnresolvedCheck('sess-1', 'no submit');   // yields for subagents
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    engine.noteSessionActivity('sess-1');
    engine.onSpecReady(jobId, stepId, '# spec');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(step().state).toBe('spec_pending_review');
    expect(step().failure).toBeUndefined();
  });

  it('re-arming on each yielded turn restarts the grace clock', async () => {
    engine.armUnresolvedCheck('sess-1', 'no submit');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 0.8);
    engine.armUnresolvedCheck('sess-1', 'no submit');   // yielded again, still waiting
    await vi.advanceTimersByTimeAsync(GRACE_MS * 0.8);
    expect(step().failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(step().failure?.reason).toBe('no submit');   // finally silent long enough
  });

  it('a session that never comes back still fails, so the job cannot hang', async () => {
    engine.armUnresolvedCheck('sess-1', 'no submit');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(step().failure?.reason).toBe('no submit');
  });

  it('a check armed by a superseded session does not land on the retried step', async () => {
    engine.armUnresolvedCheck('sess-1', 'no submit');
    engine.onStepRetry(jobId, stepId);                  // fresh round, sess-1 is history
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(step().failure).toBeUndefined();
  });
});

describe('WorkEngine.reconcileInterruptedSteps — spec/plan round resume', () => {
  it('re-dispatches an interrupted speccing round rather than failing it', async () => {
    const { engine, queue, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOpenPrStep(engine, job.id).id;
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => s.id === stepId ? { ...s, state: 'speccing' as const, sessionId: 'sess-2' } as OpenPrStep : s),
    }));

    engine.reconcileInterruptedSteps();
    await flush();

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === stepId)!;
    expect(reloaded.failure).toBeUndefined();
    expect(queue.get(job.id)!.events!.some((e) => e.kind === 'step_retried' && e.who === 'system')).toBe(true);
    expect(resumed).toEqual([{ sessionId: 'sess-2', content: '/code.spec' }]);
  });

  it('re-dispatches an interrupted planning round rather than failing it', async () => {
    const { engine, queue, resumed } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOpenPrStep(engine, job.id).id;
    queue.mutate(job.id, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => s.id === stepId ? { ...s, state: 'planning' as const, sessionId: 'sess-3' } as OpenPrStep : s),
    }));

    engine.reconcileInterruptedSteps();
    await flush();

    const reloaded = queue.get(job.id)!.steps.find((s) => s.id === stepId)!;
    expect(reloaded.failure).toBeUndefined();
    expect(resumed).toEqual([{ sessionId: 'sess-3', content: '/code.plan' }]);
  });
});
