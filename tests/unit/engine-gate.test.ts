import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord, OrchestratedStep, Step } from '../../src/work/work-types.js';
import { handleHook, handlePostToolFailureHook } from '../../src/permissions/hook-handler.js';
import { ApprovalModeStore } from '../../src/permissions/approval-mode.js';

// write.* and code.* actions carry a gated allowlist (Task 2); read.investigate doesn't.
// The engine no longer reads a static human_gate flag off the registry — a step is only
// ever gated by whether it actually raises a draft.
function gatedAllowlistFor(name: string) {
  return name.startsWith('write.') || name.startsWith('code.')
    ? { alwaysAllow: [], alwaysAllowBashPatterns: ['^git push'], alwaysAllowMcpPatterns: ['^mcp__linear__save_'], alwaysAllowPathPatterns: [] }
    : { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] };
}
// validateNext's self-round branch refuses a named `move.action` with no side_effects at all
// (`unknown action`) — needed so a test can drive a REAL self-round rebind through
// onStepProgress rather than hand-injecting a bound action.
function sideEffectsFor(name: string) {
  return name.startsWith('write.') || name.startsWith('code.') ? 'external-write' : 'none';
}
const actionRegistry = {
  getAction(name: string) {
    return {
      frontmatter: { outpost: { runner: 'claude', side_effects: sideEffectsFor(name) } },
      gated: gatedAllowlistFor(name),
    };
  },
  gatedFor(name: string) { return gatedAllowlistFor(name); },
  // Only exercised once a test resumes an orchestrated controller (buildActionCatalog reads
  // it); every other test never touches this path.
  listActions() { return []; },
} as never;

function makeEngine(over: Record<string, unknown> = {}) {
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
    ...over,
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

// A controller "already running" — sessionId is pre-set (as if a real spawn already
// happened), so submitDraft/acceptDraft/etc. can resume it without going through the
// spawn-session/governor machinery this harness doesn't model.
function orchestratedStep(
  id: string, controller: string, dispatches: OrchestratedStep['dispatches'] = [],
  over: Partial<OrchestratedStep> = {},
): OrchestratedStep {
  return {
    id, type: 'orchestrated', title: id, description: 'd', controller,
    workspace: { kind: 'none' }, goal: 'g', dispatches, inbox: [],
    roundsSpent: 0, consecutiveSelfRounds: 0, state: 'running', sessionId: `${id}-sess`,
    createdAt: 1000, updatedAt: 1000, ...over,
  };
}

function seedOrchestratedJob(queue: JobQueue, engine: WorkEngine, steps: Step[]): string {
  const job = engine.createJob({ source: 'manual', title: 't', description: 'd' });
  queue.mutate(job.id, (j): JobRecord => ({ ...j, state: 'executing', steps }));
  return job.id;
}

function orchestratedStepOf(queue: JobQueue, jobId: string, stepId: string): OrchestratedStep {
  return queue.get(jobId)!.steps.find((s) => s.id === stepId) as OrchestratedStep;
}

const CALLS = [{ id: 'c1', label: 'file issue', tool: { name: 'mcp__linear__save_issue', args: { title: 'Bug', teamId: 'T1' } } }];

describe('WriteDraft — draft → accept', () => {
  it('parks the step on submit_write_draft without approving anything', async () => {
    const { engine, queue, spawned } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    expect(spawned).toHaveLength(1);

    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' },
      summary: 'File Bug on T1', calls: CALLS,
    });

    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('gate_pending_approval');
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts![0]!.approvedAt).toBeUndefined();
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', { title: 'Bug', teamId: 'T1' })).toBeUndefined();
  });

  it('accept pins the user-edited calls and resumes the session', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;

    const edited = [{ ...CALLS[0]!, tool: { name: 'mcp__linear__save_issue', args: { title: 'Edited', teamId: 'T1' } } }];
    await engine.acceptDraft(jobId, 'g1', draftId, edited);
    await Promise.resolve();

    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('running');
    expect(s.drafts![0]!.approvedAt).toBe(1000);
    expect(resumed).toContain(sid);
    // The user's edit is what's pinned; the original payload is not.
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', { title: 'Edited', teamId: 'T1' })?.id).toBe('c1');
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', { title: 'Bug', teamId: 'T1' })).toBeUndefined();
  });

  it('consumePin spends a pin exactly once and releasePin restores it', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, CALLS);
    await Promise.resolve();

    const args = { title: 'Bug', teamId: 'T1' };
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', args)?.id).toBe('c1');
    engine.consumePin(sid, 'c1');
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', args)).toBeUndefined();
    engine.releasePin(sid, 'c1');
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', args)?.id).toBe('c1');
  });

  // Task 7 (fix round 1): PostToolUseFailure, not PostToolUse — the Bash tool throws when its
  // exit-code classifier calls a command an error (default: any non-zero exit; `git push` is
  // not on the small allowlist of commands where that's given a different meaning), and that
  // throw is what routes to this event. releaseConsumedPin can't ask pinFor for the spent pin
  // (pinFor skips consumed calls by design — that's the point of a pin), so it has to match on
  // the tool_use_id PreToolUse recorded at consume time (round 3: the payload-matching
  // fallback this test originally exercised was deleted as fail-open — see releaseConsumedPin).
  it('a PostToolUseFailure with no interrupt restores the spent pin for an identical retry', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [{ id: 'c1', bash: 'git push origin fix' }];
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);
    await Promise.resolve();

    const input = { command: 'git push origin fix' };
    engine.consumePin(sid, engine.pinFor(sid, 'Bash', input)!.id, 'tu-1');
    expect(engine.pinFor(sid, 'Bash', input)).toBeUndefined();

    handlePostToolFailureHook(
      { session_id: sid, tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-1', error: 'Command failed with exit code 1', is_interrupt: false },
      (s, t, i, u) => engine.releaseConsumedPin(s, t, i, u),
    );
    expect(engine.pinFor(sid, 'Bash', input)?.id).toBe('c1');
  });

  // A user/session interrupt mid-call leaves it genuinely unknown whether the write reached
  // the remote before the cut. Releasing anyway risks the unsafe direction (an already-executed
  // write running twice); leaving it consumed only costs one re-approval. handlePostToolFailureHook
  // is the gate that enforces this — exercised here against the real engine, not a stub, so the
  // daemon's actual wiring shape is pinned too.
  it('a PostToolUseFailure with is_interrupt does NOT release the pin', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [{ id: 'c1', bash: 'git push origin fix' }];
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);
    await Promise.resolve();

    const input = { command: 'git push origin fix' };
    engine.consumePin(sid, engine.pinFor(sid, 'Bash', input)!.id, 'tu-1');
    expect(engine.pinFor(sid, 'Bash', input)).toBeUndefined();

    handlePostToolFailureHook(
      { session_id: sid, tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-1', error: 'interrupted', is_interrupt: true },
      (s, t, i, u) => engine.releaseConsumedPin(s, t, i, u),
    );
    expect(engine.pinFor(sid, 'Bash', input)).toBeUndefined();
  });

  // A malformed/incomplete event (missing session_id or tool_name) must be ignored rather
  // than reaching for a pin it has no session to scope against.
  it('handlePostToolFailureHook ignores an event missing session_id or tool_name', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [{ id: 'c1', bash: 'git push origin fix' }];
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);
    await Promise.resolve();

    const input = { command: 'git push origin fix' };
    engine.consumePin(sid, engine.pinFor(sid, 'Bash', input)!.id, 'tu-1');
    expect(engine.pinFor(sid, 'Bash', input)).toBeUndefined();

    const releaseConsumedPin = (s: string, t: string, i: unknown, u?: string) => engine.releaseConsumedPin(s, t, i, u);
    handlePostToolFailureHook({ tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-1' }, releaseConsumedPin);
    handlePostToolFailureHook({ session_id: sid, tool_input: input, tool_use_id: 'tu-1' }, releaseConsumedPin);
    expect(engine.pinFor(sid, 'Bash', input)).toBeUndefined();
  });

  // Review round 2, IMPORTANT 1: a non-zero exit means the tool reported failure, not proof
  // the write never landed (a compound clause's first half can still have run), so the release
  // has to be exactly-once — scoped to the SPECIFIC call that failed, not just "some call whose
  // payload matches." tool_use_id is what makes that precise: two pins in one draft can carry
  // the identical bash text (e.g. the same push approved twice), and only the one PreToolUse
  // actually consumed for THIS tool_use_id may be released.
  it('releaseConsumedPin, given a tool_use_id, releases exactly the pin that id consumed — not a same-payload sibling', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [
      { id: 'c1', bash: 'git push origin fix' },
      { id: 'c2', bash: 'git push origin fix' },
    ];
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);
    await Promise.resolve();

    engine.consumePin(sid, 'c1', 'tu-1');
    engine.consumePin(sid, 'c2', 'tu-2');

    handlePostToolFailureHook(
      { session_id: sid, tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, tool_use_id: 'tu-2', error: 'exit 1' },
      (s, t, i, u) => engine.releaseConsumedPin(s, t, i, u),
    );

    const draft = stepOf(queue, jobId, 'g1').drafts![0]!;
    expect(draft.calls.find((c) => c.id === 'c1')!.consumedAt).toBeDefined();   // untouched
    expect(draft.calls.find((c) => c.id === 'c2')!.consumedAt).toBeUndefined(); // released
    expect(draft.calls.find((c) => c.id === 'c2')!.releasedAfterFailure).toBe(true);
  });

  // The other half of exactly-once: when a tool_use_id IS supplied but nothing consumed
  // matches it (duplicate/replayed delivery of an older failure, or a forged/cross-session
  // id), refuse rather than fall back to a payload guess.
  it('releaseConsumedPin refuses to release via payload match when a supplied tool_use_id does not match', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [{ id: 'c1', bash: 'git push origin fix' }];
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);
    await Promise.resolve();

    engine.consumePin(sid, 'c1', 'tu-1');
    const input = { command: 'git push origin fix' };

    handlePostToolFailureHook(
      { session_id: sid, tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-does-not-match', error: 'exit 1' },
      (s, t, i, u) => engine.releaseConsumedPin(s, t, i, u),
    );

    expect(engine.pinFor(sid, 'Bash', input)).toBeUndefined(); // still consumed
  });

  // Important-3 regression: submitDraft's `kept` filter retains every approved draft, so a
  // step making two gated writes accumulates two. pinFor must resolve the second write's pin,
  // not stay pinned to the first (already-superseded) one.
  it('pinFor resolves the LATEST approved draft when a step has made two gated writes', async () => {
    const { engine, queue, clock } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;

    const firstCall = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'First' } } };
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 'first', calls: [firstCall],
    });
    const draft1 = stepOf(queue, jobId, 'g1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'g1', draft1, [firstCall]);

    clock.now = 2000;
    const secondCall = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'Second' } } };
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 'second', calls: [secondCall],
    });
    const draft2 = stepOf(queue, jobId, 'g1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'g1', draft2, [secondCall]);

    expect(stepOf(queue, jobId, 'g1').drafts).toHaveLength(2);
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', { title: 'Second' })?.id).toBe('c1');
  });

  // steps/action.ts's buildEnvelope selects the step's own current draft and delegates to
  // writeGateFor — mirrors the dispatchResume/resumeControllerRound coverage below, but for an
  // ActionStep's own dispatchActionResume path.
  it("dispatchActionResume's envelope carries the writeGate phase and feedback", async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const envelopePath = join(dir, 'jobs', jobId, 'steps', 'g1', 'envelope.json');

    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;

    engine.reviseDraft(jobId, 'g1', draftId, 'shorter title');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const draftEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(draftEnvelope.typePayload.writeGate).toEqual({ phase: 'draft', feedback: ['shorter title'] });

    const draftId2 = stepOf(queue, jobId, 'g1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'g1', draftId2, CALLS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const commitEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(commitEnvelope.typePayload.writeGate).toEqual({
      phase: 'commit', approvedCalls: CALLS, feedback: ['shorter title'],
    });
  });
});

