import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error
import { sessions } from '../../src/pwa/state/sessions.js';

describe('sessions slice: statusline and lastUsage fields', () => {
  beforeEach(() => {
    sessions.set((s: any) => ({
      ...s,
      sessionsById: new Map(),
      currentSessionId: null,
    }));
  });

  it('initializes statusline and lastUsage to null in a new slice', () => {
    const id = 'test-session';
    sessions.ensureSlice(id);
    const slice = sessions.getSlice(id);
    expect(slice).not.toBeNull();
    expect(slice?.statusline).toBe(null);
    expect(slice?.lastUsage).toBe(null);
  });

  it('setStatusline updates the statusline field', () => {
    const id = 'test-session';
    sessions.ensureSlice(id);
    const before = sessions.getSlice(id);
    expect(before?.statusline).toBe(null);

    sessions.for(id).setStatusline('running');
    const after = sessions.getSlice(id);
    expect(after?.statusline).toBe('running');
  });

  it('setStatusline maintains reference equality when value does not change', () => {
    const id = 'test-session';
    sessions.ensureSlice(id);
    const slice1 = sessions.getSlice(id);

    sessions.for(id).setStatusline('running');
    const slice2 = sessions.getSlice(id);
    expect(slice1 === slice2).toBe(false); // changed, so different reference

    sessions.for(id).setStatusline('running');
    const slice3 = sessions.getSlice(id);
    expect(slice2 === slice3).toBe(true); // no change, same reference
  });

  it('setLastUsage updates the lastUsage field', () => {
    const id = 'test-session';
    sessions.ensureSlice(id);
    const before = sessions.getSlice(id);
    expect(before?.lastUsage).toBe(null);

    const usage = { tokens: 100, chars: 500 };
    sessions.for(id).setLastUsage(usage);
    const after = sessions.getSlice(id);
    expect(after?.lastUsage).toBe(usage);
  });

  it('setLastUsage maintains reference equality when value does not change', () => {
    const id = 'test-session';
    sessions.ensureSlice(id);

    const usage = { tokens: 100, chars: 500 };
    sessions.for(id).setLastUsage(usage);
    const slice1 = sessions.getSlice(id);

    sessions.for(id).setLastUsage(usage);
    const slice2 = sessions.getSlice(id);
    expect(slice1 === slice2).toBe(true); // same value, same reference
  });

  it('NULL_SLICE_API has no-op stubs for setStatusline and setLastUsage', () => {
    const api = sessions.for(null);
    expect(api.setStatusline).toBeDefined();
    expect(api.setLastUsage).toBeDefined();
    // Calling them should not throw
    expect(() => {
      api.setStatusline('test');
      api.setLastUsage({ tokens: 1, chars: 1 });
    }).not.toThrow();
  });
});
