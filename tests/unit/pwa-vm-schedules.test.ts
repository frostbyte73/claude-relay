import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { humanizeCron, guardLabel, scheduleCards, filterScheduleCards, scheduleDetail, runRow, whatSummary, draftValidity } from '../../src/pwa/vm/schedules.js';

const NOW = new Date('2026-07-13T12:00:00Z').getTime(); // a Monday

describe('humanizeCron', () => {
  it('reads */N minute intervals', () => {
    expect(humanizeCron('*/15 * * * *')).toBe('Every 15 minutes');
  });
  it('reads a daily time', () => {
    expect(humanizeCron('0 9 * * *')).toBe('Daily at 9:00 AM');
  });
  it('reads a weekly day+time', () => {
    expect(humanizeCron('0 9 * * 0')).toBe('Weekly Sun at 9:00 AM');
  });
  it('falls back to the raw string for unrecognized shapes', () => {
    expect(humanizeCron('*/5 9-17 * * 1-5')).toBe('*/5 9-17 * * 1-5');
  });
});

describe('guardLabel', () => {
  it('formats a usage-threshold guard', () => {
    expect(guardLabel({ kind: 'usage-threshold', window: '7d', op: '>', value: 90 })).toBe('7d usage > 90%');
  });
  it('formats a no-repo-changes guard without a repo', () => {
    expect(guardLabel({ kind: 'no-repo-changes' })).toBe('no repo changes since last run');
  });
  it('formats a no-repo-changes guard scoped to a repo', () => {
    expect(guardLabel({ kind: 'no-repo-changes', repo: 'org/repo' })).toBe('no changes in org/repo since last run');
  });
});

describe('draftValidity', () => {
  it('flags everything missing on an empty draft', () => {
    const v = draftValidity({ name: '', trigger: null, what: null });
    expect(v.valid).toBe(false);
    expect(v.missing).toEqual(['a name', 'a trigger', 'what to run']);
  });
  it('requires a non-blank name', () => {
    const v = draftValidity({ name: '   ', trigger: { kind: 'cron', expr: '0 9 * * 0' }, what: { kind: 'skill', skill: 'read.investigate' } });
    expect(v.missing).toContain('a name');
  });
  it('requires cwd for a prompt what', () => {
    const v = draftValidity({ name: 'x', trigger: { kind: 'token-opportunistic' }, what: { kind: 'prompt', prompt: 'hi', cwd: '' } });
    expect(v.valid).toBe(false);
    expect(v.missing).toContain('what to run');
  });
  it('is valid when name + trigger + a complete what are present', () => {
    const v = draftValidity({ name: 'Weekly', trigger: { kind: 'cron', expr: '0 9 * * 0' }, what: { kind: 'prompt', prompt: 'hi', cwd: '/x' } });
    expect(v).toEqual({ valid: true, missing: [] });
  });
});

describe('whatSummary', () => {
  it('labels a skill by name (mono)', () => {
    expect(whatSummary({ kind: 'skill', skill: 'code.review-diff' })).toEqual({ kind: 'skill', label: 'code.review-diff', mono: true });
  });
  it('treats a legacy kind-less shape as a skill', () => {
    expect(whatSummary({ skill: 'read.investigate' })).toEqual({ kind: 'skill', label: 'read.investigate', mono: true });
  });
  it('snippets a prompt (non-mono)', () => {
    const s = whatSummary({ kind: 'prompt', prompt: '  Review the\nmerged  PRs  ', cwd: '/x' });
    expect(s).toEqual({ kind: 'prompt', label: 'Review the merged PRs', mono: false });
  });
  it('uses a script first line (mono)', () => {
    expect(whatSummary({ kind: 'script', script: '\n#!/bin/bash\nnpm test', cwd: '/x' })).toEqual({ kind: 'script', label: '#!/bin/bash', mono: true });
  });
  it('labels a native handler by name (mono)', () => {
    expect(whatSummary({ kind: 'native', handler: 'pr-watcher' })).toEqual({ kind: 'native', label: 'pr-watcher', mono: true });
  });
});

function schedule(overrides = {}) {
  return {
    id: 's1',
    name: 'Weekly code review',
    enabled: true,
    trigger: { kind: 'cron', expr: '0 9 * * 0' },
    what: { kind: 'skill', skill: 'code.review-diff', repos: ['org/repo'] },
    guards: [{ kind: 'usage-threshold', window: '7d', op: '>', value: 90 }],
    routing: {},
    nextRunAt: NOW + 3 * 86_400_000,
    ...overrides,
  };
}

