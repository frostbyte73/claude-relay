import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { trackedGroups, focusAction, launchBadge, jobLaunchBadge, stepLaunchBadge, isHighPriority, orchestratedRows } from '../../src/pwa/vm/tracked.js';

const live = (orchestrator: boolean, stepIds: string[] = []) => ({ orchestrator, stepIds });

describe('trackedGroups', () => {
  it('backlog = planning job never launched (no orchestrator session, no steps)', () => {
    const jobs = [{ id: 'j1', state: 'planning', steps: [] }];
    expect(trackedGroups(jobs).backlog.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('running = live orchestrator session', () => {
    const jobs = [{ id: 'j1', state: 'planning', orchestratorSessionId: 'o', steps: [], live: live(true) }];
    expect(trackedGroups(jobs).running.map((j: any) => j.id)).toEqual(['j1']);
    expect(trackedGroups(jobs).backlog).toEqual([]);
  });

  it('running = a step with a live session', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' }], live: live(false, ['s1']) }];
    expect(trackedGroups(jobs).running.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('implement phase with a DEAD session -> needs you (diff awaiting push)', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.needsYou.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.running).toEqual([]);
  });

  it('a gated controller move -> needs you', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'gate_pending_approval' }], live: live(false, []) }];
    expect(trackedGroups(jobs).needsYou.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('merge-ready (approved + green) -> waiting, not needs-you', () => {
    // Merging is the controller's move; the user's turn arrives when the policy
    // force-gates it (state -> gate_pending_approval), not before.
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
        pr: { reviewState: 'approved', ciState: 'success' } }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.waiting.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });

  it('a controller chewing on PR comments with no live session -> waiting (Outpost will triage)', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'pr_comments' }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.waiting.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });

  it('PR open, CI pending, not approved -> waiting', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
        pr: { ciState: 'pending', reviewState: 'review_required' } }], live: live(false, []) }];
    expect(trackedGroups(jobs).waiting.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('failed -> needs you; done/abandoned -> done', () => {
    const jobs = [
      { id: 'j1', state: 'failed', steps: [{ id: 's1', failure: { reason: 'boom' } }], live: live(false, []) },
      { id: 'j2', state: 'done', steps: [] },
      { id: 'j3', state: 'abandoned', steps: [] },
    ];
    const g = trackedGroups(jobs);
    expect(g.needsYou.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.done.map((j: any) => j.id).sort()).toEqual(['j2', 'j3']);
  });

  it('running is evaluated before needs-you when both apply', () => {
    // s1 parked on a gate (needs you), s2 still implementing live -> job shows as running.
    const jobs = [{ id: 'j1', state: 'executing', steps: [
      { id: 's1', type: 'orchestrated', state: 'gate_pending_approval', phase: 'pr_open' },
      { id: 's2', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' },
    ], live: live(false, ['s2']) }];
    const g = trackedGroups(jobs);
    expect(g.running.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });
});

describe('focusAction', () => {
  it('plan_pending_review -> review plan', () => {
    const a = focusAction({ id: 'j1', state: 'plan_pending_review', steps: [{ id: 's1' }, { id: 's2' }] });
    expect(a.cta.action).toBe('review-plan');
  });

  it('a gated controller move -> review gate, described by its question', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Handle PR feedback', type: 'orchestrated', state: 'gate_pending_approval',
        gate: { question: 'Merge this PR?' } }], live: live(false, []) });
    expect(a.cta.action).toBe('review-gate');
    expect(a.description).toBe('Merge this PR?');
  });

  it('merge-ready -> no action; the job is waiting on the controller to gate the merge', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Ship it', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
        pr: { reviewState: 'approved', ciState: 'success' } }], live: live(false, []) });
    expect(a.cta.action).toBe('none');
    expect(a.title).toBe('Waiting');
  });

  it('an indefinite meta.wait hold -> resume', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Soak', type: 'action', state: 'waiting', inputs: { reason: 'Let the canary bake' } }],
      live: live(false, []) });
    expect(a.cta.action).toBe('resume-wait');
    expect(a.description).toBe('Let the canary bake');
  });

  it('implement phase with a dead session -> review diff & push', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Add feature', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' }], live: live(false, []) });
    expect(a.cta.action).toBe('review-diff');
    expect(a.description).toContain('Add feature');
  });

  it('a live running step -> watch', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Working', sessionId: 'sess1', state: 'running' }], live: live(false, ['s1']) });
    expect(a.cta.action).toBe('watch');
  });

  it('failed job -> retry', () => {
    const a = focusAction({ id: 'j1', state: 'failed',
      steps: [{ id: 's1', title: 'Broken', failure: { reason: 'boom', at: 1 } }], live: live(false, []) });
    expect(a.cta.action).toBe('retry');
    expect(a.description).toBe('boom');
  });

  it('done job -> no action', () => {
    const a = focusAction({ id: 'j1', state: 'done', steps: [] });
    expect(a.cta.action).toBe('none');
  });
});

