// Per-mount session view — the shared transcript+composer core for BOTH
// layouts (D7 convergence). Desktop's sessions-surface mounts this into its
// single detail pane; the mobile shell mounts it into its singleton #root
// (app.js's mountMobileSessionView). Only one mount is ever live at a time in
// practice today, but the module is written class-selector-scoped (not
// id-based) so that isn't a hard assumption anywhere in here.
//
// Chrome that genuinely differs by layout (meter strip, the full-width
// Agents entry strip, approval-card countdown) is gated behind CSS or
// isDesktop() at the narrowest possible point — content markup (transcript
// rendering, tool tiles, ask cards) never forks.
//
// This module intentionally does NOT touch module-level globals in app.js.
// Its only external dependencies are the sessions store's per-slice API
// (`sessions.for(id)`, `sessions.subscribeSlice`, `sessions.mountView`,
// `sessions.unmountView`) and pure HTML helpers.

import { sessions } from '../../state/sessions.js';
import { approvals } from '../../state/approvals.js';
import { subagents } from '../../state/subagents.js';
import { conn } from '../../state/conn.js';
import { usage } from '../../state/usage.js';
import { nav } from '../../state/nav.js';
import { keymap } from '../../state/keymap.js';
import { formatCombo } from '../../utils/hotkey.js';
import {
  forceReconnect,
  openAgentsForSession,
  openDiffForSession,
  openSession,
  promoteSessionToJob,
} from '../../app-bridge.js';
import { escapeHtml } from './html.js';
import { minimalMsgHtml } from './message-html.js';
import { openSessionWs, closeSessionWs, sendUserMessage, reconnectAndSend, sendApprovalModeSet, sendInterrupt, sessionWsReadyState } from './session-ws.js';
import { renderThinkingStrip, renderTodoPill, renderConnBanner } from './regions.js';
import { renderMeterStrip } from './meter.js';
import { bindAskCardHandlers } from '../ask-card.js';
import { submitAskAnswer } from '../ask-flow.js';
import { inlineApprovalCardHtml, bindApprovalCardHandlers } from './approval-card.js';
import { computeGitInfo, resolveSessionTitle, sessionRunMeta, archiveSession, deleteSession } from './session-actions.js';
import { agentsStripHtml, refreshAgentsSheet } from '../agents-sheet/index.js';
import { refreshTodosSheet } from '../todos-sheet.js';
import { deriveSkillLabel } from '../../vm/sessions.js';

const APPROVAL_MODES = ['ask', 'plan', 'accept-edits', 'bypass'];
const APPROVAL_MODE_LABEL = { 'ask': 'Ask', 'plan': 'Plan', 'accept-edits': 'Accept edits', 'bypass': 'Bypass' };

// Build the mount's DOM skeleton. All selectors are class-based so multiple
// session-views can coexist in the same document.
function buildSkeleton(mount) {
  mount.classList.add('sv-host');
  const modeOptions = APPROVAL_MODES.map((m) =>
    `<option value="${m}">${escapeHtml(APPROVAL_MODE_LABEL[m])}</option>`
  ).join('');
  mount.innerHTML = `
    <div class="sv-header">
      <span class="sv-header-skill"></span>
      <span class="sv-header-name"></span>
      <span class="sv-header-meta"></span>
      <div class="sv-header-actions">
        <button class="sv-header-promote" type="button">Promote to tracked <span class="o-kbd"></span></button>
        <button class="sv-header-archive" type="button" hidden>Archive <span class="o-kbd"></span></button>
        <div class="sv-header-menu-wrap">
          <button class="sv-header-menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
          <div class="sv-header-menu" hidden role="menu"></div>
        </div>
        <button class="sv-header-rail-toggle" type="button" aria-label="Toggle right rail"></button>
      </div>
    </div>
    <div class="sv-toolbar">
      <label class="sv-mode-chip">
        <span class="sv-mode-chip-label">Mode</span>
        <select class="sv-mode-select" aria-label="Permission mode for this session">${modeOptions}</select>
      </label>
    </div>
    <div class="sv-transcript">
      <div class="sv-transcript-inner" role="log" aria-live="polite"></div>
      <div class="sv-jump-wrap" hidden>
        <button class="sv-jump-latest" type="button" aria-label="Jump to latest message">↓ <span class="sv-jump-count">Latest</span></button>
      </div>
    </div>
    <div class="sv-thinking-region"></div>
    <div class="sv-agents-strip-region"></div>
    <div class="sv-todos-region"></div>
    <div class="sv-banner-region"></div>
    <div class="sv-composer-wrap">
      <div class="sv-meter-region"></div>
      <div class="sv-slash-palette" hidden></div>
      <div class="sv-composer-row">
        <div class="sv-composer" id="composer" contenteditable="true" role="textbox" aria-multiline="true"
             aria-label="Message" autocapitalize="sentences" data-placeholder="Type a message…"></div>
        <span class="sv-model-chip" hidden></span>
        <button class="sv-send" id="send" type="button" aria-label="Send">↵</button>
      </div>
    </div>
  `;
  return {
    root:      mount,
    inner:     mount.querySelector('.sv-transcript-inner'),
    transcript:mount.querySelector('.sv-transcript'),
    composerWrap: mount.querySelector('.sv-composer-wrap'),
    agentsStrip: mount.querySelector('.sv-agents-strip-region'),
    thinking:  mount.querySelector('.sv-thinking-region'),
    todos:     mount.querySelector('.sv-todos-region'),
    banner:    mount.querySelector('.sv-banner-region'),
    meter:     mount.querySelector('.sv-meter-region'),
    palette:   mount.querySelector('.sv-slash-palette'),
    composer:  mount.querySelector('.sv-composer'),
    send:      mount.querySelector('.sv-send'),
    modelChip: mount.querySelector('.sv-model-chip'),
    modeChip:  mount.querySelector('.sv-mode-chip'),
    modeSelect:mount.querySelector('.sv-mode-select'),
    jumpWrap:  mount.querySelector('.sv-jump-wrap'),
    jumpBtn:   mount.querySelector('.sv-jump-latest'),
    jumpCount: mount.querySelector('.sv-jump-count'),
    header:      mount.querySelector('.sv-header'),
    headerSkill: mount.querySelector('.sv-header-skill'),
    headerName:  mount.querySelector('.sv-header-name'),
    headerMeta:  mount.querySelector('.sv-header-meta'),
    headerPromote: mount.querySelector('.sv-header-promote'),
    headerArchive: mount.querySelector('.sv-header-archive'),
    headerPromoteKbd: mount.querySelector('.sv-header-promote .o-kbd'),
    headerArchiveKbd: mount.querySelector('.sv-header-archive .o-kbd'),
    headerMenuBtn: mount.querySelector('.sv-header-menu-btn'),
    headerMenu:    mount.querySelector('.sv-header-menu'),
    headerRailToggle: mount.querySelector('.sv-header-rail-toggle'),
  };
}

