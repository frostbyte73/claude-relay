// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessions, reconcileTurnState } from '../../src/pwa/state/sessions.js';
// @ts-expect-error PWA modules are plain JS.
import { dispatchSession, installDispatchDeps } from '../../src/pwa/ws/dispatch.js';

const SID = 'sess-1';

function slice() {
  return sessions.getSlice(SID);
}

beforeEach(() => {
  sessions.set({
    view: 'session',
    currentSessionId: SID,
    maxTranscriptLines: 500,
    sessionsById: new Map(),
  });
  sessions.ensureSlice(SID);
});

// The bug: the strip is inferred from the model's stream, so a client that was
// disconnected when the turn's terminal event went past kept spinning forever —
// replay can't always cover it (bounded event log, fresh log after a respawn).
describe('session_state turn-state reconcile', () => {
  it('clears a strip left spinning by a missed turn end', () => {
    sessions.for(SID).startThinking();
    expect(slice().thinking).toBe(true);

    reconcileTurnState(SID, { type: 'session_state', working: false, workingSince: null });

    expect(slice().thinking).toBe(false);
  });

  it('picks up a turn already in flight, dated from when it actually started', () => {
    const startedAt = Date.now() - 600_000;

    reconcileTurnState(SID, { type: 'session_state', working: true, workingSince: startedAt });

    expect(slice().thinking).toBe(true);
    expect(slice().thinkingStartedAt).toBe(startedAt);
  });

  it('leaves an in-flight turn alone rather than restarting its clock', () => {
    sessions.for(SID).startThinking(1000);

    reconcileTurnState(SID, { type: 'session_state', working: true, workingSince: 9999 });

    expect(slice().thinkingStartedAt).toBe(1000);
  });

  it('imposes nothing when the daemon states no opinion', () => {
    sessions.for(SID).startThinking();

    reconcileTurnState(SID, { type: 'session_state', spawnCwd: '/tmp' });

    expect(slice().thinking).toBe(true);
  });
});

describe('daemon_turn_end', () => {
  it('stops the strip on the Stop hook', () => {
    let stopped: string | null = null;
    installDispatchDeps({
      state: {},
      stopThinking(sid: string) { stopped = sid; sessions.for(sid).stopThinking(); },
      renderSession() {},
    });
    sessions.for(SID).startThinking();

    dispatchSession({ type: 'daemon_turn_end' }, SID);

    expect(stopped).toBe(SID);
    expect(slice().thinking).toBe(false);
  });
});
