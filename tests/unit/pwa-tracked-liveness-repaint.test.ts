// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTrackedDetail } from '../../src/pwa/components/tracked/detail.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { work } from '../../src/pwa/state/work.js';

// The daemon re-broadcasts a job with UNCHANGED updatedAt purely to flip per-session
// liveness (daemon.ts's rebroadcastJobLiveness), and the work store keeps that update
// on purpose (mergeOne's strict `>`). The Tracked detail's repaint-skip key has to
// carry `live` or the inline feed never learns its session started/stopped working —
// it sits on the parked status chip while the controller streams, until the user
// navigates away and back.

const SESSION = 'sess-impl';

function job(live: string[], updatedAt = 100) {
  return {
    id: 'j1', title: 'Ship it', state: 'executing', source: 'manual',
    createdAt: 1, updatedAt,
    events: [],
    steps: [{
      id: 'st1', type: 'orchestrated', title: 'Implement', controller: 'code.orchestrate-pr',
      // Genuinely PARKED, which is the only state that still wears the idle chip: a
      // `running` step with no live session is mid-resume and gets the animated strip
      // instead (see pwa-inline-feed-activity.test.ts). The repaint-key behaviour this
      // file guards is the same either way.
      phase: 'implement', state: 'waiting', waitingOn: { reason: 'Watching CI' },
      sessionId: SESSION, cancelled: false,
      createdAt: 1, updatedAt,
      dispatches: [], inbox: [], drafts: [], artifacts: {},
      events: [{ kind: 'spawned', at: 1 }],
      workspace: { kind: 'writable', repoCwd: '/repo', branch: 'feat/x' },
    }],
    live: { orchestrator: false, stepIds: live.length ? ['st1'] : [], sessionIds: live },
  };
}

function seed(live: string[], updatedAt?: number) {
  work.applyWsEvent({ jobId: 'j1', job: job(live, updatedAt) });
}

function idleChip(root: HTMLElement) {
  return root.querySelector('.inline-session-chip[data-variant="idle"]');
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('Tracked detail repaints on a liveness-only job update', () => {
  it('drops the parked status chip once the step session starts working again', () => {
    seed([]);
    renderTrackedDetail(root, 'j1');
    expect(idleChip(root)?.textContent).toContain('Watching CI');

    // Same job, same updatedAt — only `live` moved.
    seed([SESSION]);
    renderTrackedDetail(root, 'j1');
    expect(idleChip(root)).toBeNull();
  });

  it('still skips the repaint when nothing at all changed', () => {
    seed([SESSION]);
    renderTrackedDetail(root, 'j1');
    const shell = root.querySelector('.tk-shell');

    seed([SESSION]);
    renderTrackedDetail(root, 'j1');
    expect(root.querySelector('.tk-shell')).toBe(shell);
  });
});
