import { describe, expect, it } from 'vitest';
import { orchestratedHandler } from '../../src/steps/orchestrated.js';
import { MAX_ROUNDS } from '../../src/steps/orchestrated-policy.js';
import type { HandlerCtx } from '../../src/steps/types.js';
import type { InboxItem, JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

const ctx: HandlerCtx = { jobsDir: '/tmp/jobs', newId: () => 'id', now: () => 500 };

function step(over: Partial<OrchestratedStep> = {}): OrchestratedStep {
  return {
    id: 's1', title: 't', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'running', createdAt: 0, updatedAt: 0, ...over,
  } as OrchestratedStep;
}

const job = (s: OrchestratedStep): JobRecord => ({
  id: 'j1', source: 'manual', title: 'J', description: 'D', state: 'executing',
  steps: [s], createdAt: 0, updatedAt: 0,
});

const msg: InboxItem = { id: 'i1', at: 100, kind: 'user-message', body: 'go' };

describe('orchestratedHandler.isResolved', () => {
  it('is resolved only in the resolved state', () => {
    expect(orchestratedHandler.isResolved(step({ state: 'resolved' }))).toBe(true);
    for (const state of ['running', 'waiting', 'gate_pending_approval', 'failed'] as const) {
      expect(orchestratedHandler.isResolved(step({ state }))).toBe(false);
    }
  });
});

describe('orchestratedHandler.decide', () => {
  it('spawns the controller on a fresh step', () => {
    const s = step();
    expect(orchestratedHandler.decide(s, job(s), ctx)).toMatchObject({
      kind: 'spawn-session', jobId: 'j1', stepId: 's1',
    });
  });

  it('does nothing once a session exists and the inbox is empty', () => {
    const s = step({ sessionId: 'sess1' });
    expect(orchestratedHandler.decide(s, job(s), ctx)).toBeNull();
  });

  it('asks for inbox delivery when a live step has queued items', () => {
    const s = step({ sessionId: 'sess1', state: 'waiting', inbox: [msg] });
    expect(orchestratedHandler.decide(s, job(s), ctx)).toEqual({
      kind: 'deliver-inbox', jobId: 'j1', stepId: 's1',
    });
  });

  it('fires the timer when a soak elapses', () => {
    const s = step({ sessionId: 'sess1', state: 'waiting', waitingOn: { reason: 'soak', resumeAt: 400 } });
    expect(orchestratedHandler.decide(s, job(s), ctx)).toEqual({
      kind: 'deliver-inbox', jobId: 'j1', stepId: 's1',
    });
  });

  it('stays quiet on a gate, a cancel, and terminal states', () => {
    expect(orchestratedHandler.decide(
      step({ sessionId: 'x', state: 'gate_pending_approval' }), job(step()), ctx)).toBeNull();
    expect(orchestratedHandler.decide(step({ cancelled: true }), job(step()), ctx)).toBeNull();
    expect(orchestratedHandler.decide(step({ state: 'resolved' }), job(step()), ctx)).toBeNull();
    expect(orchestratedHandler.decide(step({ state: 'failed' }), job(step()), ctx)).toBeNull();
  });
});

describe('orchestratedHandler.buildEnvelope', () => {
  it('carries controller identity, memo, artifacts, and the round budget', () => {
    const s = step({
      memo: 'what I know', artifacts: { spec: '# Spec' }, phase: 'implement', roundsSpent: 5,
    });
    const env = orchestratedHandler.buildEnvelope(s, job(s), ctx) as Record<string, unknown>;
    expect(env).toMatchObject({
      kind: 'step', type: 'orchestrated', controller: 'code.orchestrate-pr',
      memo: 'what I know', phase: 'implement',
    });
    expect(env.artifacts).toEqual({ spec: '# Spec' });
    expect(env.roundsRemaining).toBe(MAX_ROUNDS - 5);
  });

  it('summarises dispatches without leaking runtime plumbing', () => {
    const s = step({
      dispatches: [{
        id: 'd1', action: 'code.review-diff', brief: 'b', status: 'done',
        output: 'findings', attempts: 1, sessionId: 'secret', startedAt: 1,
      }],
    });
    const env = orchestratedHandler.buildEnvelope(s, job(s), ctx) as { dispatches: Array<Record<string, unknown>> };
    expect(env.dispatches[0]).toEqual({
      id: 'd1', action: 'code.review-diff', brief: 'b', status: 'done', output: 'findings',
    });
  });

  // resolveGate clears the inbox and runs the deferred move, so the approval leaves no
  // gate-resolved item behind — without these fields the controller's only clue is its own memo,
  // which is empty on a migrated job.
  it('carries the gate verdict so an approval is detectable without the memo', () => {
    const s = step({ gateApproved: true, gateFeedback: ['tighten the spec'] });
    const env = orchestratedHandler.buildEnvelope(s, job(s), ctx) as Record<string, unknown>;
    expect(env.gateApproved).toBe(true);
    expect(env.gateFeedback).toEqual(['tighten the spec']);
  });

  it('omits the gate verdict while no gate has been resolved', () => {
    const env = orchestratedHandler.buildEnvelope(step(), job(step()), ctx) as Record<string, unknown>;
    expect(env).not.toHaveProperty('gateApproved');
    expect(env).not.toHaveProperty('gateFeedback');
  });

  // Turn 1 is a cold spawn — it goes through this envelope, not the resume path. The SKILL
  // leans on both fields (boundAction says which hat the controller wears, actionCatalog is
  // how it learns what it may dispatch), so omitting them left the first turn blind.
  it('carries boundAction and the action catalog on the cold-spawn turn', () => {
    const actionRegistry = {
      listActions: () => [{
        name: 'code.review-diff',
        frontmatter: {
          description: 'review a diff',
          outpost: { kind: 'action', category: 'code', runner: 'claude', side_effects: 'none' },
        },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }],
    } as unknown as NonNullable<HandlerCtx['actionRegistry']>;
    const s = step();
    const env = orchestratedHandler.buildEnvelope(s, job(s), { ...ctx, actionRegistry }) as Record<string, unknown>;
    expect(env.boundAction).toBe('code.orchestrate-pr');
    expect(env.actionCatalog).toEqual([{
      name: 'code.review-diff', description: 'review a diff', kind: 'action', category: 'code',
      runner: 'claude', side_effects: 'none', human_gate: false,
      input_schema: { type: 'object' }, output_schema: { type: 'object' },
    }]);
  });

  it('omits the action catalog when no registry is wired', () => {
    const env = orchestratedHandler.buildEnvelope(step(), job(step()), ctx) as Record<string, unknown>;
    expect(env).not.toHaveProperty('actionCatalog');
  });
});
