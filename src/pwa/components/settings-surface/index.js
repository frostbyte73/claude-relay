// Settings surface (P2) — sections column + section detail, "macOS System
// Settings" style per the redesign spec. Named "settings-surface" (not
// "settings") to avoid colliding with the old settings-sheet.js, which this
// surface superseded on both layouts and which P4 deleted.
//
// Renders read-only where no real backend exists yet (session-scoped grant
// lifecycle, daemon uptime) rather than fabricating controls — see CLAUDE.md's
// "no fake controls" instruction for this surface.

import { escapeHtml } from '../../util.js';
import { nav } from '../../state/nav.js';
import { isDesktop } from '../../layout/index.js';
import { refreshSessions } from '../../app-bridge.js';
import { openAddProjectSheet } from '../cwd-picker.js';
import { settings, VALID_DEFAULT_MODELS } from '../../state/settings.js';
import { sessions } from '../../state/sessions.js';
import { usage } from '../../state/usage.js';
import { grantsStore, mcpHasWarning } from '../../state/grants.js';
import { settingsSections, permissionGroupRows, allowlistRuleRows, mcpServerRows } from '../../vm/settings.js';
import { renderThemeGrid, renderModeToggle } from '../theme-picker.js';
import { mountPushSection } from '../push/index.js';
import { emptyState } from '../shell/placeholder.js';
import { renderHotkeys } from './hotkeys.js';

