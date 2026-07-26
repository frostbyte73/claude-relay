// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { dispatchSession, installDispatchDeps } from '../../src/pwa/ws/dispatch.js';
// @ts-expect-error PWA modules are plain JS.
import { sessions } from '../../src/pwa/state/sessions.js';

const SID = 'sess-1';

function lastEntry() {
  return sessions.getSlice(SID).transcript.at(-1);
}

beforeEach(() => {
  sessions.set({
    view: 'session',
    currentSessionId: SID,
    maxTranscriptLines: 500,
    sessionsById: new Map(),
  });
  sessions.ensureSlice(SID);
  installDispatchDeps({ state: {}, stopThinking() {}, renderSession() {} });
});

describe('daemon_proc_exit', () => {
  it('unexpected exit → crash tile with reopen', () => {
    dispatchSession({ type: 'daemon_proc_exit', code: 143 }, SID);
    const e = lastEntry();
    expect(e.role).toBe('error');
    expect(e.action).toBe('reopen');
    expect(e.text).toContain('143');
  });

  it('daemon-initiated idle reap → calm resumable notice, no crash tile', () => {
    dispatchSession({ type: 'daemon_proc_exit', code: 143, expected: true, reason: 'idle' }, SID);
    const e = lastEntry();
    expect(e.role).toBe('archived');
    expect(e.action).toBeUndefined();
    expect(e.text).toMatch(/resume/i);
  });

  it('daemon-initiated teardown → archived notice', () => {
    dispatchSession({ type: 'daemon_proc_exit', code: 143, expected: true, reason: 'archived' }, SID);
    const e = lastEntry();
    expect(e.role).toBe('archived');
    expect(e.text).toBe('Session archived.');
  });
});
