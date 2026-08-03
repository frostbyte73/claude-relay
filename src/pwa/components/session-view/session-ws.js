// Per-session WebSocket manager. Sole owner of `/ws/sessions/<id>` sockets.
// Each open session-view holds a reference here — the manager de-dupes by
// session id, so mounting the same session in two panes doesn't open two
// WebSockets. Mobile enters via session-view too, so a session has at most one
// live WS regardless of layout.
//
// The connection stays open across mount/unmount cycles until refCount hits 0,
// then arms a grace timer (see CLOSE_GRACE_MS) so quick tab-switches reuse the
// socket instead of thrashing.
//
// Messages route through app.js's handleWsMessage, passing the session id as
// the second argument so mutations land in the correct slice. Connection state
// is published to state/conn.js so the UI's indicator and disconnect banner
// stay in sync without polling.

import { sessions } from '../../state/sessions.js';
import { conn } from '../../state/conn.js';
import { catchUpFromDisk, openSession, refreshSessions } from '../../app-bridge.js';

const BACKOFF_MS = 750;
const MAX_BACKOFF_MULT = 6;
const FAIL_THRESHOLD = 3;

// Grace period between the last view unmounting and the WS actually closing.
// Tab switches unmount the outgoing view before mounting the incoming one, so
// a naive close-on-zero-refcount policy would kill the socket every time the
// user hops tabs — and the background session, meanwhile, wouldn't receive
// live updates while off-screen. The grace lets those quick unmount/remount
// pairs reuse the same connection AND keeps the WS alive while the session
// is genuinely just "not visible right now". Set to 60s: long enough to
// cover any reasonable UI transition, short enough that a session the user
// truly stopped attending drops after a minute.
const CLOSE_GRACE_MS = 60_000;

// Map<sessionId, ConnInfo>. ConnInfo:
//   ws:         WebSocket
//   refCount:   number  (view mounts referencing this session)
//   retries:    number  (backoff counter)
//   timer:      number|null (setTimeout handle for next retry)
//   closingIntent: boolean  (true → don't reconnect on close)
//   pendingMode: string|null (approval mode picked while the socket wasn't OPEN,
//                             flushed on the next `onopen` so the change isn't dropped)
const conns = new Map();

// Message handler installed by app.js at boot. Session-ws routes non-protocol
// frames through it, tagged with the session id.
let _handleWsMessage = null;
export function _installWsHandler(fn) { _handleWsMessage = fn; }

// Recompute the aggregate session-WS conn state from every live connection.
// 'failed' beats 'reconnecting' beats 'connected' beats 'idle'.
function republishConn() {
  let worst = 'idle';
  for (const info of conns.values()) {
    if (info.ws && info.ws.readyState === WebSocket.OPEN) {
      if (worst === 'idle') worst = 'connected';
      continue;
    }
    if (info.retries >= FAIL_THRESHOLD) { worst = 'failed'; break; }
    if (worst !== 'failed') worst = 'reconnecting';
  }
  conn.setSession(worst);
}

