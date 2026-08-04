import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessionGroups } from '../../src/pwa/vm/sessions.js';

function projects() {
  return [
    {
      cwd: '/home/alice/repo-a',
      sessions: [
        { id: 'running', title: 'Fix the bug', lastModified: 3000, archived: false, kind: 'normal' },
        { id: 'idle', title: 'Old session', lastModified: 2000, archived: false, kind: 'normal' },
        { id: 'action', title: 'Orchestrate: login flow', lastModified: 1000, archived: false, kind: 'normal', sessionClass: 'action', actionLabel: 'meta.orchestrate' },
        { id: 'archived', title: 'Ancient session', lastModified: 100, archived: true, kind: 'normal' },
      ],
    },
  ];
}

function sessionsById() {
  return new Map([
    ['running', { runState: 'foreground' }],
    ['idle', { runState: 'inactive' }],
    ['action', { runState: 'background' }],
  ]);
}

describe('sessionGroups', () => {
  it('buckets by running state, excludes archived by default', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById() });
    expect(groups.running.map((s: any) => s.id).sort()).toEqual(['action', 'running']);
    expect(groups.idle.map((s: any) => s.id)).toEqual(['idle']);
    expect(groups.recent).toEqual([]);
  });

  it('reveals archived sessions into "recent" when showArchived is set', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), showArchived: true });
    expect(groups.recent.map((s: any) => s.id)).toEqual(['archived']);
  });

  it('tab=active keeps only running/background sessions', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), tab: 'active' });
    const all = [...groups.running, ...groups.idle, ...groups.recent].map((s: any) => s.id).sort();
    expect(all).toEqual(['action', 'running']);
  });

  it('tab=action keeps only action sessions (sessionClass or edit kinds)', () => {
    const withEdit = projects();
    withEdit[0]!.sessions.push({ id: 'edit', title: 'Edit action: oncall', lastModified: 500, archived: false, kind: 'action-edit' } as any);
    const groups = sessionGroups({ projects: withEdit, sessionsById: sessionsById(), tab: 'action' });
    const all = [...groups.running, ...groups.idle, ...groups.recent].map((s: any) => s.id).sort();
    expect(all).toEqual(['action', 'edit']);
  });

  it('tab=session excludes action sessions', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), tab: 'session' });
    const all = [...groups.running, ...groups.idle, ...groups.recent].map((s: any) => s.id).sort();
    expect(all).toEqual(['idle', 'running']);
  });

  it('filter matches by title substring, case-insensitively', () => {
    const groups = sessionGroups({ projects: projects(), sessionsById: sessionsById(), filter: 'BUG' });
    const all = [...groups.running, ...groups.idle, ...groups.recent].map((s: any) => s.id);
    expect(all).toEqual(['running']);
  });

  it('sorts each group by lastModified, newest first', () => {
    const withExtra = projects();
    withExtra[0]!.sessions.push({ id: 'newer-idle', title: 'Newer', lastModified: 2500, archived: false, kind: 'normal' } as any);
    const groups = sessionGroups({ projects: withExtra, sessionsById: sessionsById() });
    expect(groups.idle.map((s: any) => s.id)).toEqual(['newer-idle', 'idle']);
  });
});