describe('WriteDraft — revise', () => {
  it('records feedback, re-runs the session, and pins nothing', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;

    engine.reviseDraft(jobId, 'g1', draftId, 'title should name the service');
    await Promise.resolve();

    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('running');
    expect(s.drafts![0]!.feedback).toEqual(['title should name the service']);
    expect(s.drafts![0]!.approvedAt).toBeUndefined();
    expect(engine.pinFor(sid, 'mcp__linear__save_issue', { title: 'Bug', teamId: 'T1' })).toBeUndefined();
    expect(resumed).toContain(sid);
  });

  it('empty feedback is a no-op', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;
    engine.reviseDraft(jobId, 'g1', draftId, '   ');
    expect(stepOf(queue, jobId, 'g1').state).toBe('gate_pending_approval');
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.feedback).toBeUndefined();
  });
});

describe('WriteDraft — deny', () => {
  it('declines the step, journals against the chooser, and never journals the action', async () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: { append: (e: never) => journalled.push(e), recent: () => [] },
    });
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;

    engine.denyDraft(jobId, 'g1', draftId, 'investigation has no verdict yet');

    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('declined');
    expect(s.failure).toBeUndefined();          // declined is not a failure
    expect(journalled).toHaveLength(1);
    expect(journalled[0]!.action).toBe('meta.orchestrate');   // the chooser, not the writer
    expect(journalled[0]!.lesson).toContain('investigation has no verdict yet');
  });

  it('deny with an empty reason is refused', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;
    engine.denyDraft(jobId, 'g1', draftId, '  ');
    expect(stepOf(queue, jobId, 'g1').state).toBe('gate_pending_approval');
  });
});

describe('WriteDraft — parked turn end', () => {
  it('a parked draft turn ending is not an unresolved-step failure', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    expect(engine.armUnresolvedCheck(sid, 'ended without output')).toBe(false);
    expect(stepOf(queue, jobId, 'g1').failure).toBeUndefined();
  });
});

describe('WriteDraft — a submit against a terminal step is a no-op', () => {
  it('ignores a submit against a resolved step', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    queue.mutate(jobId, (j) => ({
      ...j, steps: j.steps.map((s) => s.id === 'g1' ? { ...s, state: 'resolved' } as Step : s),
    }));
    // Refused, not silently swallowed — this is the MCP tool's only signal to a session
    // that its draft was never parked and it must not wait for a decision.
    const result = engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    expect(result).toEqual({ ok: false, reason: 'step is already terminal' });
    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('resolved');
    expect(s.drafts).toBeUndefined();
  });

  it('ignores a submit against a just-declined step', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    queue.mutate(jobId, (j) => ({
      ...j, steps: j.steps.map((s) => s.id === 'g1' ? { ...s, state: 'declined' } as Step : s),
    }));
    const result = engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    expect(result).toEqual({ ok: false, reason: 'step is already terminal' });
    const s = stepOf(queue, jobId, 'g1');
    expect(s.state).toBe('declined');
    expect(s.drafts).toBeUndefined();
  });
});

