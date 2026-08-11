// Agents feed + agents sheet UI. Extracted from app.js.
//
// The parent session has a floating "Agents" strip (activeCount + pending
// approval count). Tapping it opens a sheet listing per-agent buckets with
// tool_use tiles, pending approvals inline, and completion summaries.
//
// Consumers: app.js calls initAgentsSheet({ approvalCardHtml, decideApproval,
// alwaysAllowAndApprove, beginRejectWithNote, submitRejectWithNote,
// cancelRejectWithNote }) once at startup.

import { escapeHtml } from '../../util.js';
import { sessions } from '../../state/sessions.js';
import { approvals } from '../../state/approvals.js';
import { subagents } from '../../state/subagents.js';
import {
  dismissSoftKeyboard,
  makeSheetDismissible,
  noteSheetOpen,
  noteSheetClose,
  pinSheetBelowHeader,
} from '../sheet-utils.js';
import { toolUseHtml, shellLineHtml, readLineHtml } from '../tool-use-tile.js';
import { confirmSuggestion } from '../approvals-mobile.js';

let _deps = {
  approvalCardHtml: () => '',
  decideApproval: () => {},
  alwaysAllowAndApprove: () => {},
  beginRejectWithNote: () => {},
  submitRejectWithNote: () => {},
  cancelRejectWithNote: () => {},
};

export function initAgentsSheet(deps) {
  _deps = { ..._deps, ...deps };
}

function agentsStripHtml() {
  const focused = subagents.focused();
  if (focused.byId.size === 0) return '';
  const agents = [...focused.byId.values()];
  // "Active" = anything without a completion stamp. Completed agents still show up in
  // the sheet (in the bottom "Done" group), but the strip headline counts only what's
  // running so the user has a clean signal of in-flight work without the count
  // ballooning across the session.
  const activeCount = agents.filter((b) => !b.completion).length;
  const pending = agents.reduce(
    (n, b) => n + b.entries.filter((e) => e.decision === null).length,
    0,
  );
  const pendingHtml = pending > 0
    ? `<span class="agents-strip-pending"><span class="agents-strip-pulse" aria-hidden="true"></span>${escapeHtml(String(pending))} pending</span>`
    : '';
  return `
    <button class="agents-strip${pending > 0 ? ' agents-strip-attention' : ''}" type="button" id="agents-strip" aria-label="Open agent activity">
      <span class="agents-strip-label">Agents</span>
      <span class="agents-strip-sep" aria-hidden="true">·</span>
      <span class="agents-strip-count">${escapeHtml(String(activeCount))} Active</span>
      ${pendingHtml}
      <span class="agents-strip-expand" aria-hidden="true">↗</span>
    </button>
  `;
}

