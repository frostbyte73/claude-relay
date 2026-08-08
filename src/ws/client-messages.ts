// Decode + dispatch for inbound frames on the two PWA-facing WebSocket connections
// (`/ws/notifications`, `/ws/sessions/:id`), wired up by daemon.ts's `server.onWebSocket`
// handler. Pulled out of daemon.ts because `ws.on('message', ...)` runs with no
// surrounding try/catch anywhere in the stack — a throw inside the listener propagates
// out of the EventEmitter and kills the process, so the decode step has to be provably
// safe, and that's easiest to pin down in an isolated, unit-testable function.
import { parseJsonObject } from '../routes/util.js';
import type { ApprovalMode } from '../permissions/approval-mode.js';

type RawFrame = Buffer | ArrayBuffer | Buffer[];

// ws's `RawData` union also allows `Buffer[]` (a binary frame's fragments, only handed
// back unmerged when the socket's `binaryType` is set to `'fragments'`) and `ArrayBuffer`
// (only when `binaryType` is `'arraybuffer'`). Neither is reachable today — this server
// never touches `.binaryType` on any WebSocket, and the PWA client always sends JSON as a
// text frame, which `ws` merges into one Buffer before emitting 'message' regardless of
// binaryType. Handled anyway: `String(rawArray)` would join fragments with a literal
// comma and decode each one to UTF-8 independently, mangling any multi-byte character
// split across a fragment boundary.
function frameToString(raw: RawFrame): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

// `JSON.parse('null')` doesn't throw — it returns `null`, and dereferencing `.type` on
// that throws a TypeError with nothing downstream to catch it (a bare `try/catch` around
// the `JSON.parse` call only guards the parse itself). `'42'`/`'"str"'`/`'true'`/`'[]'`
// don't crash the same way — primitives and arrays tolerate `.type` access via
// autoboxing — but reusing the same plain-object guard the HTTP surfaces use
// (routes/util.ts's `parseJsonObject`) makes every non-object frame body a defined
// no-op rather than an accident of which JS values happen to support property access.
export function parseWsFrame(raw: RawFrame): Record<string, unknown> | null {
  return parseJsonObject(frameToString(raw));
}

interface ApprovalDecideTarget {
  decide(approvalId: string, decision: { allow: boolean; reason?: string }): void;
}

export interface NotificationsMessageDeps {
  queue: ApprovalDecideTarget;
}

// `/ws/notifications` accepts `approval_decide` too: that connection survives iOS
// backgrounding when the session WS often doesn't.
export function handleNotificationsMessage(raw: RawFrame, deps: NotificationsMessageDeps): void {
  const msg = parseWsFrame(raw);
  if (!msg) return;
  if (msg.type === 'approval_decide') {
    const { approvalId, decision, reason } = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
    deps.queue.decide(approvalId, { allow: decision === 'allow', reason });
  }
}

interface SessionMessageTarget {
  send(sessionId: string, message: unknown): void;
  interrupt(sessionId: string): void;
  broadcast(sessionId: string, message: unknown): void;
}

interface ApprovalModeTarget {
  set(sessionId: string, mode: ApprovalMode): void; // throws on an unrecognized mode
}

export interface SessionMessageDeps {
  queue: ApprovalDecideTarget;
  manager: SessionMessageTarget;
  modes: ApprovalModeTarget;
  log?: (line: string) => void;
}

export function handleSessionMessage(raw: RawFrame, sessionId: string, deps: SessionMessageDeps): void {
  const msg = parseWsFrame(raw);
  if (!msg) return;
  const log = deps.log ?? (() => {});
  if (msg.type === 'user_message') {
    const { content } = msg as { content: string };
    // SessionManager.send throws when the session isn't in `active` — which a client
    // can trigger any time by typing into a session whose subprocess has since exited
    // (a daemon restart drops every active entry while the PWA keeps showing them).
    // Unguarded, that throw unwinds through ws.on('message') and kills the daemon,
    // which drops every other session too. Report it, don't die.
    try {
      deps.manager.send(sessionId, { type: 'user', message: { role: 'user', content } });
    } catch (e) {
      log(`[api] user_message to ${sessionId.slice(0, 8)} failed: ${(e as Error).message}`);
    }
  } else if (msg.type === 'approval_decide') {
    const { approvalId, decision, reason } = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
    deps.queue.decide(approvalId, { allow: decision === 'allow', reason });
  } else if (msg.type === 'interrupt') {
    log(`[api] interrupt requested for session ${sessionId.slice(0, 8)}`);
    try {
      deps.manager.interrupt(sessionId);
    } catch (e) {
      log(`[api] interrupt for ${sessionId.slice(0, 8)} failed: ${(e as Error).message}`);
    }
  } else if (msg.type === 'approval_mode_set') {
    const { mode } = msg as { mode?: string };
    if (typeof mode === 'string') {
      try {
        deps.modes.set(sessionId, mode as ApprovalMode);
        deps.manager.broadcast(sessionId, { type: 'approval_mode', sessionId, mode });
        log(`[api] approval mode for ${sessionId.slice(0, 8)} → ${mode}`);
      } catch {
        // Invalid mode — ignore.
      }
    }
  }
}