const MODEL_LABELS = { default: 'Daemon default', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const APPROVAL_MODES = [
  { key: 'ask', label: 'Ask', desc: 'Tool calls outside the allowlist require explicit approval.' },
  { key: 'accept-edits', label: 'Accept edits', desc: 'Edit/Write/MultiEdit/NotebookEdit auto-approve; Bash and side-effect tools still require approval.' },
  { key: 'plan', label: 'Plan', desc: 'Read-only mode — only Read/Glob/Grep/Web*/Task/MCP read tools run.' },
  { key: 'bypass', label: 'Bypass', desc: 'All tool calls auto-approve. Equivalent to --dangerously-skip-permissions.' },
];

// ── List column ─────────────────────────────────────────────────────────

export function renderList(mount) {
  mount.classList.add('settings-nav-col');

  function paint() {
    const sel = nav.get().selectionBySurface.settings ?? null;
    const warnFlags = { mcp: mcpHasWarning(grantsStore.get()) };
    const groups = settingsSections(warnFlags, isDesktop());
    mount.innerHTML = groups.map((g) => `
      <div class="settings-nav-group">
        <div class="settings-nav-group-label">${escapeHtml(g.label)}</div>
        <div class="settings-nav-list">
          ${g.items.map((item) => `
            <button type="button" class="settings-nav-item${item.key === sel ? ' active' : ''}" data-key="${item.key}">
              <span class="settings-nav-icon">${item.icon}</span>
              <span class="settings-nav-label">${escapeHtml(item.label)}</span>
              ${item.warn ? '<span class="settings-warn-dot" title="Needs attention"></span>' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  mount.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-item');
    if (btn?.dataset.key) nav.setSelection(btn.dataset.key);
  });

  paint();
  const unsubNav = nav.subscribe(paint);
  const unsubGrants = grantsStore.subscribe(paint);
  // Kick off the lazy loads whose results feed the MCP warn-dot as soon as the
  // surface opens, not only once the user drills into MCP connections.
  void grantsStore.ensureMcpLoaded();

  // Deferred to its own microtask: renderList runs synchronously inside the
  // shell frame's paint(), and nav.setSelection() notifies subscribers
  // (including that same paint()) synchronously — calling it inline here
  // would re-enter paint() mid-call and clobber its closed-over `sel`/
  // `lastSelection` locals, leaving the detail pane blank. Deferring lets the
  // outer paint() call finish first, so the notification lands as a clean
  // top-level re-paint.
  //
  // Desktop-only: the always-visible detail pane needs a default section, but
  // on mobile a non-null selection makes screens.js skip the section list and
  // land straight on Permissions with a back chevron.
  if (isDesktop() && !nav.get().selectionBySurface.settings) {
    queueMicrotask(() => {
      if (!nav.get().selectionBySurface.settings) nav.setSelection('permissions');
    });
  }

  return () => { unsubNav(); unsubGrants(); };
}

// ── Detail pane ────────────────────────────────────────────────────────

export function renderDetail(mount, deps) {
  const key = deps?.selection;
  if (!key) {
    emptyState(mount, 'Select a section to view its detail.');
    return undefined;
  }
  const renderer = SECTION_RENDERERS[key];
  if (!renderer) {
    emptyState(mount, 'Unknown section.');
    return undefined;
  }
  return renderer(mount);
}

function detailShell(mount, title, lede) {
  mount.innerHTML = `
    <div class="settings-detail">
      <div class="settings-detail-hdr">
        <h1>${escapeHtml(title)}</h1>
        ${lede ? `<p class="settings-detail-lede">${escapeHtml(lede)}</p>` : ''}
      </div>
      <div class="settings-detail-body"></div>
    </div>
  `;
  return mount.querySelector('.settings-detail-body');
}

function block(body, heading, contentHtml) {
  const section = document.createElement('div');
  section.className = 'o-section settings-block';
  section.innerHTML = `<h3 class="o-microhead">${escapeHtml(heading)}</h3>${contentHtml}`;
  body.appendChild(section);
  return section;
}

// ── Theme ──────────────────────────────────────────────────────────────

function renderTheme(mount) {
  const body = detailShell(mount, 'Theme', 'Applies everywhere — sessions, tracked jobs, and this settings page.');
  const themeSection = block(body, 'Palette', '<div class="theme-grid-mount"></div>');
  const modeSection = block(body, 'Mode', '<div class="mode-toggle-mount"></div>');
  const unmountGrid = renderThemeGrid(themeSection.querySelector('.theme-grid-mount'));
  const unmountMode = renderModeToggle(modeSection.querySelector('.mode-toggle-mount'));
  return () => { unmountGrid(); unmountMode(); };
}

// ── Density ────────────────────────────────────────────────────────────

const DENSITIES = [
  { key: 'compact', label: 'Compact' },
  { key: 'default', label: 'Default' },
  { key: 'roomy', label: 'Roomy' },
];

function renderDensity(mount) {
  const body = detailShell(mount, 'Density', 'Row height and spacing across lists and tables.');
  const section = block(body, 'Row density', `
    <div class="settings-segmented" data-role="density">
      ${DENSITIES.map((d) => `<button type="button" data-value="${d.key}">${escapeHtml(d.label)}</button>`).join('')}
    </div>
  `);
  function paint() {
    const current = nav.get().density;
    for (const btn of section.querySelectorAll('button[data-value]')) {
      btn.classList.toggle('active', btn.dataset.value === current);
    }
  }
  section.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn?.dataset.value) nav.setDensity(btn.dataset.value);
  });
  paint();
  const unsub = nav.subscribe(paint);
  return unsub;
}

// ── Model defaults ─────────────────────────────────────────────────────