describe('WriteDraft — orchestrated steps: raiser coercion, pin isolation, deny routing', () => {
  it('coerces a {kind:"step"} raiser to {kind:"controller"} for an orchestrated step', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.drafts![0]!.raisedBy).toEqual({ kind: 'controller' });
    expect(s.state).toBe('gate_pending_approval');
  });

  // Critical regression. The FIRST version of this test hand-injected `action: 'code.merge-pr'`
  // straight into onWriteDraftReady — which passed even with the bug live, because it bypassed
  // the one thing that was actually broken: daemon.ts's submit_write_draft handler derives
  // `action` from `engine.actionForStep(jobId, stepId)`, which (before boundAction existed)
  // always fell through to `actionNameForStep` → `s.controller`, no matter what sub-action the
  // session was really bound to. This version drives a REAL self-round rebind through
  // onStepProgress (the only way `boundAction` is ever set) and derives `action` through
  // actionForStep, exactly as daemon.ts does, so it actually exercises the fix.
  it('resumes a controller-raised draft bound to the sub-action that drafted it, not the controller', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();

    // The self-round that drafts the write: `code.merge-pr`, not the controller.
    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.merge-pr');   // the fix: not 'code.orchestrate-pr'

    // Mirrors daemon.ts's submit_write_draft handler: `action` is DERIVED, never passed by the caller.
    const action = engine.actionForStep(jobId, 'o1')!;
    engine.onWriteDraftReady(jobId, 'o1', {
      action, raisedBy: { kind: 'controller' }, summary: 's', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, CALLS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(engine.actionForSession(controllerSessionId)).toBe('code.merge-pr');
  });

  // Same rebind requirement on the revise path: a redraft has to run the same skill that
  // drafted, not the controller.
  it('resumes a controller-raised draft revision bound to the sub-action too', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();

    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const action = engine.actionForStep(jobId, 'o1')!;
    engine.onWriteDraftReady(jobId, 'o1', {
      action, raisedBy: { kind: 'controller' }, summary: 's', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    engine.reviseDraft(jobId, 'o1', draftId, 'wrong PR number');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(engine.actionForSession(controllerSessionId)).toBe('code.merge-pr');
  });

  // notifyControllerDenied is the one exception: the draft is dead, so the controller should
  // resume as ITSELF to pick a different move, not stay bound to the sub-action that just got
  // denied. Also verifies boundAction itself resets — actionForStep reports the controller
  // again, not just the session.
  it('a denied controller draft resumes bound to the controller itself, not the sub-action', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();

    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const action = engine.actionForStep(jobId, 'o1')!;
    engine.onWriteDraftReady(jobId, 'o1', {
      action, raisedBy: { kind: 'controller' }, summary: 's', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    engine.denyDraft(jobId, 'o1', draftId, 'not yet');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(engine.actionForSession(controllerSessionId)).toBe('code.orchestrate-pr');
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.orchestrate-pr');
  });

  // Regression: actionForStep(jobId, stepId) alone resolves via actionNameForStep, which
  // returns the ORCHESTRATED step's own action — the controller — because `stepId` here is the
  // PARENT step, not the dispatch. Every dispatch-raised draft would otherwise be labelled with
  // the controller's action instead of the child's own.
  it("actionForStep resolves a dispatch's own action, not the controller's, when dispatchId is given", () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'write.linear-comment', brief: 'b', status: 'running', sessionId: 'sess-dA', attempts: 1 },
    ])]);
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.orchestrate-pr');
    expect(engine.actionForStep(jobId, 'o1', 'dA')).toBe('write.linear-comment');
  });

  // Regression: onStepRetry reset `sessionId`/`state`/`drafts` but not `boundAction` — the other
  // site that drops a session, alongside reconcileInterruptedSteps (which already clears it, see
  // the comment there). Left set, a step retried right after a failed bound self-round (e.g.
  // `code.merge-pr` giving up) would cold-respawn bound to the controller (spawnStepSession
  // always rebinds to `s.controller`) while `actionForStep`/the envelope kept reporting the
  // stale sub-action — three different derivations of "which action owns this step" disagreeing
  // on the very first post-retry turn.
  it('clears a stale boundAction on retry after a failed bound self-round', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    engine.rehydrateSessionBindings();

    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.merge-pr');

    // The bound round gives up outright — e.g. it couldn't merge and has nothing left to try.
    engine.onStepProgress(jobId, 'o1', { next: { kind: 'fail', reason: 'could not merge' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(orchestratedStepOf(queue, jobId, 'o1').failure).toBeDefined();
    expect(orchestratedStepOf(queue, jobId, 'o1').boundAction).toBe('code.merge-pr'); // stale, pre-fix

    engine.onStepRetry(jobId, 'o1');

    expect(orchestratedStepOf(queue, jobId, 'o1').boundAction).toBeUndefined();
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.orchestrate-pr');
  });

  // Regression: the wire `dispatchId` is trusted (no session identity at the MCP boundary), and
  // the controller's own envelope lists every sibling dispatch id. A controller naming a
  // `queued` child here — one that hasn't actually spawned yet — must be refused, not silently
  // parked: flipping a queued dispatch to `awaiting_approval` leaves nothing that can ever
  // spawn it (the launch's own `run()` requires `status === 'queued'`), so accept/revise/deny
  // all dead-end and `untilAllDispatchesDone` never clears.
  it('refuses a submit_write_draft naming a dispatch that has not spawned yet (status: queued)', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'b', status: 'queued', attempts: 0 },
    ])]);
    const result = engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 's', calls: CALLS,
    });
    expect(result).toEqual({ ok: false, reason: 'dispatch dA is not a running child (status: queued)' });
    expect(orchestratedStepOf(queue, jobId, 'o1').drafts).toBeUndefined();
    expect(orchestratedStepOf(queue, jobId, 'o1').dispatches[0]!.status).toBe('queued');
  });

  it('pin isolation both ways: a dispatch cannot reach the controller pin, and the controller cannot reach a dispatch pin', async () => {
    const { engine, queue } = makeEngine();
    const dispatchId = 'dA';
    const dispSessionId = 'sess-dA';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: dispatchId, action: 'code.implement', brief: 'b', status: 'running', sessionId: dispSessionId, attempts: 1 },
    ])]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();

    const ctrlCall = { id: 'c1', tool: { name: 'mcp__linear__save_comment', args: { body: 'ctrl' } } };
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'write.linear-comment', raisedBy: { kind: 'controller' }, summary: 'c', calls: [ctrlCall],
    });
    const ctrlDraftId = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => d.raisedBy.kind === 'controller')!.id;
    await engine.acceptDraft(jobId, 'o1', ctrlDraftId, [ctrlCall]);
    await Promise.resolve(); await Promise.resolve();

    const dispCall = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'X' } } };
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId }, summary: 'd', calls: [dispCall],
    });
    const dispDraftId = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => d.raisedBy.kind === 'dispatch')!.id;
    await engine.acceptDraft(jobId, 'o1', dispDraftId, [dispCall]);
    await Promise.resolve(); await Promise.resolve();

    // Each session reaches its own pin...
    expect(engine.pinFor(controllerSessionId, 'mcp__linear__save_comment', { body: 'ctrl' })?.id).toBe('c1');
    expect(engine.pinFor(dispSessionId, 'mcp__linear__save_issue', { title: 'X' })?.id).toBe('c1');
    // ...but never the other's, despite the colliding call id.
    expect(engine.pinFor(controllerSessionId, 'mcp__linear__save_issue', { title: 'X' })).toBeUndefined();
    expect(engine.pinFor(dispSessionId, 'mcp__linear__save_comment', { body: 'ctrl' })).toBeUndefined();
  });

  // Critical-2 regression: PinnedCall.id is only unique WITHIN a draft, so two dispatches
  // under one controller can each mint a `c1`. consumePin/releasePin must not reach across.
  it('two dispatches holding a draft with a colliding call id c1: consuming one does not spend the other', async () => {
    const { engine, queue } = makeEngine();
    const sessA = 'sess-dA';
    const sessB = 'sess-dB';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'a', status: 'running', sessionId: sessA, attempts: 1 },
      { id: 'dB', action: 'code.implement', brief: 'b', status: 'running', sessionId: sessB, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();

    const callA = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'A' } } };
    const callB = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'B' } } };
    engine.onWriteDraftReady(jobId, 'o1', { action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 'a', calls: [callA] });
    const draftA = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => d.raisedBy.kind === 'dispatch' && d.raisedBy.dispatchId === 'dA')!.id;
    await engine.acceptDraft(jobId, 'o1', draftA, [callA]);
    await Promise.resolve(); await Promise.resolve();

    engine.onWriteDraftReady(jobId, 'o1', { action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dB' }, summary: 'b', calls: [callB] });
    const draftB = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => d.raisedBy.kind === 'dispatch' && d.raisedBy.dispatchId === 'dB')!.id;
    await engine.acceptDraft(jobId, 'o1', draftB, [callB]);
    await Promise.resolve(); await Promise.resolve();

    expect(engine.pinFor(sessA, 'mcp__linear__save_issue', { title: 'A' })?.id).toBe('c1');
    expect(engine.pinFor(sessB, 'mcp__linear__save_issue', { title: 'B' })?.id).toBe('c1');

    engine.consumePin(sessA, 'c1');
    expect(engine.pinFor(sessA, 'mcp__linear__save_issue', { title: 'A' })).toBeUndefined();
    // B's own c1 must still be live — consuming A's must not touch it.
    expect(engine.pinFor(sessB, 'mcp__linear__save_issue', { title: 'B' })?.id).toBe('c1');

    engine.releasePin(sessB, 'c1');
    expect(engine.pinFor(sessB, 'mcp__linear__save_issue', { title: 'B' })?.id).toBe('c1');
  });

  // Task 7 / earlier review Critical: releaseConsumedPin re-derives the pin via
  // draftForSession, same as consumePin/releasePin — a failed dA push must not un-spend dB's
  // already-executed push just because both happen to carry call id c1.
  it('releaseConsumedPin does not un-spend a sibling dispatch\'s pin sharing call id c1', async () => {
    const { engine, queue } = makeEngine();
    const sessA = 'sess-dA';
    const sessB = 'sess-dB';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'a', status: 'running', sessionId: sessA, attempts: 1 },
      { id: 'dB', action: 'code.implement', brief: 'b', status: 'running', sessionId: sessB, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();

    const callA = { id: 'c1', bash: 'git push origin a' };
    const callB = { id: 'c1', bash: 'git push origin b' };
    engine.onWriteDraftReady(jobId, 'o1', { action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 'a', calls: [callA] });
    const draftA = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => d.raisedBy.kind === 'dispatch' && d.raisedBy.dispatchId === 'dA')!.id;
    await engine.acceptDraft(jobId, 'o1', draftA, [callA]);
    await Promise.resolve(); await Promise.resolve();

    engine.onWriteDraftReady(jobId, 'o1', { action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dB' }, summary: 'b', calls: [callB] });
    const draftB = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => d.raisedBy.kind === 'dispatch' && d.raisedBy.dispatchId === 'dB')!.id;
    await engine.acceptDraft(jobId, 'o1', draftB, [callB]);
    await Promise.resolve(); await Promise.resolve();

    // Both pushes ran (PreToolUse consumes at allow time, Task 6) — dB's actually succeeded.
    // Same call id (c1) but distinct tool_use_ids, since they're distinct real tool calls —
    // that distinction is exactly what keeps the failure below from reaching dB's pin.
    engine.consumePin(sessA, 'c1', 'tu-a');
    engine.consumePin(sessB, 'c1', 'tu-b');

    // dA's push then threw a PostToolUseFailure — release only dA's pin.
    handlePostToolFailureHook(
      { session_id: sessA, tool_name: 'Bash', tool_input: { command: 'git push origin a' }, tool_use_id: 'tu-a', error: 'Command failed with exit code 1' },
      (s, t, i, u) => engine.releaseConsumedPin(s, t, i, u),
    );

    expect(engine.pinFor(sessA, 'Bash', { command: 'git push origin a' })?.id).toBe('c1');
    // dB's already-executed push must stay spent, despite the colliding call id.
    expect(engine.pinFor(sessB, 'Bash', { command: 'git push origin b' })).toBeUndefined();
  });

  // Regression: settleOrchestratedStep previously cancelled only `queued` dispatches when the
  // parent step settles, leaving one parked on its own draft (`awaiting_approval`) behind —
  // nothing left to approve it into and nothing marking it done, either.
  it('settling the parent step also cancels a dispatch parked at awaiting_approval, not just queued ones', () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'a', status: 'awaiting_approval', sessionId: 'sess-dA', attempts: 1 },
      { id: 'dB', action: 'code.implement', brief: 'b', status: 'queued', attempts: 0 },
    ])]);
    engine.onStepFailed(jobId, 'o1', 'controller gave up');
    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.dispatches[0]!.status).toBe('cancelled');
    expect(s.dispatches[1]!.status).toBe('cancelled');
  });

  // Regression: cancelling the dispatch above doesn't remove ITS pending draft, and this drop is
  // the main gate against that — for an ORCHESTRATED step. acceptDraft's own terminal-step check
  // (a second, independent layer here) would also refuse since onStepFailed already set the
  // step's failure — but without THIS drop a stale draft left on a settled step would still be a
  // live lever: POST /approve would find it, flip the just-cancelled dispatch back to `running`,
  // and dispatchResume would re-provision a worktree and relaunch a child of a dead step. An
  // ActionStep has no equivalent drop (settleOrchestratedStep is orchestrated-only), so there the
  // terminal-step check is the sole gate — see the ActionStep-specific tests further down.
  it('settling the parent step drops its pending draft, so a later accept is refused', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'a', status: 'awaiting_approval', sessionId: 'sess-dA', attempts: 1 },
    ])]);
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 'd', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;

    engine.onStepFailed(jobId, 'o1', 'controller gave up');
    expect(orchestratedStepOf(queue, jobId, 'o1').drafts).toEqual([]);

    const result = await engine.acceptDraft(jobId, 'o1', draftId, CALLS);
    expect(result).toEqual({ ok: false, reason: 'step is already terminal', status: 409 });
    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.dispatches[0]!.status).toBe('cancelled'); // not resurrected to 'running'
    expect(resumed).not.toContain('sess-dA');
  });

  // Approved drafts are the audit trail for a write already (partially) committed — settling
  // must not erase them, only the still-undecided ones.
  it('settling the parent step keeps an already-approved draft', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'write.linear-comment', raisedBy: { kind: 'controller' }, summary: 'c', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, CALLS);
    await Promise.resolve(); await Promise.resolve();

    engine.onStepFailed(jobId, 'o1', 'controller gave up');
    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts![0]!.approvedAt).toBeDefined();
  });

  it('deny routing — controller raiser: wakes the parked controller via immediate delivery', async () => {
    const { engine, queue, resumed } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();

    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'write.linear-comment', raisedBy: { kind: 'controller' }, summary: 's', calls: CALLS,
    });
    expect(orchestratedStepOf(queue, jobId, 'o1').state).toBe('gate_pending_approval');
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;

    engine.denyDraft(jobId, 'o1', draftId, 'not now');
    await Promise.resolve(); await Promise.resolve();

    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.state).toBe('running');   // moved out of gate_pending_approval, not stuck
    expect(s.lastDelivered?.some((i) => i.kind === 'gate-resolved')).toBe(true);
    expect(resumed).toContain(controllerSessionId);
  });

  it('deny routing — dispatch raiser: settleDispatch alone wakes the waiting controller', async () => {
    const { engine, queue, resumed } = makeEngine();
    const dispSessionId = 'sess-dA';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'b', status: 'running', sessionId: dispSessionId, attempts: 1 },
    ], { state: 'waiting', waitingOn: { reason: 'r', untilAllDispatchesDone: true } })]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();

    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 's', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    engine.denyDraft(jobId, 'o1', draftId, 'not needed');
    await Promise.resolve(); await Promise.resolve();

    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.dispatches[0]!.status).toBe('cancelled');
    expect(s.state).toBe('running');   // drainForDelivery took it out of `waiting`
    expect(resumed).toContain(controllerSessionId);
  });

  // Important-5 regression: `awaiting_approval` is exactly the boot-time status of a dispatch
  // parked on a draft the user hasn't ruled on yet, and nothing else ever rebinds it later.
  it('rehydrateSessionBindings rebinds a dispatch cold-resumed mid-approval', () => {
    const { engine, queue } = makeEngine();
    const dispSessionId = 'sess-dA';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'b', status: 'awaiting_approval', sessionId: dispSessionId, attempts: 1 },
    ])]);
    // The draft that parked the dispatch was already approved before the (simulated) restart.
    queue.mutate(jobId, (j) => ({
      ...j,
      steps: j.steps.map((s) => s.id === 'o1' && s.type === 'orchestrated' ? {
        ...s,
        drafts: [{
          id: 'd1', action: 'code.implement', raisedBy: { kind: 'dispatch' as const, dispatchId: 'dA' },
          summary: 's', calls: CALLS, requestedAt: 0, approvedAt: 500,
        }],
      } : s),
    }));

    engine.rehydrateSessionBindings();

    expect(engine.pinFor(dispSessionId, 'mcp__linear__save_issue', { title: 'Bug', teamId: 'T1' })?.id).toBe('c1');
  });

  // Important-A regression: dispatchResume is `void`-called from resumeRaiser, so a throwing
  // provision() must never escape as an unhandled rejection — it has to fail the dispatch,
  // exactly like spawnDispatchSession's own provision guard.
  it('a throwing provision on dispatch resume fails the dispatch instead of rejecting', async () => {
    const { engine, queue } = makeEngine({
      worktreeManager: { provision: async () => { throw new Error('git blew up'); } } as never,
    });
    const dispSessionId = 'sess-dA';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'b', status: 'running', sessionId: dispSessionId, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();

    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 's', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, CALLS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const s = orchestratedStepOf(queue, jobId, 'o1');
    expect(s.dispatches[0]!.status).toBe('failed');
    expect(s.dispatches[0]!.failure).toMatch(/git blew up/);
  });

  // Important-B regression: the resumed dispatch's envelope has to carry the draft's phase
  // (draft vs commit) and feedback — otherwise a "propose changes" resume is indistinguishable
  // from a fresh spawn and the child just redrafts the same thing forever.
  it('dispatchResume envelope carries the writeGate phase and feedback', async () => {
    const { engine, queue, dir } = makeEngine();
    const dispSessionId = 'sess-dA';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.implement', brief: 'b', status: 'running', sessionId: dispSessionId, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();
    const envelopePath = join(dir, 'jobs', jobId, 'steps', 'dA', 'envelope.json');

    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.implement', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 's', calls: CALLS,
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;

    engine.reviseDraft(jobId, 'o1', draftId, 'shorter title');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const draftEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(draftEnvelope.typePayload.writeGate).toEqual({ phase: 'draft', feedback: ['shorter title'] });

    const draftId2 = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'o1', draftId2, CALLS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const commitEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    // The accepted draft is the SAME one that carried the redraft feedback — accepting doesn't
    // erase that history, it just adds approvedAt/calls on top.
    expect(commitEnvelope.typePayload.writeGate).toEqual({
      phase: 'commit', approvedCalls: CALLS, feedback: ['shorter title'],
    });
  });

  // Important-N1 regression: an approved draft is kept around forever, so without this a
  // controller would carry `writeGate: {phase:'commit', ...}` on EVERY later round for the rest
  // of the step, long after the write it authorized actually landed.
  it('a controller resumed after its only approved call is consumed carries no writeGate', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();
    const envelopePath = join(dir, 'jobs', jobId, 'steps', 'o1', 'envelope.json');

    const ctrlCall = { id: 'c1', tool: { name: 'mcp__linear__save_comment', args: { body: 'ctrl' } } };
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'write.linear-comment', raisedBy: { kind: 'controller' }, summary: 'c', calls: [ctrlCall],
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts![0]!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, [ctrlCall]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Sanity: right after accept, the commit-phase envelope IS reporting the live call.
    const commitEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(commitEnvelope.writeGate).toEqual({ phase: 'commit', approvedCalls: [ctrlCall], feedback: [] });

    engine.consumePin(controllerSessionId, 'c1');   // the write actually happened

    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const laterEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(laterEnvelope.writeGate).toBeUndefined();
  });

  // Final-review CRITICAL: the canonical code.orchestrate-pr ladder. code.merge-pr drafts the
  // merge AND the branch delete together (12a moved the delete into `push`, so there is no
  // ungated path); the merge fails, the pin releases, neither call ever lands; the controller
  // rebinds to code.fix-ci to chase red CI. Before this fix, code.fix-ci's envelope still
  // carried `writeGate.phase:'commit'` with both approved calls, and pinFor still matched them
  // for that session — an approved payload from a round that already failed, handed to a
  // DIFFERENT action that never drafted it and the user was never asked about.
  it('an approved-but-unconsumed draft from an earlier bound action is invisible to a later, different bound action', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();
    const envelopePath = join(dir, 'jobs', jobId, 'steps', 'o1', 'envelope.json');

    // Round 1: bound to code.merge-pr, drafts the merge + the branch delete together.
    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const mergeAction = engine.actionForStep(jobId, 'o1')!;
    expect(mergeAction).toBe('code.merge-pr');

    const mergeCall = { id: 'c1', bash: 'gh pr merge 7 --squash' };
    const deleteCall = { id: 'c2', bash: 'git push origin --delete -- "feat/x"' };
    engine.onWriteDraftReady(jobId, 'o1', {
      action: mergeAction, raisedBy: { kind: 'controller' }, summary: 'merge', calls: [mergeCall, deleteCall],
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, [mergeCall, deleteCall]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // The merge is attempted and fails: PreToolUse consumed the pin, PostToolUseFailure
    // released it — correct by design. The delete was never even attempted.
    expect(engine.pinFor(controllerSessionId, 'Bash', { command: 'gh pr merge 7 --squash' })?.id).toBe('c1');
    engine.consumePin(controllerSessionId, 'c1', 'tu-1');
    engine.releasePin(controllerSessionId, 'c1');

    // Round 2: the merge round hands back; the controller binds a DIFFERENT action.
    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.fix-ci' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.fix-ci');

    // Neither call the merge round drafted is reachable by the fix-ci round...
    expect(engine.pinFor(controllerSessionId, 'Bash', { command: 'gh pr merge 7 --squash' })).toBeUndefined();
    expect(engine.pinFor(controllerSessionId, 'Bash', { command: 'git push origin --delete -- "feat/x"' })).toBeUndefined();
    // ...and the envelope this round actually reads carries no writeGate at all.
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(envelope.writeGate).toBeUndefined();
  });

  // The legitimate case that has to keep working: the SAME bound action, resumed again
  // (explicitly re-asserting itself across turns, the way accept/revise's resumeRaiser threads
  // draft.action through), still sees its own remaining pin and writeGate mid-commit.
  it('the same bound action resuming mid-commit still sees its own remaining pin and writeGate', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr')]);
    const controllerSessionId = orchestratedStepOf(queue, jobId, 'o1').sessionId!;
    engine.rehydrateSessionBindings();
    const envelopePath = join(dir, 'jobs', jobId, 'steps', 'o1', 'envelope.json');

    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const action = engine.actionForStep(jobId, 'o1')!;

    const mergeCall = { id: 'c1', bash: 'gh pr merge 7 --squash' };
    const deleteCall = { id: 'c2', bash: 'git push origin --delete -- "feat/x"' };
    engine.onWriteDraftReady(jobId, 'o1', {
      action, raisedBy: { kind: 'controller' }, summary: 'merge', calls: [mergeCall, deleteCall],
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, [mergeCall, deleteCall]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // The merge succeeds this time and consumes its pin; the delete is still outstanding.
    engine.consumePin(controllerSessionId, 'c1', 'tu-1');

    // The round continues into its next turn, explicitly re-asserting the SAME bound action.
    engine.onStepProgress(jobId, 'o1', { next: { kind: 'self-round', action: 'code.merge-pr' } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(engine.actionForStep(jobId, 'o1')).toBe('code.merge-pr');

    expect(engine.pinFor(controllerSessionId, 'Bash', { command: 'git push origin --delete -- "feat/x"' })?.id).toBe('c2');
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(envelope.writeGate).toEqual({ phase: 'commit', approvedCalls: [deleteCall], feedback: [] });
  });
});

// Review round 1, IMPORTANT 4 / MINOR 6: the hook needs to tell "nothing drafted", "a draft
// is awaiting the user", and "an approved draft exists but this call isn't one of its pins"
// apart to word the deny reason correctly, and a gated denial must leave journal evidence.
describe('WriteDraft — hook backstop detail (draftStateFor / journalGatedDenial)', () => {
  it('draftStateFor tracks none -> pending -> approved across the draft lifecycle', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    expect(engine.draftStateFor(sid)).toBe('none');

    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: CALLS,
    });
    expect(engine.draftStateFor(sid)).toBe('pending');

    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;
    await engine.acceptDraft(jobId, 'g1', draftId, CALLS);
    await Promise.resolve();
    expect(engine.draftStateFor(sid)).toBe('approved');
  });

  it('journalGatedDenial appends a gated_denied journal entry carrying the hook deny reason', async () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: {
        append: (e: never) => { journalled.push(e); return e; },
        recent: () => [],
        hasEntryForStep: () => false,
      },
    });
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;

    engine.journalGatedDenial(sid, 'write.linear-issue', 'no approved pin for this call');

    expect(journalled).toHaveLength(1);
    expect(journalled[0]!.action).toBe('write.linear-issue');
    expect(journalled[0]!.outcome).toBe('gated_denied');
    expect(journalled[0]!.lesson).toBe('no approved pin for this call');
  });

  it('journalGatedDenial on a session with no bound step is a no-op, not a throw', () => {
    const { engine } = makeEngine();
    expect(() => engine.journalGatedDenial('unbound-session', 'write.linear-issue', 'reason')).not.toThrow();
  });

  // Review round 2, IMPORTANT 1 regression: a dispatch's bound step is the PARENT
  // orchestrated step, whose action is the controller (code.orchestrate-pr) — the journal
  // entry must still land against the child action the hook actually denied
  // (code.merge-pr), or the child gets no evidence and the controller's journal gets a
  // lesson about someone else's action.
  it("a dispatch session's gated denial journals against the CHILD action, not the controller", () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: {
        append: (e: never) => { journalled.push(e); return e; },
        recent: () => [],
        hasEntryForStep: () => false,
      },
    });
    const dispSessionId = 'sess-dA';
    seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.merge-pr', brief: 'b', status: 'running', sessionId: dispSessionId, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();

    engine.journalGatedDenial(dispSessionId, 'code.merge-pr', 'no approved pin for this call');

    expect(journalled).toHaveLength(1);
    expect(journalled[0]!.action).toBe('code.merge-pr');
    expect(journalled[0]!.outcome).toBe('gated_denied');
  });

  // Review round 3, item 2 regression: journalGatedDenial's dedupe key for a dispatch must
  // be the dispatch's OWN id, not the parent orchestrated step's — two sequential dispatches
  // of the SAME child action under one controller would otherwise share a dedupe slot and
  // the second dispatch's distinct denial would be silently dropped.
  it('two sequential dispatches of the same child action each get their own gated_denied entry', () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string; jobId: string; stepId?: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: {
        append: (e: never) => { journalled.push(e); return e; },
        recent: () => [],
        hasEntryForStep: (
          action: string, jobId: string, stepId?: string,
          opts: { outcome?: string; excludeOutcome?: string } = {},
        ) => journalled.some((e) => e.action === action && e.jobId === jobId
          && (!e.stepId || !stepId || e.stepId === stepId)
          && (opts.outcome === undefined || e.outcome === opts.outcome)
          && (opts.excludeOutcome === undefined || e.outcome !== opts.excludeOutcome)),
      },
    });
    const sessA = 'sess-dA';
    const sessB = 'sess-dB';
    seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.merge-pr', brief: 'a', status: 'running', sessionId: sessA, attempts: 1 },
      { id: 'dB', action: 'code.merge-pr', brief: 'b', status: 'running', sessionId: sessB, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();

    engine.journalGatedDenial(sessA, 'code.merge-pr', 'dA missing its pin');
    engine.journalGatedDenial(sessB, 'code.merge-pr', 'dB missing its pin');

    expect(journalled).toHaveLength(2);
    expect(journalled.map((j) => j.lesson).sort()).toEqual(['dA missing its pin', 'dB missing its pin']);
  });

  // Review round 2, IMPORTANT 2 regression: a gated denial must not occupy (or be crowded
  // out by) onStepFailed's one-entry-per-step 'blocked' backstop — both are real, distinct
  // evidence and both must survive.
  it('a gated denial does not suppress the same step\'s later real failure lesson', async () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string; jobId: string; stepId?: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: {
        append: (e: never) => { journalled.push(e); return e; },
        recent: () => [],
        hasEntryForStep: (
          action: string, jobId: string, stepId?: string,
          opts: { outcome?: string; excludeOutcome?: string } = {},
        ) => journalled.some((e) => e.action === action && e.jobId === jobId
          && (!e.stepId || !stepId || e.stepId === stepId)
          && (opts.outcome === undefined || e.outcome === opts.outcome)
          && (opts.excludeOutcome === undefined || e.outcome !== opts.excludeOutcome)),
      },
    });
    const jobId = seedJob(queue, engine, [actionStep('g1', 'write.linear-issue')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;

    engine.journalGatedDenial(sid, 'write.linear-issue', 'attempted before drafting');
    engine.onStepFailed(jobId, 'g1', 'Linear API rejected the comment');

    expect(journalled).toHaveLength(2);
    expect(journalled.find((j) => j.outcome === 'gated_denied')!.lesson).toBe('attempted before drafting');
    expect(journalled.find((j) => j.outcome === 'blocked')!.lesson).toBe('Linear API rejected the comment');
  });

  // Review round 3, IMPORTANT 1 regression: journalBlocker's deferral must recognize ANY
  // self-authored outcome word — submit_journal's documented contract allows action-specific
  // ones (code.fix-ci's 'unfixable', code.fix-pr-comment's 'failed'/'conflicted',
  // code.resolve-conflicts's 'unresolvable') — not just the literal string 'blocked'.
  // Narrowing the dedupe to an exact 'blocked' match would silently duplicate a real
  // self-reported lesson under any other outcome word.
  it('journalBlocker defers to a self-authored lesson under any outcome word, not just "blocked"', async () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string; jobId: string; stepId?: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: {
        append: (e: never) => { journalled.push(e); return e; },
        recent: () => journalled,
        hasEntryForStep: (
          action: string, jobId: string, stepId?: string,
          opts: { outcome?: string; excludeOutcome?: string } = {},
        ) => journalled.some((e) => e.action === action && e.jobId === jobId
          && (!e.stepId || !stepId || e.stepId === stepId)
          && (opts.outcome === undefined || e.outcome === opts.outcome)
          && (opts.excludeOutcome === undefined || e.outcome !== opts.excludeOutcome)),
      },
    });
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);

    // The action self-journaled via submit_journal with its own outcome word before
    // calling submit_step_failed — journalBlocker's backstop must defer to it.
    journalled.push({ action: 'code.fix-ci', jobId, stepId: 'g1', outcome: 'unfixable', lesson: 'root cause is upstream' });

    engine.onStepFailed(jobId, 'g1', 'gave up after 3 attempts');

    expect(journalled).toHaveLength(1);
  });

  // Review round 3, "also add the missing test": the round-2 dispatch-attribution test
  // called engine.journalGatedDenial directly with a hand-supplied action string, bypassing
  // the hook layer entirely. This drives the REAL handleHook for a dispatch session, wired
  // exactly like daemon.ts wires it (actionForSession/gatedForAction/pinFor/onGatedDenial
  // all backed by the same engine), so the child-action attribution is proven end to end
  // rather than assumed.
  it('handleHook journals a dispatch\'s gated denial against the CHILD action end to end', async () => {
    const journalled: Array<{ action: string; outcome: string; lesson: string; stepId?: string }> = [];
    const { engine, queue } = makeEngine({
      journalStore: {
        append: (e: never) => { journalled.push(e); return e; },
        recent: () => [],
        hasEntryForStep: () => false,
      },
    });
    const dispSessionId = 'sess-dA';
    const jobId = seedOrchestratedJob(queue, engine, [orchestratedStep('o1', 'code.orchestrate-pr', [
      { id: 'dA', action: 'code.merge-pr', brief: 'b', status: 'running', sessionId: dispSessionId, attempts: 1 },
    ])]);
    engine.rehydrateSessionBindings();

    // An approved draft exists for the dispatch, but authorizes a DIFFERENT push than the
    // one the child attempts below — draftStateFor resolves 'approved' with no matching pin,
    // which is a journal-worthy state (review round 2's "ALSO" narrowing).
    const approvedCall = { id: 'c1', label: 'push', bash: 'git push origin other-branch' };
    engine.onWriteDraftReady(jobId, 'o1', {
      action: 'code.merge-pr', raisedBy: { kind: 'dispatch', dispatchId: 'dA' }, summary: 's', calls: [approvedCall],
    });
    const draftId = orchestratedStepOf(queue, jobId, 'o1').drafts!.find((d) => !d.approvedAt)!.id;
    await engine.acceptDraft(jobId, 'o1', draftId, [approvedCall]);
    await Promise.resolve(); await Promise.resolve();

    const modes = new ApprovalModeStore();
    modes.set(dispSessionId, 'ask');
    const result = await handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: dispSessionId },
      allowlist: { allows: () => true } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      actionForSession: (id) => engine.actionForSession(id),
      gatedForAction: (name) => gatedAllowlistFor(name),
      pinFor: (sid, tool, input) => engine.pinFor(sid, tool, input),
      onPinConsumed: (sid, callId) => engine.consumePin(sid, callId),
      draftStateFor: (sid) => engine.draftStateFor(sid),
      onGatedDenial: (sid, action, reason) => engine.journalGatedDenial(sid, action, reason),
      onNotify: () => {},
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(journalled).toHaveLength(1);
    expect(journalled[0]!.action).toBe('code.merge-pr');   // the child, not code.orchestrate-pr
    expect(journalled[0]!.outcome).toBe('gated_denied');
    expect(journalled[0]!.stepId).toBe('dA');              // the dispatch's own id, not 'o1'
  });
});

