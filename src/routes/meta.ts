import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import type { ActionRegistry } from '../actions/index.js';
import type { PermissionGroupMap } from '../actions/types.js';
import { Allowlist, type AllowlistConfig, type RuleKind, type RuleScope } from '../permissions/allowlist.js';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ProjectRegistry } from '../storage/project-registry.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import { isKnownCwd } from '../git/known-cwd.js';
import type { JournalStore } from '../storage/journal-store.js';
import { readJsonObject } from './util.js';

export interface MetaRoutesDeps {
  actionRegistry: ActionRegistry;
  permissionGroups: PermissionGroupMap;
  allowlist: Allowlist;
  allowlistPath: string;
  projectAllowlistDir: string;
  actionsStore: ActionsStore;
  actionsStorePath: string;
  projectRegistry: ProjectRegistry;
  worktreeManager: WorktreeManager;
  journalStore: JournalStore;
  mcpConfigPath: string;
}

// Same group-name resolution ActionRegistry.resolvePermissions uses internally
// (core implied for claude runners, explicit "core" in the list is a no-op) —
// duplicated here rather than exported from the registry since it's the only
// other place that needs it.
function groupNamesForAction(fm: { outpost: { runner: string; permissions?: string[] } }): string[] {
  const names: string[] = [];
  if (fm.outpost.runner === 'claude') names.push('core');
  for (const g of fm.outpost.permissions ?? []) {
    if (g !== 'core') names.push(g);
  }
  return names;
}

// Matches claude code's projects-dir sanitization (also duplicated in
// worktree-manager.ts) — used here only to locate a project's allowlist file
// given a cwd we already trust (from ProjectRegistry / WorktreeManager).
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

type PersistedRuleScope = 'global' | { project: string } | { action: string };

// Stable, URL-safe rule id: derived from (kind, value, scope) so GET and DELETE
// agree across restarts without a separate id store.
export function encodeRuleId(kind: RuleKind, value: string, scope: PersistedRuleScope): string {
  const scopeKey = scope === 'global' ? 'global'
    : 'project' in scope ? `project:${scope.project}`
    : `action:${scope.action}`;
  return Buffer.from(JSON.stringify([kind, value, scopeKey]), 'utf8').toString('base64url');
}

export function decodeRuleId(id: string): { kind: RuleKind; value: string; scope: PersistedRuleScope } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [kind, value, scopeKey] = parsed as [unknown, unknown, unknown];
  if (kind !== 'tool' && kind !== 'bash' && kind !== 'mcp' && kind !== 'path') return null;
  if (typeof value !== 'string' || typeof scopeKey !== 'string') return null;
  let scope: PersistedRuleScope;
  if (scopeKey === 'global') scope = 'global';
  else if (scopeKey.startsWith('project:')) scope = { project: scopeKey.slice('project:'.length) };
  else if (scopeKey.startsWith('action:')) scope = { action: scopeKey.slice('action:'.length) };
  else return null;
  return { kind, value, scope };
}

function isEmptyConfig(cfg: AllowlistConfig): boolean {
  return cfg.alwaysAllow.length === 0
    && cfg.alwaysAllowBashPatterns.length === 0
    && cfg.alwaysAllowMcpPatterns.length === 0
    && (cfg.alwaysAllowPathPatterns ?? []).length === 0;
}

interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  headers?: Record<string, string>;
}

function readMcpServersFile(path: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    return raw.mcpServers ?? {};
  } catch {
    return {};
  }
}

function transportOf(cfg: McpServerConfig): 'http' | 'sse' | 'stdio' {
  if (cfg.type === 'sse') return 'sse';
  if (cfg.type === 'stdio' || (!cfg.url && !!cfg.command)) return 'stdio';
  return 'http';
}

const MCP_PROBE_TIMEOUT_MS = 2500;