function renderModelDefaults(mount) {
  const body = detailShell(mount, 'Model defaults', 'Applied to new sessions started from here on — a specific session can still be overridden from its header badge.');
  const modelSection = block(body, 'Default model for new sessions', `
    <div class="settings-segmented" data-role="model">
      ${VALID_DEFAULT_MODELS.map((m) => `<button type="button" data-value="${m}">${escapeHtml(MODEL_LABELS[m] ?? m)}</button>`).join('')}
    </div>
    <p class="settings-note">Seeds the ⌘K palette's model chip — cycle it there (⌘M) to override a single launch.</p>
  `);
  const approvalSection = block(body, 'Default approval mode', `
    <div class="settings-segmented" data-role="approval">
      ${APPROVAL_MODES.map((m) => `<button type="button" data-value="${m.key}">${escapeHtml(m.label)}</button>`).join('')}
    </div>
    <p class="settings-note" data-role="approval-desc"></p>
  `);
  const concurrencySection = block(body, 'Autonomous launch concurrency', `
    <div class="settings-row">
      <label class="settings-row-label" for="settings-launch-concurrency">Jobs launched at once</label>
      <input class="settings-row-input" id="settings-launch-concurrency" type="number" min="1" step="1" inputmode="numeric" />
    </div>
    <p class="settings-note">How many token-scheduled jobs run at once. Higher spends tokens faster; 1 finishes one at a time.</p>
  `);

  function paintModel() {
    const current = settings.get().defaultModel;
    for (const btn of modelSection.querySelectorAll('button[data-value]')) {
      btn.classList.toggle('active', btn.dataset.value === current);
    }
  }
  function paintApproval() {
    const current = settings.get().defaultApprovalMode ?? 'ask';
    for (const btn of approvalSection.querySelectorAll('button[data-value]')) {
      btn.classList.toggle('active', btn.dataset.value === current);
    }
    const desc = APPROVAL_MODES.find((m) => m.key === current)?.desc ?? '';
    approvalSection.querySelector('[data-role="approval-desc"]').textContent = desc;
  }
  const concurrencyInput = concurrencySection.querySelector('#settings-launch-concurrency');
  function paintConcurrency() {
    // Skip while the field has focus so a live broadcast from another device
    // doesn't clobber keystrokes mid-edit here.
    if (document.activeElement === concurrencyInput) return;
    concurrencyInput.value = String(settings.get().launchConcurrency);
  }

  modelSection.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn?.dataset.value) settings.setDefaultModel(btn.dataset.value);
  });
  approvalSection.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn?.dataset.value) settings.setDefaultApprovalMode(btn.dataset.value);
  });
  concurrencyInput.addEventListener('change', () => {
    const n = Number(concurrencyInput.value);
    if (Number.isInteger(n) && n >= 1) settings.setLaunchConcurrency(n);
    else concurrencyInput.value = String(settings.get().launchConcurrency);
  });

  paintModel();
  paintApproval();
  paintConcurrency();
  const unsub = settings.subscribe(() => { paintModel(); paintApproval(); paintConcurrency(); });
  return unsub;
}

// ── Permissions ────────────────────────────────────────────────────────

function groupRowHtml(row) {
  return `
    <div class="permgroup-row">
      <span class="o-pill grp-${row.tone}">${escapeHtml(row.name)}</span>
      <div class="permgroup-desc">${escapeHtml(row.description)}</div>
      <span class="permgroup-count">${row.actionCount} action${row.actionCount === 1 ? '' : 's'}</span>
    </div>
  `;
}

function allowRowHtml(row, idx) {
  return `
    <div class="allow-row">
      <span class="allow-row-icon" aria-hidden="true">✓</span>
      <div>
        <div class="allow-row-pattern">${escapeHtml(row.pattern)}</div>
        <div class="allow-row-scope">${escapeHtml(row.kind)} · ${escapeHtml(row.scopeText)}</div>
      </div>
      <button type="button" class="o-btn o-btn--default sm allow-row-revoke" data-revoke-idx="${idx}">Revoke</button>
    </div>
  `;
}

