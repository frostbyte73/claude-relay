import { readdirSync, readFileSync, statSync, unlinkSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { LineParser } from './stream-json.js';
import type { ProjectRegistry } from '../storage/project-registry.js';
import type { WorktreeManager, WorktreeRecord } from '../git/worktree-manager.js';

export type SessionKind = 'normal' | 'action-edit' | 'skill-edit';

export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  path: string;
  worktreePath?: string;
  worktreeBranch?: string;
  archived?: boolean;
  // Set when this session was spawned for action / skill authoring; lets the
  // Projects view filter them out. Tracked in-memory on SessionManager; lost on
  // daemon restart (acceptable — these are short-lived sessions).
  kind?: SessionKind;
  // Set from the durable session-meta sidecar for any session Outpost spawned to
  // run an action on the user's behalf (orchestrator, step, or action/skill edit).
  // 'action' vs a plain interactive 'session' drives the sessions-list tabs + badge.
  sessionClass?: 'action' | 'session';
  // The action a `sessionClass: 'action'` session runs (e.g. `meta.orchestrate`,
  // `code.implement`, `meta.build-action`), surfaced as the list card's badge.
  actionLabel?: string;
  // Live proc state, annotated by GET /api/sessions from SessionManager.
  runState?: 'foreground' | 'background' | 'idle';
}

export interface ProjectInfo {
  projectDir: string;
  cwd: string;
  lastModified: number;
  sessions: SessionInfo[];
  isGitRepo: boolean;
  source: 'claude' | 'registry' | 'both';
  // Populated only when the user has run a `[1m]` model variant; lets the PWA pick 1M over the 200k default.
  contextWindowSize?: number;
}

export interface SubagentCompletion {
  status: string;
  summary?: string;
  result?: string;
  completedAt: number;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  description?: string;
  parentToolUseId?: string;
  firstSeenAt: number;
  entries: TranscriptMessage[];
  completion: SubagentCompletion | null;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text: string;
  // Owning assistant message's API id (`msg_*`); used by the PWA to dedupe WS replay vs disk load.
  msgId?: string;
  // Raw tool_use input alongside rendered string so the PWA can rebuild UI without re-parsing `text`.
  toolName?: string;
  toolInput?: unknown;
  // `toolu_*` id linking a tool_use entry to its tool_result; used to resolve TaskCreate → task id.
  toolUseId?: string;
  // Rejection status back-annotated from the paired user tool_result's `toolUseResult` sidecar; keeps
  // the rejection frame visible after a disk-side transcript rebuild.
  decision?: 'allow' | 'deny';
  rejectReason?: string;
}

// Tools whose tool_result we surface (instead of dropping) because the PWA renders the pair specially.
const PAIRED_TOOL_NAMES = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'AskUserQuestion',
]);

// Skip Claude Code's synthetic "user" messages (command echoes, reminders, task-notifications, skill loadouts).
function isSystemInjection(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<local-command-') ||
    t.startsWith('<command-') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<bash-input>') ||
    t.startsWith('<bash-stdout>') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('Base directory for this skill:') ||
    t.startsWith('Caveat: ');
}

// Extract <command-args> from a slash-command invocation so the transcript shows what the human typed.
// Returns null if not a slash-command invocation.
function rewriteSlashCommandInvocation(text: string): string | null {
  if (!text.trimStart().startsWith('<command-message>')) return null;
  const m = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  if (!m) return null;
  const args = m[1]!.trim();
  return args.length > 0 ? args : null;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface RawSessionRecord {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | RawContentBlock[];
  };
}

