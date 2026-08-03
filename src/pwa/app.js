import { partitionSessions } from './session-filter.js';
import {
  sendApprovalModeSet as tabSendApprovalModeSet,
  sendUserMessage as tabSendUserMessage,
  sendInterrupt as tabSendInterrupt,
  sendOnSessionWs,
  forceReconnectAll as forceReconnectSessionWs,
  sessionWsReadyState,
  forceCloseFromTest,
  getSessionWs,
} from './components/session-view/session-ws.js';
import { conn } from './state/conn.js';
import {
  openNotifyWs,
  installNotifyHandlers,
  forceReconnectNotifyWs,
  sendOnNotifyWs,
  notifyWsReadyState,
} from './state/notify-ws.js';
import { dispatchSession, dispatchBroadcast, installDispatchDeps } from './ws/dispatch.js';
import { isDesktop, onLayoutChange } from './layout/index.js';
import { nav, setSessionHint, peekSessionHint } from './state/nav.js';
import { startSession } from './session-launch.js';
import { installAppBridge } from './app-bridge.js';
import {
  sessions,
  findMatchingToolUseId,
  expandToolByContent,
  applyPendingExpand,
} from './state/sessions.js';
import { approvals } from './state/approvals.js';
import { settings, VALID_THEMES, VALID_MODES } from './state/settings.js';
import { hydrate as hydratePreferences } from './state/preferences.js';
import './state/keymap.js'; // registers the `hotkeys` prefs key on import
import {
  subagents,
  applyTaskUse,
  applyTaskResult,
  applyTaskTranscriptMessage,
  applyTaskNotification,
  recordParentAgentInvocation,
  addSubagentEntry,
  applyDiskSubagents,
  bringAgentToFront,
} from './state/subagents.js';
import { getHeader as getGitHeader } from './state/git.js';
import { initialDeepLink, applyDeepLink } from './deep-links.js';
import { installTestHooks } from './test-hooks.js';
import {
  initCwdPicker,
  openCwdPickerSheet,
  closeCwdPickerSheet,
  openAddProjectSheet,
  closeAddProjectSheet,
  commitNewSessionCwd,
} from './components/cwd-picker.js';
import {
  initMobileHeader,
  setHeader,
  refreshHeaderModeChip,
  currentSessionDiffable,
  setAcceptEdits,
} from './components/mobile-header.js';
import { syncThemeColorMeta } from './components/theme-picker.js';
import { usage } from './state/usage.js';
import { work } from './state/work.js';
import {
  noteSheetOpen,
  noteSheetClose,
  dismissSoftKeyboard,
  pinSheetBelowHeader,
  confirmInSheet,
  makeSheetDismissible,
} from './components/sheet-utils.js';
import { openTodosSheet, closeTodosSheet, refreshTodosSheet } from './components/todos-sheet.js';
import {
  bindAskCardHandlers,
} from './components/ask-card.js';
import {
  initAskFlow,
  ensureAskInlineTile,
  submitAskAnswer,
  askApprovalCardHtml,
  askMsgHtml,
  applyAskTranscriptMessage,
} from './components/ask-flow.js';
import {
  initApprovalsMobile,
  formatApprovalCountdown,
  showApprovalToast,
  flushPendingDecides,
  decideApproval,
  sendApprovalDecide,
  approvalCardHtml,
  alwaysAllowAndApprove,
  beginRejectWithNote,
  submitRejectWithNote,
  cancelRejectWithNote,
} from './components/approvals-mobile.js';
import { lookupContextWindow } from './components/session-view/meter.js';
import { EDIT_TOOLS, isHighDetailTool } from './components/tool-use-tile.js';
import { mountShell, unmountShell } from './components/shell/index.js';
import { mountMobileShell, unmountMobileShell, repaintMobileShell } from './components/mobile-shell/index.js';
import { initPalette } from './components/palette/index.js';
import {
  initDiffOverlay,
  openDiffOverlay,
  closeDiffOverlay,
  resetGitViewer,
  maybeRefreshHeaderBranch,
  refreshSourceControl,
} from './components/diff-overlay/index.js';
import {
  initAgentsSheet,
  agentsStripHtml,
  openAgentsSheet,
  closeAgentsSheet,
  refreshAgentsSheet,
  formatDurationMs,
} from './components/agents-sheet/index.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw register failed', e));
}

const root = document.getElementById('root');
const header = document.getElementById('header');

// index.html's inline boot script sets data-theme/data-mode from localStorage
// before first paint (so CSS never flashes the wrong theme); this just brings
// the <meta name="theme-color"> tag's hardcoded default in line with it. Every
// later change goes through theme-picker.js's own renderThemeGrid/renderModeToggle,
// which call this themselves.
syncThemeColorMeta();

