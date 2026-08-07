// Sessions right rail: session info card + tasks (with provenance) + subagent
// cards. Mounted once per Sessions-surface build (shell/surfaces.js only calls
// renderContext on surface switch, not on selection change — see its `paint()`),
// so this module owns its own nav subscription to react to session switches.

import { sessions } from '../../state/sessions.js';
import { subagents } from '../../state/subagents.js';
import { usage } from '../../state/usage.js';
import { nav } from '../../state/nav.js';
import { escapeHtml } from '../../util.js';
import { contextUsage } from '../../utils/context-usage.js';
import { sortedTodoEntries, todoProvenanceText } from '../todos-core.js';
import { subagentCardHtml } from '../agents-sheet/cards.js';
import { openAgentsForSession } from '../../app-bridge.js';

const MODE_LABEL = { ask: 'Ask (safe)', plan: 'Plan', 'accept-edits': 'Accept edits', bypass: 'Bypass' };

let mcpCache = null; // { servers, fetchedAt } — process-wide, not per-session.
async function fetchMcpStatus() {
  if (mcpCache && Date.now() - mcpCache.fetchedAt < 30_000) return mcpCache.servers;
  try {
    const r = await fetch('/api/mcp/status');
    if (r.ok) {
      const data = await r.json();
      mcpCache = { servers: data.servers ?? [], fetchedAt: Date.now() };
    }
  } catch { /* leave whatever's cached, or empty */ }
  return mcpCache?.servers ?? [];
}

function fmtSize(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

function shortCwd(cwd) {
  if (!cwd) return '—';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 3) return cwd;
  return '/' + parts.slice(-3).join('/');
}

