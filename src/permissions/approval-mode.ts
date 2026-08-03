import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const APPROVAL_MODES = ['ask', 'accept-edits', 'plan', 'bypass'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
const VALID_MODES: ReadonlySet<ApprovalMode> = new Set(APPROVAL_MODES);

// Atomic write — tmp file + rename, matching the pattern in project-registry.ts and
// push-subscriptions.ts. Keeps the index consistent across crashes and concurrent reads.
function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class ApprovalModeStore {
  private modes = new Map<string, ApprovalMode>();

  // path is optional so tests can spin up an in-memory store. In the daemon we always
  // pass a path so kickstart preserves each session's mode across restart — sessions
  // already rehydrate their transcript and statusline from disk, so it'd be jarring if
  // the permission mode silently reset to 'ask'.
  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { modes?: Record<string, string> };
      for (const [id, mode] of Object.entries(parsed.modes ?? {})) {
        if (VALID_MODES.has(mode as ApprovalMode)) {
          this.modes.set(id, mode as ApprovalMode);
        }
      }
    } catch {
      // Malformed file — start empty; next persist overwrites cleanly.
    }
  }

  get(sessionId: string): ApprovalMode {
    return this.modes.get(sessionId) ?? 'ask';
  }

  // True once a mode has been explicitly stored for this session. Distinguishes
  // "never set — safe to seed from the client's spawn default" from "user (or a
  // prior spawn) already chose one — leave it alone", which get()'s 'ask'
  // fallback can't tell apart.
  has(sessionId: string): boolean {
    return this.modes.has(sessionId);
  }

  set(sessionId: string, mode: ApprovalMode): void {
    if (!VALID_MODES.has(mode)) {
      throw new Error(`invalid ApprovalMode: ${JSON.stringify(mode)}`);
    }
    const prev = this.modes.get(sessionId);
    this.modes.set(sessionId, mode);
    if (prev !== mode) this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    atomicWrite(this.path, JSON.stringify({ modes: Object.fromEntries(this.modes) }, null, 2) + '\n');
  }
}

// Tools that Plan mode auto-allows regardless of allowlist contents. Mirrors the
// "read-shaped" intent: anything that can't mutate filesystem or external state.
// Includes claude agent meta-tools (TaskList/TaskGet/ToolSearch) which are read-only by construction.
export const PLAN_MODE_ALWAYS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'TaskList', 'TaskGet', 'ToolSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);

// MCP tools whose name contains a read-shaped verb are treated as read-only in plan
// mode. The verb may appear at the start, middle, or end of the underscore/hyphen-
// separated suffix — e.g. `list_issues`, `pull_request_read`, `notion-search`.
// A trailing `s` is allowed to handle `search_dashboards` etc.
// Anchored to the full tool name to prevent partial matches on unrelated segments.
export const PLAN_MODE_MCP_READ_RE = /^mcp__[^_]+__(?:.*[_-])?(read|list|search|get|show|fetch|view|describe)s?(?:[_-].*)?$/;

// Tokens that, when present anywhere in an MCP tool's name segments, indicate the
// tool mutates state. Used as a defense-in-depth check on top of PLAN_MODE_MCP_READ_RE
// — a tool like `mcp__foo__list_delete_all` matches the read regex (because "list"
// appears) but contains "delete" and must NOT auto-allow in plan mode. Plurals via
// trailing 's' are matched so `creates`/`updates` are also caught when used as verbs.
export const PLAN_MODE_MCP_MUTATORS: ReadonlySet<string> = new Set([
  'create', 'update', 'delete', 'merge', 'write', 'set', 'patch', 'put',
  'remove', 'destroy', 'close', 'cancel', 'approve', 'deny', 'publish',
  'enable', 'disable', 'grant', 'revoke', 'send', 'post', 'add', 'edit',
  'modify', 'replace', 'reset', 'restart', 'kill', 'stop', 'start',
  'open', 'submit', 'execute', 'run', 'invoke', 'trigger',
]);

// True if the tool name is safe to auto-allow in plan mode: it must match the
// read-verb regex AND contain no mutator-verb segments. Both anchors matter —
// either alone leaves a hole.
export function isPlanModeReadableMcpTool(toolName: string): boolean {
  if (!PLAN_MODE_MCP_READ_RE.test(toolName)) return false;
  // Strip "mcp__<server>__" prefix, then split on either separator.
  const suffix = toolName.replace(/^mcp__[^_]+__/, '');
  const segments = suffix.split(/[_-]+/);
  for (const seg of segments) {
    // Allow trailing 's' plural ("creates", "updates") to also trigger the denylist.
    const root = seg.endsWith('s') ? seg.slice(0, -1) : seg;
    if (PLAN_MODE_MCP_MUTATORS.has(seg) || PLAN_MODE_MCP_MUTATORS.has(root)) return false;
  }
  return true;
}