// Chunked scan that bails as soon as both title sources are found; avoids parsing multi-MB session files.
function scanTitleSources(path: string): { summary?: string; firstUserMsg?: string } {
  const fd = openSync(path, 'r');
  try {
    const CHUNK = 16 * 1024;
    const MAX = 256 * 1024; // bound so a freak file can't pin the CPU
    const buf = Buffer.alloc(CHUNK);
    let leftover = '';
    let offset = 0;
    let summary: string | undefined;
    let firstUserMsg: string | undefined;

    while (offset < MAX) {
      const bytes = readSync(fd, buf, 0, CHUNK, offset);
      if (bytes === 0) break;
      offset += bytes;
      const text = leftover + buf.subarray(0, bytes).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      const consumable = lastNl === -1 ? text : text.slice(0, lastNl);
      leftover = lastNl === -1 ? text : text.slice(lastNl + 1);

      for (const line of consumable.split('\n')) {
        if (!line) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        const o = obj as { type?: string; summary?: string; message?: { content?: string | unknown[] } };
        if (o.type === 'summary' && typeof o.summary === 'string' && !summary) summary = o.summary;
        if (o.type === 'user' && !firstUserMsg) {
          const c = o.message?.content;
          let t: string | undefined;
          if (typeof c === 'string') t = c;
          else if (Array.isArray(c)) {
            const tb = c.find((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text');
            if (tb) t = tb.text;
          }
          if (t) {
            // For slash-command messages the args ARE the user's intent — use them as the title source.
            const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
            const argsText = argsMatch ? argsMatch[1]?.trim() : '';
            if (argsText) {
              firstUserMsg = argsText;
            } else if (!isSystemInjection(t)) {
              firstUserMsg = t;
            }
          }
        }
        if (summary && firstUserMsg) return { summary, firstUserMsg };
      }
      if (bytes < CHUNK) break;
    }
    return { summary, firstUserMsg };
  } finally {
    closeSync(fd);
  }
}

function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  // Order matters — longest/most-specific patterns first so partial-strip doesn't leave a stub.
  const fillers: RegExp[] = [
    /^(?:hi|hey|hello)[,!.]?\s+(?:there[,!]?\s+)?/i,
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:help\s+(?:me\s+)?(?:to\s+|with\s+)?)?(?:try\s+to\s+|maybe\s+)?/i,
    /^please\s+(?:can\s+you\s+)?/i,
    /^let'?s\s+/i,
    /^i\s+(?:want|need|would\s+like|am\s+trying|'m\s+trying)\s+(?:to|you\s+to)\s+/i,
    /^i'?d\s+like\s+(?:to|you\s+to)\s+/i,
    /^help\s+me\s+(?:to\s+|with\s+)?/i,
    /^help\s+(?:with\s+|me\s+)?/i,
    /^how\s+do\s+(?:i|we|you)\s+/i,
    /^tell\s+me\s+(?:about\s+|how\s+|why\s+)?/i,
    /^what'?s\s+(?:going\s+on|happening|up)\s+(?:with|in|on)\s+/i,
    /^what\s+is\s+(?:going\s+on\s+(?:with|in|on)\s+)?/i,
    /^why\s+is\s+/i,
    /^look\s+(?:in)?to\s+/i,
    /^check\s+(?:on\s+|out\s+)?/i,
    /^investigate\s+/i,
    /^do\s+(?:a\s+|the\s+|you\s+)/i,
    /^make\s+(?:me\s+|a\s+)?/i,
  ];
  // Chain strips; bounded by filler count so a pathological pattern can't loop.
  for (let pass = 0; pass < fillers.length; pass++) {
    let changed = false;
    for (const re of fillers) {
      const stripped = t.replace(re, '');
      if (stripped !== t && stripped.length > 0) { t = stripped; changed = true; break; }
    }
    if (!changed) break;
  }
  if (t && /[a-z]/.test(t.charAt(0))) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
  }
  return t || 'Untitled session';
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as RawContentBlock).type === 'text') {
      const t = (b as RawContentBlock).text;
      if (typeof t === 'string') out.push(t);
    }
  }
  return out.join('\n');
}

// Claude Code writes `"toolUseResult": "User rejected tool use"` on the user-side tool_result line
// that pairs the rejected tool_use. We collect those tool_use_ids so a later back-annotation pass
// can stamp the matching tool_use entries — otherwise disk reloads wipe the rejection frame the
// PWA had rendered in-memory. The rejection reason itself isn't in the JSONL, so it's left empty.
function collectRejectedToolUseIds(obj: unknown, out: Set<string>): void {
  const o = obj as RawSessionRecord & { toolUseResult?: unknown };
  if (o.type !== 'user' || o.toolUseResult !== 'User rejected tool use') return;
  const content = o.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') out.add(b.tool_use_id);
  }
}

