// Skills library — list column (header + search + Actions⇄Skills toggle +
// rows + new-action/skill footer). Registered as the 'skills' surface's
// renderList in shell/surfaces.js.

import { actions } from '../../state/actions.js';
import { actionsApi } from '../../net/actions.js';
import { nav } from '../../state/nav.js';
import { escapeHtml } from '../../util.js';
import { skillCatalog, filterSkills } from '../../vm/library.js';
import { bindRowActivation } from '../../utils/row-activation.js';

const KINDS = [
  { id: 'action', label: 'Actions' },
  { id: 'skill', label: 'Skills' },
];

export function renderList(mount) {
  let query = '';
  let kind = 'action';

  mount.textContent = '';
  mount.classList.add('lib-list');

  const hdr = document.createElement('div');
  hdr.className = 'lib-list-hdr';
  hdr.innerHTML = '<h2>Skills</h2><span class="lib-list-count"></span>';
  mount.appendChild(hdr);

  const search = document.createElement('div');
  search.className = 'lib-search';
  search.innerHTML = '<input type="search" class="o-list-filter lib-search-input" placeholder="Filter…" aria-label="Filter">';
  mount.appendChild(search);

  const tabs = document.createElement('div');
  tabs.className = 'lib-tabs';
  tabs.setAttribute('role', 'tablist');
  mount.appendChild(tabs);

  const note = document.createElement('div');
  note.className = 'lib-kind-note';
  mount.appendChild(note);

  const body = document.createElement('div');
  body.className = 'lib-rows o-row-group';
  mount.appendChild(body);
  bindRowActivation(body);

  const foot = document.createElement('div');
  foot.className = 'lib-new-row';
  foot.innerHTML = `
    <button type="button" class="lib-new-btn" data-new="action">+ New action</button>
    <button type="button" class="lib-new-btn" data-new="skill">+ New skill</button>
  `;
  mount.appendChild(foot);
  foot.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-new]');
    if (!btn) return;
    // New action opens the main-view compose activity (skills-detail renders it
    // for the `new:` sentinel) and stays on the Skills surface. New skill remains
    // a session flow — skill-creator is genuinely interactive.
    if (btn.dataset.new === 'action') { nav.select('skills', 'new:'); return; }
    const feedback = window.prompt('What should the new skill do? (skill-creator builds it in a session)');
    if (feedback == null) return;
    btn.disabled = true;
    try {
      const res = await actionsApi.createNewSkill(feedback);
      if (res?.sessionId) nav.select('sessions', res.sessionId);
    } catch (err) {
      window.alert(`Failed to start the builder session: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  function paintTabs() {
    tabs.innerHTML = KINDS.map((k) => `
      <button type="button" role="tab" aria-selected="${k.id === kind}" class="lib-tab${k.id === kind ? ' active' : ''}" data-kind="${k.id}">${k.label}</button>
    `).join('');
    for (const btn of tabs.querySelectorAll('.lib-tab')) {
      btn.addEventListener('click', () => {
        kind = btn.dataset.kind;
        paintTabs();
        paintRows();
      });
    }
    note.hidden = kind !== 'action';
    note.textContent = kind === 'action'
      ? "Outpost's automated job actions — composed into plans, not run on their own."
      : '';
  }

  // In-flight new-action edits whose name isn't in the catalog yet — surfaced
  // as list rows so the proposal-review loop has an entry point before the
  // files exist on disk.
  function pendingEditRows(s, items) {
    const known = new Set(items.map((it) => it.name));
    return (s.edits ?? []).filter((e) => !e.actionName || !known.has(e.actionName));
  }

  function paintRows() {
    const s = actions.get();
    if (!s.loaded && s.loading) { body.innerHTML = '<div class="o-frame-empty">Loading skills…</div>'; return; }
    const all = skillCatalog(s);
    const items = filterSkills(all, { q: query, kind });
    const pending = kind === 'action' ? pendingEditRows(s, all) : [];
    hdr.querySelector('.lib-list-count').textContent = `${items.length + pending.length}`;
    if (items.length === 0 && pending.length === 0) {
      body.innerHTML = `<div class="o-frame-empty">No ${kind === 'action' ? 'actions' : 'skills'} match.</div>`;
      return;
    }
    body.innerHTML = pending.map(pendingRowHtml).join('') + items.map(rowHtml).join('');
    for (const el of body.querySelectorAll('.lib-skill-row')) {
      el.addEventListener('click', () => {
        // data-sel carries the `new:<sessionId>` WIP sentinel; data-name is an
        // installed action. Both resolve on the Skills surface — no jump to sessions.
        if (el.dataset.sel) nav.select('skills', el.dataset.sel);
        else if (el.dataset.name) nav.select('skills', el.dataset.name);
      });
    }
    refreshSelected();
  }

  function refreshSelected() {
    const selected = nav.get().selectionBySurface.skills ?? null;
    for (const el of body.querySelectorAll('.lib-skill-row')) {
      el.classList.toggle('active', !!selected && el.dataset.name === selected);
    }
  }

  search.querySelector('.lib-search-input').addEventListener('input', (e) => {
    query = e.target.value;
    paintRows();
  });

  paintTabs();
  paintRows();
  const unsubActions = actions.subscribe(paintRows);
  const unsubNav = nav.subscribe(refreshSelected);
  if (!actions.get().loaded && !actions.get().loading) actions.load();

  return () => { unsubActions(); unsubNav(); };
}

function rowHtml(item) {
  return `
    <div class="o-row lib-skill-row" data-name="${escapeHtml(item.name)}" role="button" tabindex="0">
      <span class="o-row-icon lib-cat-dot lib-cat-${escapeHtml(item.category)}" aria-hidden="true">●</span>
      <div class="o-row-title lib-skill-name">${escapeHtml(item.name)}</div>
    </div>
  `;
}

function pendingRowHtml(edit) {
  const name = edit.actionName ?? 'draft';
  // Both named and unnamed new-action edits resolve to the WIP view on the Skills
  // surface via the `new:<sessionId>` sentinel (see skills-detail.js) — the inline
  // feed + proposal card live there, so there's no reason to jump into the session.
  return `
    <div class="o-row lib-skill-row lib-skill-row-pending" data-sel="new:${escapeHtml(edit.sessionId)}" role="button" tabindex="0">
      <span class="o-row-icon lib-cat-dot lib-cat-meta" aria-hidden="true">◌</span>
      <div class="o-row-title lib-skill-hdr">
        <span class="lib-skill-name">${escapeHtml(name)}</span>
        <span class="o-pill lib-cat-pill lib-cat-meta">${edit.proposal ? 'review' : 'drafting'}</span>
      </div>
    </div>
  `;
}
