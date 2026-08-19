import { statSync } from 'node:fs';
import { ClaudeProc } from './claude-proc.js';
import { EventLog } from './event-log.js';
import type { WebSocket } from 'ws';
import type { WorktreeManager } from '../git/worktree-manager.js';

export type SessionModel = 'sonnet' | 'opus' | 'haiku' | 'fable';

// Why the daemon itself is tearing a session down, threaded into daemon_proc_exit
// so the PWA can tell a graceful shutdown from a crash. 'idle' = reaped for
// inactivity (resumable on the next message); 'archived' = worktree/step gone.
// Absent on the exit event means the subprocess died on its own → a real crash.
export type SessionCloseReason = 'idle' | 'archived';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// Replay window sized to survive iOS backgrounding the PWA.
const DEFAULT_EVENT_LOG_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_LOG_MAX_EVENTS = 5000;

interface ActiveSession {
  id: string;
  proc: ClaudeProc;
  clients: Set<WebSocket>;
  eventLog: EventLog;
  idleTimer?: NodeJS.Timeout;
  // Set by close() right before the SIGTERM so onExit can flag the exit as
  // daemon-initiated (vs a crash). Cleared implicitly — a fresh spawn makes a new session.
  closeReason?: SessionCloseReason;
  lastActivity: number;
  // Forwarded via session_state so the PWA can anchor file paths before the next /api/sessions refresh.
  spawnCwd: string;
  // Ids we've already fired onSessionRegistered for (guards against re-firing every init message).
  registeredIds: Set<string>;
}

function isInitMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: string; subtype?: string };
  return m.type === 'system' && m.subtype === 'init';
}