function renderPermissions(mount) {
  const body = detailShell(mount, 'Permissions', 'Permission groups gate what tools each skill can call. Extras narrow those groups per-action.');
  const groupsSection = block(body, 'Groups in use', '<div class="settings-loading">Loading…</div>');
  const grantsSection = block(body, 'Grants', '<div class="settings-loading">Loading…</div>');

  // grantsStore caches rules for the tab's lifetime (no reload mutator yet) —
  // track revocations locally so the list reflects them without a refetch.
  const revoked = new Set();
  const ruleKey = (r) => r.id ?? `${r.kind}:${r.value}:${JSON.stringify(r.scope)}`;
  const visibleRules = () => (grantsStore.get().rules ?? []).filter((r) => !revoked.has(ruleKey(r)));

  function paint() {
    const state = grantsStore.get();
    const groupRows = permissionGroupRows(state.groups);
    groupsSection.innerHTML = `<h3>Groups in use</h3>${
      state.groupsLoaded
        ? (groupRows.length ? groupRows.map(groupRowHtml).join('') : '<p class="settings-note">No actions registered.</p>')
        : '<div class="settings-loading">Loading…</div>'
    }`;
    const rules = visibleRules();
    const ruleRows = allowlistRuleRows(rules);
    grantsSection.innerHTML = `<h3>Grants${state.rulesLoaded ? ` · ${ruleRows.length}` : ''}</h3>${
      state.rulesLoaded
        ? (ruleRows.length ? ruleRows.map(allowRowHtml).join('') : '<p class="settings-note">No always-allow rules recorded yet.</p>')
        : '<div class="settings-loading">Loading…</div>'
    }`;
  }

  grantsSection.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revoke-idx]');
    if (!btn) return;
    const rule = visibleRules()[Number(btn.dataset.revokeIdx)];
    if (!rule) return;
    if (!confirm(`Revoke "${rule.value}" (${rule.kind})? Future calls matching it will ask again.`)) return;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/allowlist/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      revoked.add(ruleKey(rule));
      paint();
    } catch (err) {
      window.alert(`Revoke failed: ${err.message}`);
      btn.disabled = false;
    }
  });

  paint();
  const unsub = grantsStore.subscribe(paint);
  void grantsStore.ensurePermissionsLoaded();
  return unsub;
}

// ── MCP connections ────────────────────────────────────────────────────

function mcpRowHtml(row) {
  const iconTone = row.tone === 'danger' ? 'hot' : 'ok'; // o-row-icon's danger modifier is named "hot"
  return `
    <div class="o-row mcp-row">
      <span class="o-row-icon ${iconTone}">◈</span>
      <div>
        <div class="o-row-title">${escapeHtml(row.name)}</div>
        <div class="o-row-sub">${escapeHtml(row.transport)}</div>
      </div>
      <span class="o-pill ${row.tone}">${escapeHtml(row.statusLabel)}</span>
    </div>
  `;
}

function renderMcp(mount) {
  const body = detailShell(mount, 'MCP connections', 'Servers configured for spawned sessions (daemon-level MCP config plus your ~/.claude.json).');
  const section = block(body, 'Servers', `
    <button type="button" class="o-btn o-btn--default settings-refresh-btn">Refresh</button>
    <div class="o-row-group mcp-rows"></div>
  `);
  const rowsEl = section.querySelector('.mcp-rows');
  const refreshBtn = section.querySelector('.settings-refresh-btn');

  function paint() {
    const state = grantsStore.get();
    refreshBtn.disabled = state.mcpLoading;
    refreshBtn.textContent = state.mcpLoading ? 'Refreshing…' : 'Refresh';
    if (!state.mcpLoaded) {
      rowsEl.innerHTML = '<div class="settings-loading">Loading…</div>';
      return;
    }
    const rows = mcpServerRows(state.mcpServers);
    rowsEl.innerHTML = rows.length
      ? rows.map(mcpRowHtml).join('')
      : '<p class="settings-note">No MCP servers configured.</p>';
  }

  refreshBtn.addEventListener('click', () => { void grantsStore.loadMcp(); });
  paint();
  const unsub = grantsStore.subscribe(paint);
  void grantsStore.ensureMcpLoaded();
  return unsub;
}

// ── Projects ───────────────────────────────────────────────────────────

