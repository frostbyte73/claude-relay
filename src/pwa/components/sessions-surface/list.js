// Sessions list column: header · filter (shell.focusFilter, via the shared
// .o-list-filter class the global keymap already targets) · tabs · Running/Idle/Recent
// groups · rich cards. Replaces the per-project accordion of the legacy
// shell/list-sessions.js with the state-grouped list the redesign calls for
// (sessions-list.html is authoritative).
//
// Known limitation (documented, not silently papered over): the 2-line
// last-turn preview is only derivable for sessions that already have a live
// slice in state/sessions.js — i.e. ones opened at least once this browser
// session. Sessions the client has never loaded a transcript for render without
// a preview line. (The action/session badge is NOT subject to this — it's
// stamped server-side onto the session record, so it's always present.)

import { sessions } from '../../state/sessions.js';
import { approvals } from '../../state/approvals.js';
import { subagents } from '../../state/subagents.js';
import { keymap } from '../../state/keymap.js';
import { formatCombo } from '../../utils/hotkey.js';
import { nav } from '../../state/nav.js';
import { sessionGroups, deriveLastTurnPreview, fmtElapsedDuration } from '../../vm/sessions.js';
import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { openPalette } from '../palette/index.js';
import { startSession } from '../../session-launch.js';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'session', label: 'Session' },
  { key: 'action', label: 'Action' },
];

const TAB_KEY = 'op:sessions:tab';
const TAB_KEYS = new Set(TABS.map((t) => t.key));

function idleFor(lastModified) {
  const ms = Date.now() - (lastModified ?? Date.now());
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m idle`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h idle`;
  return `${Math.floor(hrs / 24)}d idle`;
}

function relativeDay(lastModified) {
  const days = Math.floor((Date.now() - (lastModified ?? Date.now())) / 86_400_000);
  if (days <= 0) return relPast(lastModified);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function shortCwd(cwd) {
  if (!cwd) return '—';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 3) return cwd;
  return '/' + parts.slice(-3).join('/');
}