const state = {
  lingeringTimer: null,
  // Rollup of the two WS channels, computed by updateConnIndicator subscribing
  // to state/conn.js: 'connected' / 'reconnecting' / 'failed'.
  connState: 'reconnecting',
  // cleared on first non-error message OR by daemon_error; otherwise a bad-cwd error renders blank
  pendingNewSession: null, // { id, cwd } | null
  // first bypass tap arms; second tap within 4s commits
  bypassConfirmPending: false,
  // slash-command palette — opened by typing `/` at the start of the composer
  paletteOpen: false,
  paletteFilter: '',
  paletteHighlight: 0,
};

// 1M-context Opus advertises with the [1m] suffix; unknown ids fall back to 200k


const initialButton = document.getElementById('add-project-initial');
if (initialButton) initialButton.onclick = () => openAddProjectSheet();

async function loadDaemonInfo() {
  try {
    const r = await fetch('/api/info');
    if (!r.ok) return;
    const info = await r.json();
    usage.setDaemonInfo(info);
    if (Array.isArray(info.slashCommands)) {
      usage.setSlashCommands(info.slashCommands);
    }
    // session-view's own regions already react to the `usage`/`sessions`
    // stores directly (usage.subscribe/subscribeSlice) — avoid render()'s
    // remount churn while a session is actively mounted.
    if (sessions.get().view !== 'session') render();
  } catch { /* offline-ok */ }
}

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    sessions.setProjects(data.projects);
    seedRunStates(data.projects ?? []);
    approvals.setPending(data.pending ?? []);
    for (const a of approvals.get().pending) {
      if (isHighDetailTool(a.toolName) && a.sessionId) {
        sessions.for(a.sessionId).markToolExpanded(`approval-${a.approvalId}`, true);
      }
    }
    render();
  } catch (e) {
    // The shell is already mounted (render() runs at boot) — surfaces show
    // their own empty states, so a failed fetch must not blow away #root.
    showStatusToast(`Failed to load sessions: ${String(e.message)}`);
  }
}

// GET /api/sessions rows carry daemon-side liveness (runState:
// 'foreground'|'background'|'idle'). Seed/update slices from it so sessions
// running on the daemon but never opened in this tab still count as running
// (cockpit In-flight, sidebar count) after a reload. Sessions with a
// locally-mounted view stay 'foreground' — their own WS owns that lifecycle.
function seedRunStates(projects) {
  for (const p of projects) {
    for (const s of p.sessions ?? []) {
      const serverRunning = s.runState === 'foreground' || s.runState === 'background';
      const slice = sessions.getSlice(s.id);
      if (serverRunning) {
        sessions.upsertSlice(s.id, { cwd: p.cwd, spawnCwd: s.worktreePath ?? p.cwd });
        if (slice?.runState === 'inactive') sessions.setRunState(s.id, 'background');
      } else if (s.runState === 'idle' && slice?.runState === 'background') {
        sessions.setRunState(s.id, 'inactive');
      }
    }
  }
}

// Handle to the mobile-mounted session-view. Only one is active at a time
// (mobile shows one session at a time by design). Kept at module scope so
// re-entering render() while the same session is showing is a cheap no-op
// (session-view already reacts to slice updates via subscribeSlice).
let mobileSvHandle = null;
let mobileSvSessionId = null;
// Session id whose mount is currently in flight. mountMobileSessionView is
// async (dynamic import), but render() runs it more than once per session-open
// — enterSession's synchronous store notify fires the view-watcher, then
// openSession() calls render() again. `mobileSvHandle` is only set AFTER the
// await, so it can't dedupe those calls; without this synchronous marker every
// call sails past the guard and mounts a second session-view into #root,
// leaking the first (its WS, its nav/sessions subscriptions, and a mountedCount
// that never returns to 0). It also lets a mount that resolves after the user
// already left abort instead of clobbering #root out from under the shell.
let mobileSvPendingId = null;

function unmountMobileSessionView() {
  mobileSvPendingId = null;
  if (mobileSvHandle) { try { mobileSvHandle.unmount(); } catch { /* ignore */ } }
  mobileSvHandle = null;
  mobileSvSessionId = null;
}

