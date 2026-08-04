import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';

// write.linear-comment is a human_gate claude action; read.investigate is an ungated
// one. The engine reads human_gate off this registry to decide whether a step's session
// runs a draft→review→commit loop with its external write hard-blocked until approval.
const actionRegistry = {
  getAction(name: string) {
    if (name === 'write.linear-comment') return { frontmatter: { outpost: { runner: 'claude', human_gate: true } } };
    return { frontmatter: { outpost: { runner: 'claude' } } };
  },
} as never;

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-gate-'));
  const queue = new JobQueue(dir);
  const spawned: string[] = [];
  const resumed: string[] = [];
  const clock = { now: 1000 };
  const sessionManager = {
    spawnDetached(sessionId: string) { spawned.push(sessionId); },
    send() {},
    isWorking() { return false; },
    sendOrResume(sessionId: string) { resumed.push(sessionId); },
  } as never;
  const worktreeManager = { provision: async () => ({ path: dir }) } as never;
  const linearWriter = { setState: async () => undefined } as never;
  const engine = new WorkEngine({
    queue, sessionManager, worktreeManager, linearWriter,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => clock.now,
  });
  return { engine, queue, spawned, resumed, clock, dir };
}

function actionStep(id: string, action: string, inputs: Record<string, unknown> = {}): ActionStep {
  return {
    id, type: 'action', title: id, description: 'd', goal: 'g',
    action, inputs, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000,
  };
}

function seedJob(queue: JobQueue, engine: WorkEngine, steps: ActionStep[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps }));
  return job.id;
}

function stepOf(queue: JobQueue, jobId: string, stepId: string): ActionStep {
  return queue.get(jobId)!.steps.find((s) => s.id === stepId) as ActionStep;
}

describe('WorkEngine human_gate — draft → review → commit', () => {
  it('spawns a draft session whose external write is held, then parks on submit_write_draft', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seedJob(queue, engine, [
      actionStep('g1', 'write.linear-comment', { issue_ref: 'CSCU-1', body: 'hi' }),
    ]);

    await engine.tick(jobId);
    const drafted = stepOf(queue, jobId, 'g1');
    expect(drafted.state).toBe('running');           // draft turn is live
    expect(spawned).toHaveLength(1);
    expect(drafted.sessionId).toBe(spawned[0]);
    // The write is hard-blocked while the draft turn runs (not yet approved).
    expect(engine.writeGateHeldForSession(drafted.sessionId!)).toBe(true);

    engine.onWriteDraftReady(jobId, 'g1', 'Drafted comment body');
    const parked = stepOf(queue, jobId, 'g1');
    expect(parked.state).toBe('gate_pending_approval');
    expect(parked.draft).toBe('Drafted comment body');
    expect(engine.writeGateHeldForSession(parked.sessionId!)).toBe(true); // still held
  });

  it('approveGate lifts the write-block and resumes the session to post', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-comment', { issue_ref: 'CSCU-1', body: 'hi' })]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', 'Drafted body');

    engine.approveGate(jobId, 'g1');
    await Promise.resolve();  // dispatchActionResume is async

    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('running');
    expect(s.gateApproved).toBe(true);
    expect(engine.writeGateHeldForSession(sid)).toBe(false); // approval lifts the block
    expect(resumed).toContain(sid);                          // same session resumed to commit
  });

  it('rejectGate records feedback and resumes for a redraft, still holding the write', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-comment', { issue_ref: 'CSCU-1', body: 'hi' })]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', 'First draft');

    engine.rejectGate(jobId, 'g1', 'make it warmer');
    await Promise.resolve();

    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('running');
    expect(s.gateApproved).toBeFalsy();
    expect(s.gateFeedback).toEqual(['make it warmer']);
    expect(engine.writeGateHeldForSession(sid)).toBe(true);  // still blocked — not approved
    expect(resumed).toContain(sid);                          // resumed for redraft

    // A second draft re-parks; a second rejection accumulates feedback.
    engine.onWriteDraftReady(jobId, 'g1', 'Second draft');
    expect(stepOf(queue, jobId, 'g1').state).toBe('gate_pending_approval');
    engine.rejectGate(jobId, 'g1', 'shorter');
    expect(stepOf(queue, jobId, 'g1').gateFeedback).toEqual(['make it warmer', 'shorter']);
  });

  it('rejectGate with empty feedback is a no-op (nothing to redraft toward)', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-comment', { body: 'hi' })]);
    await engine.tick(jobId);
    engine.onWriteDraftReady(jobId, 'g1', 'draft');
    engine.rejectGate(jobId, 'g1', '   ');
    expect(stepOf(queue, jobId, 'g1').state).toBe('gate_pending_approval');
    expect(stepOf(queue, jobId, 'g1').gateFeedback).toBeUndefined();
  });

  it('a parked draft turn ending is not treated as an unresolved-step failure', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-comment', { body: 'hi' })]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', 'draft');
    // The draft turn's Stop hook fires while parked — must NOT fail the step.
    const failed = engine.armUnresolvedCheck(sid, 'ended without output');
    expect(failed).toBe(false);
    expect(stepOf(queue, jobId, 'g1').failure).toBeUndefined();
    expect(stepOf(queue, jobId, 'g1').state).toBe('gate_pending_approval');
  });

  it('an ungated claude action spawns immediately with no write-block', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('r1', 'read.investigate', { subject: 's' })]);

    await engine.tick(jobId);

    const s = stepOf(queue, jobId, 'r1');
    expect(s.state).toBe('running');
    expect(spawned).toHaveLength(1);
    expect(engine.writeGateHeldForSession(s.sessionId!)).toBe(false);
  });
});
