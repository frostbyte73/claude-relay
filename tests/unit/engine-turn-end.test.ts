import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { OrchestratedStep, ProposedStep } from '../../src/work/work-types.js';

// Minimal harness mirroring orchestrator.test.ts's makeEngine, extended to
// capture the resumed message content (not just the sessionId/env) so a
// controller round's dispatch can be asserted.
function makeEngine(unresolvedGraceMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-turn-'));
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
  // bindAction() no-ops without an actionsStore, so the harness must configure one for
  // the binding to take, exactly as the real daemon does for every step session.
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

describe('WorkEngine.materialize — initial state derives from the handler registry', () => {
  it('a freshly materialized orchestrated step starts in running', () => {
    const { engine, queue } = makeEngine();
    const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
    const stepId = addOrchestratedStep(engine, job.id).id;
    const step = queue.get(job.id)!.steps.find((s) => s.id === stepId)!;
    expect(step.state).toBe('running');
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

// Flushes the microtask queue so fire-and-forget `void this.tickOne(...)` / resume calls
// (async, but only awaiting an in-memory worktreeManager.provision stub) have settled
// before assertions run.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Stand-in for UNRESOLVED_GRACE_MS, injected so the unresolved-check tests don't have to
// drive a five-minute clock.
const GRACE_MS = 60_000;

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
    stepId = addOrchestratedStep(engine, jobId).id;
    queue.mutate(jobId, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => s.id === stepId ? { ...s, sessionId: 'sess-1' } as OrchestratedStep : s),
    }));
    engine.rehydrateSessionBindings();
  });

  function step(): OrchestratedStep {
    return queue.get(jobId)!.steps.find((s) => s.id === stepId) as OrchestratedStep;
  }

  // A self-round is the controller queueing its own next turn onto the same session.
  function selfRound(action?: string) {
    engine.onStepProgress(jobId, stepId, {
      phase: 'spec', next: { kind: 'self-round', ...(action ? { action } : {}) },
    });
  }

  it('a resume dispatched while the session is still mid-turn owes exactly one stale Stop', async () => {
    working.add('sess-1');                        // the current turn's Stop hasn't landed yet
    selfRound('code.plan');
    await flush();
    expect(engine.consumeStaleTurnStop('sess-1')).toBe(true);
    expect(engine.consumeStaleTurnStop('sess-1')).toBe(false);
  });

  it('the stale Stop does not fail the step, and the next round still runs', async () => {
    working.add('sess-1');
    selfRound('code.plan');
    await flush();
    // Mirror the daemon Stop handler's gate: a stale Stop is consumed and skips the check.
    const stale = engine.consumeStaleTurnStop('sess-1');
    if (!stale) engine.armUnresolvedCheck('sess-1', 'x');
    expect(stale).toBe(true);
    expect(step().failure).toBeUndefined();       // step survived the trailing Stop
    expect(step().state).toBe('running');
  });

  it('when the prior Stop already landed, no stale Stop is owed and a genuine premature Stop still fails', async () => {
    // working NOT set: the previous turn ended before the next round was queued.
    selfRound('code.plan');
    await flush();
    expect(engine.consumeStaleTurnStop('sess-1')).toBe(false);
    // A real round that ends without submitting is failable — the check arms here and
    // lands once the session stays quiet (covered below).
    expect(engine.armUnresolvedCheck('sess-1', 'no submit')).toBe(true);
  });
});

// Regression: job 2808e24e — a round dispatched three background subagents and yielded its
// turn to wait for them. The Stop hook failed the step on the spot; the session was
// re-invoked when the agents reported and submitted a perfectly good result six minutes
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
    stepId = addOrchestratedStep(engine, jobId).id;
    queue.mutate(jobId, (j) => ({
      ...j,
      state: 'executing',
      steps: j.steps.map((s) => s.id === stepId ? { ...s, sessionId: 'sess-1' } as OrchestratedStep : s),
    }));
    // This is what binds sess-1 to the step (roleBySession), as a spawn would have.
    engine.rehydrateSessionBindings();
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => { vi.useRealTimers(); });

  function step(): OrchestratedStep {
    return queue.get(jobId)!.steps.find((s) => s.id === stepId) as OrchestratedStep;
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

  it('the submit that lands after the round resumes leaves a healthy step', async () => {
    engine.armUnresolvedCheck('sess-1', 'no submit');   // yields for subagents
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    engine.noteSessionActivity('sess-1');
    engine.onStepProgress(jobId, stepId, {
      phase: 'spec', artifacts: { spec: '# spec' },
      next: { kind: 'wait', wait: { reason: 'holding' } },
    });
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(step().artifacts?.spec).toBe('# spec');
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