// Full-width "Agents" strip — mobile's entry point into the agents sheet
// (mobile has no persistent rail to show subagents in). Desktop hides this
// region via CSS; its equivalent affordance is the persistent right rail
// (sessions-surface/rail.js). agentsStripHtml reads subagents.focused(), which
// app.js's openSession() keeps pointed at whichever session is current — true
// for the mobile singleton flow this region is built for.
function renderAgentsStrip(dom, sessionId) {
  if (!dom.agentsStrip) return;
  dom.agentsStrip.innerHTML = agentsStripHtml();
  const btn = dom.agentsStrip.querySelector('.agents-strip');
  if (btn) btn.onclick = () => openAgentsForSession(sessionId);
}

// ─────────────────────── Slash-command palette ────────────────────────────
// Ported from the legacy mobile-session-view.js singleton; enabled on both
// layouts (the daemon accepts slash commands in any session, so desktop gets
// the same fuzzy autocomplete). Arrow/Enter/Escape capture only happens while
// the palette is open — i.e. the composer text starts with "/" — so ordinary
// multi-line editing is never hijacked.
function filteredSlashCommands(filter) {
  const f = filter.toLowerCase();
  if (!f) return usage.get().slashCommands.slice(0, 50);
  const scored = [];
  for (const c of usage.get().slashCommands) {
    const name = c.name.slice(1).toLowerCase();
    if (name.startsWith(f)) { scored.push({ c, rank: 0, pos: 0 }); continue; }
    let i = 0, pos = -1;
    for (let j = 0; j < name.length && i < f.length; j++) {
      if (name[j] === f[i]) { if (pos < 0) pos = j; i++; }
    }
    if (i === f.length) scored.push({ c, rank: 1, pos });
  }
  scored.sort((a, b) => a.rank - b.rank || a.pos - b.pos || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, 50).map((s) => s.c);
}

