// Playwright test hooks. Every export here is intentional test-only surface —
// none of these are called by production code. Named with double underscores
// (__outpost*) so they're clearly non-API and easy to grep out of shipping.
//
// app.js calls installTestHooks() once at boot with the app-internal pieces
// that don't cleanly import (currentSessionId + openSessionInWorkspaceTab
// require lexical scope; state is the mutable ref).

import { sessions } from './state/sessions.js';
import { settings } from './state/settings.js';
import { nav } from './state/nav.js';
import { startSession } from './session-launch.js';
import {
  sendOnSessionWs,
  getSessionWs,
  forceCloseFromTest,
  sessionWsReadyState,
} from './components/session-view/session-ws.js';
import { isDesktop } from './layout/index.js';

let hooks = {
  appState: null,
  openSession: null,
  openSessionInWorkspaceTab: null,
  refreshSessions: null,
};

export function installTestHooks(d) {
  hooks = { ...hooks, ...d };
  wire();
}

// sessions.currentSessionId is a mobile-only UI pointer (state/sessions.js's own
// enterSession() doc comment) — desktop's "which session is on screen" lives in
// nav.get().selectionBySurface.sessions instead (mobile-shell/index.js and
// sessions-surface/index.js each read the field their own layout owns). Every test
// hook below that means "the session currently open in the UI" needs to resolve it
// the same layout-aware way, or it silently reads null on desktop.
function currentTestSessionId() {
  return isDesktop() ? (nav.get().selectionBySurface.sessions ?? null) : sessions.get().currentSessionId;
}

function wire() {
  // __outpostSendWs(msg): sends msg over the current session's WS. Returns true if sent.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostSendWs = (msg) => {
    const sid = currentTestSessionId();
    return sid ? sendOnSessionWs(sid, msg) : false;
  };

  // __outpostWaitWsMsg(predicate): resolves with the first incoming session WS
  // message for which predicate(msg) returns true. Attaches its own listener so
  // the app's dispatch handler is unaffected.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostWaitWsMsg = (predicate) => new Promise((resolve) => {
    const sid = currentTestSessionId();
    const ws = sid ? getSessionWs(sid) : null;
    if (!ws) { resolve(null); return; }
    const handler = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (predicate(msg)) {
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    ws.addEventListener('message', handler);
  });

  // __outpostGetState(): returns selected state fields. Lets Playwright poll JS
  // state directly without needing the settings sheet's segmented control to be
  // in the DOM.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostGetState = () => {
    const s = sessions.get();
    const sid = currentTestSessionId();
    // approvalMode/lastSeenSeq/replayGapCount live per-session-slice (multi-live
    // sessions, D2) on desktop — session-view's own renderModeChip() reads
    // slice.approvalMode, not the top-level mirror mobile-header.js uses. Reading
    // `s.approvalMode` directly here always silently read the mobile-only default.
    const slice = sid ? sessions.getSlice(sid) : null;
    return {
      approvalMode: isDesktop() ? (slice?.approvalMode ?? 'ask') : s.approvalMode,
      acceptEdits: settings.get().acceptEdits,
      defaultApprovalMode: settings.get().defaultApprovalMode,
      connState: hooks.appState?.connState,
      currentSessionId: sid,
      lastSeenSeq: slice?.lastSeenSeq ?? 0,
      replayGapCount: slice?.replayGapCount ?? 0,
    };
  };

  // __outpostForceCloseSessionWs(): close the session WS to drive the reconnect path.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostForceCloseSessionWs = () => {
    const sid = currentTestSessionId();
    if (sid) forceCloseFromTest(sid);
  };

  // __outpostSessionWsReadyState(): expose the live readyState so tests can wait for reconnect.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostSessionWsReadyState = () => {
    const sid = currentTestSessionId();
    return sid ? sessionWsReadyState(sid) : -1;
  };

  // __outpostSetLastSeenSeq(n): rewind lastSeenSeq to force a stale ?since= on next connect.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostSetLastSeenSeq = (n) => {
    const sid = currentTestSessionId();
    if (sid) sessions.for(sid).setLastSeenSeq(n);
  };

  // __outpostOpenSession({id, cwd, spawn?, base?}): open a session view. On
  // mobile, switches the single-view shell to view: 'session' via openSession.
  // On desktop, an explicit `cwd` means this is a brand-new session the daemon
  // doesn't know about yet — mirrors palette/index.js's launchSession()
  // (startSession + nav.select) rather than openSessionInWorkspaceTab, which
  // only resolves cwd/worktree info by looking the id up in sessions.projects
  // and silently no-ops it for a session that isn't there yet. Without `cwd`,
  // this opens an already-known session, so the workspace-tab lookup applies.
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostOpenSession = (opts) => {
    if (!opts?.id) throw new Error('__outpostOpenSession requires an id');
    if (isDesktop()) {
      if (opts.cwd) {
        startSession({
          id: opts.id,
          cwd: opts.cwd,
          spawnCwd: opts.cwd,
          spawnMode: opts.spawn,
          baseBranch: opts.base,
          fromTicketId: opts.fromTicketId ?? null,
        });
        nav.select('sessions', opts.id);
        return;
      }
      void hooks.openSessionInWorkspaceTab(opts.id, opts.fromTicketId ?? null);
      return;
    }
    hooks.openSession(opts.id, {
      cwd: opts.cwd,
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.fromTicketId ? { fromTicketId: opts.fromTicketId } : {}),
    });
  };

  // __outpostRefreshSessions(): re-fetches /api/sessions and re-renders the
  // list. Lets tests pull in a newly-registered project without doing a full
  // page reload (which would wipe state.approvalMode set optimistically in
  // list view before opening a session).
  // @ts-expect-error — intentional globalThis assignment for test infrastructure only
  globalThis.__outpostRefreshSessions = () => hooks.refreshSessions();
}