// Best-effort transport-level reachability check — a non-2xx response still proves
// the server is up, so we only call it 'unreachable' on a network failure/timeout.
async function probeHttpServer(url: string, headers?: Record<string, string>): Promise<{ status: 'ok' | 'unreachable'; httpStatus?: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MCP_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ac.signal });
    return { status: 'ok', httpStatus: res.status };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export function registerMetaRoutes(server: Server, deps: MetaRoutesDeps): void {
  const {
    actionRegistry, permissionGroups, allowlist, allowlistPath, projectAllowlistDir,
    actionsStore, actionsStorePath, projectRegistry, worktreeManager, journalStore, mcpConfigPath,
  } = deps;

  server.route('GET', '/api/permission-groups', (_req, res) => {
    const counts = new Map<string, number>();
    for (const a of actionRegistry.listActions()) {
      for (const name of groupNamesForAction(a.frontmatter)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const groups = Object.entries(permissionGroups).map(([name, cfg]) => ({
      name,
      description: cfg.description ?? '',
      alwaysAllow: cfg.alwaysAllow,
      alwaysAllowBashPatterns: cfg.alwaysAllowBashPatterns,
      alwaysAllowMcpPatterns: cfg.alwaysAllowMcpPatterns,
      alwaysAllowPathPatterns: cfg.alwaysAllowPathPatterns,
      actionCount: counts.get(name) ?? 0,
    }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ groups }));
  });

  // Body: { kind: 'tool'|'bash'|'mcp', value: string, scope?: 'global' | { project: string } | { action: string } | { session: string } | 'session' }.
  // Validates + dedupes + atomic-writes global allowlist.json or per-project file.
  // Action scope persists via ActionsStore (actions.json). Session scope is
  // in-memory only — dies with the session, never touches disk. The bare-string
  // 'session' form pairs with a top-level sessionId field.
  async function handlePostAllowlistRule(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = await readJsonObject<{ kind?: string; value?: string; sessionId?: string; scope?: 'global' | 'session' | { project?: string } | { action?: string } | { session?: string } }>(req, res);
    if (!payload) return;
    const { kind, value, scope } = payload;
    if (kind !== 'tool' && kind !== 'bash' && kind !== 'mcp' && kind !== 'path') {
      res.statusCode = 400; res.end('kind must be tool|bash|mcp|path'); return;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
      res.statusCode = 400; res.end('value must be a 1..500 char string'); return;
    }
    let normalizedScope: 'global' | { project: string } | { action: string } | { session: string };
    if (scope === undefined || scope === 'global') {
      normalizedScope = 'global';
    } else if (scope === 'session' && typeof payload.sessionId === 'string' && payload.sessionId.length > 0) {
      normalizedScope = { session: payload.sessionId };
    } else if (typeof scope === 'object' && scope !== null && typeof (scope as { session?: string }).session === 'string' && (scope as { session: string }).session.length > 0) {
      normalizedScope = { session: (scope as { session: string }).session };
    } else if (typeof scope === 'object' && scope !== null && typeof (scope as { project?: string }).project === 'string' && (scope as { project: string }).project.startsWith('/')) {
      normalizedScope = { project: (scope as { project: string }).project };
    } else if (typeof scope === 'object' && scope !== null && typeof (scope as { action?: string }).action === 'string' && (scope as { action: string }).action.length > 0) {
      normalizedScope = { action: (scope as { action: string }).action };
    } else {
      res.statusCode = 400; res.end('scope must be "global" | {project: <absolute-cwd>} | {action: <name>} | {session: <id>} | "session" (+ sessionId)'); return;
    }
    let added: boolean;
    try {
      added = allowlist.addRule(kind, value, normalizedScope);
    } catch (e) {
      res.statusCode = 400; res.end(`invalid pattern: ${(e as Error).message}`); return;
    }
    if (added && normalizedScope === 'global') {
      const tmp = `${allowlistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(allowlist.toConfig('global'), null, 2) + '\n');
      renameSync(tmp, allowlistPath);
      console.log(`[api] allowlist[global]: added ${kind} rule ${JSON.stringify(value)} (total ${allowlist.ruleCount()})`);
    } else if (added && typeof normalizedScope === 'object' && 'project' in normalizedScope) {
      // Project file persistence lives inside Allowlist.addRule.
      console.log(`[api] allowlist[project=${normalizedScope.project}]: added ${kind} rule ${JSON.stringify(value)}`);
    } else if (added && typeof normalizedScope === 'object' && 'action' in normalizedScope) {
      // Action persistence lives inside ActionsStore.addRule (chained via Allowlist).
      console.log(`[api] allowlist[action=${normalizedScope.action}]: added ${kind} rule ${JSON.stringify(value)}`);
    } else if (added && typeof normalizedScope === 'object' && 'session' in normalizedScope) {
      console.log(`[api] allowlist[session=${normalizedScope.session.slice(0, 8)}]: added ${kind} rule ${JSON.stringify(value)} (in-memory)`);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ added, ruleCount: allowlist.ruleCount() }));
  }

  server.route('POST', '/api/allowlist/rules', handlePostAllowlistRule);

  server.route('GET', '/api/allowlist/rules', (_req, res) => {
    type Row = { id: string; kind: RuleKind; value: string; scope: PersistedRuleScope; source: string };
    const rows: Row[] = [];
    const pushConfig = (cfg: AllowlistConfig, scope: Row['scope'], source: string) => {
      const push = (kind: RuleKind, value: string) =>
        rows.push({ id: encodeRuleId(kind, value, scope), kind, value, scope, source });
      for (const v of cfg.alwaysAllow) push('tool', v);
      for (const v of cfg.alwaysAllowBashPatterns) push('bash', v);
      for (const v of cfg.alwaysAllowMcpPatterns) push('mcp', v);
      for (const v of cfg.alwaysAllowPathPatterns ?? []) push('path', v);
    };

    pushConfig(allowlist.toConfig('global'), 'global', allowlistPath);

    // Project-scoped rules only exist under cwds the daemon already knows about —
    // there's no directory listing of "every project that ever got a rule", so this
    // walks known project/worktree cwds rather than globbing the allowlists dir.
    const candidateCwds = new Set<string>();
    for (const p of projectRegistry.list()) candidateCwds.add(p.cwd);
    for (const rec of worktreeManager.list()) if (rec.projectCwd) candidateCwds.add(rec.projectCwd);
    for (const cwd of candidateCwds) {
      const cfg = allowlist.toConfig({ project: cwd });
      if (isEmptyConfig(cfg)) continue;
      pushConfig(cfg, { project: cwd }, join(projectAllowlistDir, `${sanitizeCwd(cwd)}.json`));
    }

    for (const [name, cfg] of Object.entries(actionsStore.list())) {
      if (isEmptyConfig(cfg.allowlist)) continue;
      pushConfig(cfg.allowlist, { action: name }, actionsStorePath);
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rules: rows }));
  });

  // Revokes a persisted grant (global or project scope). Session-scoped rules
  // are never listed here (they die with the session); action-scoped rules are
  // managed via the action editor and can't be revoked from this endpoint.
  server.route('DELETE', '/api/allowlist/rules/:id', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/allowlist\/rules\/([A-Za-z0-9_-]+)$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const decoded = decodeRuleId(m[1]!);
    if (!decoded) { res.statusCode = 400; res.end('malformed rule id'); return; }
    if (typeof decoded.scope === 'object' && 'action' in decoded.scope) {
      res.statusCode = 409; res.end('action-scoped rules are managed via the action editor'); return;
    }
    const removed = allowlist.removeRule(decoded.kind, decoded.value, decoded.scope as RuleScope);
    if (!removed) { res.statusCode = 404; res.end('rule not found'); return; }
    if (decoded.scope === 'global') {
      // Project-file persistence lives inside Allowlist.removeRule; the global
      // file is owned by the daemon, so re-serialize it here (same atomic-rename
      // shape as the POST /api/allowlist/rules handler).
      const tmp = `${allowlistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(allowlist.toConfig('global'), null, 2) + '\n');
      renameSync(tmp, allowlistPath);
    }
    const scopeLabel = decoded.scope === 'global' ? 'global' : `project=${(decoded.scope as { project: string }).project}`;
    console.log(`[api] allowlist[${scopeLabel}]: removed ${decoded.kind} rule ${JSON.stringify(decoded.value)}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  server.route('GET', '/api/actions/:name/journal', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/actions\/([^/?]+)\/journal(?:\?.*)?$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    const url = new URL(req.url ?? '', 'http://internal');
    let limit = 10;
    const limitRaw = url.searchParams.get('limit');
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 200);
    }
    const entries = journalStore.recent(name, limit);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ entries }));
  });

  server.route('GET', '/api/mcp/status', async (_req, res) => {
    const merged = new Map<string, McpServerConfig>();
    for (const [name, cfg] of Object.entries(readMcpServersFile(mcpConfigPath))) merged.set(name, cfg);
    // User-global config (~/.claude.json "mcpServers") merges in for every spawned
    // session too — claude adds --mcp-config servers to whatever's already configured
    // rather than replacing it (no --strict-mcp-config flag is passed). First
    // occurrence wins on a name collision.
    for (const [name, cfg] of Object.entries(readMcpServersFile(join(homedir(), '.claude.json')))) {
      if (!merged.has(name)) merged.set(name, cfg);
    }

    const servers = await Promise.all([...merged.entries()].map(async ([name, cfg]) => {
      const transport = transportOf(cfg);
      if (transport === 'stdio') {
        return { name, transport, status: 'configured' as const };
      }
      if (!cfg.url) {
        return { name, transport, status: 'unreachable' as const };
      }
      const probe = await probeHttpServer(cfg.url, cfg.headers);
      return { name, transport, status: probe.status, ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {}) };
    }));

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ servers }));
  });

  server.route('GET', '/api/files', (req, res) => {
    const url = new URL(req.url ?? '', 'http://internal');
    const cwd = url.searchParams.get('cwd') ?? '';
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    let limit = 50;
    const limitRaw = url.searchParams.get('limit');
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 500);
    }
    if (!cwd || !existsSync(cwd) || !isKnownCwd(cwd, projectRegistry, worktreeManager)) {
      res.statusCode = 400; res.end('cwd must be a registered project or known worktree path'); return;
    }
    let files: string[];
    try {
      const buf = execFileSync('git', ['-C', cwd, 'ls-files', '-z'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024,
      });
      files = buf.toString('utf8').split('\0').filter(Boolean);
    } catch (e) {
      res.statusCode = 500; res.end(`ls-files failed: ${(e as Error).message}`); return;
    }
    const filtered = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ files: filtered.slice(0, limit) }));
  });
}