// Round 3, IMPORTANT 2: releaseConsumedPin has no payload fallback anymore (see the
// `releaseConsumedPin` tests above) — onPinConsumed forwarding hookInput.tool_use_id is now
// the ONLY seam that supplies a pin's consumedToolUseId. If a future edit dropped that third
// argument (easy to do quietly, the way the OTHER handleHook wiring in this file and in
// hook-gated-pin.test.ts drops it), every real PostToolUseFailure would find a consumed pin
// with no id and release nothing — a silent, fully-green no-op, exactly the round-0 failure
// mode relocated to a new seam. This drives the REAL handleHook end to end, not a stub, so
// that seam is proven rather than assumed.
describe('WriteDraft — handleHook forwards tool_use_id into onPinConsumed', () => {
  it('a hookInput carrying tool_use_id ends up as consumedToolUseId on the pin it allowed', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [{ id: 'c1', bash: 'git push origin fix' }];
    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls,
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);
    await Promise.resolve();

    const modes = new ApprovalModeStore();
    modes.set(sid, 'ask');
    const result = await handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: sid, tool_use_id: 'tu-1' },
      allowlist: { allows: () => true } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      actionForSession: (id) => engine.actionForSession(id),
      gatedForAction: (name) => gatedAllowlistFor(name),
      pinFor: (s, tool, input) => engine.pinFor(s, tool, input),
      onPinConsumed: (s, callId, toolUseId) => engine.consumePin(s, callId, toolUseId),
      draftStateFor: (s) => engine.draftStateFor(s),
      onGatedDenial: () => {},
      onNotify: () => {},
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    const draft = stepOf(queue, jobId, 'g1').drafts![0]!;
    expect(draft.calls.find((c) => c.id === 'c1')!.consumedToolUseId).toBe('tu-1');
  });
});

