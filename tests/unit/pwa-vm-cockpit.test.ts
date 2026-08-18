import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { cockpitInbox, stepWaitPill } from '../../src/pwa/vm/cockpit.js';

const NOW = 1_000_000_000_000;

describe('stepWaitPill', () => {
  // Critical 2: `state === 'gate_pending_approval'` alone misses a dispatch-raised draft
  // (submitDraft only flips the DISPATCH's own status, never the parent step's state) — all
  // three raiser kinds must produce the same approval CTA, not the generic "On hold" a
  // meta.wait fallback would show.
  it('an ActionStep draft (raisedBy: step) gets Approve write', () => {
    expect(stepWaitPill({
      type: 'action', state: 'gate_pending_approval',
      drafts: [{ id: 'd1', raisedBy: { kind: 'step' } }],
    })).toEqual({ label: 'Approve write', variant: 'gate' });
  });

  it('a controller-raised draft gets Approve move', () => {
    expect(stepWaitPill({
      type: 'orchestrated', state: 'gate_pending_approval',
      drafts: [{ id: 'd1', raisedBy: { kind: 'controller' } }],
    })).toEqual({ label: 'Approve move', variant: 'gate' });
  });

  it('a dispatch-raised draft gets Approve move even though the PARENT step is still waiting', () => {
    expect(stepWaitPill({
      type: 'orchestrated', state: 'waiting',
      drafts: [{ id: 'd1', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' } }],
    })).toEqual({ label: 'Approve move', variant: 'gate' });
  });

  it('an indefinite meta.wait hold (no draft) falls back to On hold', () => {
    expect(stepWaitPill({ type: 'action', state: 'waiting' })).toEqual({ label: 'On hold', variant: 'gate' });
  });
});

describe('cockpitInbox — decide', () => {
  it('is empty when nothing is parked on the user', () => {
    expect(cockpitInbox({ now: NOW })).toEqual({ decide: [], broken: [], cleared: [] });
  });

  it('includes a pending approval, pointing at its session', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      pendingApprovals: [{ approvalId: 'a1', sessionId: 'sX', toolName: 'Bash', sessionTitle: 'outpost', enqueuedAt: NOW - 1000 }],
    });
    expect(decide).toHaveLength(1);
    expect(decide[0]).toMatchObject({
      key: 'approval:a1',
      kind: 'approval',
      tone: 'hot',
      title: 'outpost',
      detail: 'Bash',
      time: NOW - 1000,
      open: { surface: 'sessions', id: 'sX' },
    });
  });

  it('includes a job awaiting plan review', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      jobs: [{ id: 'j1', title: 'Ship the thing', state: 'plan_pending_review', updatedAt: NOW - 500, steps: [] }],
    });
    expect(decide[0]).toMatchObject({
      key: 'plan:j1', kind: 'plan-review', title: 'Ship the thing', detail: 'Plan review',
      open: { surface: 'tracked', id: 'j1' },
    });
  });

  it('includes a step parked on a gate, labelled by stepWaitPill', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j2', title: 'PR job', state: 'executing', updatedAt: NOW - 2000,
        externalRef: { issueIdentifier: 'CS-1608' },
        steps: [{ id: 's1', type: 'orchestrated', state: 'gate_pending_approval', updatedAt: NOW - 100 }],
      }],
    });
    expect(decide[0]).toMatchObject({
      key: 'gate:j2:s1', kind: 'step-gate', ref: 'CS-1608', detail: 'Approve move', time: NOW - 100,
    });
  });

  // isTerminalJob: abandonJob flips job state without rewriting step states, so a dead
  // job can still hold a step that satisfies stepNeedsYou.
  it('ignores needy steps on a terminal job', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j3', title: 'Dead', state: 'abandoned', updatedAt: NOW,
        steps: [{ id: 's1', type: 'orchestrated', state: 'gate_pending_approval', updatedAt: NOW }],
      }],
    });
    expect(decide).toEqual([]);
  });

  it('includes a pending action proposal, pointing at the action in the library', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      actionEdits: [{
        sessionId: 'sess-1', actionName: 'code.implement', status: 'review', author: 'improver',
        proposal: { summary: 'Tighten the self-review step', postedAt: NOW - 7200_000 },
      }],
    });
    expect(decide[0]).toMatchObject({
      key: 'proposal:code.implement',
      kind: 'action-proposal',
      tone: 'hot',
      title: 'code.implement',
      detail: 'meta.improve-actions proposed a revision',
      time: NOW - 7200_000,
      open: { surface: 'skills', id: 'code.implement' },
    });
  });

  it('attributes a user-authored proposal differently and keys an unnamed one by session', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      actionEdits: [{
        sessionId: 'sess-2', actionName: null, status: 'review', author: 'user',
        proposal: { summary: 'New action', postedAt: NOW - 60_000 },
      }],
    });
    expect(decide[0]).toMatchObject({
      key: 'proposal:sess-2', title: 'New action', detail: 'Proposal ready for review',
      open: { surface: 'skills', id: 'new:sess-2' },
    });
  });

  it('ignores an edit that has no proposal yet', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      actionEdits: [{ sessionId: 'sess-3', actionName: 'code.plan', status: 'editing' }],
    });
    expect(decide).toEqual([]);
  });

  it('includes a pending schedule proposal', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      scheduleDrafts: new Map([['sess-4', { name: 'nightly-lint', summary: 'Runs lint at 2am' }]]),
    });
    expect(decide[0]).toMatchObject({
      key: 'sched-proposal:sess-4', kind: 'schedule-proposal', title: 'nightly-lint',
      detail: 'Schedule ready to save',
      open: { surface: 'schedules', id: '__new__:sess:sess-4' },
    });
  });

  it('includes an implement step whose session died before a PR existed', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j4', title: 'Add flag', state: 'executing', updatedAt: NOW - 300,
        live: { orchestrator: false, stepIds: [] },
        steps: [{ id: 's9', type: 'orchestrated', phase: 'implement', sessionId: 'sess-x', state: 'running', updatedAt: NOW - 300 }],
      }],
    });
    expect(decide[0]).toMatchObject({
      key: 'push:j4:s9', kind: 'awaiting-push', detail: 'Review the diff and push',
      open: { surface: 'tracked', id: 'j4' },
    });
  });

  it('sorts newest first', () => {
    const { decide } = cockpitInbox({
      now: NOW,
      pendingApprovals: [{ approvalId: 'old', sessionId: 's1', toolName: 'Bash', enqueuedAt: NOW - 9000 }],
      jobs: [{ id: 'j5', title: 'Recent', state: 'plan_pending_review', updatedAt: NOW - 10, steps: [] }],
    });
    expect(decide.map((i: { key: string }) => i.key)).toEqual(['plan:j5', 'approval:old']);
  });
});

