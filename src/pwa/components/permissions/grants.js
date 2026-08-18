import { escapeHtml } from '../../util.js';
import { grantsStore } from '../../state/grants.js';
import { metaApi } from '../../net/meta.js';
import { grantRows, groupCards, GATED_GROUP_NAMES, KIND_ORDER, KIND_LABEL } from '../../vm/permissions.js';

// The Grants block of the Permissions page: every global/project/action-scoped allowlist rule,
// laid out by kind (same taxonomy the group editor uses) rather than nested under a group —
// a grant here isn't scoped to any group, it's what an unbound interactive call falls back to.
//
// This block is NOT a second door into a permission group. "Promote..." hands the exact
// (kind, value) to the Groups block's own inline editor via `deps.promoteToGroup` and stops
// right there — the write still goes through PUT /api/permission-groups/:name and its lint,
// same as every other group edit (see groups.js's `promote`). Inline edit/revoke here only
// ever touch the standalone rule itself, never a group.

export function renderGrantsBlock(mount, deps) {
  const state = {
    editingId: null,
    editValue: '',
    saving: false,
    error: null,       // { id, message } — message is the server's text, unmodified
    promotingId: null, // id of the row whose group picker is open
    promoteGroup: '',
  };
  let focusInput = false;

  function rawRow(id) {
    return grantRows(grantsStore.get().rules).find((r) => r.id === id) ?? null;
  }

  function editorHtml(row) {
    return `
      <div class="allow-editor">
        <input class="allow-edit-input" type="text" spellcheck="false" autocapitalize="off"
               value="${escapeHtml(state.editValue)}" />
        <div class="allow-editor-actions">
          <button type="button" class="o-btn o-btn--primary sm allow-save"${state.saving ? ' disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>
          <button type="button" class="o-btn o-btn--ghost sm allow-cancel">Cancel</button>
        </div>
      </div>
      ${state.error && state.error.id === row.id ? `<div class="permgroup-rule-error">${escapeHtml(state.error.message)}</div>` : ''}
    `;
  }

  function promoteHtml(row) {
    const snap = grantsStore.get();
    const cards = snap.groupsLoaded ? groupCards(snap.groups) : [];
    const gatedSelected = GATED_GROUP_NAMES.includes(state.promoteGroup);
    return `
      <div class="allow-picker">
        <select class="allow-group-select"${snap.groupsLoaded ? '' : ' disabled'}>
          <option value="">${snap.groupsLoaded ? 'Choose a group…' : 'Loading groups…'}</option>
          ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === state.promoteGroup ? ' selected' : ''}>${escapeHtml(c.name)}${c.gated ? ' (gated)' : ''}</option>`).join('')}
        </select>
        <button type="button" class="o-btn o-btn--primary sm allow-confirm-promote"${!state.promoteGroup ? ' disabled' : ''}>Open in Permission groups</button>
        <button type="button" class="o-btn o-btn--ghost sm allow-cancel-promote">Cancel</button>
        ${gatedSelected ? '<p class="settings-note perm-pending-gated-note">This opens the editor for a gated group — nothing is granted until you Save there.</p>' : ''}
      </div>
    `;
  }

  function rowHtml(row) {
    const isEditing = state.editingId === row.id;
    const isPromoting = state.promotingId === row.id;
    const err = !isEditing && state.error && state.error.id === row.id ? state.error.message : null;
    return `
      <div class="allow-row" data-id="${escapeHtml(row.id)}" data-kind="${row.kind}" data-editable="${row.editable}">
        <span class="allow-row-icon" aria-hidden="true">✓</span>
        <div class="allow-row-main">
          ${isEditing ? editorHtml(row) : `
            <code class="allow-row-pattern">${escapeHtml(row.pattern)}</code>
            <div class="allow-row-scope">${escapeHtml(row.scopeText)}</div>
          `}
          ${isPromoting ? promoteHtml(row) : ''}
          ${err ? `<div class="permgroup-rule-error">${escapeHtml(err)}</div>` : ''}
        </div>
        <div class="allow-row-actions">
          ${!isEditing && row.editable ? '<button type="button" class="o-btn o-btn--ghost sm allow-edit">Edit</button>' : ''}
          ${!isEditing ? '<button type="button" class="o-btn o-btn--ghost sm allow-promote">Promote…</button>' : ''}
          ${!isEditing ? '<button type="button" class="o-btn o-btn--default sm allow-row-revoke">Revoke</button>' : ''}
        </div>
      </div>
    `;
  }

  function sectionsHtml(rows) {
    const byKind = new Map(KIND_ORDER.map((k) => [k, []]));
    for (const r of rows) byKind.get(r.kind)?.push(r);
    return KIND_ORDER.filter((k) => byKind.get(k).length).map((k) => `
      <div class="allow-kind" data-kind="${k}">
        <h4 class="o-microhead">${escapeHtml(KIND_LABEL[k])}</h4>
        ${byKind.get(k).map(rowHtml).join('')}
      </div>
    `).join('');
  }

  function paint() {
    const snap = grantsStore.get();
    if (!snap.rulesLoaded) {
      mount.innerHTML = '<div class="settings-loading">Loading…</div>';
      return;
    }
    const rows = grantRows(snap.rules);
    mount.innerHTML = rows.length
      ? sectionsHtml(rows)
      : '<p class="settings-note">No grants outside the permission groups.</p>';
    if (focusInput) {
      focusInput = false;
      const input = mount.querySelector('.allow-editor .allow-edit-input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }

  async function saveEdit(id) {
    const value = state.editValue.trim();
    if (!value || state.saving) return;
    state.saving = true;
    state.error = null;
    paint();
    try {
      await metaApi.putAllowlistRule(id, value);
      state.editingId = null;
      // Repaint from what the daemon persisted, never from `value` — the id encodes the
      // value, so a successful edit answers with a brand new id and this old one is dead.
      await grantsStore.reloadRules();
    } catch (e) {
      state.error = { id, message: e.body || e.message };
    } finally {
      state.saving = false;
      paint();
    }
  }

  async function revoke(id, pattern) {
    if (!confirm(`Revoke "${pattern}"? Anything relying on this grant loses it immediately.`)) return;
    state.error = null;
    try {
      await metaApi.deleteAllowlistRule(id);
      await grantsStore.reloadRules();
    } catch (e) {
      state.error = { id, message: e.body || e.message };
      paint();
    }
  }

  mount.addEventListener('input', (e) => {
    if (e.target.classList.contains('allow-edit-input')) state.editValue = e.target.value;
  });

  mount.addEventListener('keydown', (e) => {
    if (!e.target.closest('.allow-editor')) return;
    if (e.key === 'Enter') { e.preventDefault(); const row = e.target.closest('.allow-row'); if (row) void saveEdit(row.dataset.id); }
    else if (e.key === 'Escape') { e.preventDefault(); state.editingId = null; state.error = null; paint(); }
  });

  mount.addEventListener('change', (e) => {
    if (!e.target.classList.contains('allow-group-select')) return;
    state.promoteGroup = e.target.value;
    paint();
  });

  mount.addEventListener('click', (e) => {
    const row = e.target.closest('.allow-row');
    if (!row) return;
    const { id } = row.dataset;

    if (e.target.closest('.allow-edit')) {
      const current = rawRow(id);
      if (!current) return;
      state.editingId = id;
      state.editValue = current.pattern;
      state.promotingId = null;
      state.error = null;
      focusInput = true;
      paint();
      return;
    }
    if (e.target.closest('.allow-cancel')) { state.editingId = null; state.error = null; paint(); return; }
    if (e.target.closest('.allow-save')) { void saveEdit(id); return; }

    if (e.target.closest('.allow-promote')) {
      state.promotingId = id;
      state.promoteGroup = '';
      state.editingId = null;
      state.error = null;
      paint();
      return;
    }
    if (e.target.closest('.allow-cancel-promote')) { state.promotingId = null; paint(); return; }
    if (e.target.closest('.allow-confirm-promote')) {
      const current = rawRow(id);
      if (!current || !state.promoteGroup) return;
      deps.promoteToGroup(state.promoteGroup, current.kind, current.pattern);
      state.promotingId = null;
      state.promoteGroup = '';
      paint();
      return;
    }

    if (e.target.closest('.allow-row-revoke')) {
      const current = rawRow(id);
      if (!current) return;
      void revoke(id, current.pattern);
    }
  });

  paint();
  const unsub = grantsStore.subscribe(paint);
  void grantsStore.loadRules();
  void grantsStore.loadGroups();
  return unsub;
}
