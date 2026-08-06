import { describe, expect, it } from 'vitest';
import { migrateJob, migrateOpenPrStep } from '../../src/storage/jobs-migrate.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';

// The `open-pr` step type no longer exists in the live type system — these are raw persisted
// records, which is exactly the shape migrateOpenPrStep reads.
type LegacyRecord = Record<string, unknown>;

function legacy(over: LegacyRecord = {}): LegacyRecord {
  return {
    id: 's1', title: 'Ship it', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/repo', branch: 'fix/x' },
    goal: 'g', approach: 'a', state: 'pr_open',
    createdAt: 1, updatedAt: 2, ...over,
  };
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
    const cases: Array<[string, OrchestratedStep['state'], string]> = [
      ['speccing', 'running', 'spec'],
      ['spec_pending_review', 'running', 'spec'],
      ['planning', 'running', 'spec'],       // never-dispatched: rewound to the spec phase
      ['implementing', 'running', 'spec'],   // never-dispatched: rewound to the spec phase
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

  // Moved from work-queue-migrate: pre-spec-flow records were materialized straight into
  // 'implementing', so a never-dispatched one must not arrive as an implement-phase step.
  it('rewinds a never-dispatched implementing/planning record to the spec phase', () => {
    for (const state of ['implementing', 'planning']) {
      const s = migrateOpenPrStep(legacy({ state }));
      expect(s.phase, state).toBe('spec');
      expect(s.state, state).toBe('running');
    }
  });

  it('leaves a genuinely-dispatched implementing record in the implement phase', () => {
    expect(migrateOpenPrStep(legacy({ state: 'implementing', sessionId: 'sess' })).phase).toBe('implement');
    expect(migrateOpenPrStep(legacy({ state: 'implementing', prUrl: 'http://x' })).phase).toBe('implement');
    expect(migrateOpenPrStep(legacy({ state: 'implementing', cancelled: true })).phase).toBe('implement');
    expect(migrateOpenPrStep(legacy({ state: 'implementing', spec: '# s' })).phase).toBe('implement');
  });

  it('lands an unrecognized state in Needs-you rather than leaving it undefined', () => {
    // A hand-edited or corrupt record. `state: undefined` is unrecoverable — nothing in the
    // engine can act on it — where a `failed` step can at least be retried or edited.
    const s = migrateOpenPrStep(legacy({ state: 'who-knows' }));
    expect(s.state).toBe('failed');
    expect(s.phase).toBe('failed');
  });

  // `state: 'failed'` with no `.failure` is inert in every direction: decide() ignores it, the
  // pr-watcher skips it, decideJobTransitions keys job failure on `.failure`, and the cockpit's
  // "Job failed → Retry" card keys on it too. The job stalls with nothing to click.
  it('gives every failed landing a .failure so the user has a way out', () => {
    const conflict = migrateOpenPrStep(legacy({ state: 'conflict_unresolved', updatedAt: 42 }));
    expect(conflict.state).toBe('failed');
    expect(conflict.failure?.reason).toMatch(/conflict/i);
    expect(conflict.failure?.at).toBe(42);

    const unknown = migrateOpenPrStep(legacy({ state: 'who-knows' }));
    expect(unknown.state).toBe('failed');
    expect(unknown.failure?.reason).toMatch(/who-knows/);
  });

  it('keeps the record\'s own failure when it already had one', () => {
    const s = migrateOpenPrStep(legacy({ state: 'failed', failure: { reason: 'CI never went green', at: 9 } }));
    expect(s.failure).toEqual({ reason: 'CI never went green', at: 9 });
  });

  it('omits inputs.approach entirely when the legacy record had none', () => {
    const s = migrateOpenPrStep(legacy({ approach: undefined }));
    expect(s.inputs && 'approach' in s.inputs).toBe(false);
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

  const job2 = (steps: LegacyRecord[]): JobRecord =>
    ({ id: 'j1', source: 'manual', title: 'J', description: 'D', state: 'executing',
       steps, createdAt: 0, updatedAt: 0 } as unknown as JobRecord);

  it('migrates open-pr steps and leaves others untouched', () => {
    const action = {
      id: 's2', title: 'Look', description: 'd', type: 'action' as const,
      workspace: { kind: 'none' as const }, action: 'read.investigate', goal: 'g',
      state: 'resolved' as const, createdAt: 0, updatedAt: 0,
    };
    const out = migrateJob(job2([legacy(), action]));
    expect(out.steps[0]!.type).toBe('orchestrated');
    expect(out.steps[1]).toEqual(action);
  });

  it('is idempotent', () => {
    const once = migrateJob(job2([legacy()]));
    expect(migrateJob(once)).toEqual(once);
  });
});