function stampRejections(messages: TranscriptMessage[], rejectedIds: Set<string>): TranscriptMessage[] {
  if (rejectedIds.size === 0) return messages;
  return messages.map((m) =>
    m.role === 'tool_use' && m.toolUseId && rejectedIds.has(m.toolUseId)
      ? { ...m, decision: 'deny' as const }
      : m,
  );
}

function extractTranscriptMessages(obj: unknown, taskToolUseIds: Set<string>): TranscriptMessage[] {
  const o = obj as RawSessionRecord;
  if (o.type !== 'user' && o.type !== 'assistant') return [];
  const content = o.message?.content;
  const msgId = o.type === 'assistant' ? o.message?.id : undefined;

  if (typeof content === 'string') {
    if (o.type === 'user') {
      const rewritten = rewriteSlashCommandInvocation(content);
      if (rewritten !== null) return [{ role: 'user', text: rewritten, ...(msgId ? { msgId } : {}) }];
      if (isSystemInjection(content)) return [];
    }
    return [{ role: o.type, text: content, ...(msgId ? { msgId } : {}) }];
  }
  if (!Array.isArray(content)) return [];

  const parts: TranscriptMessage[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      if (o.type === 'user') {
        const rewritten = rewriteSlashCommandInvocation(b.text);
        if (rewritten !== null) {
          parts.push({ role: 'user', text: rewritten, ...(msgId ? { msgId } : {}) });
          continue;
        }
        if (isSystemInjection(b.text)) continue;
      }
      parts.push({ role: o.type, text: b.text, ...(msgId ? { msgId } : {}) });
    } else if (b.type === 'tool_use' && o.type === 'assistant') {
      const name = typeof b.name === 'string' ? b.name : 'tool';
      const input = b.input ?? {};
      const inputStr = JSON.stringify(input).slice(0, 240);
      const useId = typeof b.id === 'string' ? b.id : undefined;
      if (useId && PAIRED_TOOL_NAMES.has(name)) taskToolUseIds.add(useId);
      parts.push({
        role: 'tool_use',
        text: `${name}(${inputStr})`,
        toolName: name,
        toolInput: input,
        ...(useId ? { toolUseId: useId } : {}),
        ...(msgId ? { msgId } : {}),
      });
    } else if (b.type === 'tool_result' && o.type === 'user') {
      // Skip routine tool_results; only keep ones paired with a Task* tool_use (needed for the assigned task id).
      const useId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
      if (!useId || !taskToolUseIds.has(useId)) continue;
      const text = flattenToolResultContent(b.content);
      if (!text) continue;
      parts.push({ role: 'tool_result', text, toolUseId: useId });
    }
  }
  return parts;
}

// Returns agent_id → completion. Handles both async (<task-notification> XML) and sync (toolUseResult sidecar) shapes.
function readTaskNotifications(parentJsonlPath: string): Map<string, SubagentCompletion> {
  const completions = new Map<string, SubagentCompletion>();
  let content: string;
  try {
    content = readFileSync(parentJsonlPath, 'utf8');
  } catch {
    return completions;
  }
  const parser = new LineParser();
  parser.onLine = (obj) => {
    const o = obj as RawSessionRecord & {
      timestamp?: string;
      toolUseResult?: { status?: string; agentId?: string; content?: unknown };
    };
    if (o.type !== 'user') return;
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const completedAt = Number.isNaN(ts) ? Date.now() : ts;

    // Sync shape: only stamp on terminal status; the same record also appears with 'async_launched' at dispatch.
    const tur = o.toolUseResult;
    if (tur && typeof tur.agentId === 'string' && tur.status && tur.status !== 'async_launched') {
      const completion: SubagentCompletion = { status: tur.status, completedAt };
      const summary = firstTextOfToolResult(o.message?.content);
      if (summary) completion.summary = summary;
      completions.set(tur.agentId, completion);
      return;
    }

    const c = o.message?.content;
    if (typeof c !== 'string') return;
    if (!c.trimStart().startsWith('<task-notification>')) return;
    const get = (tag: string): string | undefined => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const m = re.exec(c);
      return m ? m[1]!.trim() : undefined;
    };
    const taskId = get('task-id');
    if (!taskId) return;
    const completion: SubagentCompletion = {
      status: get('status') ?? 'completed',
      completedAt,
    };
    const summary = get('summary');
    if (summary) completion.summary = summary;
    const result = get('result');
    if (result) completion.result = result;
    completions.set(taskId, completion);
  };
  parser.write(content);
  return completions;
}

