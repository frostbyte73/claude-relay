// Sessions list column: header · filter (shell.focusFilter, via the shared
// .o-list-filter class the global keymap already targets) · tabs ·
// Sessions/Actions/Idle/Recent groups · rich cards. Replaces the per-project
// accordion of the legacy shell/list-sessions.js with the state-grouped list the
// redesign calls for (sessions-list.html is authoritative).
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
import { placeKeyedNodes } from '../../utils/keyed-rows.js';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'session', label: 'Session' },
  { key: 'action', label: 'Action' },
];

const TAB_KEY = 'op:sessions:tab';
const TAB_KEYS = new Set(TABS.map((t) => t.key));

// Section order, top to bottom; `group` keys into sessionGroups()'s return.
const SECTIONS = [
  { label: 'Sessions', group: 'sessions' },
  { label: 'Actions', group: 'actions' },
  { label: 'Idle', group: 'idle' },
  { label: 'Recent', group: 'recent' },
];

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

// ── Cards ────────────────────────────────────────────────────────────────
// A card is built once per session and then patched field by field, never
// re-rendered from a string. The live dot (`.o-row-icon.busy`) carries an
// infinite CSS pulse, and a re-created element restarts its keyframes from
// zero — so rebuilding the list on every store tick (a message in ANY session,
// any subagent entry, plus the 1s duration ticker) made every dot in the list
// reset and re-sync. Patching leaves the animating node alone.

function timeLabelFor(item, runningMs, running) {
  if (running) return fmtElapsedDuration(runningMs) || 'running';
  if (item.archived) return relativeDay(item.lastModified);
  return idleFor(item.lastModified);
}

function badgesHtml(item) {
  const badges = [];
  if (item.subagentCount > 0) badges.push(`<span class="o-pill">${item.subagentCount} subagent${item.subagentCount === 1 ? '' : 's'}</span>`);
  if (item.hasApproval) badges.push(`<span class="o-pill review">Approval pending</span>`);
  return badges.join('');
}

// Structure matches what the old string renderer emitted, so the primitives'
// grid/`:first-child` radius rules and `.sess-foot`'s flex gap are unchanged.
// `.sess-last` is always present and toggled with `hidden` (display:none keeps
// it out of the body's flex gap) so its ref stays stable.
function buildCard(item) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'o-row sess-card';
  el.dataset.sessionId = item.id;
  el.innerHTML = `
    <span class="o-row-icon" aria-hidden="true">●</span>
    <div class="sess-card-body">
      <div class="sess-hdr"><span class="o-pill code sess-skill"></span></div>
      <div class="o-row-title"></div>
      <div class="o-row-sub sess-last" hidden></div>
      <div class="o-row-sub sess-foot"><span class="cwd"></span></div>
    </div>
    <span class="o-row-time"></span>
  `;
  return {
    el,
    icon:  el.querySelector('.o-row-icon'),
    skill: el.querySelector('.sess-skill'),
    title: el.querySelector('.o-row-title'),
    last:  el.querySelector('.sess-last'),
    foot:  el.querySelector('.sess-foot'),
    cwd:   el.querySelector('.cwd'),
    time:  el.querySelector('.o-row-time'),
    badges: '',
  };
}

function patchCard(card, item, { isActive, runningMs }) {
  const running = item.runState === 'foreground' || item.runState === 'background';
  const isAction = item.sessionClass === 'action';

  setClass(card.icon, `o-row-icon ${running ? 'busy' : 'idle'}`);
  card.el.classList.toggle('active', isActive);
  setClass(card.skill, `o-pill code sess-skill${isAction ? '' : ' free'}`);
  setText(card.skill, isAction ? (item.actionLabel || 'action') : 'session');
  setText(card.title, item.title ?? '(untitled)');
  setText(card.cwd, shortCwd(item.cwd));
  setText(card.time, timeLabelFor(item, runningMs, running));

  const preview = item.preview ? truncate(item.preview, 180) : '';
  card.last.hidden = preview === '';
  setText(card.last, preview);

  // Pills are direct children of .sess-foot (its flex gap spaces them), so they
  // are swapped in place rather than wrapped in a container.
  const pills = badgesHtml(item);
  if (pills !== card.badges) {
    card.badges = pills;
    for (const pill of [...card.foot.querySelectorAll('.o-pill')]) pill.remove();
    if (pills) card.foot.insertAdjacentHTML('beforeend', pills);
  }
}

