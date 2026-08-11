import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { stepDotState } from '../../src/pwa/components/work/ticket-row.js';

describe('stepDotState', () => {
  // Same gap Critical 2 named in focusAction/stepWaitPill: a dispatch-raised draft never
  // flips the PARENT step's own `state` to `gate_pending_approval` (only the dispatch's own
  // status does), so the job-list row's mini step-dot must check `drafts` directly too —
  // otherwise the row's overall tone (jobTone, via needsYou) and its own per-step dot would
  // disagree about which step needs the user.
  it('is gate for a step with an unapproved draft even while its own state is still waiting', () => {
    expect(stepDotState({
      type: 'orchestrated', state: 'waiting',
      drafts: [{ id: 'd1', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' } }],
    })).toBe('gate');
  });

  it('is gate for the ordinary gate_pending_approval case', () => {
    expect(stepDotState({ type: 'action', state: 'gate_pending_approval' })).toBe('gate');
  });

  it('is todo for a plain waiting orchestrated step with no draft', () => {
    expect(stepDotState({ type: 'orchestrated', state: 'waiting' })).toBe('todo');
  });

  // A declined ActionStep keeps its sessionId (nothing clears it) — without an explicit
  // check it fell through to `s.sessionId ? 'active' : 'todo'` and read as still running,
  // while the timeline dot (step-card.js) already correctly shows its own ⊘ for this state.
  it('is not active for a declined step even though sessionId is still set', () => {
    expect(stepDotState({ type: 'action', state: 'declined', sessionId: 'sess1' })).not.toBe('active');
  });
});
