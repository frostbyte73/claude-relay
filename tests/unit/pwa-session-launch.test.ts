// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessions } from '../../src/pwa/state/sessions.js';
// @ts-expect-error plain JS
import { peekSessionHint } from '../../src/pwa/state/nav.js';
// @ts-expect-error plain JS
import { startSession } from '../../src/pwa/session-launch.js';

beforeEach(() => {
  sessions.set({
    view: 'list', projects: [], currentSessionId: null, currentSessionCwd: null,
    currentSessionSpawnCwd: null, currentSessionFromTicketId: null, approvalMode: 'ask',
    expandedProjects: {}, showArchivedByProject: new Map(), maxTranscriptLines: 500,
    sessionsById: new Map(),
  });
});

describe('startSession', () => {
  it('seeds the slice identity fields immediately', () => {
    const { id } = startSession({ cwd: '/p', worktreeBranch: 'feat', title: 'T' });
    const sl = sessions.getSlice(id);
    expect(sl?.cwd).toBe('/p');
    expect(sl?.spawnCwd).toBe('/p');       // defaults spawnCwd to cwd
    expect(sl?.worktreeBranch).toBe('feat');
    expect(sl?.title).toBe('T');
  });

  it('writes a spawn hint carrying WS-only fields', () => {
    startSession({ id: 'fixed', cwd: '/p', spawnMode: 'worktree', baseBranch: 'main', model: 'opus' });
    const hint = peekSessionHint('fixed');
    expect(hint).toMatchObject({ cwd: '/p', spawnMode: 'worktree', baseBranch: 'main', model: 'opus' });
  });

  it('applies a non-ask approval mode to the slice', () => {
    const { id } = startSession({ cwd: '/p', approvalMode: 'accept-edits' });
    expect(sessions.getSlice(id)?.approvalMode).toBe('accept-edits');
  });

  it('generates an id when none is supplied', () => {
    const { id } = startSession({ cwd: '/p' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});
