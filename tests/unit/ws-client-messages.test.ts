import { describe, it, expect, vi } from 'vitest';
import {
  parseWsFrame,
  handleNotificationsMessage,
  handleSessionMessage,
  type NotificationsMessageDeps,
  type SessionMessageDeps,
} from '../../src/ws/client-messages.js';

// `JSON.parse` succeeds (returns a non-object) on all of these — the daemon crash this
// module exists to prevent came from dereferencing `.type` on exactly these values with
// nothing downstream to catch the TypeError.
const NON_OBJECT_FRAMES = ['null', '42', '"str"', 'true', '[]'];

describe('parseWsFrame', () => {
  for (const body of NON_OBJECT_FRAMES) {
    it(`returns null for a "${body}" frame instead of a bare value`, () => {
      expect(parseWsFrame(Buffer.from(body))).toBeNull();
    });
  }

  it('returns null for unparsable JSON', () => {
    expect(parseWsFrame(Buffer.from('{not json'))).toBeNull();
  });

  it('returns the parsed object for a well-formed frame', () => {
    expect(parseWsFrame(Buffer.from('{"type":"interrupt"}'))).toEqual({ type: 'interrupt' });
  });

  it('decodes an ArrayBuffer frame the same as the equivalent Buffer', () => {
    const buf = Buffer.from('{"type":"interrupt"}');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    expect(parseWsFrame(ab)).toEqual({ type: 'interrupt' });
  });

  it('concatenates a Buffer[] fragmented frame rather than joining with commas', () => {
    // `String([Buffer.from('{"type":"in'), Buffer.from('terrupt"}')])` would produce
    // `{"type":"in,terrupt"}` (Array.prototype.toString joins with ','), which is
    // syntactically valid-looking but semantically wrong JSON.
    const fragments = [Buffer.from('{"type":"in'), Buffer.from('terrupt"}')];
    expect(parseWsFrame(fragments)).toEqual({ type: 'interrupt' });
  });
});

describe('handleNotificationsMessage', () => {
  function deps() {
    return { queue: { decide: vi.fn() } } satisfies NotificationsMessageDeps;
  }

  for (const body of NON_OBJECT_FRAMES) {
    it(`does not throw and is a no-op for a "${body}" frame`, () => {
      const d = deps();
      expect(() => handleNotificationsMessage(Buffer.from(body), d)).not.toThrow();
      expect(d.queue.decide).not.toHaveBeenCalled();
    });
  }

  it('does not throw for unparsable JSON', () => {
    const d = deps();
    expect(() => handleNotificationsMessage(Buffer.from('{not json'), d)).not.toThrow();
    expect(d.queue.decide).not.toHaveBeenCalled();
  });

  it('dispatches approval_decide to the queue', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_decide', approvalId: 'a1', decision: 'allow' }));
    handleNotificationsMessage(raw, d);
    expect(d.queue.decide).toHaveBeenCalledWith('a1', { allow: true, reason: undefined });
  });

  it('ignores an unrecognized message type', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'something_else' }));
    handleNotificationsMessage(raw, d);
    expect(d.queue.decide).not.toHaveBeenCalled();
  });
});

describe('handleSessionMessage', () => {
  function deps() {
    return {
      queue: { decide: vi.fn() },
      manager: { send: vi.fn(), interrupt: vi.fn(), broadcast: vi.fn() },
      modes: { set: vi.fn() },
    } satisfies SessionMessageDeps;
  }

  for (const body of NON_OBJECT_FRAMES) {
    it(`does not throw and is a no-op for a "${body}" frame`, () => {
      const d = deps();
      expect(() => handleSessionMessage(Buffer.from(body), 's1', d)).not.toThrow();
      expect(d.manager.send).not.toHaveBeenCalled();
      expect(d.manager.interrupt).not.toHaveBeenCalled();
      expect(d.manager.broadcast).not.toHaveBeenCalled();
      expect(d.queue.decide).not.toHaveBeenCalled();
    });
  }

  it('forwards user_message content to manager.send', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'user_message', content: 'hi' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.manager.send).toHaveBeenCalledWith('s1', { type: 'user', message: { role: 'user', content: 'hi' } });
  });

  // SessionManager.send throws for a session that isn't active — reachable any time a
  // client types into a session whose subprocess exited. The throw used to unwind
  // through ws.on('message') and kill the daemon, taking every other session with it.
  it('does not rethrow when manager.send rejects an inactive session', () => {
    const d = deps();
    d.manager.send.mockImplementation(() => { throw new Error('session s1 not active'); });
    const raw = Buffer.from(JSON.stringify({ type: 'user_message', content: 'hi' }));
    expect(() => handleSessionMessage(raw, 's1', d)).not.toThrow();
  });

  it('does not rethrow when manager.interrupt throws', () => {
    const d = deps();
    d.manager.interrupt.mockImplementation(() => { throw new Error('session s1 not active'); });
    const raw = Buffer.from(JSON.stringify({ type: 'interrupt' }));
    expect(() => handleSessionMessage(raw, 's1', d)).not.toThrow();
  });

  it('dispatches approval_decide to the queue', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_decide', approvalId: 'a1', decision: 'deny', reason: 'no' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.queue.decide).toHaveBeenCalledWith('a1', { allow: false, reason: 'no' });
  });

  it('forwards interrupt to manager.interrupt', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'interrupt' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.manager.interrupt).toHaveBeenCalledWith('s1');
  });

  it('sets and broadcasts a valid approval_mode_set', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_mode_set', mode: 'plan' }));
    handleSessionMessage(raw, 's1', d);
    expect(d.modes.set).toHaveBeenCalledWith('s1', 'plan');
    expect(d.manager.broadcast).toHaveBeenCalledWith('s1', { type: 'approval_mode', sessionId: 's1', mode: 'plan' });
  });

  it('does not broadcast when modes.set rejects an invalid mode', () => {
    const d = deps();
    d.modes.set.mockImplementation(() => { throw new Error('invalid mode'); });
    const raw = Buffer.from(JSON.stringify({ type: 'approval_mode_set', mode: 'nonsense' }));
    expect(() => handleSessionMessage(raw, 's1', d)).not.toThrow();
    expect(d.manager.broadcast).not.toHaveBeenCalled();
  });

  it('ignores approval_mode_set with a non-string mode', () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ type: 'approval_mode_set', mode: 42 }));
    handleSessionMessage(raw, 's1', d);
    expect(d.modes.set).not.toHaveBeenCalled();
  });
});