async function mountMobileSessionView() {
  const s = sessions.get();
  const id = s.currentSessionId;
  if (!id) return;
  if (mobileSvHandle && mobileSvSessionId === id) return;   // already up
  if (mobileSvPendingId === id) return;                     // mount already in flight
  mobileSvPendingId = id;
  // A different session is currently shown (fast session-switch) — tear it down
  // before mounting the new one so its WS/subscriptions don't leak.
  if (mobileSvHandle) {
    try { mobileSvHandle.unmount(); } catch { /* ignore */ }
    mobileSvHandle = null;
    mobileSvSessionId = null;
  }
  // Brand-new sessions carry spawnMode/baseBranch via the nav session-hint
  // side channel (same mechanism desktop's sessions-surface uses) — those
  // fields aren't part of the persisted session slice, only meaningful on
  // the WS's first connect. mountSessionView (the sole openSessionWs/
  // closeSessionWs owner) reads them off this meta object.
  const hint = peekSessionHint(id);
  const { mountSessionView } = await import('./components/session-view/index.js');
  // Revalidate after the await: the user may have left the session or switched
  // to another one while the import resolved. If this mount is no longer the
  // one wanted, bail rather than clobber #root (which the shell may have
  // retaken) — leaving pendingId untouched if a newer mount claimed it.
  if (mobileSvPendingId !== id || sessions.get().view !== 'session' || sessions.get().currentSessionId !== id) {
    if (mobileSvPendingId === id) mobileSvPendingId = null;
    return;
  }
  mobileSvHandle = mountSessionView(root, id, {
    cwd: hint?.cwd ?? s.currentSessionCwd,
    spawnCwd: hint?.spawnCwd ?? s.currentSessionSpawnCwd ?? s.currentSessionCwd,
    spawnMode: hint?.spawnMode ?? null,
    baseBranch: hint?.baseBranch ?? null,
    model: hint?.model ?? null,
    fromTicketId: s.currentSessionFromTicketId ?? null,
    approvalMode: hint?.approvalMode ?? s.approvalMode,
  });
  mobileSvSessionId = id;
  mobileSvPendingId = null;
}

// Mobile render dispatch (D6/P3): sessions.view now only distinguishes
// 'session' (the untouched multi-live session-view flow) from everything
// else — mobile-shell's tab bar + nav-driven screens own everything that
// isn't a live session.
//
// mountShell/unmountShell and mountMobileShell/unmountMobileShell are always
// called in pairs on every layout crossing (never just one side) — that's
// what makes a mobile→desktop→mobile round trip resume into the SAME live
// #header/#root nodes app.js's consts hold, instead of the stale-detached-
// node blank-mobile-view bug this used to have (see shell/index.js).
function render() {
  const app = document.getElementById('app');
  if (isDesktop()) {
    unmountMobileShell();
    return mountShell(app);
  }
  unmountShell(app);
  const view = sessions.get().view;
  if (view === 'session') {
    setHeader('session');
    unmountMobileShell();
    // view === 'session': the multi-live path — mount session-view if it isn't
    // already up for this session. renderSession() below short-circuits on the
    // .sv-host marker so legacy subscribers don't fight the mount.
    mountMobileSessionView();
    return renderSession();
  }
  // Always reconcile (not just when a handle exists): a mount may still be in
  // flight (pendingId set, handle not yet assigned) — clearing it here makes
  // that async mount bail instead of clobbering the shell we're about to mount.
  unmountMobileSessionView();
  // Everything else ('list' — the persistent default): the tab bar + screen
  // navigator owns #root/#header from here.
  return mountMobileShell(root);
}