describe('cockpitInbox — broken', () => {
  it('includes a failed job', () => {
    const { broken, decide } = cockpitInbox({
      now: NOW,
      jobs: [{ id: 'j1', title: 'Broken job', state: 'failed', updatedAt: NOW - 400, steps: [] }],
    });
    expect(decide).toEqual([]);
    expect(broken[0]).toMatchObject({
      key: 'job-failed:j1', kind: 'job-failed', tone: 'warn', title: 'Broken job',
      detail: 'Job failed', open: { surface: 'tracked', id: 'j1' },
    });
  });

  it('includes a failed step on a live job, with the failure text as detail', () => {
    const { broken } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j2', title: 'Half-done', state: 'executing', updatedAt: NOW - 100,
        live: { orchestrator: false, stepIds: [] },
        steps: [{ id: 's3', type: 'action', failure: 'workspace would not provision', updatedAt: NOW - 100 }],
      }],
    });
    expect(broken[0]).toMatchObject({
      key: 'step-failed:j2:s3', kind: 'step-failed', tone: 'warn',
      detail: 'workspace would not provision',
    });
  });

  // A live session on the step means the controller is already working it — the user
  // is not needed yet, and an item here would be noise.
  it('suppresses a failed step whose session is live', () => {
    const { broken } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j3', title: 'Retrying', state: 'executing', updatedAt: NOW,
        live: { orchestrator: false, stepIds: ['s4'] },
        steps: [{ id: 's4', type: 'action', failure: 'boom', updatedAt: NOW }],
      }],
    });
    expect(broken).toEqual([]);
  });

  it('does not double-report a step failure on a job that already failed', () => {
    const { broken } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j4', title: 'Dead', state: 'failed', updatedAt: NOW,
        steps: [{ id: 's5', type: 'action', failure: 'boom', updatedAt: NOW }],
      }],
    });
    expect(broken.map((i: { key: string }) => i.key)).toEqual(['job-failed:j4']);
  });

  it('includes a schedule whose most recent run failed', () => {
    const { broken } = cockpitInbox({
      now: NOW,
      runs: [{
        id: 'r1', kind: 'sched', title: 'nightly-lint', verdict: 'failed: exit 2',
        startedAt: NOW - 21_600_000, refs: { scheduleId: 'sch-1' },
      }],
    });
    expect(broken[0]).toMatchObject({
      key: 'routine-failed:sch-1', kind: 'routine-failed', tone: 'warn',
      title: 'nightly-lint', detail: 'failed: exit 2',
      open: { surface: 'schedules', id: 'sch-1' },
    });
  });

  // The self-resolving case: the next green run clears the item with no user action.
  it('drops a routine failure once a later run of the same schedule succeeds', () => {
    const { broken } = cockpitInbox({
      now: NOW,
      runs: [
        { id: 'r2', kind: 'sched', title: 'nightly-lint', verdict: 'ok', startedAt: NOW - 1000, refs: { scheduleId: 'sch-1' } },
        { id: 'r1', kind: 'sched', title: 'nightly-lint', verdict: 'failed: exit 2', startedAt: NOW - 90_000, refs: { scheduleId: 'sch-1' } },
      ],
    });
    expect(broken).toEqual([]);
  });

  it('ignores non-sched runs and sched runs with no scheduleId', () => {
    const { broken } = cockpitInbox({
      now: NOW,
      runs: [
        { id: 'r3', kind: 'sess', title: 'a session', verdict: 'error', startedAt: NOW - 1000 },
        { id: 'r4', kind: 'sched', title: 'orphan', verdict: 'error', startedAt: NOW - 1000 },
      ],
    });
    expect(broken).toEqual([]);
  });
});

