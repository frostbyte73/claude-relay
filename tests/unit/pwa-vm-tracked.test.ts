import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { trackedGroups, focusAction, launchBadge, jobLaunchBadge, stepLaunchBadge, isHighPriority } from '../../src/pwa/vm/tracked.js';

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
      steps: [{ id: 's1', type: 'open-pr', state: 'implementing', sessionId: 'a' }], live: live(false, ['s1']) }];
    expect(trackedGroups(jobs).running.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('implementing with a DEAD session -> needs you (diff awaiting push)', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'open-pr', state: 'implementing', sessionId: 'a' }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.needsYou.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.running).toEqual([]);
  });

  it('reply drafts ready -> needs you', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'open-pr', state: 'reply_pending_review' }], live: live(false, []) }];
    expect(trackedGroups(jobs).needsYou.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('merge-ready (approved + green) -> needs you', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'open-pr', state: 'pr_open', reviewState: 'approved', ciState: 'success' }], live: live(false, []) }];
    expect(trackedGroups(jobs).needsYou.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('comment_pending_response with no live session -> waiting (Outpost will triage)', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'open-pr', state: 'comment_pending_response' }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.waiting.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });

  it('PR open, CI pending, not approved -> waiting', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'open-pr', state: 'pr_open', ciState: 'pending', reviewState: 'review_required' }], live: live(false, []) }];
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
    // s1 merge-ready (needs you), s2 still implementing live -> job shows as running.
    const jobs = [{ id: 'j1', state: 'executing', steps: [
      { id: 's1', type: 'open-pr', state: 'pr_open', reviewState: 'approved', ciState: 'success' },
      { id: 's2', type: 'open-pr', state: 'implementing', sessionId: 'a' },
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

  it('reply_pending_review -> review replies', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Handle PR feedback', type: 'open-pr', state: 'reply_pending_review' }], live: live(false, []) });
    expect(a.cta.action).toBe('review-replies');
    expect(a.description).toContain('Handle PR feedback');
  });

  it('merge-ready -> review diff', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Ship it', type: 'open-pr', state: 'pr_open', reviewState: 'approved', ciState: 'success' }], live: live(false, []) });
    expect(a.cta.action).toBe('review-diff');
  });

  it('implementing with a dead session -> review diff & push', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Add feature', type: 'open-pr', state: 'implementing', sessionId: 'a' }], live: live(false, []) });
    expect(a.cta.action).toBe('review-diff');
    expect(a.description).toContain('Add feature');
  });

  it('a live running step -> watch', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Working', sessionId: 'sess1', state: 'implementing' }], live: live(false, ['s1']) });
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