async function openSession(id, opts) {
  const isNew = id === null || !!opts?.cwd;
  if (id === null) id = crypto.randomUUID();
  let cwd = null;
  let spawnCwd = null;
  const projects = sessions.get().projects;
  if (opts?.cwd) {
    cwd = opts.cwd;
    const proj = projects.find((p) => p.cwd === opts.cwd);
    usage.setProjectContextWindow(proj?.contextWindowSize ?? null);
  } else {
    usage.setProjectContextWindow(null);
    for (const p of projects) {
      const match = p.sessions.find((s) => s.id === id);
      if (match) {
        cwd = p.cwd;
        usage.setProjectContextWindow(p.contextWindowSize ?? null);
        if (match.worktreePath) spawnCwd = match.worktreePath;
        break;
      }
    }
  }
  startSession({ id, cwd, spawnCwd, fromTicketId: opts?.fromTicketId });
  // No approvalMode override: enterSession preserves the slice's existing mode
  // (a fresh slice defaults to 'ask'). Passing a literal 'ask' here reset the
  // mode every time the user tapped back into a session on mobile — the mobile
  // header reads the top-level mirror, and the reused session socket never
  // re-broadcasts the real mode to heal an optimistic clobber.
  sessions.enterSession({ id, cwd, spawnCwd, fromTicketId: opts?.fromTicketId });
  // The agents-sheet reads via subagents.focused(); point it at this session
  // so opens land on THIS session's buckets. Then clear the slice — other open
  // sessions' subagents stay intact.
  subagents.setFocused(id);
  subagents.clearSession(id);
  // Global dedup sets — these are shared across sessions on purpose (their
  // content is uniquely-scoped ids or hash sigs from the WS stream), so we
  // no longer wipe them here. Wiping them would let stale WS deliveries be
  // reprocessed as if fresh.
  subagents.set((s) => ({ ...s, unboundInvocations: [] }));
  sessions.for(id).setPendingDefaultPush(isNew);
  settings.setAcceptEdits(false);
  settings.setModePopoverOpen(false);
  approvals.set((s) => ({ ...s, pendingAsks: new Map() }));
  usage.setLastUsage(usage.get().lastUsageBySession.get(id) ?? null);
  usage.setStatusline(usage.get().statuslineBySession.get(id) ?? null);
  usage.setMeterBreakdownOpen(false);
  state.paletteOpen = false;
  state.paletteFilter = '';
  state.paletteHighlight = 0;
  if (state.lingeringTimer) clearTimeout(state.lingeringTimer);
  state.lingeringTimer = null;
  // re-route current-session approvals into subagent buckets so the strip isn't empty on arrival
  for (const a of approvals.get().pending) {
    if (a.sessionId === id && a.agentId) addSubagentEntry(a);
  }
  state.transcriptLoading = !isNew;
  document.getElementById('toast')?.remove();
  // No manual composer clear here: render() below tears down and rebuilds the
  // session-view mount from scratch (mountSessionView's buildSkeleton replaces
  // mount.innerHTML wholesale), and session-view's own per-session draft map
  // (composerDraft in session-view/index.js) is what seeds the new session's
  // composer text — a pre-render clear here would only ever touch the OLD
  // session's about-to-be-destroyed node.
  //
  // spawnMode/baseBranch only matter for a brand-new session's first WS
  // connect and aren't part of the persisted session slice, so they travel
  // via the nav session-hint side channel — mountMobileSessionView() (called
  // from render() below) consumes it and mountSessionView is the sole
  // openSessionWs/closeSessionWs owner (no separate direct call here).
  if (isNew) {
    const defaultMode = settings.get().defaultApprovalMode;
    setSessionHint(id, {
      cwd, spawnCwd: cwd, spawnMode: opts?.spawn ?? null, baseBranch: opts?.base ?? null,
      approvalMode: defaultMode !== 'ask' ? defaultMode : undefined,
    });
  }
  render();
  if (!isNew) {
    // race against currentSessionId so a fast tab-switch doesn't leak buckets
    fetch(`/api/sessions/${encodeURIComponent(id)}/subagents`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body || sessions.get().currentSessionId !== id) return;
        applyDiskSubagents(body.subagents || [], id);
        if (sessions.get().view === 'session') renderSession();
      })
      .catch((e) => console.warn('failed to load subagents:', e));
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
      if (r.ok) {
        const { messages } = await r.json();
        if (sessions.get().currentSessionId === id) {
          // seed seenBlockSigs so the WS replay buffer can't double-push the last ~30s
          const filtered = [];
          for (const m of messages) {
            if (m.toolUseId) subagents.markBlockSigSeen(m.toolUseId);
            if (m.role === 'assistant' && m.msgId) subagents.markBlockSigSeen(`${m.msgId}|${m.text}`);
            if (applyTaskTranscriptMessage(m, id)) continue;
            if (applyAskTranscriptMessage(m, filtered, id)) continue;
            // hook payloads carry agent_type but not the parent's description
            if (m.role === 'tool_use' && m.toolName === 'Agent' && m.toolInput && typeof m.toolInput === 'object') {
              recordParentAgentInvocation({
                toolUseId: m.toolUseId,
                subagentType: m.toolInput.subagent_type,
                description: m.toolInput.description,
              });
            }
            filtered.push(m);
          }
          sessions.for(id).setTranscript(filtered);
          // Edit/Write tiles default to expanded; seed once on load (setTranscript
          // itself can't, since mapTranscript reuses it and would fight collapses).
          sessions.for(id).seedEditExpansions(filtered);
        }
      }
    } catch (e) {
      console.warn('failed to load session transcript:', e);
    } finally {
      state.transcriptLoading = false;
      if (sessions.get().currentSessionId === id) renderSession();
    }
  }
}

