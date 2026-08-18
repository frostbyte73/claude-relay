// Cockpit surface (main-only layout) — the "where am I needed" inbox. Renders the
// three sections from vm/cockpit.js: decisions parked on the user, things that
// broke, and a collapsed tail of what resolved without them.
//
// Re-render strategy: every subscribed store notifies far more often than the
// cockpit's own content actually changes. Store ticks are coalesced into one paint
// per animation frame, and each section compares a content signature (excludes the
// volatile `time` field) against its last paint — a tick that doesn't change what a
// section contains never touches the DOM. Row timestamps are refreshed
// independently on a 30s interval so "3m ago" labels don't go stale between
// content changes.

import { cockpitInbox } from '../../vm/cockpit.js';
import { approvals } from '../../state/approvals.js';
import { work } from '../../state/work.js';
import { schedulesStore } from '../../state/schedules.js';
import { runs } from '../../state/runs.js';
import { actions } from '../../state/actions.js';
import { nav } from '../../state/nav.js';
import { openScheduleDetail, openRunDetail } from '../../app-bridge.js';
import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { bindRowActivation } from '../../utils/row-activation.js';

const SECTION_DEFS = [
  { key: 'decide', label: 'Decide', empty: 'No decisions waiting.' },
  { key: 'broken', label: 'Broken', empty: 'Nothing broken.' },
  { key: 'cleared', label: 'Recently cleared', empty: 'Nothing cleared in the last 24h.', collapsed: true },
];

const TONE_GLYPH = { hot: '●', warn: '✕', ok: '✓' };

const TIME_REFRESH_MS = 30_000;

const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);

function glyphFor(tone) {
  return TONE_GLYPH[tone] ?? '○';
}

// Not every item has an honest timestamp — a schedule draft arrives over WS with no
// postedAt at all — and relPast(0) renders it as decades ago. No time beats a wrong one.
function fmtRowTime(t, now) {
  if (!t) return '';
  return relPast(t, now) ?? '';
}

function rowHtml(item, now) {
  const ref = item.ref ? `<span class="o-ref">${escapeHtml(item.ref)}</span>` : '';
  const detail = item.detail ? `<div class="o-row-sub">${escapeHtml(item.detail)}</div>` : '';
  return `
    <div class="o-row" data-row-id="${escapeHtml(item.key)}" role="button" tabindex="0">
      <span class="o-row-icon ${escapeHtml(item.tone ?? '')}">${glyphFor(item.tone)}</span>
      <div>
        <div class="o-row-title">${ref}${escapeHtml(item.title ?? '')}</div>
        ${detail}
      </div>
      <div class="o-row-time" data-time="${item.time ?? 0}">${escapeHtml(fmtRowTime(item.time, now))}</div>
    </div>`;
}

// Excludes `time` on purpose — it moves on every paint for live items, which would
// defeat the comparison.
function rowSignature(item) {
  return [item.key, item.tone, item.title, item.ref, item.detail].join('|');
}

function handleRowClick(item) {
  if (!item) return;
  if (item.kind === 'cleared-run') { openRunDetail(item.raw ?? null); return; }
  if (item.open?.surface === 'schedules') { openScheduleDetail(item.open.id ?? null); return; }
  if (item.open?.surface) nav.select(item.open.surface, item.open.id);
}

function buildSkeleton() {
  return `
    <div class="cockpit-quiet" hidden>Nothing needs you.</div>
    ${SECTION_DEFS.map((def) => `
      <div class="cockpit-group${def.collapsed ? ' collapsed' : ''}" data-group="${def.key}">
        <div class="o-group-hdr">
          <h2>${escapeHtml(def.label)}</h2>
          <span class="o-group-count"></span>
          <span class="o-group-rule"></span>
        </div>
        <div class="cockpit-group-body"></div>
      </div>`).join('')}
  `;
}

function refreshSectionTimes(bodyEl, now) {
  bodyEl.querySelectorAll('.o-row-time[data-time]').forEach((el) => {
    el.textContent = fmtRowTime(Number(el.dataset.time), now);
  });
}

function renderSection(state, items, now) {
  state.itemsByKey = new Map(items.map((i) => [i.key, i]));
  state.countEl.textContent = items.length ? String(items.length) : '';

  const nextSig = items.map(rowSignature).join('\n');
  if (state.sig === nextSig) {
    refreshSectionTimes(state.bodyEl, now);
    return;
  }
  state.sig = nextSig;
  state.bodyEl.innerHTML = items.length
    ? `<div class="o-row-group">${items.map((i) => rowHtml(i, now)).join('')}</div>`
    : `<div class="cockpit-empty">${escapeHtml(state.emptyText)}</div>`;
}

export function renderDetail(mount) {
  mount.textContent = '';
  const root = document.createElement('div');
  root.className = 'cockpit-view';
  root.innerHTML = buildSkeleton();
  mount.appendChild(root);

  const quietEl = root.querySelector('.cockpit-quiet');

  const sections = new Map(SECTION_DEFS.map((def) => {
    const groupEl = root.querySelector(`[data-group="${def.key}"]`);
    const state = {
      emptyText: def.empty,
      groupEl,
      countEl: groupEl.querySelector('.o-group-count'),
      bodyEl: groupEl.querySelector('.cockpit-group-body'),
      itemsByKey: new Map(),
      sig: null,
    };
    state.bodyEl.addEventListener('click', (e) => {
      const rowEl = e.target.closest('.o-row');
      if (!rowEl) return;
      handleRowClick(state.itemsByKey.get(rowEl.dataset.rowId));
    });
    bindRowActivation(state.bodyEl);
    if (def.collapsed) {
      groupEl.querySelector('.o-group-hdr').addEventListener('click', () => {
        groupEl.classList.toggle('collapsed');
      });
    }
    return [def.key, state];
  }));

  function paint() {
    const now = Date.now();
    const inbox = cockpitInbox({
      pendingApprovals: approvals.get().pending,
      jobs: work.get().jobs,
      actionEdits: actions.get().edits,
      scheduleDrafts: schedulesStore.get().draftBySession,
      runs: runs.get().runs,
      now,
    });
    // The empty inbox is the common case, not an error state — say so once and let
    // the sections collapse away rather than showing three "nothing here" boxes.
    const quiet = inbox.decide.length === 0 && inbox.broken.length === 0;
    quietEl.hidden = !quiet;
    for (const def of SECTION_DEFS) {
      const state = sections.get(def.key);
      state.groupEl.hidden = quiet && def.key !== 'cleared';
      renderSection(state, inbox[def.key] ?? [], now);
    }
  }

  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    raf(() => { scheduled = false; paint(); });
  }

  paint();

  const unsubs = [
    approvals.subscribe(scheduleRender),
    work.subscribe(scheduleRender),
    schedulesStore.subscribe(scheduleRender),
    runs.subscribe(scheduleRender),
    actions.subscribe(scheduleRender),
  ];
  const timer = setInterval(() => {
    for (const state of sections.values()) refreshSectionTimes(state.bodyEl, Date.now());
  }, TIME_REFRESH_MS);

  return () => {
    clearInterval(timer);
    for (const unsub of unsubs) unsub();
  };
}
