// Compact renderers for the ancillary regions above the composer: thinking
// indicator, todo count pill, and connection banner. The meter strip lives in
// ./meter.js (mobile-only chrome); the agents entry point reuses agents-
// sheet's agentsStripHtml directly; the full todos sheet is todos-sheet.js —
// session-view/index.js wires all of these (D7 convergence).
//
// Each renderer takes a target element + the slice (or global state) it reads.
// Session-view calls them on every slice tick.
import { escapeHtml } from '../../util.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { openTodosSheet } from '../todos-sheet.js';

export const TOOL_VERBS = {
  Bash: 'running',
  Read: 'reading',
  Write: 'writing',
  Edit: 'editing',
  MultiEdit: 'editing',
  Grep: 'searching',
  Glob: 'searching',
  WebFetch: 'fetching',
  WebSearch: 'searching',
  Task: 'delegating',
  Skill: 'using skill',
  ToolSearch: 'searching',
};

// Duration formatting mirrors the legacy thinkingMetaText: sub-10s to one
// decimal, sub-minute to integer, minute+ to mm:ss.
function fmtDuration(startedAt) {
  if (!startedAt) return '';
  const secs = (Date.now() - startedAt) / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.floor(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Static thinking-strip HTML for use inside re-rendered containers (e.g. the
// docked subagent feed cards, which are rebuilt on every subagent tick). Unlike
// renderThinkingStrip below, this returns a string — no patch-in-place, so the
// dots' animation restarts each rebuild. Acceptable for the passive docked
// strip; the primary session strip stays on the in-place path so its dot wave
// is smooth. Callers supply the verb (e.g. "reading" for Read, or "thinking"
// fallback) and an optional meta string (duration, tool name, etc.).
export function thinkingStripHtml(verb, meta) {
  return (
    `<div class="thinking-strip" role="status" aria-live="polite">` +
      `<span class="thinking-strip-label">${escapeHtml(verb || 'thinking')}</span>` +
      `<span class="thinking-strip-dots" aria-hidden="true"><span></span><span></span><span></span></span>` +
      (meta ? `<span class="thinking-strip-meta">${escapeHtml(meta)}</span>` : '') +
    `</div>`
  );
}

// Duration formatter re-exported so callers (docked feeds) can compute the
// meta line without importing the private helper below.
export function fmtStripDuration(startedAt) {
  return fmtDuration(startedAt);
}

// Thinking strip. The verb reflects the newest active tool (LIFO), falling
// back to the slice's lingeringVerb, then a generic "thinking". Reads `thinking`
// and `thinkingStartedAt` off the slice — per-session, so each mounted view
// shows its own session's state.
// Called on the 200ms meta ticker as well as slice changes, so this MUST patch
// in-place when the strip already exists. Rebuilding innerHTML each tick would
// re-create the .thinking-strip-dots spans and restart their CSS animations from
// t=0, which makes dots 2 and 3 (0.16s / 0.32s animation-delay) never reach their
// bright frame before being replaced.
export function renderThinkingStrip(region, slice) {
  if (!slice?.thinking) { region.innerHTML = ''; return; }
  const activeTools = slice.activeTools ?? [];
  const top = activeTools.length ? activeTools[activeTools.length - 1] : null;
  const verb = top
    ? (TOOL_VERBS[top.toolName] || 'thinking')
    : (slice.lingeringVerb || 'thinking');
  const meta = fmtDuration(slice.thinkingStartedAt);
  const existing = region.firstElementChild;
  if (existing && existing.classList.contains('thinking-strip')) {
    const labelEl = existing.querySelector('.thinking-strip-label');
    if (labelEl && labelEl.textContent !== verb) labelEl.textContent = verb;
    let metaEl = existing.querySelector('.thinking-strip-meta');
    if (meta) {
      if (!metaEl) {
        metaEl = document.createElement('span');
        metaEl.className = 'thinking-strip-meta';
        existing.appendChild(metaEl);
      }
      if (metaEl.textContent !== meta) metaEl.textContent = meta;
    } else if (metaEl) {
      metaEl.remove();
    }
    return;
  }
  region.innerHTML =
    `<div class="thinking-strip" role="status" aria-live="polite">` +
      `<span class="thinking-strip-label">${escapeHtml(verb)}</span>` +
      `<span class="thinking-strip-dots" aria-hidden="true"><span></span><span></span><span></span></span>` +
      (meta ? `<span class="thinking-strip-meta">${escapeHtml(meta)}</span>` : '') +
    `</div>`;
}

// Two-row task trail: most recently completed task on top (dim + strikethrough),
// in_progress/next task below (alive). Connected by a vertical hairline so the
// panel reads as a tiny timeline. Tapping opens the full todos sheet.
// Like renderThinkingStrip, this runs on every paint — so it must not rewrite
// unconditionally: the in_progress `.todos-node` carries an infinite CSS pulse
// that restarts from t=0 whenever its element is re-created. The panel's content
// only changes when the todos do, so an equality guard skips virtually every
// rewrite (setHtmlIfChanged also keeps the existing click handler valid).
export function renderTodoPill(region, slice, sessionId = null) {
  const todos = slice?.todos;
  if (!todos || todos.size === 0) { setHtmlIfChanged(region, ''); return; }
  const all = sortedTodoEntries(todos);
  const active = all.filter(([, t]) => t.status !== 'completed' && t.status !== 'deleted');
  const done = all.filter(([, t]) => t.status === 'completed');
  const lastDone = done.length ? done[done.length - 1] : null;
  const upNow = active.find(([, t]) => t.status === 'in_progress') ?? active[0] ?? null;
  const counter = `${done.length}/${all.length}`;
  if (!upNow && !lastDone) { setHtmlIfChanged(region, ''); return; }

  let html;
  if (!upNow) {
    html =
      `<button class="todos-panel todos-panel-done" type="button" aria-label="Open task list">` +
        `<span class="todos-trail-line">` +
          `<span class="todos-node todos-node-done" aria-hidden="true"></span>` +
          `<span class="todos-text todos-text-done">All ${escapeHtml(String(all.length))} complete</span>` +
          `<span class="todos-meta">${escapeHtml(counter)} <span class="todos-expand">⌃</span></span>` +
        `</span>` +
      `</button>`;
  } else {
    const topRow = lastDone ? trailRowHtml(lastDone[0], lastDone[1], 'done') : '';
    const bottomRow = trailRowHtml(upNow[0], upNow[1], 'now');
    html =
      `<button class="todos-panel" type="button" aria-label="Open task list (${escapeHtml(counter)} complete)">` +
        topRow +
        bottomRow +
        `<span class="todos-panel-meta" aria-hidden="true">` +
          `<span class="todos-meta-count">${escapeHtml(counter)}</span>` +
          `<span class="todos-expand">⌃</span>` +
        `</span>` +
      `</button>`;
  }
  if (!setHtmlIfChanged(region, html)) return;
  const btn = region.querySelector('.todos-panel');
  if (btn) btn.onclick = () => openTodosSheet(sessionId);
}

function sortedTodoEntries(todos) {
  return [...todos.entries()].sort((a, b) => {
    const ai = parseInt(a[0], 10), bi = parseInt(b[0], 10);
    if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
    return String(a[0]).localeCompare(String(b[0]));
  });
}

function trailRowHtml(id, t, slot) {
  const status = (t && typeof t.status === 'string') ? t.status : 'pending';
  const subject = (t && typeof t.subject === 'string') ? t.subject : `Task #${id}`;
  const active = (t && typeof t.activeForm === 'string') ? t.activeForm : '';
  const display = slot === 'now' && status === 'in_progress' && active ? active : subject;
  return `<span class="todos-trail-line todos-trail-${slot} todos-status-${escapeHtml(status)}">` +
    `<span class="todos-node" aria-hidden="true"></span>` +
    `<span class="todos-text">${escapeHtml(display)}</span>` +
  `</span>`;
}

// Connection banner. Callers pass THIS mount's own socket state (see
// sessionConnState in index.js): 'reconnecting' renders a quiet status line
// while session-ws backs off, 'failed' (past the backoff threshold) adds the
// retry affordance.
export function renderConnBanner(region, connState, onRetry) {
  if (connState === 'reconnecting') {
    const existing = region.querySelector('.conn-banner-reconnecting');
    if (existing) return; // don't restart the pulse on every repaint
    region.innerHTML =
      `<div class="conn-banner conn-banner-reconnecting" role="status">` +
        `<span class="conn-banner-msg">Reconnecting…</span>` +
      `</div>`;
    return;
  }
  if (connState !== 'failed') { region.innerHTML = ''; return; }
  if (region.querySelector('.sv-conn-retry')) return;
  region.innerHTML =
    `<div class="conn-banner" role="alert">` +
      `<span class="conn-banner-msg">Daemon unreachable — check Tailscale</span>` +
      `<button type="button" class="sv-conn-retry">Retry</button>` +
    `</div>`;
  region.querySelector('.sv-conn-retry')?.addEventListener('click', () => onRetry?.());
}
