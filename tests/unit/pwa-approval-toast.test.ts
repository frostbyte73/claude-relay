// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { dispatchBroadcast, installDispatchDeps } from '../../src/pwa/ws/dispatch.js';
// @ts-expect-error PWA modules are plain JS.
import { sessions } from '../../src/pwa/state/sessions.js';
// @ts-expect-error PWA modules are plain JS.
import { approvals } from '../../src/pwa/state/approvals.js';

const SID = 'sess-1';
let toasted: any[] = [];

function pending(over: Record<string, unknown> = {}) {
  return {
    type: 'approval_pending',
    approvalId: `ap-${Math.random()}`,
    sessionId: SID,
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    ...over,
  };
}

beforeEach(() => {
  toasted = [];
  approvals.set((s: any) => ({ ...s, pending: [] }));
  sessions.set({ view: 'list', currentSessionId: null, maxTranscriptLines: 500, sessionsById: new Map() });
  sessions.ensureSlice(SID);
  installDispatchDeps({
    state: {},
    renderSession() {},
    renderList() {},
    ensureAskInlineTile() {},
    sendApprovalDecide() {},
    showApprovalToast: (a: any) => toasted.push(a),
  });
});

describe('approval_pending toast gating', () => {
  it('toasts when the session is nowhere on screen', () => {
    dispatchBroadcast(pending());
    expect(toasted).toHaveLength(1);
  });

  // Desktop: no mobile-shaped view flip, so the mounted-view count is the only
  // signal that the transcript (and its inline approval card) is already visible.
  it('stays silent when the session view is mounted (desktop / inline job step)', () => {
    sessions.mountView(SID);
    dispatchBroadcast(pending());
    expect(toasted).toHaveLength(0);
  });

  it('toasts again once that view unmounts', () => {
    sessions.mountView(SID);
    sessions.unmountView(SID);
    dispatchBroadcast(pending());
    expect(toasted).toHaveLength(1);
  });

  it('stays silent mid-mount on mobile, before mountedCount lands', () => {
    sessions.set((s: any) => ({ ...s, view: 'session', currentSessionId: SID }));
    dispatchBroadcast(pending());
    expect(toasted).toHaveLength(0);
  });

  it('toasts for a background session while another one is open', () => {
    sessions.set((s: any) => ({ ...s, view: 'session', currentSessionId: SID }));
    sessions.mountView(SID);
    dispatchBroadcast(pending({ sessionId: 'sess-2' }));
    expect(toasted).toHaveLength(1);
  });
});
