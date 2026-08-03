// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessions } from '../../src/pwa/state/sessions.js';

beforeEach(() => {
  localStorage.clear();
  sessions.set({
    view: 'list',
    projects: [],
    currentSessionId: null,
    currentSessionCwd: null,
    currentSessionSpawnCwd: null,
    currentSessionFromTicketId: null,
    approvalMode: 'ask',
    expandedProjects: {},
    showArchivedByProject: new Map(),
    maxTranscriptLines: 500,
    sessionsById: new Map(),
  });
});

describe('sessions store', () => {
  it('enterSession sets view and session id', () => {
    sessions.enterSession({ id: 'abc', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    const s = sessions.get();
    expect(s.view).toBe('session');
    expect(s.currentSessionId).toBe('abc');
    expect(s.currentSessionCwd).toBe('/p');
    expect(s.approvalMode).toBe('ask');
  });

  it('leaveSession clears the current pointer and resets view', () => {
    sessions.enterSession({ id: 'abc', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    sessions.for('abc').appendTranscript({ id: 'm1', role: 'user', text: 'hi' });
    sessions.leaveSession();
    const s = sessions.get();
    expect(s.view).toBe('list');
    expect(s.currentSessionId).toBeNull();
    // The slice itself is retained across leaves — multi-live keeps the transcript.
    expect(sessions.getSlice('abc')?.transcript.length).toBe(1);
  });

  it('setExpandedProject persists to localStorage', () => {
    sessions.setExpandedProject('/foo', true);
    expect(JSON.parse(localStorage.getItem('op:expandedProjects')!)).toEqual({ '/foo': true });
  });

  it('subscribers are notified on mutation', () => {
    const seen: string[] = [];
    const off = sessions.subscribe((s: { view: string }) => seen.push(s.view));
    sessions.enterSession({ id: 'abc', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    sessions.leaveSession();
    off();
    sessions.enterSession({ id: 'abc', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    expect(seen).toEqual(['session', 'list']);
  });

  it('markToolExpanded toggles expandedTools set on the slice', () => {
    sessions.enterSession({ id: 'abc', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    sessions.for('abc').markToolExpanded('approval-x', true);
    expect(sessions.getSlice('abc')?.expandedTools.has('approval-x')).toBe(true);
    sessions.for('abc').markToolExpanded('approval-x', false);
    expect(sessions.getSlice('abc')?.expandedTools.has('approval-x')).toBe(false);
  });

  it('thinking state is isolated per session slice', () => {
    sessions.ensureSlice('a');
    sessions.ensureSlice('b');
    sessions.for('a').startThinking();
    expect(sessions.getSlice('a').thinking).toBe(true);
    expect(sessions.getSlice('a').thinkingStartedAt).toBeGreaterThan(0);
    expect(sessions.getSlice('b').thinking).toBe(false);
    sessions.for('a').stopThinking();
    expect(sessions.getSlice('a').thinking).toBe(false);
  });

  it('currentSlice() returns the slice for currentSessionId', () => {
    sessions.ensureSlice('a');
    sessions.for('a').startThinking();
    sessions.enterSession({ id: 'a', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    expect(sessions.currentSlice().thinking).toBe(true);
    sessions.enterSession({ id: 'b', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    expect(sessions.currentSlice().thinking).toBe(false);
    // switching didn't clobber 'a's slice
    expect(sessions.getSlice('a').thinking).toBe(true);
  });

  it('currentSlice() returns a safe empty slice when no session is current', () => {
    const empty = sessions.currentSlice();
    expect(empty.thinking).toBe(false);
    expect(empty.transcript).toEqual([]);
    expect(empty.todos.size).toBe(0);
    expect(empty.expandedTools.size).toBe(0);
  });

  it('forCurrent() routes mutations to the current session slice', () => {
    sessions.enterSession({ id: 'abc', cwd: '/p', spawnCwd: '/p', approvalMode: 'ask' });
    sessions.forCurrent().appendTranscript({ id: 'm1', role: 'user', text: 'hi' });
    expect(sessions.getSlice('abc')?.transcript.length).toBe(1);
  });

  it('setMaxTranscriptLines pushes the clamped value to the daemon', async () => {
    const { vi } = await import('vitest');
    const patch = vi.fn();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, opts: any) => {
      patch(JSON.parse(opts.body));
      return { ok: true, json: async () => ({}) };
    }));
    sessions.setMaxTranscriptLines(99999);
    await vi.advanceTimersByTimeAsync(500);
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ maxTranscriptLines: 10000 }));
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('upsertSlice reconciler', () => {
    it('creates a slice from the partial when absent', () => {
      sessions.upsertSlice('s1', { cwd: '/p', worktreeBranch: 'feat' });
      const sl = sessions.getSlice('s1');
      expect(sl?.cwd).toBe('/p');
      expect(sl?.worktreeBranch).toBe('feat');
    });

    it('fills a null identity field on an existing slice', () => {
      sessions.ensureSlice('s1');                 // minted cwd-less (e.g. by a WS frame)
      expect(sessions.getSlice('s1')?.cwd).toBeNull();
      sessions.upsertSlice('s1', { cwd: '/p', spawnCwd: '/wt' });
      expect(sessions.getSlice('s1')?.cwd).toBe('/p');
      expect(sessions.getSlice('s1')?.spawnCwd).toBe('/wt');
    });

    it('never overwrites a known identity field with null or a stale value', () => {
      sessions.upsertSlice('s1', { cwd: '/real' });
      sessions.upsertSlice('s1', { cwd: null });   // a later hint with no cwd
      sessions.upsertSlice('s1', { cwd: '/stale' });
      expect(sessions.getSlice('s1')?.cwd).toBe('/real');
    });

    it('returns the same state reference when nothing changes (no needless notify)', () => {
      sessions.upsertSlice('s1', { cwd: '/p' });
      const before = sessions.get().sessionsById;
      sessions.upsertSlice('s1', { cwd: '/p' });
      expect(sessions.get().sessionsById).toBe(before);
    });

    it('backfills cwd onto a slice minted cwd-less by an inbound frame', () => {
      sessions.ensureSlice('daemon-sess');                       // WS frame minted it first
      expect(sessions.getSlice('daemon-sess')?.cwd).toBeNull();
      sessions.upsertSlice('daemon-sess', { cwd: '/repo', spawnCwd: '/repo' });   // seedRunStates
      expect(sessions.getSlice('daemon-sess')?.cwd).toBe('/repo');
    });
  });
});