// recovers the gap when iOS backgrounding outlasted the daemon's 30s replay buffer.
// Runs for both foreground and background sessions — the WS is opened
// explicitly for `id` upstream, so the catch-up target is `id`, not
// currentSessionId.
async function catchUpFromDisk(id) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
    if (!r.ok || !sessions.getSlice(id)) return;
    const { messages } = await r.json();
    if (!sessions.getSlice(id)) return;
    const isCurrent = id === sessions.get().currentSessionId;
    const S = sessions.for(id);

    // long iOS suspend can evict sessions transcript while seenBlockSigs survives; detect drift
    // and full-rebuild, otherwise dedup-append would skip every message as "already seen"
    const diskAssistantCount = messages.filter((m) => m.role === 'assistant').length;
    const slice = sessions.getSlice(id);
    const memAssistantCount = slice.transcript.filter((m) => m.role === 'assistant').length;
    if (diskAssistantCount > memAssistantCount + 1) {
      rebuildTranscriptFromDisk(messages, id);
      try {
        const r2 = await fetch(`/api/sessions/${encodeURIComponent(id)}/subagents`);
        if (r2.ok && sessions.getSlice(id)) {
          const body = await r2.json();
          applyDiskSubagents(body.subagents || [], id);
        }
      } catch { /* ignore */ }
      if (isCurrent && sessions.get().view === 'session') renderSession();
      return;
    }

    // user messages have no msgId, so block dedup can't catch them; skip by count instead
    let userMsgsToSkip = slice.transcript.filter((m) => m.role === 'user').length;
    let added = false;
    for (const m of messages) {
      if (m.role === 'tool_use' && m.toolUseId) {
        if (subagents.hasBlockSig(m.toolUseId)) continue;
        subagents.markBlockSigSeen(m.toolUseId);
      } else if (m.role === 'assistant' && m.msgId) {
        const sig = `${m.msgId}|${m.text}`;
        if (subagents.hasBlockSig(sig)) continue;
        subagents.markBlockSigSeen(sig);
      } else if (m.role === 'tool_result' && m.toolUseId && approvals.get().consumedTaskResults.has(m.toolUseId)) {
        continue;
      } else if (m.role === 'user') {
        if (userMsgsToSkip > 0) { userMsgsToSkip--; continue; }
      }
      if (applyTaskTranscriptMessage(m, id)) { added = true; continue; }
      if (applyAskTranscriptMessage(m, sessions.getSlice(id)?.transcript ?? [], id)) { added = true; continue; }
      if (m.role === 'tool_use' && m.toolName === 'Agent' && m.toolInput && typeof m.toolInput === 'object') {
        recordParentAgentInvocation({
          toolUseId: m.toolUseId,
          subagentType: m.toolInput.subagent_type,
          description: m.toolInput.description,
        });
      }
      S.appendTranscript(m);
      added = true;
    }
    try {
      const r2 = await fetch(`/api/sessions/${encodeURIComponent(id)}/subagents`);
      if (r2.ok && sessions.getSlice(id)) {
        const body = await r2.json();
        applyDiskSubagents(body.subagents || [], id);
        added = true;
      }
    } catch { /* ignore */ }
    if (added && isCurrent && sessions.get().view === 'session') renderSession();
  } catch (e) {
    console.warn('failed to catch up from disk:', e);
  }
}

// preserves locally-pushed user messages not yet written to disk (sendMessage→flush race)
function rebuildTranscriptFromDisk(messages, sessionId) {
  const sid = sessionId ?? sessions.get().currentSessionId;
  if (!sid) return;
  const S = sessions.for(sid);
  const slice = sessions.getSlice(sid);
  const diskUserTexts = new Set(
    messages.filter((m) => m.role === 'user' && typeof m.text === 'string').map((m) => m.text),
  );
  const pendingLocalUsers = (slice?.transcript ?? []).filter(
    (m) => m.role === 'user' && !m.msgId && !diskUserTexts.has(m.text),
  );

  // Only reset per-session state — the global dedup sets (seenBlockSigs,
  // consumedTaskResults, taskToolUseIds, pendingCreates) are shared with
  // other multi-live sessions and mustn't be wiped from under them.
  S.setTodos(new Map());

  const filtered = [];
  for (const m of messages) {
    if (m.toolUseId) subagents.markBlockSigSeen(m.toolUseId);
    if (m.role === 'assistant' && m.msgId) subagents.markBlockSigSeen(`${m.msgId}|${m.text}`);
    if (applyTaskTranscriptMessage(m, sid)) continue;
    if (applyAskTranscriptMessage(m, filtered, sid)) continue;
    if (m.role === 'tool_use' && m.toolName === 'Agent' && m.toolInput && typeof m.toolInput === 'object') {
      recordParentAgentInvocation({
        toolUseId: m.toolUseId,
        subagentType: m.toolInput.subagent_type,
        description: m.toolInput.description,
      });
    }
    filtered.push(m);
  }
  S.setTranscript([...filtered, ...pendingLocalUsers]);
}

function leaveSession() {
  const fromTicketId = sessions.get().currentSessionFromTicketId;
  // No direct closeSessionWs() here: sessions.leaveSession() below flips view
  // to 'list', the view-watcher's render() detects the transition and
  // unmountMobileSessionView() closes the WS via mountSessionView's own
  // unmount() — mountSessionView is the sole openSessionWs/closeSessionWs
  // owner (see openSession()'s matching note).
  resetGitViewer();
  approvals.set((s) => ({ ...s, rejectionDrafts: new Map(), rejectionReasons: new Map() }));
  sessions.leaveSession();
  // sessions.leaveSession() always lands view on 'list' now (mobile-shell's
  // neutral "show the tab bar" sentinel — see render()'s dispatch); when the
  // session was opened from a tracked job, land back on that job's Tracked
  // drill-in instead of the tab bar's default (Cockpit/whatever was active).
  if (!isDesktop() && fromTicketId) nav.select('tracked', fromTicketId);
  if (state.lingeringTimer) { clearTimeout(state.lingeringTimer); state.lingeringTimer = null; }
  document.getElementById('toast')?.remove();
  closeTodosSheet();
  closeAgentsSheet();
  loadSessions();
}