function truncate(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function subagentCountBySession() {
  const map = new Map();
  for (const [sid, slice] of subagents.get().bySession) map.set(sid, slice.byId.size);
  return map;
}

function approvalSessionIds() {
  return new Set((approvals.get().pending ?? []).map((a) => a.sessionId).filter(Boolean));
}

// Best-effort last-turn preview, derived from whatever transcript this browser
// session has already loaded for a live slice (see module doc).
function previewBySession() {
  const map = new Map();
  for (const [id, slice] of sessions.get().sessionsById) {
    const preview = deriveLastTurnPreview(slice.transcript);
    if (preview) map.set(id, preview);
  }
  return map;
}

function cardHtml(item, { isActive, runningMs }) {
  const isAction = item.sessionClass === 'action';
  const badgeText = isAction ? (item.actionLabel || 'action') : 'session';
  const skillBadge = `<span class="o-pill code sess-skill${isAction ? '' : ' free'}">${escapeHtml(badgeText)}</span>`;
  const running = item.runState === 'foreground' || item.runState === 'background';
  const iconState = running ? 'busy' : 'idle';
  let timeLabel;
  if (running) {
    timeLabel = escapeHtml(fmtElapsedDuration(runningMs) || 'running');
  } else if (item.archived) {
    timeLabel = escapeHtml(relativeDay(item.lastModified));
  } else {
    timeLabel = escapeHtml(idleFor(item.lastModified));
  }
  const preview = item.preview ? `<div class="o-row-sub sess-last">${escapeHtml(truncate(item.preview, 180))}</div>` : '';
  const badges = [];
  if (item.subagentCount > 0) badges.push(`<span class="o-pill">${item.subagentCount} subagent${item.subagentCount === 1 ? '' : 's'}</span>`);
  if (item.hasApproval) badges.push(`<span class="o-pill review">Approval pending</span>`);
  return `
    <button type="button" class="o-row sess-card${isActive ? ' active' : ''}" data-session-id="${escapeHtml(item.id)}">
      <span class="o-row-icon ${iconState}" aria-hidden="true">●</span>
      <div class="sess-card-body">
        <div class="sess-hdr">${skillBadge}</div>
        <div class="o-row-title">${escapeHtml(item.title ?? '(untitled)')}</div>
        ${preview}
        <div class="o-row-sub sess-foot">
          <span class="cwd">${escapeHtml(shortCwd(item.cwd))}</span>
          ${badges.join('')}
        </div>
      </div>
      <span class="o-row-time">${timeLabel}</span>
    </button>
  `;
}

function sectionHtml(label, items, selected, runningSince) {
  const rows = items.map((it) => cardHtml(it, {
    isActive: it.id === selected,
    runningMs: runningSince.has(it.id) ? Date.now() - runningSince.get(it.id) : null,
  })).join('');
  return `<div class="sess-group-label o-microhead">${escapeHtml(label)} · ${items.length}</div><div class="o-row-group">${rows}</div>`;
}

export function renderList(mount) {
  mount.classList.add('sess-list');
  let tab = (() => { try { const t = localStorage.getItem(TAB_KEY); return t && TAB_KEYS.has(t) ? t : 'all'; } catch { return 'all'; } })();
  let filter = '';
  const runningSince = new Map();
  const itemsById = new Map();

  mount.innerHTML = `
    <div class="sess-list-hdr">
      <h2>Sessions</h2>
      <span class="sess-list-count"></span>
    </div>
    <div class="o-list-filterbar sess-list-searchbar">
      <input type="search" class="o-list-filter sess-list-search" placeholder="Filter sessions…" aria-label="Filter sessions">
      <span class="o-kbd sess-filter-kbd">${formatCombo(keymap.bindingFor('shell.focusFilter'))}</span>
    </div>
    <div class="sess-list-tabs" role="tablist" aria-label="Filter by kind"></div>
    <div class="sess-list-body"></div>
    <button type="button" class="sess-new-btn">+ New session<span class="sess-new-kbd"> · <span class="o-kbd">${formatCombo(keymap.bindingFor('shell.togglePalette'))}</span></span></button>
  `;
  const countEl = mount.querySelector('.sess-list-count');
  const tabsEl = mount.querySelector('.sess-list-tabs');
  const bodyEl = mount.querySelector('.sess-list-body');
  const filterInput = mount.querySelector('.sess-list-search');
  const newBtn = mount.querySelector('.sess-new-btn');
  const filterKbd = mount.querySelector('.sess-filter-kbd');
  const newKbd = newBtn.querySelector('.o-kbd');

  newBtn.addEventListener('click', () => openPalette());
  filterInput.addEventListener('input', (e) => { filter = e.target.value; paint(); });

  function renderTabs() {
    tabsEl.innerHTML = TABS.map((t) =>
      `<button type="button" class="sess-tab${t.key === tab ? ' active' : ''}" data-tab="${t.key}">${escapeHtml(t.label)}</button>`
    ).join('');
    for (const btn of tabsEl.querySelectorAll('.sess-tab')) {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === tab) return;
        tab = btn.dataset.tab;
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
        renderTabs();
        paint();
      });
    }
  }
  renderTabs();

  function wireCardClicks() {
    for (const card of bodyEl.querySelectorAll('.sess-card')) {
      card.addEventListener('click', () => {
        const id = card.dataset.sessionId;
        const item = itemsById.get(id);
        if (!item) return;
        startSession({
          id,
          cwd: item.cwd,
          spawnCwd: item.worktreePath ?? item.cwd,
          title: item.title,
          worktreePath: item.worktreePath,
          worktreeBranch: item.worktreeBranch,
        });
        nav.select('sessions', id);
      });
    }
  }

  function paint() {
    const prevScroll = bodyEl.scrollTop;
    const projects = sessions.get().projects ?? [];
    const sessionsById = sessions.get().sessionsById;
    const subCounts = subagentCountBySession();
    const approvalIds = approvalSessionIds();
    const common = { projects, sessionsById, subagentCountBySession: subCounts, approvalSessionIds: approvalIds, previewBySession: previewBySession() };

    // Unfiltered pass drives the header count and the running-duration tracker
    // (background/idle sessions still need their clock ticking even while a
    // tab/filter hides them from the visible list).
    const full = sessionGroups({ ...common, tab: 'all', filter: '', showArchived: true });
    const allItems = [...full.running, ...full.idle, ...full.recent];
    itemsById.clear();
    const now = Date.now();
    for (const item of allItems) {
      itemsById.set(item.id, item);
      const running = item.runState === 'foreground' || item.runState === 'background';
      if (running && !runningSince.has(item.id)) runningSince.set(item.id, now);
      if (!running && runningSince.has(item.id)) runningSince.delete(item.id);
    }
    countEl.textContent = `${full.running.length} running · ${allItems.length} total`;

    const groups = sessionGroups({ ...common, tab, filter, showArchived: false });
    const selected = nav.get().selectionBySurface.sessions ?? null;
    const sections = [];
    if (groups.running.length) sections.push(sectionHtml('Running', groups.running, selected, runningSince));
    if (groups.idle.length) sections.push(sectionHtml('Idle', groups.idle, selected, runningSince));
    if (groups.recent.length) sections.push(sectionHtml('Recent', groups.recent, selected, runningSince));
    bodyEl.innerHTML = sections.join('') || `<div class="o-frame-empty">No sessions match.</div>`;
    bodyEl.scrollTop = prevScroll;
    wireCardClicks();
  }

  paint();
  // Nav-only changes (a different card selected) don't need a full repaint —
  // just flip the .active class — but running-state/approvals/subagent ticks
  // do need the list re-derived. A 1s ticker keeps "4m 08s" advancing without
  // wiring a store subscription for wall-clock time.
  const refreshActive = () => {
    const selected = nav.get().selectionBySurface.sessions ?? null;
    for (const card of bodyEl.querySelectorAll('.sess-card')) {
      card.classList.toggle('active', card.dataset.sessionId === selected);
    }
  };
  // Coalesce to one repaint per frame — paint() re-derives every group twice and
  // rebuilds the list via innerHTML, while the stores fan out synchronously with
  // no batching (state/create-store.js). Without this, hydrating one long session
  // drives a full rebuild per transcript append and per subagent entry.
  let paintRaf = 0;
  const schedulePaint = () => {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(() => { paintRaf = 0; paint(); });
  };
  const unsubSessions = sessions.subscribe(schedulePaint);
  const unsubApprovals = approvals.subscribe(schedulePaint);
  const unsubSubagents = subagents.subscribe(schedulePaint);
  const unsubNav = nav.subscribe(refreshActive);
  const unsubKeymap = keymap.subscribe(() => {
    filterKbd.textContent = formatCombo(keymap.bindingFor('shell.focusFilter'));
    newKbd.textContent = formatCombo(keymap.bindingFor('shell.togglePalette'));
  });
  const ticker = setInterval(() => {
    if (runningSince.size > 0) schedulePaint();
  }, 1000);
  return () => {
    if (paintRaf) cancelAnimationFrame(paintRaf);
    unsubSessions(); unsubApprovals(); unsubSubagents(); unsubNav(); unsubKeymap();
    clearInterval(ticker);
  };
}
