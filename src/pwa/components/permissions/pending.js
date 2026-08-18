import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { grantsStore } from '../../state/grants.js';
import { nav } from '../../state/nav.js';
import { metaApi } from '../../net/meta.js';
import { pendingRows, mcpUnclassifiedRows, groupCards, GATED_GROUP_NAMES } from '../../vm/permissions.js';

// The Pending classifications block of the Permissions page: this is the "Allow" button's
// honest successor. A blocked call never becomes a grant with one click here — it becomes
// evidence with three possible verdicts. `never` and `fix-action` resolve the denial and grant
// nothing; `promote` is the only one that can widen the system, so it alone opens a group
// picker (plus a sign-off confirm for a gated group) and is styled to stand apart from the
// other two at a glance.
//
// The MCP half lists servers with unclassified tools and links to Settings > MCP connections
// rather than rebuilding that panel's apply flow here (see routes/meta.ts and vm/permissions.js
// for why it's fetched on its own, slower schedule instead of folded into the denials route).

export function renderPendingBlock(mount) {
  const state = {
    catalogServers: [],
    catalogLoaded: false,
    catalogLoading: false,
    catalogError: null,
    promotingId: null,  // denial id whose group picker is open
    promoteGroup: '',
    busyId: null,       // denial id with an in-flight verdict POST
    error: null,        // { id, message }
  };

  function findDenial(action, id) {
    return (grantsStore.get().pendingDenials ?? []).find((d) => d.action === action && d.id === id);
  }

  function mcpSectionHtml(mcpRows) {
    if (state.catalogError) {
      return `<p class="settings-note perm-pending-mcp-error">MCP catalog check failed: ${escapeHtml(state.catalogError)}</p>`;
    }
    if (state.catalogLoading && !state.catalogLoaded) {
      return '<div class="settings-loading">Checking MCP servers…</div>';
    }
    if (!mcpRows.length) return '';
    return `
      <div class="perm-pending-mcp-list">
        ${mcpRows.map((s) => `
          <div class="perm-pending-mcp-row">
            <span class="o-row-icon">◈</span>
            <span class="perm-pending-mcp-name">${escapeHtml(s.server)}</span>
            <span class="perm-pending-mcp-count">${s.unclassified} unclassified tool${s.unclassified === 1 ? '' : 's'}</span>
            <button type="button" class="o-btn o-btn--default sm perm-pending-mcp-link">Review in MCP connections</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  function promoteHtml(row) {
    const snap = grantsStore.get();
    const cards = snap.groupsLoaded ? groupCards(snap.groups) : [];
    const gatedSelected = GATED_GROUP_NAMES.includes(state.promoteGroup);
    const busy = state.busyId === row.id;
    return `
      <div class="perm-pending-picker">
        <select class="perm-pending-group-select"${snap.groupsLoaded ? '' : ' disabled'}>
          <option value="">${snap.groupsLoaded ? 'Choose a group…' : 'Loading groups…'}</option>
          ${cards.map((c) => `<option value="${escapeHtml(c.name)}"${c.name === state.promoteGroup ? ' selected' : ''}>${escapeHtml(c.name)}${c.gated ? ' (gated)' : ''}</option>`).join('')}
        </select>
        <button type="button" class="o-btn o-btn--primary sm perm-pending-confirm-promote"${!state.promoteGroup || busy ? ' disabled' : ''}>${busy ? 'Promoting…' : 'Confirm promote'}</button>
        <button type="button" class="o-btn o-btn--ghost sm perm-pending-cancel-promote"${busy ? ' disabled' : ''}>Cancel</button>
        ${gatedSelected ? '<p class="settings-note perm-pending-gated-note">A gated group means nothing if a call can run into it unchecked — confirming will ask you to sign off.</p>' : ''}
      </div>
    `;
  }

  function rowHtml(action, row) {
    const busy = state.busyId === row.id;
    const promoting = state.promotingId === row.id;
    const err = state.error && state.error.id === row.id ? state.error.message : null;
    return `
      <div class="perm-pending-row" data-id="${escapeHtml(row.id)}" data-action="${escapeHtml(action)}">
        <div class="perm-pending-row-main">
          <code class="perm-pending-command">${escapeHtml(row.command ?? row.tool)}</code>
          <div class="perm-pending-meta">
            ${row.suggested
              ? `<span class="perm-pending-suggested">${escapeHtml(row.suggested.kind)}: <code>${escapeHtml(row.suggested.value)}</code></span>`
              : '<span class="perm-pending-suggested none">no rule could be derived</span>'}
            ${row.count > 1 ? `<span class="perm-pending-count">× ${escapeHtml(String(row.count))}</span>` : ''}
            <span class="perm-pending-when">${escapeHtml(relPast(row.at) ?? '')}</span>
          </div>
        </div>
        <div class="perm-pending-actions">
          <button type="button" class="o-btn o-btn--ghost sm perm-pending-never"${busy ? ' disabled' : ''}>Never</button>
          <button type="button" class="o-btn o-btn--ghost sm perm-pending-fix"${busy ? ' disabled' : ''}>Fix the action</button>
          <button type="button" class="o-btn o-btn--danger sm perm-pending-promote-btn"${busy || !row.suggested ? ' disabled' : ''}
            title="${row.suggested ? 'Grants a real permission — opens a group picker' : 'No rule could be derived for this call'}">Promote…</button>
        </div>
        ${promoting ? promoteHtml(row) : ''}
        ${err ? `<div class="permgroup-rule-error">${escapeHtml(err)}</div>` : ''}
      </div>
    `;
  }

  function batchHtml(batch) {
    return `
      <div class="perm-pending-batch" data-action="${escapeHtml(batch.action)}">
        <h4 class="o-microhead">${escapeHtml(batch.action)}</h4>
        ${batch.rows.map((r) => rowHtml(batch.action, r)).join('')}
      </div>
    `;
  }

  function paint() {
    const snap = grantsStore.get();
    if (!snap.pendingLoaded) {
      // A failed load must say so rather than spin: this panel is the only front door to a
      // denial, and a permanent "Loading…" makes every waiting verdict invisible.
      mount.innerHTML = snap.pendingErr
        ? `<p class="settings-note perm-pending-load-error">Could not load pending denials: ${escapeHtml(snap.pendingErr)}</p>`
        : '<div class="settings-loading">Loading…</div>';
      return;
    }
    const rows = pendingRows({
      denials: snap.pendingDenials,
      mcp: mcpUnclassifiedRows(state.catalogServers),
    });
    const denialsHtml = rows.denials.length
      ? rows.denials.map(batchHtml).join('')
      : '<p class="settings-note">No unresolved denials.</p>';
    mount.innerHTML = `
      <div class="perm-pending-mcp">${mcpSectionHtml(rows.mcp)}</div>
      <div class="perm-pending-denials">${denialsHtml}</div>
    `;
  }

  async function loadCatalog() {
    state.catalogLoading = true;
    paint();
    try {
      const data = await metaApi.mcpCatalog();
      state.catalogServers = Array.isArray(data?.servers) ? data.servers : [];
      state.catalogLoaded = true;
      state.catalogError = null;
    } catch (e) {
      state.catalogError = e.body || e.message;
    } finally {
      state.catalogLoading = false;
      paint();
    }
  }

  // Repaints from a fresh GET rather than patching local state, same discipline as groups.js's
  // commit() — a verdict can be refused (e.g. a gated promote missing sign-off never reaches
  // this point, but a lint refusal on the rule itself does), and a resolved denial should
  // disappear because the server says it's resolved, not because the click handler assumed so.
  async function submitVerdict(action, denialId, body) {
    state.busyId = denialId;
    state.error = null;
    paint();
    try {
      await metaApi.denialVerdict(action, denialId, body);
      state.promotingId = null;
      state.promoteGroup = '';
      await grantsStore.reloadPending();
      if (body.disposition === 'promote') await grantsStore.reloadGroups();
    } catch (e) {
      state.error = { id: denialId, message: e.body || e.message };
    } finally {
      state.busyId = null;
      paint();
    }
  }

  mount.addEventListener('click', (e) => {
    if (e.target.closest('.perm-pending-mcp-link')) { nav.setSelection('mcp'); return; }

    const row = e.target.closest('.perm-pending-row');
    if (!row) return;
    const { id, action } = row.dataset;

    if (e.target.closest('.perm-pending-never')) {
      void submitVerdict(action, id, { disposition: 'never', decidedBy: 'user' });
      return;
    }
    if (e.target.closest('.perm-pending-fix')) {
      void submitVerdict(action, id, { disposition: 'fix-action', decidedBy: 'user' });
      return;
    }
    if (e.target.closest('.perm-pending-promote-btn')) {
      state.promotingId = id;
      state.promoteGroup = '';
      state.error = null;
      paint();
      return;
    }
    if (e.target.closest('.perm-pending-cancel-promote')) {
      state.promotingId = null;
      state.error = null;
      paint();
      return;
    }
    if (e.target.closest('.perm-pending-confirm-promote')) {
      const denial = findDenial(action, id);
      if (!denial?.suggested || !state.promoteGroup) return;
      const gated = GATED_GROUP_NAMES.includes(state.promoteGroup);
      if (gated && !confirm(
        `Promoting into the gated group "${state.promoteGroup}" lets every future call this rule matches run without a per-call approval. Continue?`
      )) return;
      void submitVerdict(action, id, {
        disposition: 'promote',
        group: state.promoteGroup,
        rule: denial.suggested,
        decidedBy: 'user',
      });
    }
  });

  mount.addEventListener('change', (e) => {
    if (!e.target.classList.contains('perm-pending-group-select')) return;
    state.promoteGroup = e.target.value;
    paint();
  });

  paint();
  const unsub = grantsStore.subscribe(paint);
  void grantsStore.loadPending();
  void grantsStore.loadGroups();
  void loadCatalog();
  return unsub;
}