// Aggregate the session/notify conn states into a single indicator on <html>,
// and re-render on `failed` transitions so the disconnect banner appears/vanishes.
// Only the current session's WS state feeds this; background session hiccups are
// visible in their own tab views, not the shell-wide indicator.
function updateConnIndicator() {
  const c = conn.get();
  const inSession = sessions.get().view === 'session';
  const sessionState = inSession ? c.session : 'connected';
  const anyFailed = sessionState === 'failed' || c.notify === 'failed';
  const allReady = c.notify === 'connected' && (sessionState === 'connected' || sessionState === 'idle');

  const next = anyFailed ? 'failed' : (allReady ? 'connected' : 'reconnecting');
  const prev = state.connState;
  state.connState = next;
  document.documentElement.setAttribute('data-conn', next);

  if ((prev === 'failed') !== (next === 'failed')) {
    if (inSession) renderSession();
    else render();
  }
}
conn.subscribe(updateConnIndicator);

function forceReconnect() {
  forceReconnectSessionWs();
  forceReconnectNotifyWs();
}

// idempotent — notification WS and session WS seed Ask tiles in either order.
// sessionId scopes the transcript scan + append to the correct session's slice
// (multi-live: background sessions can seed their own ask tiles).


// Stable skeleton + per-region updates: the old root.innerHTML rebuild dropped keyboard
// focus on every WS message, wiping in-progress composer text on mobile.
// Transient status toast for ephemeral feedback. tone='danger' (default) for failures,
// 'success' for positive confirmations like clipboard copy. Replaces any prior toast.
function showStatusToast(text, tone) {
  document.getElementById('status-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'status-toast';
  t.className = `status-toast${tone === 'success' ? ' status-toast-success' : ''}`;
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

// D7: thinking-lifecycle + usage-recording helpers, relocated verbatim from
// the deleted mobile-session-view.js singleton. These are genuine session
// state mutations (not view rendering) — ws/dispatch.js and diff-overlay.js
// call them regardless of layout, so they belong here rather than in any
// one view module. `startThinking`/`stopThinking` wrap the per-session slice
// mutators; `state.lingeringTimer` is the one shared (non-session-scoped) JS
// timer handle tracking the "still show the last tool's verb briefly" window
// — see ws/dispatch.js's `user` handler for where it's armed.
function startThinking(sid) {
  if (!sid) return;
  sessions.for(sid).startThinking();
}

function stopThinking(sid) {
  if (!sid) return;
  sessions.for(sid).stopThinking();
  if (state.lingeringTimer) {
    clearTimeout(state.lingeringTimer);
    state.lingeringTimer = null;
  }
}

function recordUsage(u, model, sid) {
  if (!u) return;
  // Synthetic assistant messages (rate-limit notices) carry model "<synthetic>" — don't
  // let that overwrite the real model id.
  const realModel = (typeof model === 'string' && !model.startsWith('<')) ? model : null;
  const lu = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    model: realModel ?? usage.get().lastUsage?.model ?? null,
  };
  usage.setLastUsage(lu);
  // Attribute to the delivering socket's own session id — desktop's multi-live
  // sessions each have their own per-session WS, and `currentSessionId` is the
  // mobile-only singleton pointer (null on desktop), so keying on it left
  // lastUsageBySession empty and the rail's message_start model fallback dead.
  const curId = sid ?? sessions.get().currentSessionId;
  if (curId) usage.setLastUsageFor(curId, lu);
  if (realModel) {
    // Project override wins — API responses strip the [1m] suffix so we can't tell a 1M
    // Opus from a 200k one without ~/.claude.json's projectContextWindow.
    usage.setContextWindow(usage.get().projectContextWindow ?? lookupContextWindow(realModel));
  }
}

// session-view/index.js's own paint() already repaints reactively via store
// subscriptions for whichever session is mounted (desktop's single detail
// pane or the mobile singleton) — ws/dispatch.js's `deps.renderSession()`
// calls, diff-overlay.js's, and approvals-mobile.js's predate that and are
// kept as a no-op purely so those modules' existing deps contracts don't need
// a follow-up edit (see D7 write-up).
function renderSession() {}


// Send an approval decision over the most reliable channel available. Notifications WS is
// the preferred channel — it's engineered to survive iOS backgrounding and is the one that
// delivered the approval_pending. If both WSs are down (rare but possible), queue the
// decide for flush when the notifications WS next opens. Returns true if the decision was
// sent immediately, false if queued.

// Reject-with-note flow. The transcript reject button no longer decides immediately —
// it swaps the card's actions for a textarea so the user can tell Claude WHY. The
// reason is plumbed as permissionDecisionReason (hook-handler.ts), which Claude reads
// as feedback instead of looping into another tool attempt.


function scrollTranscriptBottom() {
  requestAnimationFrame(() => {
    const t = root.querySelector('#transcript');
    if (t) t.scrollTop = t.scrollHeight;
  });
}

/* ───── Utils ───────────────────────────────────────────────────── */

function setProjectExpanded(projectDir, expanded) {
  sessions.setExpandedProject(projectDir, expanded);
}

// When the PWA comes back to the foreground (user unlocks phone, switches back from
// another app), iOS may have severed the WS without firing onclose yet — the next
// retry tick is up to 1.5s away. Fire a reconnect immediately so the user doesn't see
// a stale snapshot while waiting.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Check the live readyState rather than our state store — iOS can put the socket
  // into CLOSED without notifying, in which case the store's mirror is stale.
  const notifyDead = notifyWsReadyState() !== WebSocket.OPEN;
  const { currentSessionId, view } = sessions.get();
  const sessionDead = currentSessionId && sessionWsReadyState(currentSessionId) !== WebSocket.OPEN;
  if (notifyDead || sessionDead) forceReconnect();
  // Even if both WSs survived the background, in-memory state may have drifted from
  // disk truth — e.g. a backgrounded subagent's task-notification can land on disk but
  // not on the WS our PWA was listening to. Force a disk reconcile on every foreground
  // transition while in a session. Dedup via seenBlockSigs / readSubagents merging
  // makes this a no-op when nothing changed, and a recovery when something did.
  if (currentSessionId && view === 'session') {
    catchUpFromDisk(currentSessionId);
  }
});