export interface SessionManagerOpts {
  settingsPath: string;
  mcpConfigPath: string;
  daemonAuthSecret: string;
  daemonHost: string;
  hookPort: number;
  sessionStore: import('./session-store.js').SessionStore;
  worktreeManager?: WorktreeManager;
  onProcMessage?: (sessionId: string, msg: unknown) => void;
  // Tests shrink these to force replay_gap fallback paths without producing 5000 fixtures.
  eventLogMaxEvents?: number;
  eventLogMaxAgeMs?: number;
  // Fires on user_message forwarding so the Stop hook can gate push notifications on turn duration.
  onTurnStart?: (sessionId: string) => void;
  // Fires when a spawned claude subprocess exits. Used by the work orchestrator to detect
  // investigator/implementer/responder sessions that died without signalling completion.
  onSessionExit?: (sessionId: string, code: number | null) => void;
  // Fires the first time claude emits its system/init message (JSONL is on disk by then).
  // Daemon fans this out as a `sessions_changed` notification so the PWA can refresh its
  // list without waiting for a full reload.
  onSessionRegistered?: (sessionId: string) => void;
}

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  // Persists across the session's lifetime so getCwd() works after the process exits (hook may fire mid-session).
  private sessionCwds = new Map<string, string>();
  // In-memory; lost on daemon restart. Only set when a session is spawned via the
  // agent / skill edit endpoints. Used by GET /api/sessions to surface kind for
  // PWA-side filtering of the Projects view.
  private sessionKinds = new Map<string, import('./session-store.js').SessionKind>();

  tagKind(sessionId: string, kind: import('./session-store.js').SessionKind): void {
    this.sessionKinds.set(sessionId, kind);
  }

  getKind(sessionId: string): import('./session-store.js').SessionKind | undefined {
    return this.sessionKinds.get(sessionId);
  }

  constructor(private opts: SessionManagerOpts) {}

  // On resume, cwd is read from the session's JSONL; the opts.cwd argument is only honored for new sessions.
  // On worktree-creation failure the daemon emits daemon_error and closes the WS — no silent fallback to shared mode.
  attach(sessionId: string, ws: WebSocket, opts: { cwd?: string; spawnMode?: 'shared' | 'worktree'; baseBranch?: string; since?: number; model?: SessionModel } = {}): void {
    const since = opts.since ?? 0;
    // Sticky per-session: applied on this spawn and any later idle-reap respawn.
    if (opts.model) this.sessionModels.set(sessionId, opts.model);
    let s = this.active.get(sessionId);
    if (s) {
      this.attachClient(s, ws, since);
      return;
    }
    const existingWt = this.opts.worktreeManager?.get(sessionId);
    if (existingWt && !existingWt.archivedAt && existingWt.worktreePath) {
      s = this.spawn(sessionId, existingWt.worktreePath);
      this.attachClient(s, ws, since);
      return;
    }
    const known = this.opts.sessionStore.findSession(sessionId);
    if (known) {
      s = this.spawn(sessionId, known.cwd);
      this.attachClient(s, ws, since);
      return;
    }
    if (!opts.cwd || !opts.cwd.startsWith('/')) {
      ws.send(JSON.stringify({
        type: 'daemon_error',
        message: opts.cwd
          ? `cwd must be absolute: ${opts.cwd}`
          : 'cwd required for new session',
      }));
      ws.close();
      return;
    }
    try {
      if (!statSync(opts.cwd).isDirectory()) {
        ws.send(JSON.stringify({ type: 'daemon_error', message: `cwd is not a directory: ${opts.cwd}` }));
        ws.close();
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'daemon_error', message: `cwd does not exist: ${opts.cwd}` }));
      ws.close();
      return;
    }
    if (opts.spawnMode === 'worktree') {
      if (!this.opts.worktreeManager) {
        ws.send(JSON.stringify({ type: 'daemon_error', message: 'worktreeManager not configured but spawnMode=worktree requested' }));
        ws.close();
        return;
      }
      if (!opts.baseBranch) {
        ws.send(JSON.stringify({ type: 'daemon_error', message: 'baseBranch required for spawnMode=worktree' }));
        ws.close();
        return;
      }
      const cwd = opts.cwd;
      const baseBranch = opts.baseBranch;
      const wtMgr = this.opts.worktreeManager;
      void (async () => {
        let worktreePath: string;
        try {
          const rec = await wtMgr.create({ sessionId, projectCwd: cwd, baseBranch });
          worktreePath = rec.worktreePath;
        } catch (e) {
          ws.send(JSON.stringify({
            type: 'daemon_error',
            message: `worktree creation failed: ${(e as Error).message}`,
          }));
          ws.close();
          return;
        }
        const session = this.spawn(sessionId, worktreePath);
        this.attachClient(session, ws, since);
      })();
      return;
    }
    s = this.spawn(sessionId, opts.cwd);
    this.attachClient(s, ws, since);
  }

  // Replays missed events from `since`; if `since` predates earliestSeq, emits replay_gap so the client falls back to the HTTP transcript endpoint.
  private attachClient(s: ActiveSession, ws: WebSocket, since: number): void {
    s.clients.add(ws);
    this.cancelIdleTimer(s);

    // Protocol frame, no _seq. `working`/`workingSince` are the authoritative turn state:
    // the client's thinking strip is otherwise a pure guess derived from the event stream,
    // and a reconnect that lands past the replay window (or after a respawn, which resets
    // the log) never sees the turn's terminal event — leaving the strip spinning forever
    // on a session that finished minutes ago.
    ws.send(JSON.stringify({
      type: 'session_state',
      latestSeq: s.eventLog.latestSeq(),
      earliestSeq: s.eventLog.earliestSeq(),
      spawnCwd: s.spawnCwd,
      working: this.isWorking(s.id),
      workingSince: this.workingSince(s.id),
    }));

    if (since > 0 && since < s.eventLog.earliestSeq() - 1) {
      ws.send(JSON.stringify({
        type: 'replay_gap',
        from: since,
        earliest: s.eventLog.earliestSeq(),
      }));
    } else {
      for (const evt of s.eventLog.replayFrom(since)) {
        ws.send(JSON.stringify({ ...(evt.message as object), _seq: evt.seq }));
      }
    }

    ws.on('close', () => {
      s.clients.delete(ws);
      if (s.clients.size === 0) this.startIdleTimer(s);
    });
  }

  send(sessionId: string, message: unknown): void {
    const s = this.active.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not active`);
    s.lastActivity = Date.now();
    // Don't restamp a turn already in flight — a queued follow-up message would
    // otherwise reset the strip's elapsed clock mid-turn.
    if (!this.working.has(sessionId)) this.working.set(sessionId, Date.now());
    if (typeof message === 'object' && message !== null
        && (message as { type?: string }).type === 'user'
        && this.opts.onTurnStart) {
      this.opts.onTurnStart(sessionId);
    }
    s.proc.send(message);
  }

  // Routed through eventLog so reconnects replay daemon-originated messages (e.g. approval_mode changes) like any other event.
  broadcast(sessionId: string, message: unknown): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    const evt = s.eventLog.push(message);
    const payload = JSON.stringify({ ...(message as object), _seq: evt.seq });
    for (const ws of s.clients) ws.send(payload);
  }

  interrupt(sessionId: string): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    s.proc.interrupt();
  }

  // Lets allowlist lookups work before the session's JSONL is flushed (first tool call of a new session).
  getCwd(sessionId: string): string | undefined {
    return this.sessionCwds.get(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  // Cleared at the Stop hook: the assistant ended its turn. The proc may stay
  // alive (resume/replan), but it is no longer working.
  markTurnEnded(sessionId: string): void {
    this.working.delete(sessionId);
  }

  // Live subprocess AND currently mid-turn. This — not isActive — is the PWA
  // "Running" signal, so a finished-but-not-yet-reaped session reads as idle.
  isWorking(sessionId: string): boolean {
    return this.active.has(sessionId) && this.working.has(sessionId);
  }

  // When the in-flight turn started, or null if the session isn't working. Lets a
  // client that attached mid-turn show a truthful elapsed time instead of restarting
  // the clock at whatever moment it happened to reconnect.
  workingSince(sessionId: string): number | null {
    if (!this.isWorking(sessionId)) return null;
    return this.working.get(sessionId) ?? null;
  }

  // 'foreground' = live proc with a PWA client attached; 'background' = live proc,
  // no client (detached step sessions, backgrounded tabs); 'idle' = no proc.
  runState(sessionId: string): 'foreground' | 'background' | 'idle' {
    const s = this.active.get(sessionId);
    if (!s) return 'idle';
    return s.clients.size > 0 ? 'foreground' : 'background';
  }

  async close(sessionId: string, reason: SessionCloseReason = 'archived'): Promise<void> {
    const s = this.active.get(sessionId);
    if (!s) return;
    s.closeReason = reason;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    await s.proc.kill();
    for (const ws of s.clients) ws.close();
    this.active.delete(sessionId);
    this.working.delete(sessionId);
  }

  // Spawn a session with no WS attached. Orchestrator uses this for child sessions
  // (investigator, implementer, responder). Reachable via manager.send() for prompts,
  // observed via opts.onProcMessage. Idempotent — no-op if already active.
  spawnDetached(sessionId: string, cwd: string, extraEnv?: Record<string, string>, permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'): void {
    if (this.active.has(sessionId)) return;
    if (permissionMode) this.permissionModes.set(sessionId, permissionMode);
    const s = this.spawn(sessionId, cwd, extraEnv);
    this.working.set(sessionId, Date.now());
    // Detached sessions have no WS to trigger the idle timer on close — arm it at spawn
    // so a session that finishes its turn and is never approved/rejected gets reaped.
    // Subsequent PWA attach/detach cycles cancel and re-arm normally.
    this.startIdleTimer(s);
  }

  // Send a message; respawn first if idle-reaped. extraEnv is applied only on respawn.
  sendOrResume(sessionId: string, cwd: string, message: unknown, extraEnv?: Record<string, string>): void {
    if (!this.active.has(sessionId)) this.spawn(sessionId, cwd, extraEnv);
    this.send(sessionId, message);
  }

  private readonly permissionModes = new Map<string, 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'>();
  private readonly sessionModels = new Map<string, SessionModel>();
  // Sessions currently executing a turn → the ms timestamp that turn started. Set
  // when a session is spawned or sent a prompt; cleared at the Stop hook
  // (markTurnEnded) or when the proc goes away. This is the liveness signal for the
  // PWA Tracked "Running" bucket — a session kept alive after finishing its turn
  // (idle-reap is 15 min out) must NOT read as working.
  private readonly working = new Map<string, number>();

  private spawn(sessionId: string, cwd: string, extraEnv?: Record<string, string>): ActiveSession {
    this.sessionCwds.set(sessionId, cwd);
    const s: ActiveSession = {
      id: sessionId,
      clients: new Set(),
      eventLog: new EventLog({
        maxEvents: this.opts.eventLogMaxEvents ?? DEFAULT_EVENT_LOG_MAX_EVENTS,
        maxAgeMs: this.opts.eventLogMaxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS,
      }),
      lastActivity: Date.now(),
      proc: null!,
      spawnCwd: cwd,
      registeredIds: new Set(),
    };
    const mode = this.opts.sessionStore.findSession(sessionId) ? 'resume' : 'new';
    const permissionMode = this.permissionModes.get(sessionId);
    const model = this.sessionModels.get(sessionId);
    s.proc = new ClaudeProc({
      sessionId,
      mode,
      settingsPath: this.opts.settingsPath,
      mcpConfigPath: this.opts.mcpConfigPath,
      cwd,
      env: { DAEMON_AUTH: this.opts.daemonAuthSecret, DAEMON_HOST: this.opts.daemonHost, OUTPOST_HOOK_PORT: String(this.opts.hookPort), ...(extraEnv ?? {}) },
      ...(permissionMode ? { permissionMode } : {}),
      ...(model ? { model } : {}),
      onMessage: (msg) => {
        s.lastActivity = Date.now();
        this.handleProcInit(s, msg);
        const evt = s.eventLog.push(msg);
        const payload = JSON.stringify({ ...(msg as object), _seq: evt.seq });
        for (const ws of s.clients) ws.send(payload);
        this.opts.onProcMessage?.(s.id, msg);
        // system/init arrives after claude has written the JSONL for this session,
        // so the daemon can safely broadcast "the list on disk changed" now. Fires
        // once per (re-keyed) id: /clear rekeys s.id in handleProcInit and the next
        // init lands with the new id, so both get surfaced.
        if (isInitMessage(msg) && !s.registeredIds.has(s.id)) {
          s.registeredIds.add(s.id);
          this.opts.onSessionRegistered?.(s.id);
        }
      },
      onError: (errMsg) => {
        for (const ws of s.clients) {
          ws.send(JSON.stringify({ type: 'daemon_error', message: errMsg }));
        }
      },
      onExit: (code) => {
        const expected = s.closeReason;
        for (const ws of s.clients) {
          ws.send(JSON.stringify(expected
            ? { type: 'daemon_proc_exit', code, expected: true, reason: expected }
            : { type: 'daemon_proc_exit', code }));
        }
        this.active.delete(s.id);
        this.working.delete(s.id);
        this.opts.onSessionExit?.(s.id, code);
      },
    });
    this.active.set(sessionId, s);
    return s;
  }

  // /clear creates a fresh internal session_id while the proc keeps running. Re-key the
  // active session, tell attached clients to snap to the new id, and reset the event log
  // so reconnects to the new id don't replay pre-/clear history. The first init event
  // (where session_id matches s.id) is a no-op.
  private handleProcInit(s: ActiveSession, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string; subtype?: string; session_id?: string };
    if (m.type !== 'system' || m.subtype !== 'init') return;
    const newId = m.session_id;
    if (typeof newId !== 'string' || newId === s.id) return;
    const oldId = s.id;
    this.active.delete(oldId);
    s.id = newId;
    this.active.set(newId, s);
    const workingSince = this.working.get(oldId);
    if (workingSince !== undefined) {
      this.working.delete(oldId);
      this.working.set(newId, workingSince);
    }
    this.sessionCwds.set(newId, s.spawnCwd);
    const model = this.sessionModels.get(oldId);
    if (model) this.sessionModels.set(newId, model);
    this.opts.worktreeManager?.softArchive(oldId, newId, s.spawnCwd);
    s.eventLog = new EventLog({
      maxEvents: this.opts.eventLogMaxEvents ?? DEFAULT_EVENT_LOG_MAX_EVENTS,
      maxAgeMs: this.opts.eventLogMaxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS,
    });
    const renamedPayload = JSON.stringify({ type: 'daemon_session_renamed', oldId, newId });
    for (const ws of s.clients) ws.send(renamedPayload);
  }

  private startIdleTimer(s: ActiveSession): void {
    s.idleTimer = setTimeout(() => {
      // Never reap a session that's still mid-turn. A long subagent run keeps the
      // parent proc's stdout quiet — subagent activity surfaces via the PreToolUse
      // hook, which doesn't refresh lastActivity — so lastActivity goes stale while
      // real work continues. Reap only once the turn has ended (Stop hook →
      // markTurnEnded clears `working`).
      const since = Date.now() - s.lastActivity;
      if (since < IDLE_TIMEOUT_MS || this.working.has(s.id)) {
        this.startIdleTimer(s);
        return;
      }
      void this.close(s.id, 'idle');
    }, IDLE_TIMEOUT_MS);
  }

  private cancelIdleTimer(s: ActiveSession): void {
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
  }
}