// The pin covers command TEXT (`--input /tmp/x.json`), not the file's content — a session
// could rewrite the file after approval and the command-text match would never notice. These
// exercise the daemon-side half: acceptDraft hashes the file the user actually approved,
// and the hook re-verifies it before ever consuming the pin.
describe('WriteDraft — file-referencing payload pinning (content digest)', () => {
  // The shared gatedAllowlistFor's `^git push` pattern doesn't cover `gh api ... --input`,
  // which is the exact shape these tests need gated — scoped to this describe block rather
  // than widening the fixture every other test in the file also uses.
  function runHook(engine: WorkEngine, sid: string, command: string) {
    const modes = new ApprovalModeStore();
    modes.set(sid, 'ask');
    return handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command }, session_id: sid, tool_use_id: 'tu-1' },
      allowlist: { allows: () => true } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      actionForSession: (id) => engine.actionForSession(id),
      gatedForAction: () => ({
        alwaysAllow: [], alwaysAllowBashPatterns: ['^git push', '^gh api '],
        alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
      }),
      pinFor: (s, tool, input) => engine.pinFor(s, tool, input),
      onPinConsumed: (s, callId, toolUseId) => engine.consumePin(s, callId, toolUseId),
      draftStateFor: (s) => engine.draftStateFor(s),
      onGatedDenial: () => {},
      onNotify: () => {},
    });
  }

  it('acceptDraft computes a digest, and an unchanged file verifies and consumes the pin', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const filePath = join(dir, 'review.json');
    writeFileSync(filePath, '{"body":"looks good"}');
    const command = `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}`;
    const calls = [{ id: 'c1', bash: command }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    const pinnedCall = stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!;
    expect(pinnedCall.fileDigests?.[filePath]).toBeTruthy();

    const result = await runHook(engine, sid, command);
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!.consumedAt).toBeDefined();
  });

  it('a file rewritten after approval fails verification and the pin is not consumed', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const filePath = join(dir, 'review.json');
    writeFileSync(filePath, '{"body":"looks good"}');
    const command = `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}`;
    const calls = [{ id: 'c1', bash: command }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    // The command text is identical — only the file's content changed since approval.
    writeFileSync(filePath, '{"body":"actually something else entirely"}');

    const result = await runHook(engine, sid, command);
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/changed since the draft was approved/);
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!.consumedAt).toBeUndefined();
  });

  it('a missing file at accept time refuses the accept instead of storing an unverifiable digest', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const filePath = join(dir, 'never-written.json');
    const calls = [{ id: 'c1', bash: `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}` }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;
    const result = await engine.acceptDraft(jobId, 'g1', draftId, calls);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not exist/);
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.approvedAt).toBeUndefined();
  });

  it('a file reference the daemon cannot confidently parse refuses the accept', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const calls = [{ id: 'c1', bash: 'gh api --method POST repos/o/r/pulls/1/reviews --input $FILE' }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;
    const result = await engine.acceptDraft(jobId, 'g1', draftId, calls);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cannot confidently identify/);
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.approvedAt).toBeUndefined();
  });

  it('a call with no file reference at all is unaffected — no fileDigests, ordinary pin', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const calls = [{ id: 'c1', bash: 'git push origin fix' }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    expect(stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!.fileDigests).toBeUndefined();
    expect(engine.pinFor(sid, 'Bash', { command: 'git push origin fix' })?.id).toBe('c1');
  });

  // Post-merge review IMPORTANT: raw-text flag scanning read `--input` inside this exact
  // commit-message quote as a real flag and refused the accept outright — `code.fix-ci`
  // routinely drafts commit messages that mention these flag names, so this was not a
  // contrived input. End-to-end proof the draft is fully approvable, not just that
  // extractFileReferences alone stops flagging it.
  it('a commit message merely mentioning --input approves and pins normally', async () => {
    const { engine, queue } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const sid = stepOf(queue, jobId, 'g1').sessionId!;
    const command = 'git commit -m "handle --input flag"';
    const calls = [{ id: 'c1', bash: command }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    const result = await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    expect(result.ok).toBe(true);
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!.fileDigests).toBeUndefined();
    expect(engine.pinFor(sid, 'Bash', { command })?.id).toBe('c1');
  });
});