// Keep --header-h in sync with the actual header height so the cross-session approval
// toast clears the header on every theme/safe-area combination instead of relying on a
// 56px guess.
(function trackHeaderHeight() {
  const header = document.getElementById('header');
  if (!header) return;
  const apply = () => {
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  };
  apply();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(apply).observe(header);
  } else {
    window.addEventListener('resize', apply);
  }
})();

// Toggle body.kb-open while the on-screen keyboard is up so the composer can drop its
// safe-area-inset-bottom padding (the keyboard already separates the field from the
// screen edge — see .composer rule in index.html). We use focus state rather than
// visualViewport.resize because the resize event is unreliable on iOS Safari/Chrome —
// it doesn't always fire, especially when the URL bar collapses simultaneously.
// focusout runs through setTimeout so focus-hopping between inputs doesn't briefly
// flash kb-open=false.
(function trackKeyboard() {
  const isTextInput = (el) => !!el && (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
    (el.getAttribute && el.getAttribute('contenteditable') === 'true')
  );
  const apply = () => {
    document.body.classList.toggle('kb-open', isTextInput(document.activeElement));
  };
  document.addEventListener('focusin', apply);
  document.addEventListener('focusout', () => setTimeout(apply, 0));
})();
// ───── Phase 4: Web Push subscription flow ─────────────────────────────
// Settings sheet section: iOS install banner, subscribe/unsubscribe toggle, test push.
// The handler also listens for messages from the service worker so foreground pushes
// (suppressed by the SW when a window is visible) and deep-link taps can route into
// existing in-page surfaces.
// Transcript retention cap — hydrated from the sessions store on load and
// written back on blur/change. The store clamps 50–10000 and re-trims every
// existing slice's transcript when the cap decreases, so the effect is
// immediate for open sessions.

// SW → page bridge. The SW posts {type:'push',...} when foreground-suppressed; we don't
// double-render here because the existing notifications WS already delivered the event.
// {type:'deepLink',...} fires when the user taps a notification while a PWA window is
// open — the SW focused us, now we apply the session+approval routing without nav.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'deepLink') {
      applyDeepLink({ sessionId: msg.sessionId, approvalId: msg.approvalId });
    }
  });
}

// ───── Phase 4: deep-link handling ─────────────────────────────────────
// URL shape: /?session=<id>&approval=<id>. Used when the user taps a push notification
// and the PWA either launches cold OR is already open (SW posts via 'deepLink' message).


installDispatchDeps({
  state,
  render,
  renderSession,
  // The mobile-shell-driven views (everything but the session feed) self-
  // subscribe to their own stores and repaint reactively — dispatch.js's
  // view==='list' broadcast nudges just need *a* re-render, not the old
  // session-list-only renderer (which would otherwise blow away the mounted
  // mobile shell's DOM out from under it).
  renderList: render,
  showApprovalToast,
  openCwdPickerSheet,
  refreshHeaderModeChip,
  setAcceptEdits,
  recordUsage,
  startThinking,
  stopThinking,
  ensureAskInlineTile,
  leaveSession,
  sendApprovalDecide,
  loadSessions,
});

