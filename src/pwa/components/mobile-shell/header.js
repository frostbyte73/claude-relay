// The mobile header shapes (mobile-cockpit-tracked.html): list-root (Cockpit —
// greeting + compact usage widget), list (title + count sub + search/settings
// icons), drill-in (back chevron + compact title stack + ⋯ menu), and session
// (back chevron + title/branch/state stack + mode chip + diff + ⋯ menu). Built
// as plain functions that fill the shared #header element — mobile-header.js's
// setHeader() delegates to these for every mode; the session shape's store
// reads and action behavior stay in mobile-header.js.

import { usage } from '../../state/usage.js';
import { usageTier, clampPct, usagePopoverHtml } from '../../utils/usage-bar.js';
import { fmtRemaining } from '../../utils/formatting.js';
import { noteSheetOpen, noteSheetClose, pinSheetBelowHeader, makeSheetDismissible } from '../sheet-utils.js';
import { escapeHtml } from '../../util.js';

function usageBarRowHtml(staticLabel, pct, resetsAt) {
  const hasPct = typeof pct === 'number' && Number.isFinite(pct);
  const clamped = hasPct ? clampPct(pct) : 0;
  const tier = hasPct ? usageTier(clamped) : null;
  // Label shows time-until-reset when known, falling back to the window's static label.
  const label = fmtRemaining(resetsAt) ?? staticLabel;
  return `
    <div class="m-usage-row">
      <span class="m-usage-lbl">${escapeHtml(label)}</span>
      <div class="m-usage-bar"><div class="m-usage-fill${tier && tier !== 'ok' ? ` ${tier}` : ''}" style="width:${clamped}%"></div></div>
      <span class="m-usage-pct">${hasPct ? Math.round(clamped) : '—'}</span>
    </div>`;
}

function usageWidgetHtml(au) {
  return `
    <button type="button" class="m-usage" id="m-usage-trigger" aria-haspopup="dialog" aria-label="Account usage">
      ${usageBarRowHtml('5h', au?.five_hour?.used_percentage, au?.five_hour?.resets_at)}
      ${usageBarRowHtml('7d', au?.seven_day?.used_percentage, au?.seven_day?.resets_at)}
    </button>`;
}

let usageSheetTeardown = null;

function openUsageSheet() {
  if (usageSheetTeardown) return; // already open
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet m-usage-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Account usage');
  sheet.innerHTML = `
    <div class="grabber"></div>
    <div class="header-row">
      <span class="sheet-title">Usage</span>
      <button class="sheet-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="m-usage-sheet-body">${usagePopoverHtml(usage.get().accountUsage)}</div>
  `;
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => { backdrop.classList.add('open'); sheet.classList.add('open'); });
  pinSheetBelowHeader(sheet);
  noteSheetOpen(close);

  const unsubUsage = usage.subscribe(() => {
    sheet.querySelector('.m-usage-sheet-body').innerHTML = usagePopoverHtml(usage.get().accountUsage);
  });

  function close() {
    backdrop.classList.remove('open');
    sheet.classList.remove('open');
    noteSheetClose();
    unsubUsage();
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 380);
    usageSheetTeardown = null;
  }
  backdrop.addEventListener('click', close);
  sheet.querySelector('.sheet-close').addEventListener('click', close);
  makeSheetDismissible(sheet, close);
  usageSheetTeardown = close;
}

// Fill a #m-usage-slot with the compact usage widget, keep it live off the
// usage store, and open the usage sheet on tap. Returns the store teardown so
// setHeader() can unsubscribe on the next repaint. Shared by list-root
// (Cockpit) and list (the other primary tabs) so usage rides every main header.
function mountUsageSlot(slot) {
  const paintUsage = () => { slot.innerHTML = usageWidgetHtml(usage.get().accountUsage); };
  paintUsage();
  slot.addEventListener('click', (e) => { if (e.target.closest('#m-usage-trigger')) openUsageSheet(); });
  return usage.subscribe(paintUsage);
}

// ── list-root: Cockpit's home shape ─────────────────────────────────────
export function renderListRoot(header, { greeting, sub }) {
  header.innerHTML = `
    <div class="title-block">
      <div class="m-greet">${escapeHtml(greeting)}</div>
      <div class="m-sub">${escapeHtml(sub)}</div>
    </div>
    <div class="h-actions" id="m-usage-slot"></div>
  `;
  return mountUsageSlot(header.querySelector('#m-usage-slot'));
}

