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
import { reconcileKeyedRows, resetKeyedRows } from '../../utils/keyed-rows.js';
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

// Task rows + the counts the section header shows. The `.rail-section` wrapper
// and header live in the persistent skeleton (see buildSkeleton), because
// `.sess-rail`'s flex `gap` applies to its direct children and a wrapper
// appearing/disappearing would shift the rail's spacing.
function tasksFor(sessionId, hideDone) {
  const slice = sessions.getSlice(sessionId);
  const entries = sortedTodoEntries(slice?.todos ?? new Map()).filter(([, t]) => t.status !== 'deleted');
  const doneCount = entries.filter(([, t]) => t.status === 'completed').length;
  const visible = hideDone ? entries.filter(([, t]) => t.status !== 'completed') : entries;
  return {
    total: entries.length,
    doneCount,
    rows: visible.map(([id, t]) => ({ key: id, html: todoRowHtml(id, t) })),
  };
}

// Running first, then completed newest-first — the order the cards are keyed
// into the DOM by.
function orderedSubagents(sessionId) {
  const slice = subagents.forSession(sessionId);
  const items = slice.tabOrder.map((id) => [id, slice.byId.get(id)]).filter(([, b]) => b);
  const running = items.filter(([, b]) => !b.completion);
  const done = items.filter(([, b]) => b.completion)
    .sort((a, b) => (b[1].completion.completedAt || 0) - (a[1].completion.completedAt || 0));
  return { running, done, ordered: [...running, ...done] };
}

export function renderContext(mount) {
  mount.classList.add('sess-rail');
  let currentId = null;
  let hideDone = false;
  let mcpServers = [];
  let dom = null;

  function loadHideDoneFor(id) {
    try { hideDone = id ? localStorage.getItem(`op:hideDone:${id}`) === '1' : false; } catch { hideDone = false; }
  }

  // Built once; per paint only the regions inside it are updated, and both lists
  // are reconciled by key. Two reasons: a session with dozens of subagents used
  // to rebuild ~100 KB of cards and rebind a handler per card on every store
  // tick (the rail listens to sessions + subagents + usage), and the in-progress
  // task dot carries an infinite CSS pulse that restarts whenever its element is
  // re-created — same defect renderThinkingStrip already guards against.
  function buildSkeleton() {
    mount.innerHTML = `
      <div class="rail-section">
        <div class="o-group-hdr rail-section-hdr"><h3>Session</h3><span class="o-group-rule rail-rule"></span></div>
        <div class="rail-info-slot"></div>
      </div>
      <div class="rail-section rail-tasks-section" hidden>
        <div class="o-group-hdr rail-section-hdr">
          <h3>Tasks</h3>
          <span class="o-group-count rail-section-count"></span>
          <span class="o-group-rule rail-rule"></span>
          <button type="button" class="o-btn o-btn--ghost sm rail-hide-done" data-action="toggle-hide-done"></button>
        </div>
        <div class="rail-todos"></div>
      </div>
      <div class="rail-section rail-subagents-section" hidden>
        <div class="o-group-hdr rail-section-hdr">
          <h3>Subagents</h3>
          <span class="o-group-count rail-section-count"></span>
          <span class="o-group-rule rail-rule"></span>
        </div>
        <div class="rail-subagents"></div>
      </div>
    `;
    dom = {
      info:      mount.querySelector('.rail-info-slot'),
      tasks:     mount.querySelector('.rail-tasks-section'),
      tasksCount: mount.querySelector('.rail-tasks-section .rail-section-count'),
      hideDoneBtn: mount.querySelector('.rail-hide-done'),
      todos:     mount.querySelector('.rail-todos'),
      subs:      mount.querySelector('.rail-subagents-section'),
      subsCount: mount.querySelector('.rail-subagents-section .rail-section-count'),
      cards:     mount.querySelector('.rail-subagents'),
    };
  }

  // Delegated once onto the mount, so a repaint never rebinds anything. Returns
  // an unwire so a remount of the same mount node can't stack duplicates.
  function wireHandlers() {
    const onClick = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('[data-action="toggle-hide-done"]')) {
        hideDone = !hideDone;
        try { localStorage.setItem(`op:hideDone:${currentId}`, hideDone ? '1' : '0'); } catch { /* ignore */ }
        paint();
        return;
      }
      const card = target.closest('.rail-subagent');
      if (card) openAgent(card);
    };
    const onKeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target instanceof Element ? e.target.closest('.rail-subagent') : null;
      if (!card) return;
      e.preventDefault();
      openAgent(card);
    };
    mount.addEventListener('click', onClick);
    mount.addEventListener('keydown', onKeydown);
    return () => {
      mount.removeEventListener('click', onClick);
      mount.removeEventListener('keydown', onKeydown);
    };
  }

  function openAgent(card) {
    if (!currentId) return;
    const agentId = card.dataset.agentId;
    if (agentId) subagents.setActive(agentId, currentId);
    openAgentsForSession(currentId);
  }

  function paint() {
    const id = nav.get().selectionBySurface.sessions ?? null;
    if (id !== currentId) { currentId = id; loadHideDoneFor(id); }
    if (!id) {
      if (dom) { resetKeyedRows(dom.cards); resetKeyedRows(dom.todos); dom = null; }
      mount.innerHTML = '';
      return;
    }
    if (!dom) buildSkeleton();
    dom.info.innerHTML = infoCardHtml(id, mcpServers);

    const tasks = tasksFor(id, hideDone);
    dom.tasks.hidden = tasks.total === 0;
    dom.tasksCount.textContent = `${tasks.doneCount} of ${tasks.total}`;
    dom.hideDoneBtn.textContent = hideDone ? 'Show done' : 'Hide done';
    reconcileKeyedRows(dom.todos, tasks.rows);

    const { running, done, ordered } = orderedSubagents(id);
    dom.subs.hidden = ordered.length === 0;
    dom.subsCount.textContent = `${running.length} running${done.length ? ` · ${done.length} done` : ''}`;
    reconcileKeyedRows(dom.cards, ordered.map(([agentId, b]) => ({
      key: agentId,
      html: subagentCardHtml(agentId, b),
    })));
  }

  // Coalesce to one repaint per frame. The stores fan out synchronously with no
  // batching (state/create-store.js), so hydrating a session with a long
  // transcript and many subagents would otherwise run one paint per store
  // mutation, thousands of them. Same guard session-view/index.js uses.
  let paintRaf = 0;
  const schedulePaint = () => {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(() => { paintRaf = 0; paint(); });
  };

  fetchMcpStatus().then((servers) => { mcpServers = servers; paint(); });

  const unwireHandlers = wireHandlers();
  paint();
  const unsubNav = nav.subscribe(schedulePaint);
  const unsubSessions = sessions.subscribe(schedulePaint);
  const unsubSubagents = subagents.subscribe(schedulePaint);
  const unsubUsage = usage.subscribe(schedulePaint);
  return () => {
    if (paintRaf) cancelAnimationFrame(paintRaf);
    unwireHandlers();
    unsubNav(); unsubSessions(); unsubSubagents(); unsubUsage();
  };
}