// The payload is now editable INLINE in the approval card, not just hashed off whatever the
// session already wrote to disk: `PinnedCall.files` (path -> content) lets the user's edit
// reach the file the daemon is about to pin. These exercise acceptDraft's own half of that —
// write the (possibly edited) body, THEN digest what was actually written, never the stale
// on-disk bytes from before the edit.
describe('WriteDraft — inline editable payload (files)', () => {
  it('accept writes the submitted content to disk and digests those exact bytes', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const filePath = join(dir, 'review.json');
    // Nothing on disk yet at all — proves the daemon is the one creating it from `files`, not
    // re-reading a copy the session wrote itself.
    const command = `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}`;
    const calls = [{ id: 'c1', bash: command, files: { [filePath]: '{"body":"drafted"}' } }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    const result = await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    expect(result.ok).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('{"body":"drafted"}');
    const pinnedCall = stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!;
    expect(pinnedCall.files).toBeUndefined(); // the pin is the digest, not a second copy of the body
    expect(pinnedCall.fileDigests?.[filePath]).toBeTruthy();
  });

  it('accept overwrites stale on-disk content with the edited body before digesting', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const filePath = join(dir, 'review.json');
    writeFileSync(filePath, '{"body":"the session\'s original draft"}');
    const command = `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}`;
    // The user edited the body in the approval card before accepting — this is what must win.
    const calls = [{ id: 'c1', bash: command, files: { [filePath]: '{"body":"the user\'s edit"}' } }];

    engine.onWriteDraftReady(jobId, 'g1', {
      action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's',
      calls: [{ id: 'c1', bash: command }],
    });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    expect(readFileSync(filePath, 'utf8')).toBe('{"body":"the user\'s edit"}');
    const pinnedCall = stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!;
    const { hashFileContents } = await import('../../src/work/write-draft.js');
    expect(pinnedCall.fileDigests?.[filePath]).toBe(await hashFileContents(filePath));
  });

  it('a call with no files entry still digests whatever is already on disk (backward compat)', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    const filePath = join(dir, 'review.json');
    writeFileSync(filePath, '{"body":"written by the session itself, the old way"}');
    const command = `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}`;
    const calls = [{ id: 'c1', bash: command }]; // no `files` at all

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    await engine.acceptDraft(jobId, 'g1', stepOf(queue, jobId, 'g1').drafts![0]!.id, calls);

    const { hashFileContents } = await import('../../src/work/write-draft.js');
    const pinnedCall = stepOf(queue, jobId, 'g1').drafts![0]!.calls[0]!;
    expect(pinnedCall.fileDigests?.[filePath]).toBe(await hashFileContents(filePath));
    expect(readFileSync(filePath, 'utf8')).toBe('{"body":"written by the session itself, the old way"}');
  });

  it('a write failure refuses the accept instead of pinning a payload that never reached disk', async () => {
    const { engine, queue, dir } = makeEngine();
    const jobId = seedJob(queue, engine, [actionStep('g1', 'code.fix-ci')]);
    await engine.tick(jobId);
    // The parent directory doesn't exist — writeFile doesn't mkdir -p, so this fails closed.
    const filePath = join(dir, 'no-such-subdir', 'review.json');
    const command = `gh api --method POST repos/o/r/pulls/1/reviews --input ${filePath}`;
    const calls = [{ id: 'c1', bash: command, files: { [filePath]: '{"body":"x"}' } }];

    engine.onWriteDraftReady(jobId, 'g1', { action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 's', calls });
    const draftId = stepOf(queue, jobId, 'g1').drafts![0]!.id;
    const result = await engine.acceptDraft(jobId, 'g1', draftId, calls);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/could not write/);
    expect(stepOf(queue, jobId, 'g1').drafts![0]!.approvedAt).toBeUndefined();
  });
});