const HOUR = 3_600_000;

describe('cockpitInbox — cleared', () => {
  it('includes resolution events from the last 24h, newest first', () => {
    const { cleared } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j1', title: 'CS-1440', state: 'executing', updatedAt: NOW, steps: [],
        events: [
          { id: 'e1', at: NOW - 3 * HOUR, kind: 'plan_approved', who: 'user' },
          { id: 'e2', at: NOW - 1 * HOUR, kind: 'step_merged', who: 'orchestrator' },
        ],
      }],
    });
    expect(cleared.map((i: { key: string }) => i.key)).toEqual(['cleared:j1:e2', 'cleared:j1:e1']);
    expect(cleared[0]).toMatchObject({
      kind: 'cleared-event', tone: 'ok', title: 'CS-1440', detail: 'step merged',
      open: { surface: 'tracked', id: 'j1' },
    });
  });

  it('ignores events older than 24h and non-resolution events', () => {
    const { cleared } = cockpitInbox({
      now: NOW,
      jobs: [{
        id: 'j2', title: 'Old', state: 'executing', updatedAt: NOW, steps: [],
        events: [
          { id: 'e1', at: NOW - 30 * HOUR, kind: 'plan_approved', who: 'user' },
          { id: 'e2', at: NOW - 1 * HOUR, kind: 'step_started', who: 'orchestrator' },
        ],
      }],
    });
    expect(cleared).toEqual([]);
  });

  it('includes a successful schedule run and carries the raw record for the run detail', () => {
    const run = {
      id: 'r1', kind: 'sched', title: 'backup-runner', verdict: 'ok',
      startedAt: NOW - 5 * HOUR, durationMs: 1000, refs: { scheduleId: 'sch-2' },
    };
    const { cleared } = cockpitInbox({ now: NOW, runs: [run] });
    expect(cleared[0]).toMatchObject({
      key: 'cleared:run:r1', kind: 'cleared-run', tone: 'ok', title: 'backup-runner',
      detail: 'succeeded', open: { surface: 'runs', id: 'r1' },
    });
    expect(cleared[0].raw).toBe(run);
  });

  // A 5-minute cron would otherwise bury everything else under its own green runs.
  it('keeps only the newest successful run per schedule', () => {
    const { cleared } = cockpitInbox({
      now: NOW,
      runs: [
        { id: 'r2', kind: 'sched', title: 'poller', verdict: 'ok', startedAt: NOW - 1000, refs: { scheduleId: 'sch-3' } },
        { id: 'r1', kind: 'sched', title: 'poller', verdict: 'ok', startedAt: NOW - 60_000, refs: { scheduleId: 'sch-3' } },
      ],
    });
    expect(cleared.map((i: { key: string }) => i.key)).toEqual(['cleared:run:r2']);
  });

  it('leaves a still-failing routine out of cleared (it belongs in broken)', () => {
    const { broken, cleared } = cockpitInbox({
      now: NOW,
      runs: [{ id: 'r1', kind: 'sched', title: 'nightly-lint', verdict: 'error', startedAt: NOW - HOUR, refs: { scheduleId: 'sch-4' } }],
    });
    expect(broken).toHaveLength(1);
    expect(cleared).toEqual([]);
  });

  it('caps the tail at 12 items', () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`, at: NOW - i * 60_000, kind: 'step_resolved', who: 'orchestrator',
    }));
    const { cleared } = cockpitInbox({
      now: NOW,
      jobs: [{ id: 'j3', title: 'Busy', state: 'executing', updatedAt: NOW, steps: [], events }],
    });
    expect(cleared).toHaveLength(12);
  });
});