describe('scheduleCards', () => {
  it('shapes a cron card as enabled with a relative next-run', () => {
    const [card] = scheduleCards([schedule()], NOW);
    expect(card.sourceKind).toBe('cron');
    expect(card.when).toBe('Weekly Sun at 9:00 AM');
    expect(card.descriptor).toBe('0 9 * * 0');
    expect(card.what).toEqual({ kind: 'skill', label: 'code.review-diff', mono: true });
    expect(card.dimmed).toBe(false);
    expect(card.nextRunSummary).toBe('in 3d');
  });

  it('dims a paused schedule and reports "Paused" instead of a next run', () => {
    const [card] = scheduleCards([schedule({ enabled: false })], NOW);
    expect(card.dimmed).toBe(true);
    expect(card.nextRunSummary).toBe('Paused');
  });

  it('carries builtin through for the badge/delete-hide', () => {
    const [userCard] = scheduleCards([schedule()], NOW);
    expect(userCard.builtin).toBe(false);
    const [builtinCard] = scheduleCards([schedule({ builtin: true })], NOW);
    expect(builtinCard.builtin).toBe(true);
  });

  it('shapes an event card from its descriptor', () => {
    const [card] = scheduleCards([schedule({ trigger: { kind: 'event', descriptor: 'linear.issue.created' } })], NOW);
    expect(card.sourceKind).toBe('event');
    expect(card.when).toBe('linear.issue.created');
    expect(card.descriptor).toBe('event · linear.issue.created');
  });

  it('shapes a token card from the server-attached tokenStatus', () => {
    const [card] = scheduleCards([schedule({
      trigger: { kind: 'token-opportunistic' },
      nextRunAt: null,
      tokenStatus: { state: 'waiting', reason: 'Waiting — 7d usage ahead of pace (60% used, 5d to reset)' },
    } as any)], NOW);
    expect(card.sourceKind).toBe('token');
    expect(card.when).toBe('When tokens are free');
    expect(card.descriptor).toBe('token · opportunistic');
    expect(card.nextRunSummary).toBe('Waiting — 7d usage ahead of pace (60% used, 5d to reset)');
  });

  it('names the debounce on a token card that has one', () => {
    const [daily] = scheduleCards([schedule({ trigger: { kind: 'token-opportunistic', debounceMs: 86_400_000 } } as any)], NOW);
    expect(daily.when).toBe('When tokens are free · at most once per day');
    const [sixHourly] = scheduleCards([schedule({ trigger: { kind: 'token-opportunistic', debounceMs: 6 * 3_600_000 } } as any)], NOW);
    expect(sixHourly.when).toBe('When tokens are free · at most once per 6 hours');
  });
});

describe('filterScheduleCards', () => {
  it('passes through on "all"', () => {
    const cards = scheduleCards([schedule(), schedule({ id: 's2', trigger: { kind: 'event', descriptor: 'x' } })], NOW);
    expect(filterScheduleCards(cards, 'all')).toHaveLength(2);
  });
  it('filters to one source kind', () => {
    const cards = scheduleCards([schedule(), schedule({ id: 's2', trigger: { kind: 'event', descriptor: 'x' } })], NOW);
    expect(filterScheduleCards(cards, 'event').map((c: any) => c.id)).toEqual(['s2']);
  });
});

describe('scheduleDetail', () => {
  it('shapes the trigger card with guards and next-run', () => {
    const detail = scheduleDetail(schedule(), [], NOW);
    expect(detail.trigger.guards).toEqual([{ raw: schedule().guards[0], label: '7d usage > 90%' }]);
    expect(detail.trigger.nextRunRelative).toBe('in 3d');
    expect(detail.whatToRun.kind).toBe('skill');
    expect(detail.whatToRun.skill).toBe('code.review-diff');
    expect(detail.whatToRun.repos).toEqual(['org/repo']);
  });

  it('shapes prompt and script whatToRun with cwd', () => {
    const promptDetail = scheduleDetail(schedule({ what: { kind: 'prompt', prompt: 'Summarize merged PRs', cwd: '/work/repo' } }), [], NOW);
    expect(promptDetail.whatToRun.kind).toBe('prompt');
    expect(promptDetail.whatToRun.prompt).toBe('Summarize merged PRs');
    expect(promptDetail.whatToRun.cwd).toBe('/work/repo');

    const scriptDetail = scheduleDetail(schedule({ what: { kind: 'script', script: 'npm test', cwd: '/work/repo' } }), [], NOW);
    expect(scriptDetail.whatToRun.kind).toBe('script');
    expect(scriptDetail.whatToRun.script).toBe('npm test');
    expect(scriptDetail.whatToRun.cwd).toBe('/work/repo');
  });

  it('shapes a token trigger with its status reason and no clock next-run', () => {
    const detail = scheduleDetail(schedule({
      trigger: { kind: 'token-opportunistic' },
      nextRunAt: null,
      tokenStatus: { state: 'eligible', reason: 'Headroom — 7d at 30% used, 3d to reset' },
    } as any), [], NOW);
    expect(detail.trigger.sourceKind).toBe('token');
    expect(detail.trigger.when).toBe('When tokens are free');
    expect(detail.trigger.nextRunAbsolute).toBeNull();
    expect(detail.trigger.nextRunRelative).toBe('Headroom — 7d at 30% used, 3d to reset');
  });

  it('reports "Paused" and no next run when disabled', () => {
    const detail = scheduleDetail(schedule({ enabled: false }), [], NOW);
    expect(detail.trigger.nextRunRelative).toBe('Paused');
    expect(detail.trigger.nextRunAbsolute).toBeNull();
  });
});

describe('runRow', () => {
  it('surfaces a skip reason for skipped runs', () => {
    const row = runRow({ id: 'r1', scheduleId: 's1', startedAt: NOW, outcome: 'skipped', skipReason: '7d usage was at 96%' }, NOW);
    expect(row.verdictText).toBe('Skipped — 7d usage was at 96%');
    expect(row.tone).toBe('warn');
  });

  it('summarizes findings + delivery outcomes as a follow-up line', () => {
    const row = runRow({
      id: 'r2',
      scheduleId: 's1',
      startedAt: NOW,
      outcome: 'ok',
      verdict: { summary: 'Found 2 issues', findings: [{ title: 'a' }, { title: 'b' }] },
      delivery: { github: { status: 'pending-approval' }, cockpit: { surfaced: true } },
    }, NOW);
    expect(row.tone).toBe('ok');
    expect(row.followUp).toBe('2 findings · GitHub post pending approval');
    expect(row.canApproveGithub).toBe(true);
  });
});