// Reacts to a live desktop/mobile crossing (window resize past 1024px, a
// tablet rotation) by re-running the top-level dispatch, which un/mounts
// whichever shell is no longer active (see render()'s unmountMobileShell()/
// unmountShell()/mountShell() calls) so the two never both hold live
// subscriptions — and, since P4, so a mobile→desktop→mobile round trip in one
// page load resumes into the same #header/#root nodes instead of leaving
// mobile-shell mounting into stale detached ones (former blank-view bug).
onLayoutChange(() => render());

loadDaemonInfo();
loadSessions().then(() => {
  if (initialDeepLink) applyDeepLink(initialDeepLink);
});
// Daemon-backed preferences (Spec A): all stores' register() calls above have
// already run, so hydrate can safely reconcile against them.
void hydratePreferences();
installNotifyHandlers({
  onMessage: dispatchBroadcast,
  onOpen: () => {
    flushPendingDecides();
    void work.loadAll();
    // Runs/Schedules surfaces are mounted on both layouts now (P3) — each
    // surface's own list.js also lazy-loads on first mount (loading/loaded
    // guarded), so this is just a warm boot preload, not the only load path.
    import('./state/runs.js').then(({ runs }) => runs.load());
    import('./state/schedules.js').then(({ schedulesStore }) => schedulesStore.load());
  },
});
openNotifyWs();

// View changes need to trigger a render; the rest of the app updates view via
// explicit render() calls at each call site, but the work tabs and back buttons
// mutate view from inside components that don't have access to render().
let lastView = sessions.get().view;
sessions.subscribe(() => {
  const v = sessions.get().view;
  if (v !== lastView) {
    lastView = v;
    render();
  }
});



// Desktop's "open this session" entry point. Despite the name (kept for
// test-hooks.js's existing __outpostOpenSession contract), this no longer
// opens a workspace tab — it selects the session in the nav-based Sessions
// surface (D1: the tab/pane shell is gone). Session context that isn't yet
// backed by sessions.get().projects (a session just created, or one whose
// project list hasn't loaded) travels via the nav session-hint side channel.
async function openSessionInWorkspaceTab(id, fromTicketId) {
  const { nav } = await import('./state/nav.js');
  let cwd = null, spawnCwd = null, title = null, worktreePath = null, worktreeBranch = null;
  for (const p of sessions.get().projects) {
    const match = p.sessions?.find((s) => s.id === id);
    if (match) {
      cwd = p.cwd;
      title = match.title;
      worktreePath = match.worktreePath;
      worktreeBranch = match.worktreeBranch;
      spawnCwd = match.worktreePath ?? p.cwd;
      break;
    }
  }
  startSession({ id, cwd, spawnCwd, title, worktreePath, worktreeBranch, fromTicketId });
  nav.select('sessions', id);
}

initMobileHeader({
  appState: state,
  leaveSession,
  openDiffOverlay,
  maybeRefreshHeaderBranch,
});
initApprovalsMobile({
  showStatusToast,
  renderSession,
  openSession,
});
initAskFlow({ formatApprovalCountdown, decideApproval });
initCwdPicker({
  appState: state,
  openSession,
  loadSessions,
  render,
  setProjectExpanded,
});

installTestHooks({
  appState: state,
  openSession,
  openSessionInWorkspaceTab,
  refreshSessions: loadSessions,
});

// Install the cross-module callback bridge. Extracted components (session-view,
// work cards, etc.) can't import from app.js without cycling, so they import
// these callables from app-bridge.js — this line hands the concrete impls to
// the bridge at boot.
installAppBridge({
  catchUpFromDisk,
  decideApproval,
  forceReconnect,
  leaveSession,
  openSession: (opts) => globalThis.__outpostOpenSession(opts),
  refreshSessions: () => loadSessions(),
  openAgentsForSession(sessionId) {
    if (!sessionId) return;
    subagents.setFocused(sessionId);
    openAgentsSheet();
  },
  // openDiffOverlay is fully sessionId-scoped internally — no need to first
  // stamp the mobile-only currentSessionId/currentSessionCwd pointer just so
  // its opts-less fallback can pick it back up (that pointer is layout-scoped
  // state other consumers key off; the desktop git button has no business
  // mutating it just to open a diff).
  openDiffForSession(sessionId) {
    if (!sessionId) return;
    openDiffOverlay({ sessionId });
  },
});
import('./components/session-view/session-ws.js').then(({ _installWsHandler }) => {
  _installWsHandler(dispatchSession);
});

initDiffOverlay({ renderSession, startThinking, scrollTranscriptBottom, leaveSession });
initAgentsSheet({
  approvalCardHtml,
  decideApproval,
  alwaysAllowAndApprove,
  beginRejectWithNote,
  submitRejectWithNote,
  cancelRejectWithNote,
});
initPalette();

// Mount the shell immediately — it needs no session data (each surface shows
// its own loading/empty state), and gating the first render() on
// loadSessions() resolving left index.html's static pre-redesign skeleton on
// screen for the whole fetch (and forever on fetch failure).
render();