describe('orchestratedRows', () => {
  const step = (o = {}) => ({
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Ship it',
    state: 'running', dispatches: [], inbox: [], ...o,
  });

  it('labels a known phase and tones a merged one as done', () => {
    expect(orchestratedRows(step({ phase: 'implement' })).phaseChip).toEqual({ label: 'Implement', tone: '' });
    expect(orchestratedRows(step({ phase: 'merged', state: 'resolved' })).phaseChip)
      .toEqual({ label: 'Merged', tone: 'ok' });
  });

  it('humanizes a phase the controller coined itself', () => {
    expect(orchestratedRows(step({ phase: 'awaiting_qa' })).phaseChip)
      .toEqual({ label: 'Awaiting qa', tone: '' });
  });

  it('surfaces the wait reason only while waiting', () => {
    const waiting = { waitingOn: { reason: 'Watching CI' } };
    expect(orchestratedRows(step({ state: 'waiting', ...waiting })).waitingReason).toBe('Watching CI');
    expect(orchestratedRows(step({ state: 'running', ...waiting })).waitingReason).toBeNull();
  });

  it('tones dispatch rows by status and carries the child session', () => {
    const rows = orchestratedRows(step({ dispatches: [
      { id: 'd1', action: 'code.implement', brief: 'do it', status: 'running', sessionId: 'sess1' },
      { id: 'd2', action: 'code.fix-ci', brief: 'fix', status: 'failed', failure: 'boom' },
    ] })).dispatchRows;
    expect(rows.map((r: any) => [r.status, r.tone, r.sessionId]))
      .toEqual([['running', 'investigate', 'sess1'], ['failed', 'danger', null]]);
    expect(rows[1].failure).toBe('boom');
  });

  it('puts the memo ahead of the artifacts and labels the known keys', () => {
    const rows = orchestratedRows(step({ memo: 'where I am', artifacts: { spec: '# S', implPlan: '# P', notes: 'n' } }));
    expect(rows.artifactRows.map((a: any) => [a.key, a.label]))
      .toEqual([['memo', 'Memo'], ['spec', 'Spec'], ['implPlan', 'Implementation plan'], ['notes', 'Notes']]);
  });

  it('drops empty artifacts rather than rendering a blank disclosure', () => {
    expect(orchestratedRows(step({ artifacts: { spec: '   ' } })).artifactRows).toEqual([]);
  });

  it('slugs an artifact key into a safe CSS class token, keeping key for the label lookup', () => {
    const rows = orchestratedRows(step({
      artifacts: { 'weird key! with/slashes': 'body', '': 'body2', '!!!': 'body3' },
    })).artifactRows;
    expect(rows.map((a: any) => [a.key, a.slug])).toEqual([
      ['weird key! with/slashes', 'weird-key-with-slashes'],
      ['', 'artifact'],
      // Both empty-ish keys fall back to 'artifact'; the second is disambiguated rather
      // than sharing the first's disclosure state.
      ['!!!', 'artifact-2'],
    ]);
    // Every slug is a lone token match for the CSS class regex — no injected space, no
    // leftover punctuation that would break out of `orc-artifact-<slug>`.
    for (const a of rows) expect((a as any).slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('breaks a slug collision so two artifacts cannot share one disclosure', () => {
    // tracked/detail.js keys each <details>'s open/closed state off its className, so two
    // keys normalising to the same slug would toggle each other across repaints.
    const rows = orchestratedRows(step({
      artifacts: { notes: 'a', 'Notes!': 'b', 'NOTES': 'c' },
    })).artifactRows;
    const slugs = rows.map((a: any) => a.slug);
    expect(slugs).toEqual(['notes', 'notes-2', 'notes-3']);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('exposes the gate only while parked on it', () => {
    const gated = step({
      state: 'gate_pending_approval',
      gate: { draft: 'gh pr merge', question: 'Merge?' },
      gateFeedback: ['not yet'],
    });
    expect(orchestratedRows(gated).gate).toEqual({ draft: 'gh pr merge', question: 'Merge?', feedback: ['not yet'] });
    expect(orchestratedRows(step({ gate: { draft: 'x', question: 'y' } })).gate).toBeNull();
  });

  it('offers mark-resolved only while the step is still live', () => {
    expect(orchestratedRows(step()).canMarkResolved).toBe(true);
    expect(orchestratedRows(step({ state: 'resolved' })).canMarkResolved).toBe(false);
    expect(orchestratedRows(step({ state: 'failed' })).canMarkResolved).toBe(false);
    expect(orchestratedRows(step({ cancelled: true })).canMarkResolved).toBe(false);
  });
});

describe('launchBadge', () => {
  it('running -> Running badge', () => {
    expect(launchBadge({ state: 'running' })).toEqual({ label: 'Running', kind: 'running' });
  });

  it('queued -> Queued badge with reason', () => {
    expect(launchBadge({ state: 'queued', reason: 'no token headroom' }))
      .toEqual({ label: 'Queued — no token headroom', kind: 'queued' });
  });

  it('idle -> no badge', () => {
    expect(launchBadge({ state: 'idle' })).toBeNull();
  });

  it('absent -> no badge', () => {
    expect(launchBadge(undefined)).toBeNull();
  });
});

describe('jobLaunchBadge / stepLaunchBadge', () => {
  const job = {
    id: 'j1',
    highPriority: true,
    launchStatus: {
      job: { state: 'queued', reason: '1/1 slots busy' },
      steps: { s1: { state: 'running' }, s2: { state: 'idle' } },
    },
  };

  it('reads the job-level status', () => {
    expect(jobLaunchBadge(job)).toEqual({ label: 'Queued — 1/1 slots busy', kind: 'queued' });
  });

  it('reads a running step', () => {
    expect(stepLaunchBadge(job, 's1')).toEqual({ label: 'Running', kind: 'running' });
  });

  it('idle step -> no badge', () => {
    expect(stepLaunchBadge(job, 's2')).toBeNull();
  });

  it('unknown step -> no badge', () => {
    expect(stepLaunchBadge(job, 's-missing')).toBeNull();
  });

  it('missing launchStatus -> no badge', () => {
    expect(jobLaunchBadge({ id: 'j2' })).toBeNull();
  });

  it('isHighPriority passthrough', () => {
    expect(isHighPriority(job)).toBe(true);
    expect(isHighPriority({ id: 'j2' })).toBe(false);
  });
});
