// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error plain JS
import { usage } from '../../src/pwa/state/usage.js';

// recordUsage lives in app.js and is wired as a dispatch dep; this test pins the
// invariant directly on the usage store: a per-session write lands under the id
// passed in, not under the (desktop-null) currentSessionId pointer.
beforeEach(() => {
  usage.set({
    daemonInfo: null, slashCommands: [], statusline: null,
    statuslineBySession: new Map(), lastUsage: null, lastUsageBySession: new Map(),
    accountUsage: null, contextWindow: 200_000, projectContextWindow: null, meterBreakdownOpen: false,
  });
});

describe('usage attribution keys on the real session id', () => {
  it('setLastUsageFor stores under the given session id', () => {
    usage.setLastUsageFor('sock-123', { model: 'claude-opus-4-8', inputTokens: 1, outputTokens: 2, cacheCreate: 0, cacheRead: 0 });
    expect(usage.get().lastUsageBySession.get('sock-123')?.model).toBe('claude-opus-4-8');
    expect(usage.get().lastUsageBySession.get(null)).toBeUndefined();
  });
});