function renderProjects(mount) {
  const body = detailShell(mount, 'Projects', 'Repos registered with Outpost — the cwds ⌘K offers for new sessions and jobs.');
  const section = block(body, 'Registered projects', `
    <div class="settings-projects"></div>
    <button type="button" class="o-btn o-btn--default settings-add-project">+ Add project…</button>
  `);
  const rowsEl = section.querySelector('.settings-projects');

  function paint() {
    const projects = [...(sessions.get().projects ?? [])].sort((a, b) => a.cwd.localeCompare(b.cwd));
    rowsEl.innerHTML = projects.length
      ? projects.map((p) => `
        <div class="settings-project-row">
          <span class="settings-project-cwd">${escapeHtml(p.cwd)}</span>
          ${p.isGitRepo ? '' : '<span class="o-pill">not a git repo</span>'}
          <button type="button" class="o-btn o-btn--default sm settings-project-remove" data-cwd="${escapeHtml(p.cwd)}">Remove</button>
        </div>
      `).join('')
      : '<p class="settings-note">No projects registered yet.</p>';
  }

  rowsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.settings-project-remove');
    if (!btn) return;
    const cwd = btn.dataset.cwd;
    if (!confirm(`Remove ${cwd} from Outpost? Sessions and worktrees on disk are untouched.`)) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/projects', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd }) });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      refreshSessions();
    } catch (err) {
      window.alert(`Remove failed: ${err.message}`);
      btn.disabled = false;
    }
  });
  section.querySelector('.settings-add-project').addEventListener('click', () => openAddProjectSheet());

  paint();
  return sessions.subscribe(paint);
}

// ── Notifications ──────────────────────────────────────────────────────

function renderNotifications(mount) {
  const body = detailShell(mount, 'Notifications', 'Push notifications for approvals and job completions while this tab isn’t focused.');
  const section = block(body, 'Push', '<div class="push-mount"></div>');
  return mountPushSection(section.querySelector('.push-mount'));
}

// ── Daemon: Tailscale ──────────────────────────────────────────────────

function kv(label, value) {
  return `<div class="settings-kv"><span class="settings-kv-label">${escapeHtml(label)}</span><span class="settings-kv-value">${escapeHtml(value)}</span></div>`;
}

function renderTailscale(mount) {
  const body = detailShell(mount, 'Tailscale', 'This page is already being served over the tailnet — the host below is how you reached it.');
  block(body, 'Connection', `
    ${kv('Reached via', typeof location !== 'undefined' ? location.host : '—')}
    ${kv('Protocol', typeof location !== 'undefined' ? location.protocol.replace(':', '') : '—')}
  `);
  return undefined;
}

// ── Daemon: Health & logs ──────────────────────────────────────────────

function renderHealth(mount) {
  const body = detailShell(mount, 'Health & logs', 'Read-only daemon status.');
  const section = block(body, 'Daemon', '');
  function paint() {
    const info = usage.get().daemonInfo;
    section.innerHTML = `<h3>Daemon</h3>${
      info
        ? `${kv('Version', info.version ?? '—')}${kv('Allowlist rules', String(info.allowlistRuleCount ?? 0))}${kv('Approval timeout', `${Math.round((info.approvalTimeoutMs ?? 0) / 1000)}s`)}`
        : '<div class="settings-loading">Loading…</div>'
    }`;
  }
  paint();
  return usage.subscribe(paint);
}

// ── Daemon: Advanced ───────────────────────────────────────────────────

function renderAdvanced(mount) {
  const body = detailShell(mount, 'Advanced', '');
  const section = block(body, 'Transcript retention', `
    <div class="settings-row">
      <label class="settings-row-label" for="settings-max-transcript">Messages kept per session</label>
      <input class="settings-row-input" id="settings-max-transcript" type="number" min="50" max="10000" step="50" inputmode="numeric" />
    </div>
    <p class="settings-note">Applies to every session — oldest messages fall off first.</p>
  `);
  const input = section.querySelector('#settings-max-transcript');
  input.value = String(sessions.get().maxTranscriptLines);
  input.addEventListener('change', () => {
    const n = Number(input.value);
    if (!Number.isFinite(n)) { input.value = String(sessions.get().maxTranscriptLines); return; }
    sessions.setMaxTranscriptLines(n);
    input.value = String(sessions.get().maxTranscriptLines);
  });
  return undefined;
}

const SECTION_RENDERERS = {
  theme: renderTheme,
  density: renderDensity,
  'model-defaults': renderModelDefaults,
  permissions: renderPermissions,
  projects: renderProjects,
  mcp: renderMcp,
  notifications: renderNotifications,
  tailscale: renderTailscale,
  health: renderHealth,
  advanced: renderAdvanced,
  hotkeys: renderHotkeys,
};
