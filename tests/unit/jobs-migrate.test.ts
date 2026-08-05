import { describe, expect, it } from 'vitest';
import { migrateJob, migrateOpenPrStep } from '../../src/storage/jobs-migrate.js';
import type { JobRecord, OpenPrStep, OrchestratedStep } from '../../src/work/work-types.js';

function legacy(over: Partial<OpenPrStep> = {}): OpenPrStep {
  return {
    id: 's1', title: 'Ship it', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/repo', branch: 'fix/x' },
    goal: 'g', approach: 'a', state: 'pr_open',
    createdAt: 1, updatedAt: 2, ...over,
  } as OpenPrStep;
}

describe('migrateOpenPrStep', () => {
  it('becomes an orchestrated step driven by code.orchestrate-pr', () => {
    const s = migrateOpenPrStep(legacy());
    expect(s.type).toBe('orchestrated');
    expect(s.controller).toBe('code.orchestrate-pr');
    expect(s.dispatches).toEqual([]);
    expect(s.inbox).toEqual([]);
    expect(s.roundsSpent).toBe(0);
    expect(s.consecutiveSelfRounds).toBe(0);
  });

  it('moves watcher facts under pr and off the top level', () => {
    const s = migrateOpenPrStep(legacy({
      prUrl: 'https://github.com/o/r/pull/7', prState: 'open', ciState: 'failure',
      reviewState: 'review_required', mergeable: 'mergeable',
      ciChecks: [{ name: 'test', state: 'failure' }],
    }));
    expect(s.pr).toMatchObject({
      prUrl: 'https://github.com/o/r/pull/7', prState: 'open', ciState: 'failure',
      reviewState: 'review_required', mergeable: 'mergeable',
    });
    expect(s.pr?.ciChecks).toEqual([{ name: 'test', state: 'failure' }]);
    expect((s as unknown as Record<string, unknown>).prUrl).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).ciState).toBeUndefined();
  });

  it('promotes spec and implPlan into artifacts', () => {
    const s = migrateOpenPrStep(legacy({ spec: '# S', implPlan: '# P' }));
    expect(s.artifacts).toEqual({ spec: '# S', implPlan: '# P' });
    expect((s as unknown as Record<string, unknown>).spec).toBeUndefined();
  });

  it('omits artifacts entirely when there were none', () => {
    expect(migrateOpenPrStep(legacy()).artifacts).toBeUndefined();
  });

  it('parks an open PR in waiting, watching all four PR signals', () => {
    const s = migrateOpenPrStep(legacy({ state: 'pr_open' }));
    expect(s.state).toBe('waiting');
    expect(s.phase).toBe('pr_open');
    expect(s.waitingOn?.events).toEqual(['ci', 'review-state', 'pr-state', 'pr-comments']);
    expect(s.waitingOn?.reason).toBeTruthy();
  });

  it('maps every legacy state to the right resting place', () => {
    const cases: Array<[OpenPrStep['state'], OrchestratedStep['state'], string]> = [
      ['speccing', 'running', 'spec'],
      ['spec_pending_review', 'running', 'spec'],
      ['planning', 'running', 'plan'],
      ['implementing', 'running', 'implement'],
      ['comment_pending_response', 'running', 'pr_comments'],
      ['reply_pending_review', 'running', 'pr_comments'],
      ['conflicting', 'running', 'conflict'],
      ['conflict_unresolved', 'failed', 'conflict'],
      ['merged', 'resolved', 'merged'],
      ['failed', 'failed', 'failed'],
    ];
    for (const [legacyState, expected, phase] of cases) {
      const s = migrateOpenPrStep(legacy({ state: legacyState }));
      expect(s.state, legacyState).toBe(expected);
      expect(s.phase, legacyState).toBe(phase);
    }
  });

  it('drops the deleted control fields', () => {
    const s = migrateOpenPrStep(legacy({
      ciFixing: true, ciFixAttempts: 2, ciFixLastSignature: 'a|b', ciFixGaveUp: true,
      conflictResolving: true, conflictPostAction: 'squash-to-base',
    }));
    for (const k of ['ciFixing', 'ciFixAttempts', 'ciFixLastSignature', 'ciFixGaveUp',
                     'conflictResolving', 'conflictPostAction', 'editQueue']) {
      expect((s as unknown as Record<string, unknown>)[k], k).toBeUndefined();
    }
  });

  it('preserves identity, session, events, and the thread shapes the PWA renders', () => {
    const s = migrateOpenPrStep(legacy({
      sessionId: 'sess1', reviewed: true,
      events: [{ id: 'e1', at: 5, kind: 'spawned', who: 'orchestrator' }],
      iterations: [{ id: 'it1', kind: 'replies', status: 'approved', startedAt: 3 }],
      draftedReplies: [{ commentId: 'c1', recommendation: 'reply', rationale: 'r', draftReply: 'd' }],
    }));
    expect(s.id).toBe('s1');
    expect(s.sessionId).toBe('sess1');
    expect(s.reviewed).toBe(true);
    expect(s.createdAt).toBe(1);
    expect(s.events).toHaveLength(1);
    expect(s.iterations).toHaveLength(1);
    expect(s.draftedReplies).toHaveLength(1);
  });
});

describe('migrateJob', () => {
  const job = (steps: JobRecord['steps']): JobRecord => ({
    id: 'j1', source: 'manual', title: 'J', description: 'D', state: 'executing',
    steps, createdAt: 0, updatedAt: 0,
  });

  it('migrates open-pr steps and leaves others untouched', () => {
    const action = {
      id: 's2', title: 'Look', description: 'd', type: 'action' as const,
      workspace: { kind: 'none' as const }, action: 'read.investigate', goal: 'g',
      state: 'resolved' as const, createdAt: 0, updatedAt: 0,
    };
    const out = migrateJob(job([legacy(), action]));
    expect(out.steps[0]!.type).toBe('orchestrated');
    expect(out.steps[1]).toEqual(action);
  });

  it('is idempotent', () => {
    const once = migrateJob(job([legacy()]));
    expect(migrateJob(once)).toEqual(once);
  });
});
