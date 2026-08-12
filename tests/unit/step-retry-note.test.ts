import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import { actionHandler } from '../../src/steps/action.js';
import type { ActionEnvelope } from '../../src/work/envelope.js';
import type { ActionStep, ProposedStep } from '../../src/work/work-types.js';

// A retry cold-spawns: onStepRetry clears `sessionId`, so the next attempt gets a brand new
// session with no transcript. `attempts` (and the envelope's previousAttempts built from it)
// is the only channel carrying the user's correction across that boundary — these pin that it
// survives, accumulates, and actually reaches the spawned session.
function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'retry-note-'));
  const queue = new JobQueue(dir);
  const sent: Array<{ sessionId: string; content: string }> = [];
  const sessionManager = {
    spawnDetached() { /* no subprocess in the harness */ },
    send(sessionId: string, msg: { message: { content: string } }) {
      sent.push({ sessionId, content: msg.message.content });
    },
    isWorking() { return false; },
    sendOrResume() { /* not exercised */ },
  } as never;
  const engine = new WorkEngine({
    queue,
    sessionManager,
    worktreeManager: { provision: async () => ({ path: dir }) } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1,
  });
  return { engine, queue, sent };
}

function seedJob(engine: WorkEngine, queue: JobQueue) {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  // A fresh job is `planning`; decide() only dispatches once the plan is approved.
  queue.mutate(job.id, (j) => ({ ...j, state: 'executing' }));
  return job.id;
}

function seedFailedStep(engine: WorkEngine, queue: JobQueue, reason: string) {
  const jobId = seedJob(engine, queue);
  const proposed: ProposedStep = {
    type: 'action',
    action: 'read.investigate',
    title: 'Investigate canary health',
    description: 'd',
    goal: 'g',
    workspace: { kind: 'none' },
  };
  const step = engine.addStepManually(jobId, proposed)!;
  engine.onStepFailed(jobId, step.id, reason);
  return { jobId, stepId: step.id };
}

const stepOf = (queue: JobQueue, jobId: string, stepId: string) =>
  queue.get(jobId)!.steps.find((s) => s.id === stepId)! as ActionStep;

describe('retrying a step with a message', () => {
  it('records the cleared failure alongside the note, and accumulates across retries', () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = seedFailedStep(engine, queue, 'no canary health verdict is obtainable');

    engine.onStepRetry(jobId, stepId, '  the sync engine never ran — check the flag first  ');

    let step = stepOf(queue, jobId, stepId);
    expect(step.failure).toBeUndefined();
    expect(step.sessionId).toBeUndefined();
    expect(step.attempts).toEqual([
      { at: 1, failure: 'no canary health verdict is obtainable', note: 'the sync engine never ran — check the flag first' },
    ]);

    engine.onStepFailed(jobId, stepId, 'flag was on, still no data');
    engine.onStepRetry(jobId, stepId, 'look at ochicago1b specifically');

    step = stepOf(queue, jobId, stepId);
    expect(step.attempts).toHaveLength(2);
    expect(step.attempts![1]).toEqual({ at: 1, failure: 'flag was on, still no data', note: 'look at ochicago1b specifically' });
  });

  // The count alone is worth carrying: it's what tells attempt 3 it isn't the first to try,
  // even when the user said nothing.
  it('records a bare retry with no note', () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = seedFailedStep(engine, queue, 'boom');

    engine.onStepRetry(jobId, stepId);
    engine.onStepRetry(jobId, stepId, '   ');

    const attempts = stepOf(queue, jobId, stepId).attempts!;
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => !('note' in a))).toBe(true);
  });

  it("surfaces the attempts on the retried session's envelope", () => {
    const { engine, queue } = makeEngine();
    const { jobId, stepId } = seedFailedStep(engine, queue, 'no verdict obtainable');
    engine.onStepRetry(jobId, stepId, 'check the flag first');

    const job = queue.get(jobId)!;
    const envelope = actionHandler.buildEnvelope(
      stepOf(queue, jobId, stepId),
      job,
      { now: () => 1, jobsDir: '/tmp' } as never,
    ) as ActionEnvelope;
    expect(envelope.previousAttempts).toEqual([
      { at: 1, failure: 'no verdict obtainable', note: 'check the flag first' },
    ]);
  });

  // Without this the envelope field is invisible: no SKILL.md tells its action to look for a
  // key that's absent on every first run, and the spawn prompt is otherwise a bare `/action`.
  it('tells the respawned session it is a retry, and says nothing extra on a first spawn', async () => {
    const { engine, queue, sent } = makeEngine();
    const { jobId, stepId } = seedFailedStep(engine, queue, 'boom');

    await engine.tick(jobId);
    expect(sent).toHaveLength(0); // a failed step doesn't dispatch

    engine.onStepRetry(jobId, stepId, 'the flag was never enabled');
    await engine.tick(jobId);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain('/read.investigate');
    expect(sent[0]!.content).toContain('Attempt 2');
    expect(sent[0]!.content).toContain('previousAttempts');
    expect(sent[0]!.content).toContain("user's correction");
  });

  it('leaves a first spawn as a bare slash command', async () => {
    const { engine, queue, sent } = makeEngine();
    const jobId = seedJob(engine, queue);
    engine.addStepManually(jobId, {
      type: 'action', action: 'read.investigate', title: 't', description: 'd', goal: 'g',
      workspace: { kind: 'none' },
    } as ProposedStep);

    await engine.tick(jobId);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe('/read.investigate');
  });
});