function infoCardHtml(sessionId, mcpServers) {
  const slice = sessions.getSlice(sessionId);
  const sl = slice?.statusline ?? null;
  const cu = contextUsage(sl, slice?.lastUsage ?? null, {
    fallbackTotal: usage.get().contextWindow || undefined,
    retagTo1M: usage.get().projectContextWindow === 1_000_000,
  });
  // Statusline is authoritative, but doesn't fire in --print mode / before the
  // first hook. Fall back to the model/tokens seeded from message_start (same
  // source the meter strip uses) so the row isn't stuck on "—".
  let modelLabel = sl?.model?.display_name || sl?.model?.id || cu.modelDisplay || null;
  const size = fmtSize(sl?.contextWindow?.context_window_size ?? (cu.known ? cu.total : null));
  const used = fmtSize(cu.known ? cu.used : null);
  const tokensLabel = (size && used) ? `${used} / ${size}` : null;
  const cwd = slice?.cwd ?? slice?.spawnCwd ?? null;
  const mode = slice?.approvalMode ?? 'ask';
  const connected = mcpServers.filter((s) => s.status !== 'unreachable').length;

  const rows = [
    ['Model', modelLabel ? `<span class="v mono">${escapeHtml(modelLabel)}</span>` : `<span class="v">—</span>`],
    ['CWD', cwd ? `<span class="v mono" title="${escapeHtml(cwd)}">${escapeHtml(shortCwd(cwd))}</span>` : `<span class="v">—</span>`],
    ['Mode', `<span class="v rail-mode rail-mode-${escapeHtml(mode)}">${escapeHtml(MODE_LABEL[mode] ?? mode)}</span>`],
    ['Tokens', tokensLabel ? `<span class="v mono">${escapeHtml(tokensLabel)}</span>` : `<span class="v">—</span>`],
  ];
  if (mcpServers.length > 0) {
    rows.push(['MCPs', `<span class="v"><span class="o-pill ok">${connected} connected</span></span>`]);
  }
  const cells = rows.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span>${v}`).join('');
  return `<div class="o-card rail-info-card">${cells}</div>`;
}

function todoRowHtml(id, t) {
  const status = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'pending';
  const box = status === 'done' ? '✓' : status === 'doing' ? '▶' : '◯';
  const label = (status === 'doing' && t.activeForm) ? t.activeForm : (t.subject || `Task #${id}`);
  const meta = todoProvenanceText(t);
  return `
    <div class="rail-todo rail-todo-${status}">
      <span class="rail-todo-box" aria-hidden="true">${box}</span>
      <div class="rail-todo-body">
        <div class="rail-todo-text">${escapeHtml(label)}</div>
        ${meta ? `<div class="rail-todo-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
    </div>
  `;
}

function tasksSectionHtml(sessionId, hideDone) {
  const slice = sessions.getSlice(sessionId);
  const entries = sortedTodoEntries(slice?.todos ?? new Map()).filter(([, t]) => t.status !== 'deleted');
  if (entries.length === 0) return '';
  const doneCount = entries.filter(([, t]) => t.status === 'completed').length;
  const visible = hideDone ? entries.filter(([, t]) => t.status !== 'completed') : entries;
  const rows = visible.map(([id, t]) => todoRowHtml(id, t)).join('');
  return `
    <div class="rail-section">
      <div class="o-group-hdr rail-section-hdr">
        <h3>Tasks</h3>
        <span class="o-group-count rail-section-count">${doneCount} of ${entries.length}</span>
        <span class="o-group-rule rail-rule"></span>
        <button type="button" class="o-btn o-btn--ghost sm rail-hide-done" data-action="toggle-hide-done">${hideDone ? 'Show done' : 'Hide done'}</button>
      </div>
      <div class="rail-todos">${rows}</div>
    </div>
  `;
}

function subagentsSectionHtml(sessionId) {
  const slice = subagents.forSession(sessionId);
  if (slice.byId.size === 0) return '';
  const items = slice.tabOrder.map((id) => [id, slice.byId.get(id)]).filter(([, b]) => b);
  const running = items.filter(([, b]) => !b.completion);
  const done = items.filter(([, b]) => b.completion)
    .sort((a, b) => (b[1].completion.completedAt || 0) - (a[1].completion.completedAt || 0));
  const summary = `${running.length} running${done.length ? ` · ${done.length} done` : ''}`;
  const cards = [...running, ...done].map(([id, b]) => subagentCardHtml(id, b)).join('');
  return `
    <div class="rail-section">
      <div class="o-group-hdr rail-section-hdr">
        <h3>Subagents</h3>
        <span class="o-group-count rail-section-count">${escapeHtml(summary)}</span>
        <span class="o-group-rule rail-rule"></span>
      </div>
      <div class="rail-subagents">${cards}</div>
    </div>
  `;
}

export function renderContext(mount) {
  mount.classList.add('sess-rail');
  let currentId = null;
  let hideDone = false;
  let mcpServers = [];

  function loadHideDoneFor(id) {
    try { hideDone = id ? localStorage.getItem(`op:hideDone:${id}`) === '1' : false; } catch { hideDone = false; }
  }

  function wireHandlers(id) {
    const toggleBtn = mount.querySelector('[data-action="toggle-hide-done"]');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        hideDone = !hideDone;
        try { localStorage.setItem(`op:hideDone:${id}`, hideDone ? '1' : '0'); } catch { /* ignore */ }
        paint();
      });
    }
    for (const card of mount.querySelectorAll('.rail-subagent')) {
      const open = () => {
        const agentId = card.dataset.agentId;
        if (agentId) subagents.setActive(agentId, id);
        openAgentsForSession(id);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    }
  }

  function paint() {
    const id = nav.get().selectionBySurface.sessions ?? null;
    if (id !== currentId) { currentId = id; loadHideDoneFor(id); }
    if (!id) { mount.innerHTML = ''; return; }
    const scrollTop = mount.scrollTop;
    const info = infoCardHtml(id, mcpServers);
    const tasks = tasksSectionHtml(id, hideDone);
    const subs = subagentsSectionHtml(id);
    mount.innerHTML = `
      <div class="rail-section">
        <div class="o-group-hdr rail-section-hdr"><h3>Session</h3><span class="o-group-rule rail-rule"></span></div>
        ${info}
      </div>
      ${tasks}
      ${subs}
    `;
    mount.scrollTop = scrollTop;
    wireHandlers(id);
  }

  // Coalesce to one repaint per frame. The stores fan out synchronously with no
  // batching (state/create-store.js), and paint() rebuilds the whole rail via
  // innerHTML + rewires handlers — so hydrating a session with a long transcript
  // and many subagents would otherwise run one full rebuild per store mutation,
  // thousands of them, each O(subagents). Same guard session-view/index.js uses.
  let paintRaf = 0;
  const schedulePaint = () => {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(() => { paintRaf = 0; paint(); });
  };

  fetchMcpStatus().then((servers) => { mcpServers = servers; paint(); });

  paint();
  const unsubNav = nav.subscribe(schedulePaint);
  const unsubSessions = sessions.subscribe(schedulePaint);
  const unsubSubagents = subagents.subscribe(schedulePaint);
  const unsubUsage = usage.subscribe(schedulePaint);
  return () => {
    if (paintRaf) cancelAnimationFrame(paintRaf);
    unsubNav(); unsubSessions(); unsubSubagents(); unsubUsage();
  };
}
