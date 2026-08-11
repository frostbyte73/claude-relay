// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderList } from '../../src/pwa/components/sessions-surface/list.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { sessions } from '../../src/pwa/state/sessions.js';

// The live dot (.o-row-icon.busy) carries an infinite CSS pulse, so it must not
// be re-created by a repaint — a fresh element restarts its keyframes from zero,
// which is what made every dot in the list reset whenever any session or
// subagent produced a message. Node identity across a repaint IS the invariant;
// jsdom can't observe the animation itself.

const RUNNING = { id: 'sess-running', title: 'one', lastModified: Date.now(), runState: 'background' };
const OTHER = { id: 'sess-other', title: 'two', lastModified: Date.now(), runState: 'background' };

function seed(sessionList: unknown[]) {
  sessions.set((s: Record<string, unknown>) => ({
    ...s,
    projects: [{ cwd: '/repo', sessions: sessionList }],
  }));
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  seed([]);
});

describe('sessions list repaints without re-creating cards', () => {
  it('keeps the same dot element across an unrelated store tick', async () => {
    seed([RUNNING, OTHER]);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    renderList(mount);

    const card = mount.querySelector('.sess-card[data-session-id="sess-running"]')!;
    const dot = card.querySelector('.o-row-icon')!;
    expect(dot.className).toContain('busy');

    // A message landing in a *different* session — the exact trigger that used
    // to reset every dot in the list.
    sessions.for('sess-other').appendTranscript({ role: 'assistant', text: 'hi' });
    await nextFrame();

    expect(mount.querySelector('.sess-card[data-session-id="sess-running"]')).toBe(card);
    expect(card.querySelector('.o-row-icon')).toBe(dot);
  });

  it('patches the volatile fields in place rather than replacing the card', async () => {
    seed([RUNNING]);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    renderList(mount);

    const card = mount.querySelector('.sess-card')!;
    const dot = card.querySelector('.o-row-icon')!;
    expect(card.querySelector('.o-row-title')?.textContent).toBe('one');

    seed([{ ...RUNNING, title: 'renamed', runState: 'inactive' }]);
    await nextFrame();

    expect(mount.querySelector('.sess-card')).toBe(card);
    expect(card.querySelector('.o-row-icon')).toBe(dot);
    expect(card.querySelector('.o-row-title')?.textContent).toBe('renamed');
    // Same node, restyled — the pulse stops because the class changed, not
    // because the element was rebuilt.
    expect(dot.className).toContain('idle');
    expect(dot.className).not.toContain('busy');
  });

  it('drops a card once its session leaves the list', async () => {
    seed([RUNNING, OTHER]);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    renderList(mount);
    expect(mount.querySelectorAll('.sess-card').length).toBe(2);

    seed([RUNNING]);
    await nextFrame();

    expect(mount.querySelectorAll('.sess-card').length).toBe(1);
    expect(mount.querySelector('.sess-card')?.getAttribute('data-session-id')).toBe('sess-running');
  });
});