// ── list: Tracked / Sessions / Schedules / More-root / library screens ─────
export function renderList(header, { title, sub, onSearch, onSettings }) {
  const icons = [
    onSearch ? '<button type="button" class="h-icon" data-action="search" aria-label="Search">🔍</button>' : '',
    onSettings ? '<button type="button" class="h-icon" data-action="settings" aria-label="Settings">⚙</button>' : '',
  ].join('');
  header.innerHTML = `
    <div class="title-block">
      <div class="m-greet">${escapeHtml(title)}</div>
      ${sub ? `<div class="m-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
    <div class="h-actions">${icons}<div id="m-usage-slot"></div></div>
  `;
  header.querySelector('[data-action="search"]')?.addEventListener('click', () => onSearch?.());
  header.querySelector('[data-action="settings"]')?.addEventListener('click', () => onSettings?.());
  return mountUsageSlot(header.querySelector('#m-usage-slot'));
}

// ── session: live transcript screen ────────────────────────────────────────
// Same row language as drill-in (40px .m-back chevron | stacked .title-block |
// .h-actions) with session-specific actions: a slot the caller fills with the
// permission-mode chip, an optional source-control icon, and a ⋯ menu whose
// items the caller re-renders as state changes (delegated click → onMenuAction,
// so item rewrites don't lose handlers). Returns { els, renderMenuItems,
// teardown } — teardown removes the document-level outside-click listener.
export function renderSessionShape(header, { onBack, onDiff, onMenuAction }) {
  header.innerHTML = `
    <button type="button" class="m-back" aria-label="Back">‹</button>
    <div class="title-block">
      <div class="m-greet m-greet-compact mh-session-title"></div>
      <div class="m-sub mh-session-sub">
        <span class="mh-branch" hidden></span>
        <span class="mh-sub-sep" aria-hidden="true" hidden>·</span>
        <span class="mh-state">
          <span class="mh-live-dot" aria-hidden="true" hidden></span>
          <span class="mh-state-text"></span>
        </span>
      </div>
    </div>
    <div class="h-actions">
      <span class="mh-mode-slot"></span>
      <button type="button" class="h-icon mh-diff-btn" data-action="diff" aria-label="Open source control" hidden>⌥</button>
      <div class="mh-menu-wrap">
        <button type="button" class="h-icon" data-action="menu" aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
        <div class="mh-menu" hidden role="menu"></div>
      </div>
    </div>
  `;
  // The sub-row's parts are addressed individually: its run-state carries a
  // forever-pulsing dot next to a duration that ticks every second, so
  // rebuilding the row's markup would restart the pulse once a second.
  const els = {
    title:   header.querySelector('.mh-session-title'),
    sub:     header.querySelector('.mh-session-sub'),
    branch:  header.querySelector('.mh-branch'),
    subSep:  header.querySelector('.mh-sub-sep'),
    liveDot: header.querySelector('.mh-live-dot'),
    stateText: header.querySelector('.mh-state-text'),
    modeSlot:header.querySelector('.mh-mode-slot'),
    diffBtn: header.querySelector('.mh-diff-btn'),
    menuBtn: header.querySelector('[data-action="menu"]'),
    menu:    header.querySelector('.mh-menu'),
  };
  header.querySelector('.m-back').addEventListener('click', onBack);
  els.diffBtn.addEventListener('click', () => onDiff?.());
  const closeMenu = () => {
    els.menu.hidden = true;
    els.menuBtn.setAttribute('aria-expanded', 'false');
  };
  els.menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = els.menu.hidden;
    els.menu.hidden = !open;
    els.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  els.menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    closeMenu();
    onMenuAction?.(btn.dataset.action);
  });
  const onOutsideClick = (e) => {
    if (els.menu.hidden) return;
    if (e.target.closest('.mh-menu-wrap')) return;
    closeMenu();
  };
  document.addEventListener('click', onOutsideClick);
  return {
    els,
    renderMenuItems(items) {
      els.menu.innerHTML = items.map((it) =>
        `<button type="button" class="mh-menu-item${it.danger ? ' mh-menu-item-danger' : ''}" data-action="${escapeHtml(it.action)}" role="menuitem">${escapeHtml(it.label)}</button>`
      ).join('');
    },
    teardown() { document.removeEventListener('click', onOutsideClick); },
  };
}

// ── drill-in: Tracked/Schedule/Skill/Settings detail ───────────────────────
export function renderDrillIn(header, { title, sub, onBack, onMenu }) {
  header.innerHTML = `
    <button type="button" class="m-back" aria-label="Back">‹</button>
    <div class="title-block">
      <div class="m-greet m-greet-compact">${escapeHtml(title)}</div>
      ${sub ? `<div class="m-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
    <div class="h-actions">${onMenu ? '<button type="button" class="h-icon" data-action="menu" aria-label="Menu">⋯</button>' : ''}</div>
  `;
  header.querySelector('.m-back').addEventListener('click', onBack);
  header.querySelector('[data-action="menu"]')?.addEventListener('click', onMenu);
}
