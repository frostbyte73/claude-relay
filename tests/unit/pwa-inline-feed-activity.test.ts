// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTrackedDetail } from '../../src/pwa/components/tracked/detail.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { work } from '../../src/pwa/state/work.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessions } from '../../src/pwa/state/sessions.js';

// Sending review comments from the git view drains the step's inbox, which sets
// `state: 'running'` and clears `waitingOn` (drainForDelivery in
// steps/orchestrated-inbox.ts) BEFORE anything is spawned: resumeControllerRound
// still has to await a worktree provision and clear the launch governor. Across
// that whole window the step is running, no session is working, and the feed has
// nothing but `phase` left to say — so it painted the bare phase label as a parked
// status ("⏸ Implement"), which is exactly what a step parked for an hour looks
// like. The user cannot tell their feedback landed.
//
// Then, once the session does start streaming, the ONLY thing that flips the feed
// off that chip is `job.live.sessionIds` — server-derived, recomputed on discrete
// daemon edges, and delivered on the notifications WS rather than the per-session
// WS the feed is already attached to. The feed holds direct evidence of the turn
// (its own slice is thinking) and was discarding it in favour of that laggy
// out-of-band boolean.

const SESSION = 'sess-impl';

function job({ live = [], state = 'running', waitingOn = null as unknown, lastDelivered = [] as unknown[] }) {
  return {
    id: 'j1', title: 'Ship it', state: 'executing', source: 'manual',
    createdAt: 1, updatedAt: 100,
    events: [],
    steps: [{
      id: 'st1', type: 'orchestrated', title: 'Implement', controller: 'code.orchestrate-pr',
      phase: 'implement', state, waitingOn, lastDelivered, sessionId: SESSION, cancelled: false,
      createdAt: 1, updatedAt: 100,
      dispatches: [], inbox: [], drafts: [], artifacts: {},
      events: [{ kind: 'spawned', at: 1 }],
      workspace: { kind: 'writable', repoCwd: '/repo', branch: 'feat/x' },
    }],
    live: { orchestrator: false, stepIds: live.length ? ['st1'] : [], sessionIds: live },
  };
}

function seed(opts: Parameters<typeof job>[0]) {
  work.applyWsEvent({ jobId: 'j1', job: job(opts) });
}

const chipText = (root: HTMLElement) =>
  root.querySelector('.inline-session-chip')?.textContent?.trim() ?? null;

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  // The store is a module singleton, so a test that leaves the slice mid-turn would decide
  // the next one's first paint.
  sessions.for(SESSION).stopThinking();
});

describe('inline feed during the resume window', () => {
  it('a step woken by review feedback names the message, not a bare phase label', () => {
    // Exactly what the diff view leaves behind: inbox drained onto lastDelivered,
    // state flipped to running, waitingOn cleared, nothing spawned yet.
    seed({
      live: [], state: 'running', waitingOn: null,
      lastDelivered: [{ id: 'i1', at: 1, kind: 'user-message', body: 'passthrough is file only' }],
    });
    renderTrackedDetail(root, 'j1');

    // No pause chip at all — this state is moving, so it gets the animated strip.
    expect(chipText(root)).toBeNull();
    expect(root.querySelector('.thinking-strip-label')?.textContent).toBe('Picking up your message');
  });

  it('a resume with no user message still reads as moving rather than parked', () => {
    seed({ live: [], state: 'running', waitingOn: null });
    renderTrackedDetail(root, 'j1');
    expect(chipText(root)).not.toBe('⏸ Implement');
    expect(root.querySelector('.thinking-strip-label')?.textContent).toBe('Resuming');
  });

  it('still shows a genuinely parked controller its own reason', () => {
    seed({ live: [], state: 'waiting', waitingOn: { reason: 'Watching CI', events: ['pr-state'] } });
    renderTrackedDetail(root, 'j1');
    expect(chipText(root)).toBe('⏸ Watching CI');
  });
});

describe('inline feed trusts its own session stream over job liveness', () => {
  it('shows the live turn when the slice is thinking even though `live` says idle', () => {
    seed({ live: [], state: 'running', waitingOn: null });
    renderTrackedDetail(root, 'j1');

    // The per-session WS delivers the turn. `live` has not been re-broadcast yet
    // (governor/provision window, or a missed edge) — the feed must not care.
    sessions.for(SESSION).startThinking();

    expect(root.querySelector('.inline-session-chip')).toBeNull();
    expect(root.querySelector('.thinking-strip')).not.toBeNull();
  });

  it('falls back to the parked chip once the turn ends and liveness still says idle', () => {
    seed({ live: [], state: 'waiting', waitingOn: { reason: 'Watching CI', events: ['pr-state'] } });
    renderTrackedDetail(root, 'j1');
    sessions.for(SESSION).startThinking();
    expect(root.querySelector('.inline-session-chip')).toBeNull();

    sessions.for(SESSION).stopThinking();
    expect(chipText(root)).toBe('⏸ Watching CI');
  });
});