function renderSlashPalette(dom, paletteState, onPick) {
  const region = dom.palette;
  if (!region) return;
  if (!paletteState.open) {
    region.hidden = true;
    region.innerHTML = '';
    return;
  }
  const items = filteredSlashCommands(paletteState.filter);
  if (items.length === 0) {
    region.hidden = false;
    region.innerHTML = `<div class="slash-empty">No matches</div>`;
    return;
  }
  const high = Math.min(paletteState.highlight, items.length - 1);
  paletteState.highlight = high;
  region.hidden = false;
  region.innerHTML = `
    <ul class="slash-list" role="listbox" aria-label="Slash commands">
      ${items.map((c, i) => `
        <li role="option" class="slash-item${i === high ? ' slash-item-highlight' : ''}" data-cmd="${escapeHtml(c.name)}" aria-selected="${i === high ? 'true' : 'false'}">
          <span class="slash-name">${escapeHtml(c.name)}</span>
          ${c.description ? `<span class="slash-desc">${escapeHtml(c.description)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
  for (const li of region.querySelectorAll('.slash-item')) {
    li.addEventListener('click', (e) => {
      e.preventDefault();
      onPick(li.dataset.cmd);
    });
  }
}

function evaluatePaletteState(dom, paletteState, onChange) {
  const text = dom.composer.textContent || '';
  const trimmed = text.trimStart();
  // Open only while the command token itself is being typed — once whitespace
  // follows it the user is writing arguments, and Enter must send rather than
  // re-insert the highlighted command over their text.
  const open = trimmed.startsWith('/') && !/\s/.test(trimmed);
  if (!open) {
    if (paletteState.open) {
      paletteState.open = false;
      paletteState.filter = '';
      paletteState.highlight = 0;
      onChange();
    }
    return;
  }
  const filter = trimmed.slice(1).split(/\s/)[0] ?? '';
  const wasOpen = paletteState.open;
  const prevFilter = paletteState.filter;
  paletteState.open = true;
  paletteState.filter = filter;
  if (!wasOpen || prevFilter !== filter) paletteState.highlight = 0;
  onChange();
}

function placeCursorAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

// ─────────────────────── Session header (D2/P2 sessions contract) ─────────
// Skill badge + name + live-pulse duration + Promote/⋯/rail-toggle actions.
// Hidden entirely on mobile via CSS (mirrors .sv-toolbar's existing pattern —
// mobile has its own #header chrome, see mobile-header.js), so this always
// computes but is only visible on desktop. The identity helpers
// (resolveSessionTitle, sessionRunMeta, computeGitInfo) live in
// ./session-actions.js, shared with the mobile header.

function headerMenuItemsHtml(sessionId) {
  const { diffable } = computeGitInfo(sessionId);
  // Archive is a top-level header button (see .sv-header-archive), not a menu
  // item — the ⋯ menu keeps only diff + the destructive delete.
  const items = [];
  if (diffable) items.push(`<button type="button" class="sv-header-menu-item" data-action="open-diff">Open diff</button>`);
  items.push(`<button type="button" class="sv-header-menu-item sv-header-menu-item-danger" data-action="delete">Delete</button>`);
  return items.join('');
}

function renderHeader(dom, slice, sessionId, meta) {
  if (!dom.header) return;
  const skill = deriveSkillLabel(slice?.transcript);
  dom.headerSkill.textContent = skill || 'session';
  dom.headerSkill.classList.toggle('free', !skill);
  dom.headerName.textContent = resolveSessionTitle(sessionId, meta);
  const { live, text } = sessionRunMeta(slice, sessionId);
  dom.headerMeta.innerHTML = `${live ? '<span class="sv-header-live" aria-hidden="true"></span>' : ''}<span>${escapeHtml(text)}</span>`;
  dom.headerMenu.innerHTML = headerMenuItemsHtml(sessionId);
  if (dom.headerArchive) dom.headerArchive.hidden = computeGitInfo(sessionId).archived;
  if (dom.headerPromoteKbd) dom.headerPromoteKbd.textContent = formatCombo(keymap.bindingFor('session.promoteToJob'));
  if (dom.headerArchiveKbd) dom.headerArchiveKbd.textContent = formatCombo(keymap.bindingFor('session.archive'));
  const collapsed = !!nav.get().contextCollapsed;
  dom.headerRailToggle.textContent = collapsed ? '«' : '»';
  dom.headerRailToggle.setAttribute('aria-label', collapsed ? 'Show right rail' : 'Hide right rail');
}

function closeHeaderMenu(dom) {
  dom.headerMenu.hidden = true;
  dom.headerMenuBtn.setAttribute('aria-expanded', 'false');
}

// Returns an unwire function — the document-level outside-click listener must
// be torn down on unmount, or every session-view mount/unmount cycle (tab
// switches) leaks one more of these onto the document.
function wireHeader(dom, sessionId) {
  dom.headerPromote?.addEventListener('click', () => promoteSessionToJob(sessionId));
  // Archive stays on the (now-archived) session view — the button hides itself
  // on the next renderHeader once computeGitInfo reports archived. No nav here;
  // mobile's menu-archive is the one that returns to the list.
  dom.headerArchive?.addEventListener('click', () => archiveSession(sessionId));
  dom.headerRailToggle?.addEventListener('click', () => nav.toggleContextCollapsed());
  dom.headerMenuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dom.headerMenu.hidden;
    dom.headerMenu.hidden = !open;
    dom.headerMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  dom.headerMenu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    closeHeaderMenu(dom);
    const action = btn.dataset.action;
    if (action === 'open-diff') openDiffForSession(sessionId);
    else if (action === 'delete') deleteSession(sessionId).then((ok) => { if (ok) nav.select('sessions', null); });
  });
  const onOutsideClick = (e) => {
    if (dom.headerMenu.hidden) return;
    if (e.target.closest('.sv-header-menu-wrap')) return;
    closeHeaderMenu(dom);
  };
  document.addEventListener('click', onOutsideClick);
  return () => document.removeEventListener('click', onOutsideClick);
}

// Reflect the slice's approvalMode into the <select> + chip data-mode attribute
// (which drives per-mode styling). No-ops if the user is mid-interaction on the
// select — we compare against .value to skip needless writes.
function renderModeChip(dom, slice) {
  if (!dom.modeChip || !dom.modeSelect) return;
  const mode = slice?.approvalMode ?? 'ask';
  if (dom.modeSelect.value !== mode) dom.modeSelect.value = mode;
  dom.modeChip.setAttribute('data-mode', mode);
}

// Composer model chip — read-only. session-ws.js's user_message wire format
// (checked directly) carries no model-override field, and there's no per-
// message model picker anywhere in the protocol, so this displays whatever
// model this session is actually running rather than offering a control that
// wouldn't do anything.
function renderModelChip(dom, sessionId) {
  if (!dom.modelChip) return;
  const sl = sessions.getSlice(sessionId)?.statusline ?? null;
  const label = sl?.model?.display_name || sl?.model?.id || null;
  if (!label) { dom.modelChip.hidden = true; return; }
  dom.modelChip.hidden = false;
  dom.modelChip.textContent = label;
  dom.modelChip.title = 'Model for this session — no per-message override (the session protocol carries no model-override field).';
}

// In-memory composer draft keyed by sessionId. Survives unmount/remount so
// backgrounding a tab (or switching to another tab in the same pane) doesn't
// wipe what the user was typing. Cleared on send. Not persisted to disk —
// drafts don't need to survive a page reload, just tab churn.
const composerDraft = new Map();

// Persistent per-session scroll intent. `stickyBottom` defaults true so a
// freshly-mounted tab lands at the newest message. When the user scrolls up,
// we flip to false and remember their absolute scrollTop; when they come back
// within 40px of the bottom, we flip back. Survives unmount/remount so tab
// switches restore whichever mode the user last chose.
const scrollIntent = new Map();
function getIntent(sessionId) {
  let it = scrollIntent.get(sessionId);
  if (!it) { it = { stickyBottom: true, savedScrollTop: 0 }; scrollIntent.set(sessionId, it); }
  return it;
}

// Floating "jump to latest" pill — visible whenever the user has scrolled away
// from the bottom, with an unread count once new entries land behind them.
// Unread state is mount-scoped (dom.__unread / dom.__lastTotal), reset by
// renderTranscript when the user is pinned to the bottom.
function updateJumpPill(dom, sessionId) {
  if (!dom.jumpWrap) return;
  const intent = getIntent(sessionId);
  const show = !intent.stickyBottom;
  dom.jumpWrap.hidden = !show;
  if (!show) return;
  const unread = dom.__unread ?? 0;
  dom.jumpCount.textContent = unread > 0 ? `${unread} new` : 'Latest';
}

// This mount's own socket state — NOT the aggregate across all session
// sockets that conn.session carries. 'failed' still defers to the aggregate
// so the retry banner matches session-ws's backoff threshold.
function sessionConnState(sessionId) {
  if (sessionWsReadyState(sessionId) === WebSocket.OPEN) return 'connected';
  // A subprocess that exited (archive, crash, normal end) has its WS
  // force-closed with no retry pending — reporting 'reconnecting' here would
  // flash a banner for a socket that will never come back. Treat inactive
  // sessions as idle (empty banner, send stays muted).
  if (sessions.getSlice(sessionId)?.runState === 'inactive') return 'idle';
  return conn.get().session === 'failed' ? 'failed' : 'reconnecting';
}

// Renders the current transcript into `dom.inner`, then appends inline
// approval cards for THIS session's pending approvals. AskUserQuestion rides
// the same rail. Subagent approvals (with an agentId) also surface here so the
// user can act on them without opening the agents sheet — the card carries a
// `via <agentType>` chip so it's visually distinct from the parent's own
// approvals. Scroll position is driven by `scrollIntent`: stickyBottom → snap
// to bottom, otherwise restore the saved offset.
function renderTranscript(dom, slice, sessionId) {
  if (!slice) {
    dom.inner.innerHTML = '<div class="sv-empty">Loading session…</div>';
    return;
  }
  const ctx = { cwd: slice.cwd ?? null, worktreePath: slice.spawnCwd ?? null };
  const t = dom.transcript;
  const wasNearBottom = (t.scrollHeight - t.scrollTop - t.clientHeight) < 40;

  // A textarea inside an approval/ask card can have focus while a WS tick
  // repaints the whole feed — capture which one and its caret so the rewrite
  // below doesn't kick the user out mid-sentence (the draft text itself is
  // persisted store-side; this restores focus/caret on top of it).
  const active = document.activeElement;
  let refocus = null;
  if (active instanceof HTMLTextAreaElement && dom.inner.contains(active)) {
    const card = active.closest('[data-approval-id]');
    if (card?.dataset.approvalId) {
      refocus = {
        id: card.dataset.approvalId,
        selector: active.classList.contains('ask-reply-field') ? '.ask-reply-field' : '.approval-reject-reason',
        start: active.selectionStart,
        end: active.selectionEnd,
      };
    }
  }

  const cards = approvals.get().pending.filter((a) => a.sessionId === sessionId);
  const subSlice = subagents.forSession(sessionId);
  // Hide the pending tool_use / pending ask transcript entries whose approval
  // is still open — the card below already shows the call, and doubling up
  // reads as a duplicate. Subagent approvals never appear as transcript entries
  // in the parent, so pendingIds only affects the parent's own approvals.
  const pendingIds = new Set(cards.map((a) => a.toolUseId).filter(Boolean));
  const visible = slice.transcript.filter((m) => {
    if (m.role === 'tool_use' && m.toolUseId && pendingIds.has(m.toolUseId)) return false;
    if (m.role === 'ask' && m.answer == null && m.toolUseId && pendingIds.has(m.toolUseId)) return false;
    return true;
  });

  if (visible.length === 0 && cards.length === 0) {
    dom.inner.innerHTML = '<div class="sv-empty">No messages yet — say something.</div>';
    dom.__lastTotal = 0;
    dom.__unread = 0;
    updateJumpPill(dom, sessionId);
    return;
  }
  const parts = [];
  for (const m of visible) parts.push(minimalMsgHtml(m, slice.expandedTools, ctx));
  for (const a of cards) {
    const agentType = a.agentId ? subSlice.byId.get(a.agentId)?.agentType ?? null : null;
    parts.push(inlineApprovalCardHtml(a, { agentType }));
  }
  dom.inner.innerHTML = parts.join('');

  if (refocus) {
    const card = dom.inner.querySelector(`[data-approval-id="${CSS.escape(refocus.id)}"]`);
    const ta = card?.querySelector(refocus.selector);
    if (ta instanceof HTMLTextAreaElement) {
      ta.focus();
      try { ta.setSelectionRange(refocus.start, refocus.end); } catch { /* detached mid-frame */ }
    }
  }

  const intent = getIntent(sessionId);
  // Live-append case: user has been reading at the bottom and a new message
  // arrived. We keep them pinned even if they haven't scrolled yet. The
  // `wasNearBottom` check catches this before the DOM rewrite.
  if (wasNearBottom) intent.stickyBottom = true;

  // Unread accounting for the jump-to-latest pill: only counts up while the
  // user has scrolled away from the bottom.
  const total = visible.length + cards.length;
  const prevTotal = dom.__lastTotal ?? total;
  if (!intent.stickyBottom && total > prevTotal) dom.__unread = (dom.__unread ?? 0) + (total - prevTotal);
  if (intent.stickyBottom) dom.__unread = 0;
  dom.__lastTotal = total;
  updateJumpPill(dom, sessionId);

  // rAF so scrollHeight reflects layout of the newly-written HTML — otherwise
  // on first mount the transcript can still measure at 0 and scrollTop=0.
  requestAnimationFrame(() => {
    const suppress = t.__ovSuppress;
    if (suppress) suppress.until = performance.now() + 80;
    if (intent.stickyBottom) t.scrollTop = t.scrollHeight;
    else t.scrollTop = Math.min(intent.savedScrollTop, Math.max(0, t.scrollHeight - t.clientHeight));
  });
}

// Delegated click handler on the transcript inner element. Covers four
// interactions: Reopen action (error tile with a dead subprocess), inline
// approval Approve/Reject buttons, tap-to-expand for tool_use tiles, and the
// AskUserQuestion inline card's option / reply / send handlers (bound via the
// shared bindAskCardHandlers).
function bindTranscriptHandlers(dom, sessionId) {
  const S = sessions.for(sessionId);
  bindAskCardHandlers(dom.inner, {
    submitAnswer: (approval, picks, replyText) => submitAskAnswer(approval, picks, replyText, sessionId),
  });
  bindApprovalCardHandlers(dom.inner);
  dom.inner.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    // Rerun of session subprocess when the user taps the "Reopen" action on an
    // error tile.
    const reopen = target.closest('[data-msg-action="reopen"]');
    if (reopen) { openSession({ id: sessionId }); return; }

    // Tap-to-toggle for tool_use-expandable tiles. Selection heuristic: if the
    // user is selecting text inside the tile, don't collapse — they're copying.
    const el = target.closest('.msg.tool_use-expandable');
    if (!el) return;
    if (target.closest('.approval-reject-form')) return;
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0 && el.contains(sel.anchorNode)) return;
    const id = el.dataset.toolId;
    if (!id) return;
    const open = el.classList.toggle('tool_use-expanded');
    S.markToolExpanded(id, open);
    if (open) {
      requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const tRect = dom.transcript.getBoundingClientRect();
        if (rect.bottom > tRect.bottom) el.scrollIntoView({ block: 'end', behavior: 'smooth' });
      });
    }
  });
}

// `paletteState` is non-null only for mobile mounts (see mountSessionView) —
// it carries the slash-command palette's open/filter/highlight state, scoped
// to this one mount since (unlike composerDraft/scrollIntent) it doesn't need
// to survive unmount/remount.
function wireComposer(dom, sessionId, paletteState) {
  const saved = composerDraft.get(sessionId);
  if (saved) dom.composer.textContent = saved;
  const armed = () => dom.send.classList.toggle('armed', dom.composer.textContent.trim().length > 0);
  const repaintPalette = () => renderSlashPalette(dom, paletteState, insertSlashCommand);
  const insertSlashCommand = (cmd) => {
    dom.composer.textContent = `${cmd} `;
    paletteState.open = false;
    paletteState.filter = '';
    paletteState.highlight = 0;
    placeCursorAtEnd(dom.composer);
    dom.composer.focus();
    armed();
    repaintPalette();
  };
  dom.composer.addEventListener('input', () => {
    composerDraft.set(sessionId, dom.composer.textContent);
    armed();
    if (paletteState) evaluatePaletteState(dom, paletteState, repaintPalette);
  });
  armed();
  const send = () => {
    const text = dom.composer.textContent.trim();
    if (!text) return;
    // Happy path: the socket is open, send immediately. If it isn't, the session
    // was interrupted or its subprocess exited — typing a message is an explicit
    // intent to resume, so reconnect (which respawns the subprocess daemon-side)
    // and queue the message to flush on open, rather than leaving the composer
    // wedged behind a dead socket until the user reloads the session.
    if (!sendUserMessage(sessionId, text)) {
      reconnectAndSend(sessionId, text);
      // runState went 'inactive' on the interrupt/exit; the view is still
      // mounted, so restore it now that we're bringing the session back — this
      // clears the 'idle' conn state so the banner/button reflect reconnecting.
      if (sessions.getSlice(sessionId)?.runState === 'inactive') {
        sessions.setRunState(sessionId, 'foreground');
      }
      renderConnBanner(dom.banner, sessionConnState(sessionId), forceReconnect);
    }
    // Marked __pending so future stages can render it dimmed until
    // server-echoed.
    sessions.for(sessionId).appendTranscript({ role: 'user', text, __pending: true });
    dom.composer.textContent = '';
    composerDraft.delete(sessionId);
    armed();
  };
  // While the assistant is generating, the send button doubles as a stop button
  // (paint() flips .is-stop / textContent). Same dual-role treatment as the
  // legacy composer — see interruptSession in app.js.
  const interrupt = () => {
    sessions.for(sessionId).expectInterrupt();
    sendInterrupt(sessionId);
  };
  dom.send.addEventListener('click', () => {
    if (sessions.getSlice(sessionId)?.thinking) interrupt();
    else send();
  });
  dom.composer.addEventListener('keydown', (e) => {
    if (paletteState?.open) {
      const items = filteredSlashCommands(paletteState.filter);
      if (e.key === 'ArrowDown' && items.length > 0) {
        e.preventDefault();
        paletteState.highlight = (paletteState.highlight + 1) % items.length;
        repaintPalette();
        return;
      }
      if (e.key === 'ArrowUp' && items.length > 0) {
        e.preventDefault();
        paletteState.highlight = (paletteState.highlight - 1 + items.length) % items.length;
        repaintPalette();
        return;
      }
      if (e.key === 'Enter' && items.length > 0 && !window.matchMedia('(hover: none)').matches) {
        e.preventDefault();
        insertSlashCommand(items[paletteState.highlight].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        paletteState.open = false;
        repaintPalette();
        return;
      }
    }
    // Touch devices: Enter always inserts a newline — users send via the
    // on-screen button, so an on-screen keyboard's Return key shouldn't fire
    // off a half-typed message. Matches the legacy mobile composer.
    if (window.matchMedia('(hover: none)').matches) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  if (!paletteState) return () => {};
  // Outside-tap closes the palette. Scoped + torn down per mount (unlike the
  // legacy singleton's document-level listener installed once for the app's
  // whole lifetime) since a fresh one gets wired on every mount.
  const onOutsideClick = (e) => {
    if (!paletteState.open) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (dom.palette.contains(target)) return;
    if (dom.composer.contains(target)) return;
    paletteState.open = false;
    repaintPalette();
  };
  document.addEventListener('pointerdown', onOutsideClick, true);
  return () => document.removeEventListener('pointerdown', onOutsideClick, true);
}

// Public API: mount a session view for `sessionId` into `mount`. Returns an
// object with an `unmount()` that unsubscribes and downgrades the session's
// runState to background (unless another view still shows it, in which case it
// stays foreground).
export function mountSessionView(mount, sessionId, meta = {}) {
  if (!sessionId) {
    mount.innerHTML = `<div class="sv-empty">${escapeHtml('Missing session id.')}</div>`;
    return { unmount() {} };
  }
  sessions.ensureSlice(sessionId, meta);
  sessions.mountView(sessionId);
  // Spawn hints (cwd, spawnMode, baseBranch, model) are only meaningful on the FIRST
  // WS attach — the daemon ignores them once the session is running. For
  // brand-new sessions opened via the sidebar's "New session" button, the tab
  // payload carries these so the WS URL query string can carry them to the
  // daemon on first connect.
  const spawn = (meta.cwd || meta.spawnMode || meta.baseBranch || meta.model || meta.approvalMode)
    ? { cwd: meta.cwd, spawnMode: meta.spawnMode, baseBranch: meta.baseBranch, model: meta.model, approvalMode: meta.approvalMode }
    : null;
  // NB: do NOT arm pendingDefaultPush here off `spawn`. Both mount paths supply
  // meta.cwd for EXISTING sessions too (resolveSessionContext / mobile mount), so
  // keying off spawn-hint presence re-armed the flag on every re-entry and let the
  // next WS reconnect clobber the session's persisted mode with the client default.
  // openSession() is the single arming authority — it knows isNew and sets the flag
  // before this mount runs.
  openSessionWs(sessionId, spawn);

  const dom = buildSkeleton(mount);
  // When the composer-wrap grows (multi-line message, slash palette popping
  // open, meter breakdown expanding), nudge the transcript's scrollTop by the
  // same delta so already-visible content doesn't jump as the transcript's
  // flex-basis shrinks to make room. Ported from the legacy mobile composer;
  // applies on both layouts since desktop's composer can grow too.
  let resizeObserver = null;
  if (dom.composerWrap && dom.transcript && typeof ResizeObserver === 'function') {
    let lastH = dom.composerWrap.getBoundingClientRect().height;
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newH = entry.contentRect.height;
        const delta = newH - lastH;
        lastH = newH;
        if (delta > 0) dom.transcript.scrollTop += delta;
      }
    });
    resizeObserver.observe(dom.composerWrap);
  }
  // Slash palette runs on BOTH layouts — desktop types slash commands into
  // the same composer, and the keydown capture is already gated on the
  // palette being open (text starts with '/'), so it can't hijack cursor
  // movement in ordinary multi-line messages.
  const paletteState = { open: false, filter: '', highlight: 0 };
  const unwireComposer = wireComposer(dom, sessionId, paletteState);
  bindTranscriptHandlers(dom, sessionId);
  const unwireHeader = wireHeader(dom, sessionId);
  dom.modeSelect?.addEventListener('change', () => {
    const mode = dom.modeSelect.value;
    if (!APPROVAL_MODES.includes(mode)) return;
    // An explicit pick is authoritative: cancel any pending auto-default-push so
    // it can't clobber this choice (dispatch.js:approval_mode), and update the
    // slice optimistically so paint() doesn't snap the <select> back to the
    // stale value before the daemon echo lands. The echo reconciles either way.
    sessions.for(sessionId).setPendingDefaultPush(false);
    sessions.for(sessionId).setApprovalMode(mode);
    sendApprovalModeSet(sessionId, mode);
  });
  // ⌘⇧P (mockup's header shortcut) — scoped to this mount rather than the
  // global shell keymap (shell/keyboard.js is out of this surface's ownership,
  // and a document listener per mount is the same self-contained pattern the
  // mode-popover/palette overlays already use). Archive is ⌘⇧E, not the more
  // obvious ⌘⇧A, because Chrome reserves ⌘⇧A for "Search tabs" at the
  // accelerator level — it never reaches the page for us to preventDefault.
  const onHeaderKeydown = (e) => {
    if (keymap.matches(e, 'session.promoteToJob')) {
      e.preventDefault();
      promoteSessionToJob(sessionId);
    } else if (keymap.matches(e, 'session.archive')) {
      // Skip when already archived — archiveSession would 404 the second time
      // and the visible button is hidden in that state anyway.
      if (computeGitInfo(sessionId).archived) return;
      e.preventDefault();
      // Keyboard shortcut is an explicit, deliberate action — skip the
      // worktree confirm the header button still gets.
      archiveSession(sessionId, async () => true);
    }
  };
  document.addEventListener('keydown', onHeaderKeydown);

  // Scroll listener drives sticky-bottom intent. Manual scroll away from the
  // bottom flips into "restore-offset" mode; scrolling back within 40px
  // returns to "pin-to-bottom" mode. Own writes are suppressed via
  // suppressUntil — otherwise the initial snap-to-bottom would be misread as
  // a user scroll on tabs that take a layout frame to settle.
  const suppressRef = { until: 0 };
  dom.transcript.__ovSuppress = suppressRef;
  const onScroll = () => {
    if (performance.now() < suppressRef.until) return;
    const t = dom.transcript;
    const distFromBottom = t.scrollHeight - t.scrollTop - t.clientHeight;
    const intent = getIntent(sessionId);
    if (distFromBottom < 40) {
      intent.stickyBottom = true;
      dom.__unread = 0;
    } else {
      intent.stickyBottom = false;
      intent.savedScrollTop = t.scrollTop;
    }
    updateJumpPill(dom, sessionId);
  };
  dom.transcript.addEventListener('scroll', onScroll, { passive: true });
  dom.jumpBtn?.addEventListener('click', () => {
    const intent = getIntent(sessionId);
    intent.stickyBottom = true;
    dom.__unread = 0;
    const t = dom.transcript;
    suppressRef.until = performance.now() + 80;
    t.scrollTop = t.scrollHeight;
    updateJumpPill(dom, sessionId);
  });

  // Composite re-render: transcript + thinking + todo pill are all driven by
  // the session's slice (thinking* fields live there now, per-session). The
  // conn banner + send muting follow this mount's own socket state (see
  // sessionConnState); approvals subscription repaints the inline approval
  // cards.
  let metaTicker = null;
  const stopMetaTicker = () => {
    if (metaTicker) { clearInterval(metaTicker); metaTicker = null; }
  };
  let headerTicker = null;
  const stopHeaderTicker = () => {
    if (headerTicker) { clearInterval(headerTicker); headerTicker = null; }
  };
  // Ticks the meter strip once a minute so its 5H/7D "resets in…" labels stay
  // current between statusline/account-usage pushes (which fire on activity,
  // not the clock). Runs on desktop too (cheap, CSS-hidden there) rather than
  // branching on layout, matching this file's "always compute, CSS hides"
  // convention for the other mobile-only regions.
  const meterTicker = setInterval(() => renderMeterStrip(dom, sessionId), 60_000);
  // Per-mount connection chrome: quiet reconnecting/failed banner plus a
  // muted send button while THIS session's socket is down — an armed accent
  // send whose tap silently no-ops would misrepresent the state.
  const paintConn = () => {
    const st = sessionConnState(sessionId);
    renderConnBanner(dom.banner, st, forceReconnect);
    // Mute the send button only during genuine connectivity trouble. An 'idle'
    // session (interrupted / exited) is resumable — its next send reconnects and
    // delivers the message — so keep its send button live and inviting.
    dom.send.classList.toggle('sv-send-disconnected', st === 'reconnecting' || st === 'failed');
  };
  const paint = () => {
    const slice = sessions.getSlice(sessionId);
    renderModeChip(dom, slice);
    renderHeader(dom, slice, sessionId, meta);
    renderModelChip(dom, sessionId);
    renderTranscript(dom, slice, sessionId);
    renderThinkingStrip(dom.thinking, slice);
    renderTodoPill(dom.todos, slice, sessionId);
    renderMeterStrip(dom, sessionId);
    paintConn();
    // Mobile-only sheets (todos-sheet.js) no-op when not open; cheap to call
    // unconditionally so a background WS event doesn't leave an OPEN sheet
    // showing stale data (see D7 write-up — this was silently dropped when
    // the mobile shell switched to mounting this module).
    refreshTodosSheet();
    const running = slice?.runState === 'foreground' || slice?.runState === 'background';
    if (running && !headerTicker) {
      headerTicker = setInterval(() => renderHeader(dom, sessions.getSlice(sessionId), sessionId, meta), 1000);
    } else if (!running && headerTicker) {
      stopHeaderTicker();
    }
    // Same button, two meanings: while thinking it's a stop button (■,
    // interrupt path); otherwise it's a Send button (↵). Matches the legacy
    // updateThinkingRegion behavior on the singleton composer.
    if (slice?.thinking) {
      dom.send.classList.add('is-stop');
      dom.send.setAttribute('aria-label', 'Stop');
      dom.send.textContent = '■';
    } else {
      dom.send.classList.remove('is-stop');
      dom.send.setAttribute('aria-label', 'Send');
      dom.send.textContent = '↵';
    }
    // The strip's elapsed-time meta needs to tick between slice updates. Run a
    // 200ms interval only while this session is thinking; it repaints just the
    // strip so surrounding DOM (transcript, composer selection) isn't touched.
    if (slice?.thinking && !metaTicker) {
      metaTicker = setInterval(() => {
        const s = sessions.getSlice(sessionId);
        if (!s?.thinking) { stopMetaTicker(); return; }
        renderThinkingStrip(dom.thinking, s);
      }, 200);
    } else if (!slice?.thinking && metaTicker) {
      stopMetaTicker();
    }
  };
  // Coalesce repaints to one per animation frame. The store fans out
  // synchronously with no batching (state/create-store.js), so the full-history
  // replay a fresh session WS streams on reload — one frame per parent event,
  // times each subagent entry — would otherwise drive a full transcript
  // innerHTML rebuild (renderTranscript re-parses markdown for every prior
  // message) per event: O(N²) work that freezes the main thread for seconds
  // once a handful of subagents are in the feed. Deferring makes each onmessage
  // cheap, so the frame queue drains and rAF collapses the burst into a single
  // paint against the latest slice.
  let paintRaf = 0;
  let agentsRaf = 0;
  const schedulePaint = () => {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(() => { paintRaf = 0; paint(); });
  };
  const unsubSlice = sessions.subscribeSlice(sessionId, schedulePaint);
  const unsubApprovals = approvals.subscribe(schedulePaint);
  // Scope subagent + sessions subscribers to the agents strip so a subagent
  // tick doesn't force the whole transcript rewrite that paint() does — the
  // renderer only touches its own region.
  const paintAgents = () => {
    renderAgentsStrip(dom, sessionId);
    // Mobile-only sheet; no-ops when not open (see refreshTodosSheet's call
    // in paint() above for the same reasoning).
    refreshAgentsSheet();
  };
  const scheduleAgents = () => {
    if (agentsRaf) return;
    agentsRaf = requestAnimationFrame(() => { agentsRaf = 0; paintAgents(); });
  };
  const unsubSubagents = subagents.subscribe(scheduleAgents);
  const unsubSessions = sessions.subscribe(scheduleAgents);
  // Cheap: only the conn banner + send-muting react to conn changes.
  const unsubConn = conn.subscribe(paintConn);
  // Header's rail-toggle glyph and menu (diffable/archived) depend on nav —
  // repaint just the header rather than the whole paint() pipeline.
  const unsubNavHeader = nav.subscribe(() => renderHeader(dom, sessions.getSlice(sessionId), sessionId, meta));
  const unsubUsage = usage.subscribe(() => {
    renderModelChip(dom, sessionId);
    renderMeterStrip(dom, sessionId);
  });
  paint();
  paintAgents();

  return {
    unmount() {
      unsubSlice();
      unsubApprovals();
      unsubSubagents();
      unsubSessions();
      unsubConn();
      unsubNavHeader();
      unsubUsage();
      unwireHeader();
      document.removeEventListener('keydown', onHeaderKeydown);
      unwireComposer();
      resizeObserver?.disconnect();
      if (paintRaf) cancelAnimationFrame(paintRaf);
      if (agentsRaf) cancelAnimationFrame(agentsRaf);
      stopMetaTicker();
      stopHeaderTicker();
      clearInterval(meterTicker);
      sessions.unmountView(sessionId);
      closeSessionWs(sessionId);
      mount.textContent = '';
      mount.classList.remove('sv-host');
    },
  };
}