// Skip no-op writes: assigning an identical className or textContent still
// dirties style/layout for the node.
function setClass(el, cls) {
  if (el.className !== cls) el.className = cls;
}
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
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

  // Delegated once — cards persist across repaints now, but a click handler per
  // card is still needless work on a long list.
  bodyEl.addEventListener('click', (e) => {
    const cardEl = e.target instanceof Element ? e.target.closest('.sess-card') : null;
    if (!cardEl) return;
    const id = cardEl.dataset.sessionId;
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

  // Section skeletons (label + row group) exist for the life of the mount and
  // are hidden when empty, so a card never has to be re-created just because a
  // neighbouring section appeared or vanished.
  const sectionDom = new Map();
  for (const { label } of SECTIONS) {
    const labelEl = document.createElement('div');
    labelEl.className = 'sess-group-label o-microhead';
    const groupEl = document.createElement('div');
    groupEl.className = 'o-row-group';
    labelEl.hidden = true;
    groupEl.hidden = true;
    bodyEl.append(labelEl, groupEl);
    sectionDom.set(label, { labelEl, groupEl });
  }
  const emptyEl = document.createElement('div');
  emptyEl.className = 'o-frame-empty';
  emptyEl.textContent = 'No sessions match.';
  emptyEl.hidden = true;
  bodyEl.append(emptyEl);

  // sessionId → card refs, reused for as long as the session is in the list.
  const cards = new Map();

  function paintSection(label, items, selected) {
    const { labelEl, groupEl } = sectionDom.get(label);
    labelEl.hidden = items.length === 0;
    groupEl.hidden = items.length === 0;
    if (items.length === 0) {
      placeKeyedNodes(groupEl, []);
      return;
    }
    setText(labelEl, `${label} · ${items.length}`);
    const placed = items.map((item) => {
      let card = cards.get(item.id);
      if (!card) { card = buildCard(item); cards.set(item.id, card); }
      patchCard(card, item, {
        isActive: item.id === selected,
        runningMs: runningSince.has(item.id) ? Date.now() - runningSince.get(item.id) : null,
      });
      return { key: item.id, node: card.el };
    });
    placeKeyedNodes(groupEl, placed);
  }

  function paint() {
    const projects = sessions.get().projects ?? [];
    const sessionsById = sessions.get().sessionsById;
    const subCounts = subagentCountBySession();
    const approvalIds = approvalSessionIds();
    const common = { projects, sessionsById, subagentCountBySession: subCounts, approvalSessionIds: approvalIds, previewBySession: previewBySession() };

    // Unfiltered pass drives the header count and the running-duration tracker
    // (background/idle sessions still need their clock ticking even while a
    // tab/filter hides them from the visible list).
    const full = sessionGroups({ ...common, tab: 'all', filter: '', showArchived: true });
    const allItems = SECTIONS.flatMap((s) => full[s.group]);
    itemsById.clear();
    const now = Date.now();
    for (const item of allItems) {
      itemsById.set(item.id, item);
      const running = item.runState === 'foreground' || item.runState === 'background';
      if (running && !runningSince.has(item.id)) runningSince.set(item.id, now);
      if (!running && runningSince.has(item.id)) runningSince.delete(item.id);
    }
    countEl.textContent = `${full.sessions.length + full.actions.length} running · ${allItems.length} total`;

    const groups = sessionGroups({ ...common, tab, filter, showArchived: false });
    const selected = nav.get().selectionBySurface.sessions ?? null;
    for (const { label, group } of SECTIONS) paintSection(label, groups[group], selected);
    const shown = SECTIONS.flatMap((s) => groups[s.group]);
    emptyEl.hidden = shown.length > 0;
    // Drop cards for sessions that left the list entirely, so the map can't grow
    // for the life of the tab.
    const live = new Set(shown.map((i) => i.id));
    for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);
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
  // Coalesce to one repaint per frame — paint() re-derives every group twice,
  // while the stores fan out synchronously with no batching
  // (state/create-store.js). Without this, hydrating one long session drives a
  // full re-derive per transcript append and per subagent entry.
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
