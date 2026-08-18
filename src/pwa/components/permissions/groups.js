import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { grantsStore } from '../../state/grants.js';
import { metaApi } from '../../net/meta.js';
import {
  groupCards, groupContents, groupWithRule, groupWithoutRule, errorTarget, KIND_ORDER, KIND_LABEL,
} from '../../vm/permissions.js';

// The Groups block of the Permissions page: the five permission groups, each expandable into
// its rules, each rule editable through PUT /api/permission-groups/:name.
//
// This is the sanctioned door that replaced the one-click "Allow" button, and it only works
// as one if a refusal explains itself — so a 400 renders the daemon's lint message VERBATIM
// against the row it names. Nothing here paraphrases, summarizes, or substitutes a message of
// its own: the lint's sentence is the only account a user ever gets of why a rule is unsafe,
// and a wall with no reason on it is what sends people back to hand-editing config.

const ADD_LABEL = {
  tool: '+ Add tool',
  bash: '+ Add bash pattern',
  mcp: '+ Add MCP pattern',
  path: '+ Add path pattern',
};
const PLACEHOLDER = {
  tool: 'ToolName',
  bash: '^gh pr view( .*)?$',
  mcp: 'mcp__server__get_.*',
  path: 'Write:^/tmp/',
};

export function renderGroupsBlock(mount) {
  const state = {
    expanded: new Set(),
    editing: null,       // { group, kind, index: number|null, value, reason }
    error: null,         // { group, message } — message is the server's text, unmodified
    saving: false,
    historyFor: null,
    revisions: [],
    revisionsLoading: false,
  };
  let focusInput = false;

  const rawGroup = (name) => (grantsStore.get().groups ?? []).find((g) => g.name === name) ?? null;

  // Where the server's message gets rendered. The rule it names is not always the one being
  // edited — the group can already hold a rule that a later lint refuses — so blame the row
  // the message actually identifies, and fall back to the whole group rather than an
  // arbitrary row when it identifies none.
  function errorSlot(name) {
    if (!state.error || state.error.group !== name) return null;
    const message = state.error.message;
    const editing = state.editing;
    if (editing && editing.group === name && message.startsWith(`${editing.value.trim()}: `)) {
      return { kind: editing.kind, index: editing.index, message };
    }
    const target = errorTarget(rawGroup(name), message);
    return target ? { ...target, message } : { kind: null, index: null, message };
  }

  function errorHtml(message) {
    return `<div class="permgroup-rule-error">${escapeHtml(message)}</div>`;
  }

  function editorHtml(editing, slot) {
    const showsError = slot && slot.kind === editing.kind && slot.index === editing.index;
    return `
      <div class="permgroup-editor">
        <input class="permgroup-rule-input" type="text" spellcheck="false" autocapitalize="off"
               placeholder="${escapeHtml(PLACEHOLDER[editing.kind] ?? '')}"
               value="${escapeHtml(editing.value)}" />
        <input class="permgroup-rule-reason" type="text" placeholder="Why this rule? (recorded in history)"
               value="${escapeHtml(editing.reason)}" />
        <div class="permgroup-editor-actions">
          <button type="button" class="o-btn o-btn--primary sm permgroup-save"${state.saving ? ' disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>
          <button type="button" class="o-btn o-btn--ghost sm permgroup-cancel">Cancel</button>
        </div>
      </div>
      ${showsError ? errorHtml(slot.message) : ''}
    `;
  }

  function ruleHtml(name, rule, slot) {
    const editing = state.editing;
    const isEditing = editing && editing.group === name && editing.kind === rule.kind && editing.index === rule.index;
    const showsError = !isEditing && slot && slot.kind === rule.kind && slot.index === rule.index;
    return `
      <div class="permgroup-rule${isEditing ? ' editing' : ''}" data-kind="${rule.kind}" data-index="${rule.index}">
        ${isEditing ? editorHtml(editing, slot) : `
          <code class="permgroup-rule-value">${escapeHtml(rule.value)}</code>
          <div class="permgroup-rule-actions">
            <button type="button" class="o-btn o-btn--ghost sm permgroup-edit">Edit</button>
            <button type="button" class="o-btn o-btn--ghost sm permgroup-remove">Remove</button>
          </div>
          ${showsError ? errorHtml(slot.message) : ''}
        `}
      </div>
    `;
  }

  function addRowHtml(name, kind, slot) {
    const editing = state.editing;
    if (editing && editing.group === name && editing.kind === kind && editing.index === null) {
      return `<div class="permgroup-rule editing" data-kind="${kind}" data-index="new">${editorHtml(editing, slot)}</div>`;
    }
    return `<button type="button" class="o-btn o-btn--default sm permgroup-add" data-kind="${kind}">${escapeHtml(ADD_LABEL[kind])}</button>`;
  }

  // A kind with no rules gets no section of its own — its "add" lives in the footer bar, so an
  // empty group still offers all four without four empty headings.
  function sectionsHtml(name, group, slot) {
    const present = new Map(groupContents(group).map((s) => [s.kind, s]));
    const shown = KIND_ORDER.filter((kind) => present.get(kind)?.rules.length
      || (state.editing?.group === name && state.editing.kind === kind));
    const sections = shown.map((kind) => `
      <div class="permgroup-kind" data-kind="${kind}">
        <h4 class="o-microhead">${escapeHtml(KIND_LABEL[kind])}</h4>
        ${(present.get(kind)?.rules ?? []).map((r) => ruleHtml(name, r, slot)).join('')}
        ${addRowHtml(name, kind, slot)}
      </div>
    `).join('');
    const rest = KIND_ORDER.filter((k) => !shown.includes(k));
    return sections + (rest.length
      ? `<div class="permgroup-addbar">${rest.map((k) => addRowHtml(name, k, slot)).join('')}</div>`
      : '');
  }

  function historyHtml(name) {
    if (state.historyFor !== name) return '';
    if (state.revisionsLoading) return '<div class="permgroup-history-body settings-loading">Loading…</div>';
    if (!state.revisions.length) {
      return '<div class="permgroup-history-body"><p class="settings-note">No edits recorded for this group.</p></div>';
    }
    return `
      <div class="permgroup-history-body">
        ${state.revisions.map((rev) => `
          <div class="permgroup-revision" data-revision="${escapeHtml(rev.id)}">
            <div>
              <div class="permgroup-revision-when">${escapeHtml(relPast(rev.at) ?? '')} · ${escapeHtml(rev.author ?? 'user')}</div>
              <div class="permgroup-revision-why">${escapeHtml(rev.rationale ?? 'no reason recorded')}</div>
            </div>
            <button type="button" class="o-btn o-btn--default sm permgroup-revert">Revert to this</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  function cardHtml(card) {
    const group = rawGroup(card.name);
    const expanded = state.expanded.has(card.name);
    const slot = errorSlot(card.name);
    const groupWide = slot && slot.kind === null;
    return `
      <section class="o-section permgroup-card" data-group="${escapeHtml(card.name)}" data-expanded="${expanded}">
        <button type="button" class="permgroup-hdr" aria-expanded="${expanded}">
          <span class="permgroup-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
          <span class="o-pill grp-${escapeHtml(card.tone)}">${escapeHtml(card.name)}</span>
          <span class="permgroup-desc">${escapeHtml(card.description)}</span>
          ${card.gated ? '<span class="o-pill warn permgroup-gated" title="A call matching this group also needs a write draft you approved">gated</span>' : ''}
          <span class="permgroup-count">${card.actionCount} action${card.actionCount === 1 ? '' : 's'} · ${card.ruleCount} rule${card.ruleCount === 1 ? '' : 's'}</span>
        </button>
        ${expanded && group ? `
          <div class="permgroup-body">
            ${groupWide ? errorHtml(slot.message) : ''}
            ${sectionsHtml(card.name, group, slot)}
            <div class="permgroup-history">
              <button type="button" class="o-btn o-btn--ghost sm permgroup-history-toggle">${state.historyFor === card.name ? 'Hide history' : 'History'}</button>
              ${historyHtml(card.name)}
            </div>
          </div>
        ` : ''}
      </section>
    `;
  }

  function paint() {
    const snap = grantsStore.get();
    if (!snap.groupsLoaded) {
      mount.innerHTML = snap.groupsErr
        ? `<p class="settings-note permgroup-load-error">Could not load permission groups: ${escapeHtml(snap.groupsErr)}</p>`
        : '<div class="settings-loading">Loading…</div>';
      return;
    }
    const cards = groupCards(snap.groups);
    mount.innerHTML = cards.length
      ? cards.map(cardHtml).join('')
      : '<p class="settings-note">No permission groups configured.</p>';
    if (focusInput) {
      focusInput = false;
      const input = mount.querySelector('.permgroup-rule.editing .permgroup-rule-input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }

  async function loadRevisions(name) {
    state.revisionsLoading = true;
    paint();
    try {
      const data = await metaApi.groupRevisions(name);
      state.revisions = Array.isArray(data?.revisions) ? data.revisions : [];
    } catch (e) {
      state.revisions = [];
      state.error = { group: name, message: e.body || e.message };
    } finally {
      state.revisionsLoading = false;
      paint();
    }
  }

  // `next` is the whole rebuilt group — PUT replaces all four arrays, so a partial body would
  // silently delete every rule it omits.
  async function commit(name, next, rationale) {
    state.saving = true;
    state.error = null;
    paint();
    try {
      await metaApi.putPermissionGroup(name, next, rationale);
      state.editing = null;
      // Repaint from what the daemon persisted, never from `next`.
      await grantsStore.reloadGroups();
      if (state.historyFor === name) await loadRevisions(name);
    } catch (e) {
      state.error = { group: name, message: e.body || e.message };
    } finally {
      state.saving = false;
      paint();
    }
  }

  function beginEdit(name, kind, index, value) {
    state.editing = { group: name, kind, index, value, reason: '' };
    state.error = null;
    focusInput = true;
    paint();
  }

  function cancelEdit() {
    state.editing = null;
    state.error = null;
    paint();
  }

  function saveEdit() {
    const editing = state.editing;
    if (!editing || state.saving) return;
    const value = editing.value.trim();
    const group = rawGroup(editing.group);
    if (!group || !value) return;
    const verb = editing.index === null ? 'add' : 'edit';
    const rationale = editing.reason.trim()
      || `${verb} ${editing.kind} rule via Permissions page`;
    void commit(editing.group, groupWithRule(group, editing.kind, editing.index, value), rationale);
  }

  mount.addEventListener('input', (e) => {
    if (!state.editing) return;
    if (e.target.classList.contains('permgroup-rule-input')) state.editing.value = e.target.value;
    else if (e.target.classList.contains('permgroup-rule-reason')) state.editing.reason = e.target.value;
  });

  mount.addEventListener('keydown', (e) => {
    if (!e.target.closest('.permgroup-editor')) return;
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  });

  mount.addEventListener('click', (e) => {
    const card = e.target.closest('.permgroup-card');
    if (!card) return;
    const name = card.dataset.group;

    if (e.target.closest('.permgroup-hdr')) {
      if (state.expanded.has(name)) state.expanded.delete(name); else state.expanded.add(name);
      state.editing = null;
      state.error = null;
      paint();
      return;
    }
    if (e.target.closest('.permgroup-cancel')) { cancelEdit(); return; }
    if (e.target.closest('.permgroup-save')) { saveEdit(); return; }

    const addBtn = e.target.closest('.permgroup-add');
    if (addBtn) { beginEdit(name, addBtn.dataset.kind, null, ''); return; }

    const rule = e.target.closest('.permgroup-rule');
    if (rule && e.target.closest('.permgroup-edit')) {
      beginEdit(name, rule.dataset.kind, Number(rule.dataset.index),
        rule.querySelector('.permgroup-rule-value')?.textContent ?? '');
      return;
    }
    if (rule && e.target.closest('.permgroup-remove')) {
      const value = rule.querySelector('.permgroup-rule-value')?.textContent ?? '';
      if (!confirm(`Remove "${value}" from ${name}? Actions inheriting this group lose that grant.`)) return;
      const group = rawGroup(name);
      if (!group) return;
      state.editing = null;
      void commit(name, groupWithoutRule(group, rule.dataset.kind, Number(rule.dataset.index)),
        `remove ${rule.dataset.kind} rule via Permissions page`);
      return;
    }

    if (e.target.closest('.permgroup-history-toggle')) {
      if (state.historyFor === name) { state.historyFor = null; state.revisions = []; paint(); return; }
      state.historyFor = name;
      state.revisions = [];
      void loadRevisions(name);
      return;
    }

    const revision = e.target.closest('.permgroup-revision');
    if (revision && e.target.closest('.permgroup-revert')) {
      if (!confirm(`Revert ${name} to this revision? It is re-validated against today's rules, so a grant that is no longer allowed will be refused.`)) return;
      state.saving = true;
      state.error = null;
      paint();
      void (async () => {
        try {
          await metaApi.revertGroup(name, revision.dataset.revision);
          await grantsStore.reloadGroups();
          await loadRevisions(name);
        } catch (err) {
          state.error = { group: name, message: err.body || err.message };
        } finally {
          state.saving = false;
          paint();
        }
      })();
    }
  });

  // The only door the Grants block gets into a group: hand it the exact (kind, value) and
  // expand + pre-fill this block's own inline editor, so the actual write still goes through
  // commit() -> PUT /api/permission-groups/:name and its lint. Nothing here writes anything.
  function promote(name, kind, value) {
    state.expanded.add(name);
    state.editing = { group: name, kind, index: null, value, reason: '' };
    state.error = null;
    focusInput = true;
    paint();
    const card = [...mount.querySelectorAll('.permgroup-card')].find((el) => el.dataset.group === name);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  paint();
  const unsub = grantsStore.subscribe(paint);
  void grantsStore.loadGroups();
  return { unmount: unsub, promote };
}
