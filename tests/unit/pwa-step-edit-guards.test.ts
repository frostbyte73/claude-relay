// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { stepIsEditable, stepIsMovable, editBlockedReason } from '../../src/pwa/components/tracked/detail.js';

// These have to stay identical to engine.ts's stepAcceptsEdits: anything the rail enables that
// the engine refuses is a 409 the user can't act on, and anything it disables that the engine
// would accept is the dead end this file exists to close.
const step = (over: Record<string, unknown> = {}) => ({
  id: 's1', type: 'orchestrated', title: 't', state: 'running', ...over,
});

describe('tracked plan-editor guards', () => {
  it('unlocks a step that failed on its first turn', () => {
    const failed = step({ sessionId: 'sess-1', state: 'failed', failure: { reason: 'inputs.prUrl is missing', at: 1 } });
    expect(stepIsEditable(failed)).toBe(true);
  });

  it('keeps a mid-turn step locked', () => {
    const running = step({ sessionId: 'sess-1' });
    expect(stepIsEditable(running)).toBe(false);
    expect(editBlockedReason(running)).toMatch(/running/i);
    expect(editBlockedReason(running)).not.toMatch(/done|finished/i);
  });

  it('keeps resolved and cancelled steps locked, and says which', () => {
    expect(stepIsEditable(step({ state: 'resolved' }))).toBe(false);
    expect(editBlockedReason(step({ state: 'resolved' }))).toMatch(/finished/i);
    expect(stepIsEditable(step({ cancelled: true }))).toBe(false);
  });

  // reorderSteps still locks any step that ever had a session to its index, failed included.
  it('does not let an unlocked failed step be reordered', () => {
    const failed = step({ sessionId: 'sess-1', state: 'failed', failure: { reason: 'boom', at: 1 } });
    expect(stepIsMovable(failed)).toBe(false);
    expect(stepIsMovable(step({}))).toBe(true);
  });
});
