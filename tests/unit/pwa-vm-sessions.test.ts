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

  // The regression: opening a job files every finished step's session under Running.
  // mountInlineSession calls ensureSlice for every step it draws, so a slice exists for
  // sessions whose subprocess died long ago. The slice must not out-vote the daemon's own
  // row unless it actually knows something — an untouched slice carries runState `null`,
  // and the server row decides.
  it('defers to the daemon row for a slice that has no liveness evidence of its own', () => {
    const rendered = new Map<string, any>([
      ['running', { runState: null }],
      ['idle', { runState: null }],
      ['action', { runState: null }],
    ]);
    const rows = projects();
    // What GET /api/sessions says: one alive, the rest reaped.
    const serverRunState: Record<string, string> = { running: 'background', idle: 'idle', action: 'idle' };
    rows[0]!.sessions = rows[0]!.sessions.map((s) => ({ ...s, runState: serverRunState[s.id] })) as any;

    const groups = sessionGroups({ projects: rows, sessionsById: rendered });
    expect(groups.running.map((s: any) => s.id)).toEqual(['running']);
    expect(groups.idle.map((s: any) => s.id).sort()).toEqual(['action', 'idle']);
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