function openAgentsSheet() {
  dismissSoftKeyboard();
  closeAgentsSheet();
  // Selection priority on open:
  //   1. Topmost agent with pending approvals (needs user action).
  //   2. If the last-viewed agent has since completed AND any agent is still active,
  //      switch to the topmost active one — landing on a stale completed agent when
  //      live work is happening is disorienting.
  //   3. Otherwise keep the last-viewed agent.
  const focused = subagents.focused();
  const topPending = focused.tabOrder.find((id) => {
    const b = focused.byId.get(id);
    return b && b.entries.some((e) => e.decision === null);
  });
  if (topPending) {
    subagents.setActive(topPending);
  } else {
    const cur = focused.activeId ? focused.byId.get(focused.activeId) : null;
    const curCompleted = cur && cur.completion;
    if (curCompleted) {
      const topActive = focused.tabOrder.find((id) => {
        const b = focused.byId.get(id);
        return b && !b.completion;
      });
      if (topActive) subagents.setActive(topActive);
    }
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop agents-sheet-backdrop';
  backdrop.id = 'agents-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet agents-sheet';
  sheet.id = 'agents-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Subagent activity');
  sheet.innerHTML = agentsSheetBodyHtml();
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  pinSheetBelowHeader(sheet, { fillVertical: true });
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  backdrop.onclick = closeAgentsSheet;
  wireAgentsSheetHandlers(sheet);
  makeSheetDismissible(sheet, closeAgentsSheet);
  noteSheetOpen(closeAgentsSheet);
  // Land on the latest entries when the sheet first opens. After this, the
  // sticky-bottom heuristic in refreshAgentsSheet decides whether to follow
  // newly-arriving entries based on whether the user has scrolled up.
  const feed = sheet.querySelector('.agents-sheet-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

// Refresh rebuilds the sheet's innerHTML to pick up new entries/decisions. Without
// the scroll preservation below, the tab rail snaps to scrollLeft=0 on every refresh
// (lost off-screen tabs) and the feed snaps to scrollTop=0 (yanks the approval button
// out from under your finger mid-tap).
//
// Feed scroll uses a sticky-bottom strategy: if the user was already at/near the
// bottom of the feed before refresh, pin them to the new bottom afterward (so an
// arriving entry stays in view). If they had scrolled UP to read history, preserve
// the exact scrollTop so we don't yank them. Tab rail scroll is always preserved.
// `resetFeedScroll` is the explicit reset path (tab switches show a different agent's
// history, so previous scrollTop is meaningless).
function refreshAgentsSheet(opts) {
  const sheet = document.getElementById('agents-sheet');
  if (!sheet) return;
  const resetFeedScroll = opts?.resetFeedScroll === true;
  const resetTabsScroll = opts?.resetTabsScroll === true;
  const oldTabs = sheet.querySelector('.agents-tabs');
  const oldFeed = sheet.querySelector('.agents-sheet-feed');
  const tabsScrollTop = oldTabs?.scrollTop ?? 0;
  const feedScrollTop = oldFeed?.scrollTop ?? 0;
  // Treat "within 80px of bottom" as stuck-to-bottom — same fudge factor chat apps
  // use to absorb a few pixels of finger overshoot or browser sub-pixel rounding.
  const wasAtBottom = oldFeed
    ? (oldFeed.scrollHeight - oldFeed.scrollTop - oldFeed.clientHeight) < 80
    : true;

  sheet.innerHTML = agentsSheetBodyHtml();
  wireAgentsSheetHandlers(sheet);
  // innerHTML rebuild discarded the old grabber node, so re-attach the dismiss
  // gesture handlers to the fresh one.
  makeSheetDismissible(sheet, closeAgentsSheet);

  // Preserve the tab-list scroll position on refresh, EXCEPT when the caller explicitly
  // requests a reset (clicking a pending agent — that row should already be at the
  // top of the list, so snapping there is a no-op visually but keeps the user oriented
  // when their tap moved the selection to a different group). Without preservation,
  // every refresh — including ones triggered by background events — would yank the
  // scroll back to the top mid-read.
  const newTabs = sheet.querySelector('.agents-tabs');
  if (newTabs) {
    newTabs.scrollTop = resetTabsScroll ? 0 : tabsScrollTop;
    // Toggle the bottom-edge fade hint based on whether the tab list actually overflows.
    newTabs.classList.toggle('agents-tabs-overflow', newTabs.scrollHeight > newTabs.clientHeight + 1);
  }
  const newFeed = sheet.querySelector('.agents-sheet-feed');
  if (newFeed) {
    if (resetFeedScroll || wasAtBottom) {
      newFeed.scrollTop = newFeed.scrollHeight;
    } else {
      newFeed.scrollTop = feedScrollTop;
    }
  }
}

function closeAgentsSheet() {
  const backdrop = document.getElementById('agents-sheet-backdrop');
  const sheet = document.getElementById('agents-sheet');
  if (!backdrop && !sheet) return;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => {
    backdrop?.remove();
    sheet?.remove();
  }, 380);
}

// Sheet body is rebuilt from scratch on every refresh — keeps tab state in sync with
// the focused slice's activeId without having to diff DOM children. Tab + button
// handlers get re-wired by wireAgentsSheetHandlers below.
function agentsSheetBodyHtml() {
  const focused = subagents.focused();
  // Stable display order: focused.tabOrder drives the tab rail. Entries land at
  // the end on first sighting; approval_pending arrivals bump to front via
  // bringAgentToFront. After-decision shuffling stays disabled so the tabs don't
  // reorder out from under the user's finger.
  const agents = focused.tabOrder
    .map((id) => [id, focused.byId.get(id)])
    .filter(([, b]) => b);
  if (agents.length === 0) {
    return `
      <div class="grabber"></div>
      <div class="header-row">
        <span class="sheet-title">Agents</span>
        <button class="sheet-close" id="agents-sheet-close" aria-label="Close">✕</button>
      </div>
      <div class="empty-state">No subagent activity yet.</div>
    `;
  }
  // Three-way partition so the user always sees what most needs attention at the top:
  //   1. pending  — active agents with at least one undecided approval card
  //   2. active   — running agents currently quiet (no pendings)
  //   3. completed — finished agents, sorted by completion time DESCENDING (newest at
  //                  the top of the completed section, oldest sinking to the bottom)
  // Within the pending and active groups we preserve the dispatch order encoded in
  // focused.tabOrder so positions don't shuffle every time a tool finishes. The
  // pending vs active split itself happens here on every render, so the moment a new
  // approval lands the agent jumps to the top without needing a separate bump call.
  const pending = [];
  const active = [];
  const completed = [];
  for (const pair of agents) {
    if (pair[1].completion) {
      completed.push(pair);
    } else if (pair[1].entries.some((e) => e.decision === null)) {
      pending.push(pair);
    } else {
      active.push(pair);
    }
  }
  completed.sort((a, b) => (b[1].completion.completedAt || 0) - (a[1].completion.completedAt || 0));

  // Snap active tab onto a still-existing agent if the previously-active one is gone.
  // Land order: agents needing approval first, then running, then completed — same
  // priority as the rendered list so the default selection always matches what the
  // user's eye lands on at the top.
  let activeId = focused.activeId;
  const stillExists = agents.find(([id]) => id === activeId);
  if (!stillExists) {
    activeId = pending[0]?.[0] || active[0]?.[0] || completed[0]?.[0] || null;
    subagents.setActive(activeId);
  }

  const runningCount = pending.length + active.length;
  const totalPending = pending.reduce(
    (sum, [, b]) => sum + b.entries.filter((e) => e.decision === null).length,
    0,
  );
  const summary = `${runningCount} active${completed.length ? ` · ${completed.length} done` : ''}${totalPending ? ` · ${totalPending} awaiting approval` : ''}`;

  const renderTab = ([id, b]) => {
    const pending = b.entries.filter((e) => e.decision === null).length;
    const isActive = id === activeId;
    const isCompleted = !!b.completion;
    const isKilled = isCompleted && b.completion.status === 'killed';
    const badge = pending > 0
      ? `<span class="agents-tab-badge">${escapeHtml(String(pending))}</span>`
      : '';
    // Description (from parent's Agent invocation, best-effort bound by subagent_type
    // when the bucket was created) IS the agent's identity — promote it to the primary
    // tab label so users can scan all parallel agents at once instead of tapping
    // through to read each one. Fall back to the agent type when no description is
    // bound. Meta line is just the 8-char hash so the row stays wide enough to show
    // the description even on narrow phone widths. Completed agents get a small glyph
    // (✓ / ✕) in front of the hash as the visual signal that they're done.
    const primary = b.description || b.agentType;
    const doneGlyph = isCompleted
      ? `<span class="agents-tab-done-glyph" aria-hidden="true">${isKilled ? '✕' : '✓'}</span>`
      : '';
    const classes = [
      'agents-tab',
      isActive ? 'active' : '',
      pending > 0 ? 'has-pending' : '',
      isCompleted ? 'completed' : '',
      isKilled ? 'killed' : '',
    ].filter(Boolean).join(' ');
    const tabId = `agents-tab-${escapeHtml(id)}`;
    return `
      <button class="${classes}" type="button" data-agent-id="${escapeHtml(id)}" role="tab"
              id="${tabId}" aria-controls="agents-sheet-feed" aria-selected="${isActive ? 'true' : 'false'}"
              tabindex="${isActive ? '0' : '-1'}">
        <span class="agents-tab-label">${escapeHtml(primary)}</span>
        <span class="agents-tab-meta">
          ${doneGlyph}
          <span class="agents-tab-id">${escapeHtml(id.slice(0, 8))}</span>
          ${badge}
        </span>
      </button>
    `;
  };

  const pendingTabs = pending.map(renderTab).join('');
  const activeTabs = active.map(renderTab).join('');
  const completedTabs = completed.map(renderTab).join('');
  // Only render a "Done" divider when there's both running activity above and finished
  // agents below it — a label with nothing above is just visual noise. We don't need a
  // divider between pending and active: the left-edge accent bar on pending tabs is the
  // visual signal that those rows need attention.
  const doneDivider = ((pending.length + active.length) > 0 && completed.length > 0)
    ? `<div class="agents-tabs-divider">Done</div>`
    : '';

  const activeBucket = activeId ? focused.byId.get(activeId) : null;
  const feed = activeBucket ? agentFeedHtml(activeBucket) : '';

  return `
    <div class="grabber"></div>
    <div class="header-row agents-sheet-header">
      <div class="agents-sheet-title-block">
        <span class="sheet-title">Agents</span>
        <span class="agents-sheet-summary">${escapeHtml(summary)}</span>
      </div>
      <button class="sheet-close" id="agents-sheet-close" aria-label="Close">✕</button>
    </div>
    <div class="agents-tabs" role="tablist" aria-label="Agents">${pendingTabs}${activeTabs}${doneDivider}${completedTabs}</div>
    <div class="agents-sheet-feed" id="agents-sheet-feed" role="tabpanel" tabindex="0"
         aria-labelledby="${activeId ? `agents-tab-${escapeHtml(activeId)}` : ''}">${feed}</div>
  `;
}

// One agent's feed = a mini-transcript. Pending entries render as full approval cards
// (the same chrome the parent feed uses for its own approvals); resolved entries
// transform into plain tool tiles, with a "rejected" wrapper-class on deny so the user
// can see "Claude wanted to do this and you said no." If the agent has finished, the
// completion tile (parsed from <task-notification>) gets appended after the entries
// as the visual "fin." marker — the user can scroll to it to see status + summary.
function agentFeedHtml(bucket) {
  // If the parent's Agent invocation handed this subagent a description, surface it as a
  // quoted header at the top of the feed so the user remembers what the agent was asked
  // to do without scrolling the parent transcript. Best-effort — for parallel same-type
  // spawns the binding can be approximate (see recordParentAgentInvocation).
  const prompt = bucket.description
    ? `<div class="agent-feed-prompt"><span class="agent-feed-prompt-label">Spawned by</span><div class="agent-feed-prompt-text">${escapeHtml(bucket.description)}</div></div>`
    : '';
  // The last entry is "active" only when the agent itself is still running — once a
  // completion tile drops in, the trailing Read line stops animating its ellipsis.
  const liveTail = !bucket.completion;
  // Path context comes from the bucket's own sessionId — not whichever session
  // the Sessions surface last painted — so this stays correct for any bucket
  // shown by the sheet, regardless of what else is on screen.
  const slice = bucket.sessionId ? sessions.getSlice(bucket.sessionId) : null;
  const ctx = { cwd: slice?.cwd ?? null, worktreePath: slice?.spawnCwd ?? null };
  const tiles = bucket.entries.map((entry, i, arr) => agentEntryHtml(entry, liveTail && i === arr.length - 1, ctx, bucket.sessionId));
  if (bucket.completion) tiles.push(agentCompletionTileHtml(bucket.completion));
  if (tiles.length === 0 && !prompt) {
    return `<div class="empty-state">Waiting for activity…</div>`;
  }
  if (tiles.length === 0) {
    return `${prompt}<div class="empty-state">Waiting for activity…</div>`;
  }
  return `${prompt}${tiles.join('')}`;
}

// Footer tile shown once the subagent emits its <task-notification>. Mirrors the
// resolved-task style of other "this is done" affordances in the app (italic display
// label, mono metrics line). Status flips the chrome to danger when the task was
// killed instead of completing normally.
function agentCompletionTileHtml(c) {
  const isKilled = c.status === 'killed';
  const label = isKilled ? 'Stopped' : 'Completed';
  // Format the usage row: only include parts that are actually present in the payload.
  const parts = [];
  if (c.toolUses != null) parts.push(`${c.toolUses} tools`);
  if (c.totalTokens != null) parts.push(`${c.totalTokens.toLocaleString()} tokens`);
  if (c.durationMs != null) parts.push(formatDurationMs(c.durationMs));
  const stats = parts.length > 0
    ? `<div class="agent-complete-stats">${escapeHtml(parts.join(' · '))}</div>`
    : '';
  const summary = c.summary
    ? `<div class="agent-complete-summary">${escapeHtml(c.summary)}</div>`
    : '';
  return `
    <div class="agent-complete${isKilled ? ' agent-complete-killed' : ''}">
      <div class="agent-complete-label">${escapeHtml(label)}</div>
      ${stats}
      ${summary}
    </div>
  `;
}

// Divider between an agent's rounds: the parent sent it a message after it had
// already finished, so everything below this line is the resumed run. The send's
// own summary is the closest thing we have to "what it was asked for" — the full
// message body only exists in the parent's transcript.
function agentResumeTileHtml(entry) {
  const summary = entry.summary
    ? `<div class="agent-resume-summary">${escapeHtml(entry.summary)}</div>`
    : '';
  return `
    <div class="agent-resume">
      <div class="agent-resume-label">Resumed</div>
      ${summary}
    </div>
  `;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, '0')}m`;
}

function agentEntryHtml(entry, isLast, ctx, sessionId) {
  // Markers left by a resume (see subagents.markResumed): the round that had
  // already finished, then the send that woke the agent back up.
  if (entry.kind === 'completed-round') return agentCompletionTileHtml(entry.completion);
  if (entry.kind === 'resumed') return agentResumeTileHtml(entry);
  if (entry.decision === null) {
    // The bucket entry itself doesn't carry `suggestion` (see addSubagentEntry) —
    // but approvals.pending holds the full approval_pending payload (suggestion
    // included) for subagent approvals too, so look it up from there.
    const pending = approvals.get().pending.find((a) => a.approvalId === entry.approvalId);
    return _deps.approvalCardHtml({
      approvalId: entry.approvalId,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      summary: '',
      enqueuedAt: entry.enqueuedAt,
      sessionId,
      suggestion: pending?.suggestion ?? null,
    });
  }
  // Resolved Read entries render as the slim status line, never as a full tile —
  // matches how Reads render in the parent transcript.
  if (entry.toolName === 'Read') {
    return readLineHtml(entry.toolInput, ctx);
  }
  // Bash / Grep / Glob / WebFetch / WebSearch get the same inline shell-line treatment
  // in subagent feeds as in the parent transcript — slim mono row, no card chrome.
  if (
    entry.toolName === 'Bash'
    || entry.toolName === 'Grep'
    || entry.toolName === 'Glob'
    || entry.toolName === 'WebFetch'
    || entry.toolName === 'WebSearch'
    || entry.toolName === 'Skill'
    || entry.toolName === 'ToolSearch'
  ) {
    const tile = shellLineHtml(entry.toolName, entry.toolInput, ctx);
    if (entry.decision === 'deny') {
      const tag = entry.timedOut ? 'Timed out' : 'Rejected';
      return `<div class="agent-entry-rejected">${tile}<span class="agent-entry-reject-tag">${tag}</span></div>`;
    }
    return tile;
  }
  // Resolved: render as a plain tool tile. Reuse toolUseHtml by synthesizing a
  // transcript-message-shaped object. Prefer the real tool_use_id (auto-allowed
  // entries) and fall back to approvalId (entries that came through the approval
  // queue); either id is unique within its namespace and works for expand-state.
  const tileHtml = toolUseHtml({
    role: 'tool_use',
    text: `${entry.toolName}(${JSON.stringify(entry.toolInput).slice(0, 200)})`,
    toolName: entry.toolName,
    toolInput: entry.toolInput,
    toolUseId: entry.toolUseId || entry.approvalId,
  }, { ctx, expandedTools: sessions.getSlice(sessionId)?.expandedTools });
  if (entry.decision === 'deny') {
    const tag = entry.timedOut ? 'Timed out' : 'Rejected';
    return `<div class="agent-entry-rejected">${tileHtml}<span class="agent-entry-reject-tag">${tag}</span></div>`;
  }
  return tileHtml;
}

// Wire all interactive elements in the sheet. Re-called on every refresh because the
// inner HTML is rebuilt from scratch; the outer <aside> keeps its .open class so the
// slide-in transform isn't re-played.
function wireAgentsSheetHandlers(sheet) {
  const closeBtn = sheet.querySelector('#agents-sheet-close');
  if (closeBtn) closeBtn.onclick = closeAgentsSheet;
  for (const tab of sheet.querySelectorAll('.agents-tab')) {
    tab.onclick = () => {
      const id = tab.dataset.agentId;
      if (!id || id === subagents.focused().activeId) return;
      subagents.setActive(id);
      // Tab switch: feed content swaps entirely, so the previous scrollTop is
      // meaningless. The tab list's vertical scroll stays where the user left it,
      // EXCEPT when switching to a pending-approval agent — those always sort to
      // the very top of the list, so we snap the list there to keep the freshly
      // selected row in view.
      const target = subagents.focused().byId.get(id);
      const targetHasPending = target?.entries.some((e) => e.decision === null) ?? false;
      refreshAgentsSheet({ resetFeedScroll: true, resetTabsScroll: targetHasPending });
    };
  }
  // Approval card buttons inside the agent feed. stopPropagation so they don't also
  // trigger the tool_use-expandable container's tap-to-expand handler beneath them.
  for (const btn of sheet.querySelectorAll('.approval-card .approve')) {
    btn.onclick = (e) => { e.stopPropagation(); _deps.decideApproval(btn.dataset.id, 'allow'); };
  }
  for (const btn of sheet.querySelectorAll('.approval-card .approval-always')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.alwaysId;
      // Subagent entries live in state.subagents buckets, not pendingApprovals — look
      // them up there so the suggested rule reflects the actual tool call.
      let approval = approvals.get().pending.find((a) => a.approvalId === id);
      if (!approval) {
        for (const [, slice] of subagents.get().bySession) {
          for (const [, bucket] of slice.byId) {
            const entry = bucket.entries.find((e) => e.approvalId === id);
            if (entry) { approval = { toolName: entry.toolName, toolInput: entry.toolInput }; break; }
          }
          if (approval) break;
        }
      }
      if (approval) _deps.alwaysAllowAndApprove(id, approval.toolName, approval.toolInput);
    };
  }
  for (const btn of sheet.querySelectorAll('.approval-card .reject')) {
    btn.onclick = (e) => { e.stopPropagation(); _deps.beginRejectWithNote(btn.dataset.id); };
  }
  for (const btn of sheet.querySelectorAll('.approval-card .reject-send')) {
    btn.onclick = (e) => { e.stopPropagation(); _deps.submitRejectWithNote(btn.dataset.id); };
  }
  for (const btn of sheet.querySelectorAll('.approval-card .reject-cancel')) {
    btn.onclick = (e) => { e.stopPropagation(); _deps.cancelRejectWithNote(btn.dataset.id); };
  }
  for (const ta of sheet.querySelectorAll('.approval-card .approval-reject-reason')) {
    ta.oninput = () => {
      const id = ta.dataset.id;
      if (approvals.get().rejectionDrafts.has(id)) approvals.setRejectionDraft(id, ta.value);
    };
  }
  // "Always allow" suggestion footer (see approvalCardHtml / confirmSuggestion in
  // approvals-mobile.js) — mirrors session-view/approval-card.js's scope resolution
  // since subagent approvals need the same project/session/global mapping.
  for (const btn of sheet.querySelectorAll('.approval-suggestion .suggestion-confirm')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const card = btn.closest('.approval-suggestion');
      const approvalId = card?.dataset.approvalId;
      const pending = approvals.get().pending.find((a) => a.approvalId === approvalId);
      if (!pending?.suggestion) return;
      const scopeChoice = card.querySelector('.suggestion-scope-select')?.value ?? 'project';
      const sessionId = pending.sessionId;
      let ruleScope = 'global';
      if (scopeChoice === 'session' && sessionId) {
        ruleScope = { session: sessionId };
      } else if (scopeChoice === 'project') {
        const { projects } = sessions.get();
        const project = (projects || []).find((p) => (p.sessions || []).some((s) => s.id === sessionId));
        const cwd = project?.cwd ?? sessions.getSlice(sessionId)?.cwd ?? null;
        if (cwd) ruleScope = { project: cwd };
      }
      confirmSuggestion(pending, ruleScope, btn);
    };
  }
  // Tap-to-expand for resolved tool tiles (and the approval-card containers, which
  // also expose the JSON/diff payload preview).
  for (const el of sheet.querySelectorAll('.msg.tool_use-expandable')) {
    el.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('.approval-reject-form')) return;
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0 && el.contains(sel.anchorNode)) return;
      const id = el.dataset.toolId;
      if (!id) return;
      const open = el.classList.toggle('tool_use-expanded');
      // The sheet is a singleton scoped to whichever session `setFocused`
      // pointed at (desktop's Sessions rail opens it too) — not the
      // mobile-only currentSessionId pointer forCurrent() resolves.
      sessions.for(subagents.get().focusedSessionId).markToolExpanded(id, open);
    });
  }
}

// ─────────────────────── AskUserQuestion inline flow ───────────────────────
// When Claude calls AskUserQuestion, the hook intercepts it like any other approval. Instead
// of Approve/Reject, the inline approval card renders the question's options + a free-text
// reply field (see askApprovalCardHtml). Picking an option and/or writing a reply resolves
// the approval as `deny` with the user's answer as the reason — the daemon plumbs `reason`
// through to `permissionDecisionReason`, which Claude reads as the tool's effective output.
// Denying with an answer-reason is what makes Claude treat this as "the user said X" rather
// than "the tool failed."

// Wire format is exactly what the native AskUserQuestion tool_result emits, so Claude
// reads the hook-denial reason the same way it reads a successful tool call. The pending
// ask transcript entry is flipped to answered immediately (before the tool_result round-
// trips back through the WS stream) so the user sees their answer without a lag. We scan
// transcript rather than state.pendingAsks because the notification-seeded tile may not
// have a tool_use_id yet; Claude serializes Ask calls, so only the single unanswered
// entry gets flipped.

export {
  agentsStripHtml,
  openAgentsSheet,
  closeAgentsSheet,
  refreshAgentsSheet,
  formatDurationMs,
};
