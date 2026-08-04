import { schedulesStore } from '../../state/schedules.js';
import { nav } from '../../state/nav.js';
import { scheduleCards, filterScheduleCards } from '../../vm/schedules.js';
import { escapeHtml } from '../../util.js';
import { createSwitch } from './switch.js';
import { startScheduleDraft } from './draft.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'cron', label: 'Cron' },
  { id: 'once', label: 'Once' },
  { id: 'token', label: 'Token' },
  { id: 'event', label: 'Event' },
];

export function renderList(mount) {
  mount.textContent = '';
  mount.classList.add('sched-list');

  let tab = 'all';
  let filter = '';

  const hdr = document.createElement('div');
  hdr.className = 'sched-list-hdr';
  const filterbar = document.createElement('div');
  filterbar.className = 'o-list-filterbar sched-list-searchbar';
  filterbar.innerHTML = '<input type="search" class="o-list-filter sched-list-search" placeholder="Filter schedules…" aria-label="Filter schedules">';
  const body = document.createElement('div');
  body.className = 'sched-list-body';
  // Keyboard activation for the div-based cards. Not utils/row-activation.js:
  // its delegate would also swallow Enter/Space aimed at the card's embedded
  // pause switch (a real <button role="switch">), so skip interactive targets.
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    const card = e.target.closest('.sched-card[role="button"]');
    if (!card) return;
    e.preventDefault();
    card.click();
  });
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'sched-new-btn';
  newBtn.textContent = '+ New schedule';
  newBtn.addEventListener('click', () => startScheduleDraft());
  mount.appendChild(hdr);
  mount.appendChild(filterbar);
  mount.appendChild(body);
  mount.appendChild(newBtn);

  filterbar.querySelector('.sched-list-search').addEventListener('input', (e) => {
    filter = e.target.value;
    paint();
  });

  function paintHeader(schedules) {
    const activeCount = schedules.filter((s) => s.enabled).length;
    const pausedCount = schedules.length - activeCount;
    hdr.innerHTML = `
      <div class="sched-list-hdr-row">
        <h2>Schedules</h2>
        <span class="sched-list-count">${activeCount} active · ${pausedCount} paused</span>
      </div>
      <div class="sched-tabs" role="tablist">
        ${TABS.map((t) => `<button type="button" class="sched-tab${t.id === tab ? ' active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === tab}">${t.label}</button>`).join('')}
      </div>
    `;
    for (const btn of hdr.querySelectorAll('.sched-tab')) {
      btn.addEventListener('click', () => { tab = btn.dataset.tab; paint(); });
    }
  }

  function matchesFilter(c, needle) {
    return [c.name, c.when, c.descriptor, c.what?.label ?? '']
      .some((v) => v.toLowerCase().includes(needle));
  }

  function renderCard(c, active) {
    const card = document.createElement('div');
    card.className = `sched-card${active ? ' active' : ''}${c.dimmed ? ' disabled' : ''}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', () => nav.select('schedules', c.id));
    card.innerHTML = `
      <div class="sched-hdr">
        <span class="sched-source-icon">${c.sourceKind === 'event' ? '◆' : c.sourceKind === 'once' ? '◷' : c.sourceKind === 'token' ? '⚡' : '↻'}</span>
        <span class="sched-name">${escapeHtml(c.name)}</span>
        ${c.builtin ? '<span class="o-pill sched-builtin-pill">builtin</span>' : ''}
      </div>
      <div class="sched-when">${escapeHtml(c.when)}</div>
      <div class="sched-descriptor">${escapeHtml(c.descriptor)}</div>
      ${c.what?.label ? `<span class="o-pill${c.what.mono ? ' code' : ''} sched-skill-pill">${c.what.kind === 'skill' ? '' : `${escapeHtml(c.what.kind)} · `}${escapeHtml(c.what.label)}</span>` : ''}
      ${c.nextRunSummary ? `<div class="sched-next${c.enabled ? '' : ' paused'}"><span class="dot"></span>${escapeHtml(c.nextRunSummary)}</div>` : ''}
    `;
    const toggle = createSwitch(c.enabled, async (next) => {
      try { await schedulesStore.update(c.id, { enabled: next }); }
      catch { toggle.set(!next); }
    }, `${c.enabled ? 'Pause' : 'Resume'} ${c.name}`);
    card.querySelector('.sched-hdr').appendChild(toggle);
    return card;
  }

  function paint() {
    const { schedules, loaded, loading } = schedulesStore.get();
    paintHeader(schedules);
    const now = Date.now();
    const needle = filter.trim().toLowerCase();

    let cards = filterScheduleCards(scheduleCards(schedules, now), tab);
    if (needle) cards = cards.filter((c) => matchesFilter(c, needle));

    body.textContent = '';
    if (!loaded && loading) {
      const el = document.createElement('div');
      el.className = 'o-frame-empty';
      el.textContent = 'Loading schedules…';
      body.appendChild(el);
      return;
    }

    if (cards.length === 0) {
      const el = document.createElement('div');
      el.className = 'o-frame-empty';
      el.textContent = schedules.length === 0 ? 'No schedules yet.' : 'No schedules match this filter.';
      body.appendChild(el);
      return;
    }

    const selected = nav.get().selectionBySurface.schedules ?? null;
    for (const c of cards) body.appendChild(renderCard(c, c.id === selected));
  }

  paint();
  const unsubStore = schedulesStore.subscribe(paint);
  const unsubNav = nav.subscribe(paint);
  if (!schedulesStore.get().loaded && !schedulesStore.get().loading) schedulesStore.load();
  return () => { unsubStore(); unsubNav(); };
}
