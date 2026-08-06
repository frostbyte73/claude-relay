import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { cockpitGroups, sentimentSummary } from '../../src/pwa/vm/cockpit.js';

const NOW = 1_000_000_000_000;

describe('cockpitGroups', () => {
  it('waiting includes pending approvals, plan-review jobs, and needy steps, newest first', () => {
    const groups = cockpitGroups({
      now: NOW,
      pendingApprovals: [{ approvalId: 'a1', sessionId: 'sX', toolName: 'Bash', enqueuedAt: NOW - 1000 }],
      jobs: [
        { id: 'j1', title: 'Plan job', state: 'plan_pending_review', updatedAt: NOW - 500, steps: [] },
        {
          id: 'j2',
          title: 'PR job',
          state: 'executing',
          updatedAt: NOW - 2000,
          steps: [{ id: 's1', type: 'orchestrated', state: 'gate_pending_approval', updatedAt: NOW - 100 }],
        },
      ],
    });

    expect(groups.waiting.map((r: any) => r.id)).toEqual(['step-j2-s1', 'job-plan-j1', 'approval-a1']);
    expect(groups.waiting[0].kind).toBe('pr-step');
    expect(groups.waiting[0].tone).toBe('hot');
  });

  it('a step chewing on PR comments is not a waiting row, but its job still shows inFlight', () => {
    const job = {
      id: 'j1',
      title: 'Triage job',
      state: 'executing',
      updatedAt: NOW,
      externalRef: null,
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'pr_comments', updatedAt: NOW }],
    };
    const groups = cockpitGroups({ now: NOW, jobs: [job] });

    expect(groups.waiting.filter((r: any) => r.kind === 'pr-step')).toEqual([]);
    expect(groups.waiting.some((r: any) => r.pills?.some((p: any) => p.label === 'New comments'))).toBe(false);

    expect(groups.inFlight.some((r: any) => r.kind === 'job' && r.id === 'job-exec-j1')).toBe(true);
    const jobRow = groups.inFlight.find((r: any) => r.id === 'job-exec-j1');
    expect(jobRow.pills.some((p: any) => p.label === 'Executing')).toBe(true);
  });

  it('an executing job parked behind the token queue shows Queued instead of Executing', () => {
    const job = {
      id: 'j1', title: 'Parked job', state: 'executing', updatedAt: NOW, steps: [],
      launchStatus: { job: { state: 'queued', reason: 'no token headroom' }, steps: {} },
    };
    const groups = cockpitGroups({ now: NOW, jobs: [job] });
    const jobRow = groups.inFlight.find((r: any) => r.id === 'job-exec-j1');
    expect(jobRow.pills).toEqual([{ label: 'Queued — no token headroom', variant: 'warn' }]);
    expect(jobRow.tone).toBe('warn');
  });

  it('a merge-ready step raises no waiting row — the controller has to gate the merge first', () => {
    const groups = cockpitGroups({
      now: NOW,
      jobs: [{
        id: 'j1',
        title: 'Ready job',
        state: 'executing',
        updatedAt: NOW,
        steps: [{ id: 's1', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
          pr: { reviewState: 'approved', ciState: 'success' }, updatedAt: NOW }],
      }],
    });
    expect(groups.waiting.filter((r: any) => r.kind === 'pr-step')).toEqual([]);
  });

  it('a gated controller move is a hot waiting row', () => {
    const groups = cockpitGroups({
      now: NOW,
      jobs: [{
        id: 'j1',
        title: 'Ready job',
        state: 'executing',
        updatedAt: NOW,
        steps: [{ id: 's1', type: 'orchestrated', state: 'gate_pending_approval', phase: 'pr_open', updatedAt: NOW }],
      }],
    });
    expect(groups.waiting[0].tone).toBe('hot');
    expect(groups.waiting[0].pills).toEqual([{ label: 'Approve move', variant: 'gate' }]);
  });

  it('inFlight includes running/background sessions and executing jobs, excludes inactive sessions and other job states', () => {
    const sessionsById = new Map([
      ['s-run', { id: 's-run', cwd: '/home/alice/repo-a', runState: 'foreground' }],
      ['s-bg', { id: 's-bg', cwd: '/home/alice/repo-b', runState: 'background' }],
      ['s-dead', { id: 's-dead', cwd: '/home/alice/repo-c', runState: 'inactive' }],
    ]);
    const groups = cockpitGroups({
      now: NOW,
      sessionsById,
      jobs: [
        { id: 'j1', title: 'Executing', state: 'executing', updatedAt: NOW },
        { id: 'j2', title: 'Planning', state: 'planning', updatedAt: NOW },
        { id: 'j3', title: 'Done', state: 'done', updatedAt: NOW },
      ],
    });
    expect(groups.inFlight.map((r: any) => r.id).sort()).toEqual(['job-exec-j1', 'session-s-bg', 'session-s-run'].sort());
  });

  it('upcoming excludes paused schedules and caps at 5, sorted chronologically', () => {
    const schedules = Array.from({ length: 7 }, (_, i) => ({
      id: `sched-${i}`, name: `S${i}`, enabled: true, nextRunAt: NOW + (7 - i) * 1000,
    }));
    schedules.push({ id: 'paused', name: 'Paused one', nextRunAt: NOW + 1, enabled: false } as any);
    const groups = cockpitGroups({ now: NOW, schedules });
    expect(groups.upcoming).toHaveLength(5);
    expect(groups.upcoming.every((r: any) => r.id !== 'schedule-paused')).toBe(true);
    const times = groups.upcoming.map((r: any) => r.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('finished caps at 8, only within the last 24h, newest first', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`, kind: 'sess', title: `Run ${i}`, startedAt: NOW - i * 1000, durationMs: 0,
    }));
    runs.push({ id: 'old', kind: 'sess', title: 'Old run', startedAt: NOW - dayMs - 1, durationMs: 0 });
    const groups = cockpitGroups({ now: NOW, runs });
    expect(groups.finished).toHaveLength(8);
    expect(groups.finished.some((r: any) => r.id === 'run-old')).toBe(false);
    expect(groups.finished[0].id).toBe('run-r0');
  });
});

describe('sentimentSummary', () => {
  it('reports counts and fire status', () => {
    const groups = {
      waiting: [{ tone: 'hot' }, { tone: 'warn' }, { tone: 'hot' }],
      inFlight: [{}, {}],
      upcoming: [],
      finished: [],
    };
    expect(sentimentSummary(groups)).toBe('3 things need you. 2 workstreams running. Something needs urgent attention.');
  });

  it('reports a calm state when nothing is waiting or hot', () => {
    const groups = { waiting: [], inFlight: [{}], upcoming: [], finished: [] };
    expect(sentimentSummary(groups)).toBe('Nothing needs you right now. 1 workstream running. Nothing on fire.');
  });
});