// Agent replies are two text blocks: [reply, metadata]. Return the first (reply); skip the metadata block.
function firstTextOfToolResult(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = block as RawContentBlock;
    if (b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
    for (const inner of b.content) {
      const t = inner as RawContentBlock;
      if (t.type === 'text' && typeof t.text === 'string' && !t.text.startsWith('agentId:')) {
        return t.text.trim();
      }
    }
  }
  return undefined;
}

// Tail-scan for the newest user/assistant timestamp; sort key must be real activity, not mtime —
// `claude --resume` appends non-content lines that bump mtime without representing a new turn.
function lastMessageTimestampMs(path: string, size: number): number | null {
  const TAIL_BYTES = 64 * 1024;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  if (len <= 0) return null;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // Drop leading partial record if we started mid-line.
    const firstNl = start === 0 ? -1 : text.indexOf('\n');
    const usable = firstNl === -1 ? text : text.slice(firstNl + 1);
    const lines = usable.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      const o = obj as { type?: string; timestamp?: string };
      if ((o.type !== 'user' && o.type !== 'assistant') || typeof o.timestamp !== 'string') continue;
      const ms = Date.parse(o.timestamp);
      if (Number.isFinite(ms)) return ms;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function firstCwdInJsonl(path: string): string | null {
  const fd = openSync(path, 'r');
  try {
    const CHUNK = 16 * 1024;
    const MAX = 256 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let leftover = '';
    let offset = 0;

    while (offset < MAX) {
      const bytes = readSync(fd, buf, 0, CHUNK, offset);
      if (bytes === 0) break;
      offset += bytes;
      const text = leftover + buf.subarray(0, bytes).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      const consumable = lastNl === -1 ? text : text.slice(0, lastNl);
      leftover = lastNl === -1 ? text : text.slice(lastNl + 1);

      for (const line of consumable.split('\n')) {
        if (!line) continue;
        try {
          const o = JSON.parse(line) as { cwd?: unknown };
          if (typeof o.cwd === 'string' && o.cwd.length > 0) return o.cwd;
        } catch { /* one bad record shouldn't poison the read */ }
      }
      if (bytes < CHUNK) break;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

// Sessions older than this with no active worktree are stamped archived at read time.
// Active worktrees are exempt so long-running branches don't vanish at the 7d mark.
const AUTO_ARCHIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function stampAutoArchived(projects: ProjectInfo[]): void {
  const ageCutoff = Date.now() - AUTO_ARCHIVE_WINDOW_MS;
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i]!;
      if (s.archived) continue;
      if (s.lastModified < ageCutoff && !s.worktreePath) {
        p.sessions[i] = { ...s, archived: true };
      }
    }
  }
}

export class SessionStore {
  private readonly root: string;
  private readonly registry: ProjectRegistry | undefined;
  private readonly worktreeManager: WorktreeManager | undefined;
  private readonly sessionMetaDir: string | undefined;
  private cwdCache = new Map<string, { cwd: string; mtime: number }>();
  // JSONL is append-only, so size unchanged ⇒ cached timestamp still valid.
  private lastMsgTsCache = new Map<string, { size: number; ts: number | null }>();
  // Never invalidated within a daemon lifetime — restart picks up new git inits.
  private gitRepoCache = new Map<string, boolean>();

  constructor(opts: { root: string; registry?: ProjectRegistry; worktreeManager?: WorktreeManager; sessionMetaDir?: string }) {
    this.root = opts.root;
    this.registry = opts.registry;
    this.worktreeManager = opts.worktreeManager;
    this.sessionMetaDir = opts.sessionMetaDir;
  }

  // Durable per-session marker written when Outpost spawns an action session
  // (orchestrator, step, or action/skill edit): the action name + a readable title.
  // Lets the sessions list label + title action sessions without their transcript,
  // and survives daemon restarts (unlike the in-memory action binding). Keyed by
  // session id, so it's independent of the ~/.claude/projects/* dir encoding.
  writeActionMeta(sessionId: string, meta: { action: string; title: string }): void {
    if (!this.sessionMetaDir || !/^[\w-]+$/.test(sessionId)) return;
    try {
      mkdirSync(this.sessionMetaDir, { recursive: true, mode: 0o700 });
      const path = join(this.sessionMetaDir, `${sessionId}.json`);
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      renameSync(tmp, path);
    } catch { /* best-effort — the session just renders as a plain interactive one */ }
  }

  private readActionMeta(id: string): { action: string; title: string } | null {
    if (!this.sessionMetaDir || !/^[\w-]+$/.test(id)) return null;
    try {
      const parsed = JSON.parse(readFileSync(join(this.sessionMetaDir, `${id}.json`), 'utf8')) as { action?: unknown; title?: unknown };
      if (typeof parsed?.action !== 'string') return null;
      return { action: parsed.action, title: typeof parsed.title === 'string' ? parsed.title : '' };
    } catch { return null; }
  }

  private isGitRepo(cwd: string): boolean {
    const cached = this.gitRepoCache.get(cwd);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      const st = statSync(join(cwd, '.git'));
      result = st.isDirectory() || st.isFile();
    } catch { /* not a git repo */ }
    this.gitRepoCache.set(cwd, result);
    return result;
  }

  // One ProjectInfo per physical ~/.claude/projects/* dir — NO cwd collapse. Callers that
  // resolve a session id back to the dir its JSONL physically lives in (findSession, and thus
  // readMessages/delete/subagents) rely on entries staying 1:1 with dirs. Collapsing here would
  // hand back a representative projectDir that's wrong for any session merged in from a sibling dir.
  private scanProjectDirs(): ProjectInfo[] {
    let dirs: string[];
    try {
      dirs = readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(this.root, e.name));
    } catch {
      dirs = [];
    }
    // Include tombstoned worktree paths so their JSONLs survive archive/remove (folded under parent later).
    const knownWorktreePaths = new Set<string>();
    if (this.worktreeManager) {
      for (const rec of this.worktreeManager.list()) {
        if (rec.worktreePath) knownWorktreePaths.add(rec.worktreePath);
      }
    }
    const out: ProjectInfo[] = [];
    for (const projectDir of dirs) {
      const cwd = this.readCwdFromProject(projectDir);
      if (!cwd) continue;
      let cwdExists = false;
      try { cwdExists = statSync(cwd).isDirectory(); } catch { /* nope */ }
      // Drop dead cwds unless they're a known worktree (live or tombstoned) — those still get merged.
      if (!cwdExists && !knownWorktreePaths.has(cwd)) continue;
      const sessions = this.listSessionsInDir(projectDir);
      const lastModified = sessions.reduce((m, s) => Math.max(m, s.lastModified), 0);
      out.push({
        projectDir,
        cwd,
        lastModified,
        sessions,
        isGitRepo: this.isGitRepo(cwd),
        source: 'claude',
      });
    }
    return out;
  }

  // Physical dirs collapsed to one ProjectInfo per cwd, for the cwd-grouped project list. Two
  // Claude project dirs can resolve to the same cwd — most often a worktree dir whose session
  // recorded the PARENT repo's cwd, which defeats readCwdFromProject's basename guard and makes
  // the worktree dir claim the parent's cwd. Union the sessions rather than let the later dir
  // clobber the earlier (that silently drops a whole project), and keep the dir whose basename
  // matches the sanitized cwd as the representative — the canonical home for that cwd.
  private scanRawProjects(): ProjectInfo[] {
    const byCwd = new Map<string, ProjectInfo>();
    for (const p of this.scanProjectDirs()) {
      const existing = byCwd.get(p.cwd);
      if (!existing) {
        byCwd.set(p.cwd, p);
        continue;
      }
      const sanitized = p.cwd.replace(/\//g, '-');
      const incomingIsCanonical = (p.projectDir.split('/').pop() ?? '') === sanitized;
      const seen = new Set(existing.sessions.map((s) => s.id));
      const sessions = [...existing.sessions];
      for (const s of p.sessions) if (!seen.has(s.id)) sessions.push(s);
      sessions.sort((a, b) => b.lastModified - a.lastModified);
      byCwd.set(p.cwd, {
        ...existing,
        projectDir: incomingIsCanonical ? p.projectDir : existing.projectDir,
        sessions,
        lastModified: Math.max(existing.lastModified, p.lastModified),
        isGitRepo: existing.isGitRepo || p.isGitRepo,
      });
    }
    if (this.registry) {
      for (const reg of this.registry.list()) {
        let cwdExists = false;
        try { cwdExists = statSync(reg.cwd).isDirectory(); } catch { /* nope */ }
        if (!cwdExists) continue;
        const existing = byCwd.get(reg.cwd);
        if (existing) {
          byCwd.set(reg.cwd, { ...existing, source: 'both' });
        } else {
          const sanitized = reg.cwd.replace(/\//g, '-');
          byCwd.set(reg.cwd, {
            projectDir: join(this.root, sanitized),
            cwd: reg.cwd,
            lastModified: reg.addedAt,
            sessions: [],
            isGitRepo: this.isGitRepo(reg.cwd),
            source: 'registry',
          });
        }
      }
    }
    return [...byCwd.values()];
  }

  listProjects(): ProjectInfo[] {
    const raw = this.scanRawProjects();
    if (!this.worktreeManager) {
      raw.sort((a, b) => b.lastModified - a.lastModified);
      stampAutoArchived(raw);
      return raw;
    }

    // Tombstones included so their JSONLs fold under the parent project as archived rows, not orphans.
    const worktreeByCwd = new Map<string, WorktreeRecord>();
    for (const rec of this.worktreeManager.list()) {
      if (!rec.worktreePath) continue;
      worktreeByCwd.set(rec.worktreePath, rec);
    }
    const archivedSessionIds = new Set<string>();
    for (const rec of this.worktreeManager.list()) {
      if (rec.archivedAt) archivedSessionIds.add(rec.sessionId);
    }

    const parents = new Map<string, ProjectInfo>();
    const orphanWorktreeRows: { project: ProjectInfo; rec: WorktreeRecord }[] = [];
    for (const p of raw) {
      const rec = worktreeByCwd.get(p.cwd);
      if (rec) {
        orphanWorktreeRows.push({ project: p, rec });
      } else {
        parents.set(p.cwd, p);
      }
    }

    // Fold each worktree row into its parent project, synthesizing a parent if none exists.
    for (const { project: wtProject, rec } of orphanWorktreeRows) {
      let parent = parents.get(rec.projectCwd);
      if (!parent) {
        let cwdExists = false;
        try { cwdExists = statSync(rec.projectCwd).isDirectory(); } catch { /* nope */ }
        if (!cwdExists) continue;  // parent dir gone — drop the orphan rows
        const sanitized = rec.projectCwd.replace(/\//g, '-');
        parent = {
          projectDir: join(this.root, sanitized),
          cwd: rec.projectCwd,
          lastModified: 0,
          sessions: [],
          isGitRepo: this.isGitRepo(rec.projectCwd),
          source: 'claude',
        };
        parents.set(rec.projectCwd, parent);
      }
      const annotated = wtProject.sessions.map((s) => ({
        ...s,
        worktreePath: rec.worktreePath,
        worktreeBranch: rec.branch,
      }));
      parent.sessions = [...parent.sessions, ...annotated];
      parent.lastModified = Math.max(parent.lastModified, wtProject.lastModified);
    }

    for (const p of parents.values()) {
      for (let i = 0; i < p.sessions.length; i++) {
        if (archivedSessionIds.has(p.sessions[i]!.id)) {
          p.sessions[i] = { ...p.sessions[i]!, archived: true };
        }
      }
      p.sessions.sort((a, b) => b.lastModified - a.lastModified);
    }
    stampAutoArchived([...parents.values()]);

    const out = [...parents.values()];
    out.sort((a, b) => b.lastModified - a.lastModified);
    return out;
  }

  private listSessionsInDir(dir: string): SessionInfo[] {
    let files: string[];
    try { files = readdirSync(dir); } catch { return []; }
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => this.readSessionInfoFromPath(join(dir, f)))
      .filter((s): s is SessionInfo => s !== null)
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  readCwdFromProject(projectDir: string): string | null {
    let entries: { name: string; mtime: number }[];
    try {
      entries = readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const p = join(projectDir, f);
          const st = statSync(p);
          return { name: p, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return null;
    }
    if (entries.length === 0) return null;
    const newest = entries[0]!;
    const cached = this.cwdCache.get(projectDir);
    if (cached && cached.mtime === newest.mtime) return cached.cwd;
    // Prefer a cwd whose sanitization matches this dir's basename — without this, a relocated
    // worktree JSONL (archive() moves it into the parent's dir) would hijack the parent's cwd.
    const expectedBasename = projectDir.split('/').pop() ?? '';
    let fallback: string | null = null;
    for (const e of entries) {
      const cwd = firstCwdInJsonl(e.name);
      if (!cwd) continue;
      if (cwd.replace(/\//g, '-') === expectedBasename) {
        this.cwdCache.set(projectDir, { cwd, mtime: newest.mtime });
        return cwd;
      }
      if (fallback === null) fallback = cwd;
    }
    if (fallback !== null) this.cwdCache.set(projectDir, { cwd: fallback, mtime: newest.mtime });
    return fallback;
  }

  findSession(id: string): { projectDir: string; cwd: string; session: SessionInfo } | null {
    // Use the per-dir scan so a session resolves to the physical dir its JSONL lives in, never a
    // cwd-collapsed representative — otherwise a session merged in from a sibling dir would resolve
    // to the wrong projectDir and readMessages/delete would target a file that isn't there.
    for (const p of this.scanProjectDirs()) {
      const match = p.sessions.find((s) => s.id === id);
      if (match) return { projectDir: p.projectDir, cwd: p.cwd, session: match };
    }
    return null;
  }

  readMessages(id: string): TranscriptMessage[] {
    // Strict id guard prevents path traversal into other directories.
    if (!/^[\w-]+$/.test(id)) return [];
    const found = this.findSession(id);
    if (!found) return [];
    const path = join(found.projectDir, `${id}.jsonl`);
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: TranscriptMessage[] = [];
    const taskToolUseIds = new Set<string>();
    const rejectedToolUseIds = new Set<string>();
    const parser = new LineParser();
    parser.onLine = (obj) => {
      collectRejectedToolUseIds(obj, rejectedToolUseIds);
      for (const m of extractTranscriptMessages(obj, taskToolUseIds)) out.push(m);
    };
    parser.write(content);
    return stampRejections(out, rejectedToolUseIds);
  }

  // Reconstruct each subagent's transcript from <sessionDir>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json},
  // binding completion data from the parent JSONL's <task-notification> entries by task-id = agent_id.
  readSubagents(id: string): SubagentInfo[] {
    // Strict id guard prevents path traversal into other directories.
    if (!/^[\w-]+$/.test(id)) return [];
    const found = this.findSession(id);
    if (!found) return [];
    const subagentDir = join(found.projectDir, id, 'subagents');
    let metaFiles: string[];
    try {
      metaFiles = readdirSync(subagentDir).filter((f) => f.endsWith('.meta.json'));
    } catch {
      return [];
    }
    const completions = readTaskNotifications(join(found.projectDir, `${id}.jsonl`));
    const out: SubagentInfo[] = [];
    for (const metaFile of metaFiles) {
      const agentId = metaFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      const metaPath = join(subagentDir, metaFile);
      const jsonlPath = join(subagentDir, `agent-${agentId}.jsonl`);
      let meta: { agentType?: string; description?: string; toolUseId?: string };
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        continue;
      }
      let jsonlContent = '';
      let firstSeenAt = 0;
      try {
        jsonlContent = readFileSync(jsonlPath, 'utf8');
        firstSeenAt = statSync(jsonlPath).mtimeMs;
      } catch { /* meta without jsonl — surface with empty feed */ }
      const entries: TranscriptMessage[] = [];
      const taskToolUseIds = new Set<string>();
      const rejectedToolUseIds = new Set<string>();
      let firstTimestamp: number | null = null;
      const parser = new LineParser();
      parser.onLine = (obj) => {
        const o = obj as RawSessionRecord & { timestamp?: string };
        if (firstTimestamp === null && typeof o.timestamp === 'string') {
          const t = Date.parse(o.timestamp);
          if (!Number.isNaN(t)) firstTimestamp = t;
        }
        collectRejectedToolUseIds(obj, rejectedToolUseIds);
        for (const m of extractTranscriptMessages(obj, taskToolUseIds)) {
          // Subagent feeds render only tool tiles; the dispatch prompt and free-form replies live elsewhere.
          if (m.role !== 'tool_use' && m.role !== 'tool_result') continue;
          entries.push(m);
        }
      };
      parser.write(jsonlContent);
      out.push({
        agentId,
        agentType: meta.agentType ?? 'agent',
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.toolUseId ? { parentToolUseId: meta.toolUseId } : {}),
        firstSeenAt: firstTimestamp ?? firstSeenAt,
        entries: stampRejections(entries, rejectedToolUseIds),
        completion: completions.get(agentId) ?? null,
      });
    }
    out.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    return out;
  }

  // Permanently removes the session — no trash dir, not recoverable.
  delete(id: string): boolean {
    // Strict id guard prevents path traversal into other directories.
    if (!/^[\w-]+$/.test(id)) return false;
    const found = this.findSession(id);
    if (!found) return false;
    const path = join(found.projectDir, `${id}.jsonl`);
    try {
      unlinkSync(path);
      try { unlinkSync(join(found.projectDir, `${id}.title`)); } catch { /* no sidecar */ }
      if (this.sessionMetaDir) { try { unlinkSync(join(this.sessionMetaDir, `${id}.json`)); } catch { /* no sidecar */ } }
      return true;
    } catch {
      return false;
    }
  }

  private readSessionInfoFromPath(path: string): SessionInfo | null {
    try {
      const stat = statSync(path);
      const id = path.split('/').pop()!.replace(/\.jsonl$/, '');
      const lastModified = this.lastActivityMs(path, stat.size, stat.mtimeMs);
      const meta = this.readActionMeta(id);
      // Persisted sidecar so titles don't shift as new content streams in; delete to force regeneration.
      const titlePath = path.replace(/\.jsonl$/, '.title');
      let cached: string | undefined;
      try { cached = readFileSync(titlePath, 'utf8').trim(); } catch { /* no sidecar */ }
      let title: string;
      if (cached) {
        title = cached;
      } else {
        const { summary, firstUserMsg } = scanTitleSources(path);
        const rawTitle = summary ?? firstUserMsg;
        title = rawTitle ? cleanTitle(rawTitle) : 'Untitled session';
        // Don't cache "Untitled session" for a brand-new session that hasn't been written to disk yet.
        if (rawTitle) {
          try { writeFileSync(titlePath, title); } catch { /* best-effort cache */ }
        }
      }
      // An action session's stamped title/label supersedes the transcript-derived one
      // (whose first turn is a bare `/action <uuid>` slash command → a UUID or "Untitled").
      if (meta) return { id, title: meta.title || title, lastModified, path, sessionClass: 'action', actionLabel: meta.action };
      return { id, title, lastModified, path };
    } catch {
      return null;
    }
  }

  // Falls back to mtime so a brand-new session with no real turns yet still sorts to the top.
  private lastActivityMs(path: string, size: number, mtimeMs: number): number {
    const cached = this.lastMsgTsCache.get(path);
    if (cached && cached.size === size) return cached.ts ?? mtimeMs;
    const ts = lastMessageTimestampMs(path, size);
    this.lastMsgTsCache.set(path, { size, ts });
    return ts ?? mtimeMs;
  }
}