function wsUrl(id, sinceSeq, spawn) {
  const params = new URLSearchParams();
  params.set('since', String(sinceSeq | 0));
  // Spawn hints are only meaningful on the FIRST attach — the daemon ignores
  // them if the session already exists. We include them on every connect so
  // that a reconnect racing with a fresh spawn still lands correctly.
  if (spawn?.cwd)         params.set('cwd', spawn.cwd);
  if (spawn?.spawnMode)   params.set('spawn', spawn.spawnMode);
  if (spawn?.baseBranch)  params.set('base', spawn.baseBranch);
  if (spawn?.model)       params.set('model', spawn.model);
  if (spawn?.approvalMode) params.set('mode', spawn.approvalMode);
  const q = params.toString();
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws/sessions/${id}${q ? `?${q}` : ''}`;
}

function connect(id) {
  const info = conns.get(id);
  if (!info) return;
  if (info.timer) { clearTimeout(info.timer); info.timer = null; }
  const slice = sessions.getSlice(id);
  const since = slice?.lastSeenSeq ?? 0;
  const ws = new WebSocket(wsUrl(id, since, info.spawn));
  info.ws = ws;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    // Track per-slice lastSeenSeq so a reconnect asks for `since` correctly.
    // handleWsMessage does the actual per-slice mutation on non-protocol frames.
    if (typeof msg._seq === 'number') {
      const sl = sessions.getSlice(id);
      if (!sl || msg._seq > sl.lastSeenSeq) sessions.for(id).setLastSeenSeq(msg._seq);
    }
    if (msg.type === 'session_state') {
      // spawnCwd lets first tool tile render project-relative paths before /api/sessions refreshes.
      if (typeof msg.spawnCwd === 'string' && msg.spawnCwd.length > 0
          && id === sessions.get().currentSessionId) {
        sessions.set((s) => ({ ...s, currentSessionSpawnCwd: msg.spawnCwd }));
      }
      return;
    }
    if (msg.type === 'replay_gap') {
      sessions.for(id).incrReplayGap();
      catchUpFromDisk(id);
      const sl2 = sessions.getSlice(id);
      const nextSeq = Math.max(sl2?.lastSeenSeq ?? 0, (msg.earliest ?? 1) - 1);
      sessions.for(id).setLastSeenSeq(nextSeq);
      return;
    }
    if (msg.type === 'daemon_session_renamed') {
      // /clear spawned a new internal session_id; if this WS's session was the
      // mobile-current one, snap the shell onto the new id so the user stays
      // on the live subprocess. Desktop tabs are per-id so they won't follow
      // this rename yet — that's a separate concern.
      if (id === sessions.get().currentSessionId && typeof msg.newId === 'string') {
        openSession({ id: msg.newId });
        refreshSessions();
      }
      return;
    }
    _handleWsMessage?.(msg, id);
  };
  ws.onopen = () => {
    info.retries = 0;
    republishConn();
    sessions.for(id).markSessionWsHasConnected();
    // Flush a mode change queued while the socket was connecting/reconnecting
    // (sendApprovalModeSet couldn't send it then). The daemon echoes it back as
    // `approval_mode`, reconciling the optimistic UI update.
    if (info.pendingMode) {
      const mode = info.pendingMode;
      info.pendingMode = null;
      try { ws.send(JSON.stringify({ type: 'approval_mode_set', mode })); } catch { /* onclose retries */ }
    }
    // Flush user messages queued while the socket was down — reconnectAndSend
    // stashes them when the user sends into an interrupted/exited session.
    // Ordering preserved; the daemon replays them to the resumed subprocess.
    if (info.queued?.length) {
      const pending = info.queued;
      info.queued = [];
      for (const text of pending) {
        try { ws.send(JSON.stringify({ type: 'user_message', content: text })); }
        catch { (info.queued ||= []).push(text); /* onclose retries */ }
      }
    }
    // Re-run disk catch-up on every open so gaps from suspend/reconnect fill in.
    catchUpFromDisk(id);
  };
  ws.onclose = () => {
    if (conns.get(id) !== info) return;
    info.ws = null;
    if (info.closingIntent) {
      conns.delete(id);
      republishConn();
      return;
    }
    info.retries += 1;
    republishConn();
    const delay = BACKOFF_MS * Math.min(info.retries, MAX_BACKOFF_MULT);
    info.timer = setTimeout(() => { if (conns.get(id) === info) connect(id); }, delay);
  };
  ws.onerror = () => { /* close handler retries */ };
}

// Ensure a WS is open for `id`. Increments the view refcount and cancels any
// pending grace-period close so quick unmount/remount cycles reuse the socket.
export function openSessionWs(id, spawn) {
  if (!id) return;
  let info = conns.get(id);
  if (info) {
    info.refCount += 1;
    // Later views may know spawn hints the first view didn't; keep whichever
    // one has them so reconnects during first-attach can still carry the info.
    if (spawn && !info.spawn) info.spawn = spawn;
    if (info.graceTimer) { clearTimeout(info.graceTimer); info.graceTimer = null; }
    return;
  }
  info = { ws: null, refCount: 1, retries: 0, timer: null, graceTimer: null, closingIntent: false, spawn: spawn || null, pendingMode: null };
  conns.set(id, info);
  connect(id);
}

// Decrement the view refcount. When it hits zero, arm a grace timer instead of
// closing immediately — see CLOSE_GRACE_MS. If a view reopens within the grace
// window, openSessionWs cancels the timer and the socket keeps its state.
export function closeSessionWs(id) {
  if (!id) return;
  const info = conns.get(id);
  if (!info) return;
  info.refCount = Math.max(0, info.refCount - 1);
  if (info.refCount > 0) return;
  // Clear any prior grace timer so we always arm from "now".
  if (info.graceTimer) clearTimeout(info.graceTimer);
  info.graceTimer = setTimeout(() => {
    // Refcount could have gone back up between then and now — recheck.
    if (info.refCount > 0) { info.graceTimer = null; return; }
    info.closingIntent = true;
    if (info.timer) { clearTimeout(info.timer); info.timer = null; }
    if (info.ws && info.ws.readyState === WebSocket.OPEN) info.ws.close();
    else conns.delete(id);
  }, CLOSE_GRACE_MS);
}

// Force-close a session's WS regardless of refcount. Used when the daemon
// reports the subprocess exited (runState → inactive) — no point keeping the
// socket to an already-dead session alive.
export function forceCloseSessionWs(id) {
  if (!id) return;
  const info = conns.get(id);
  if (!info) return;
  info.refCount = 0;
  info.closingIntent = true;
  if (info.graceTimer) { clearTimeout(info.graceTimer); info.graceTimer = null; }
  if (info.timer) { clearTimeout(info.timer); info.timer = null; }
  if (info.ws && info.ws.readyState === WebSocket.OPEN) info.ws.close();
  else conns.delete(id);
}

// Send a user_message on the session's WS. Returns true if the send fired,
// false if the socket isn't open (caller can toast + keep composer text so the
// user can retry). Does NOT append to the transcript — that's the caller's job
// (session-view appends first for immediate feedback, then sends).
export function sendUserMessage(id, text) {
  const info = conns.get(id);
  if (!info?.ws || info.ws.readyState !== WebSocket.OPEN) return false;
  info.ws.send(JSON.stringify({ type: 'user_message', content: text }));
  return true;
}

// Send a user_message, reconnecting the session first if its socket is down.
// Used when the user types into an interrupted or exited session: the WS was
// force-closed (see forceCloseSessionWs) so `sendUserMessage` would drop the
// message. Re-opening the socket makes the daemon respawn the subprocess in
// `resume` mode (session-manager.attach → spawn), and the message is queued to
// flush the moment the socket opens. Returns true if it sent immediately,
// false if it was queued for the reconnect.
export function reconnectAndSend(id, text) {
  if (!id) return false;
  let info = conns.get(id);
  if (!info) {
    // The conn was torn down by forceCloseSessionWs — the mounted view lost its
    // refcount with it. Re-open with a fresh ref for the still-mounted view;
    // openSessionWs kicks off connect().
    openSessionWs(id);
    info = conns.get(id);
    if (!info) return false;
  } else if (info.ws && info.ws.readyState === WebSocket.OPEN) {
    info.ws.send(JSON.stringify({ type: 'user_message', content: text }));
    return true;
  } else {
    // A retry is backing off (or the socket is mid-close). Cancel closing
    // intent and kick a fresh connect now instead of waiting out the backoff.
    info.closingIntent = false;
    info.retries = 0;
    if (info.timer) { clearTimeout(info.timer); info.timer = null; }
    if (!info.ws || info.ws.readyState === WebSocket.CLOSED) connect(id);
  }
  (info.queued ||= []).push(text);
  republishConn();
  return false;
}

// Change the session's approval mode server-side. Daemon broadcasts the new
// mode back via `approval_mode`, which the WS handler routes into the slice.
// If the socket isn't OPEN yet (initial connect, reconnect backoff) the change
// is queued on the ConnInfo and flushed by `onopen` rather than silently
// dropped — callers update the UI optimistically, so a dropped send would
// leave the daemon out of sync with what the user sees. Returns false only
// when there's no connection entry at all (nothing to queue against).
export function sendApprovalModeSet(id, mode) {
  const info = conns.get(id);
  if (!info) return false;
  if (info.ws && info.ws.readyState === WebSocket.OPEN) {
    info.ws.send(JSON.stringify({ type: 'approval_mode_set', mode }));
    info.pendingMode = null;
    return true;
  }
  info.pendingMode = mode;
  return true;
}

// SIGINT the claude subprocess for `id`. Daemon acks via daemon_proc_exit; the
// caller sets expectedInterrupt on the slice first so that handler silently
// resumes instead of surfacing an error tile.
export function sendInterrupt(id) {
  const info = conns.get(id);
  if (!info?.ws || info.ws.readyState !== WebSocket.OPEN) return false;
  info.ws.send(JSON.stringify({ type: 'interrupt' }));
  return true;
}

// Send an arbitrary frame on the session's WS. Used by sendApprovalDecide's
// fallback path and by the __outpostSendWs test hook. Accepts a pre-serialized
// string or a plain object (in which case JSON.stringify runs here).
export function sendOnSessionWs(id, msg) {
  const info = conns.get(id);
  if (!info?.ws || info.ws.readyState !== WebSocket.OPEN) return false;
  info.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  return true;
}

// Force-reconnect every session WS. Called by the user-facing "reconnect"
// button. Zeroes retry counters so backoff restarts from base, closes each
// live socket, and lets the close handler schedule the immediate retry.
export function forceReconnectAll() {
  for (const info of conns.values()) {
    info.retries = 0;
    if (info.timer) { clearTimeout(info.timer); info.timer = null; }
    if (info.ws && info.ws.readyState === WebSocket.OPEN) info.ws.close();
  }
  republishConn();
}

// Diagnostic used by the test hook __outpostSessionWsReadyState: returns the
// readyState of a specific session's socket, or -1 if none.
export function sessionWsReadyState(id) {
  const info = conns.get(id);
  return info?.ws?.readyState ?? -1;
}

// Force-close a session's WS via the test hook __outpostForceCloseSessionWs.
// Fires onclose which triggers backoff reconnect — used by Playwright to
// exercise the reconnect path deterministically.
export function forceCloseFromTest(id) {
  const info = conns.get(id);
  if (info?.ws && info.ws.readyState === WebSocket.OPEN) info.ws.close();
}

// Return the raw WebSocket for a session id (or null). Used by the
// __outpostWaitWsMsg test hook to attach a one-shot message listener.
export function getSessionWs(id) {
  return conns.get(id)?.ws ?? null;
}

// Diagnostic: exposed for debugging in the browser console.
export function _connsSnapshot() {
  const out = {};
  for (const [id, info] of conns) {
    out[id] = {
      refCount: info.refCount,
      retries: info.retries,
      readyState: info.ws?.readyState ?? -1,
      closingIntent: info.closingIntent,
    };
  }
  return out;
}
