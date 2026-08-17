import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRegistry } from '../actions/index.js';
import type { ActionAllowlist } from '../actions/types.js';
import { literalRedirectPath, splitShellClauses, stripLeadingAssignments } from './shell-split.js';
import { clausesShellSafe, unsafeClauseReason } from './shell-safety.js';
import { assertNotWriteShaped } from './write-shape.js';

export interface AllowlistConfig {
  alwaysAllow: string[];
  alwaysAllowBashPatterns: string[];
  alwaysAllowMcpPatterns: string[];
  // Path-scoped tool rules. Each entry is `<ToolName>:<path-regex>` — e.g.
  // `Write:^/tmp/` allows Write calls whose `file_path` starts with `/tmp/`,
  // but no other Write calls. Pairs with file-touching tools (Read, Write,
  // Edit, MultiEdit, NotebookEdit, Glob, Grep). Optional for backward compat.
  alwaysAllowPathPatterns?: string[];
}

export type RuleKind = 'tool' | 'bash' | 'mcp' | 'path';
// Session scope is in-memory only: rules live for the daemon's lifetime of that
// session and are never written to disk. Everything else persists.
export type RuleScope = 'global' | { project: string } | { action: string } | { session: string };

interface PathRule {
  tool: string;
  pathRegex: RegExp;
}

interface CompiledRules {
  alwaysAllow: Set<string>;
  bashPatternSources: string[];
  bashPatterns: RegExp[];
  mcpPatternSources: string[];
  mcpPatterns: RegExp[];
  pathPatternSources: string[];
  pathPatterns: PathRule[];
}

// Tools whose input has a file-path-ish field that path rules apply to.
const PATH_INPUT_FIELDS: Record<string, ReadonlyArray<string>> = {
  Read:         ['file_path'],
  Write:        ['file_path'],
  Edit:         ['file_path'],
  MultiEdit:    ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Glob:         ['path'],
  Grep:         ['path'],
};

function parsePathRule(value: string): PathRule {
  const idx = value.indexOf(':');
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error(`path rule must be "<ToolName>:<regex>": ${JSON.stringify(value)}`);
  }
  const tool = value.slice(0, idx);
  const pathRegex = new RegExp(value.slice(idx + 1));
  return { tool, pathRegex };
}

// Prefix check with a trailing-slash boundary so `/foo/bar` matches under `/foo`
// but `/foobar` doesn't. Defends against two escapes:
//   1. `..` traversal — lexical `resolve()` collapses `worktree/../../etc/passwd`
//      to `/etc/passwd` before the prefix compare.
//   2. Symlink escape — realpath the deepest existing ancestor of the target so
//      a symlink already on disk resolves to its real destination. Non-existent
//      leaf segments (Write to a new file) are appended after the ancestor's
//      realpath, so the check is stable whether or not the file exists yet.
function isPathUnder(path: string, prefix: string): boolean {
  const realPath = canonicalPath(path);
  const realPrefix = canonicalPath(prefix);
  if (realPath === realPrefix) return true;
  const withSlash = realPrefix.endsWith('/') ? realPrefix : `${realPrefix}/`;
  return realPath.startsWith(withSlash);
}

// macOS's top-level system symlinks — /tmp, /var and /etc all point into /private — are two
// spellings of one directory, not an escape. Rules are written in the user-visible spelling
// (`Write:^/tmp/`), so map a realpath back onto it; without this, resolving symlinks at all
// would deny every /tmp write on the platform the daemon actually runs on.
const PRIVATE_ALIAS = /^\/private(\/(?:tmp|var|etc)(?:\/|$))/;

// The single normalisation both the regex path rules and the session-scope prefix check use.
// They must agree: they used to disagree (lexical resolve vs realpath), and the regex path
// was the weaker one — a symlink planted in world-writable /tmp turned an `Edit:^/tmp/`
// grant into a write anywhere on the box.
function canonicalPath(p: string): string {
  const real = realpathAncestor(resolve(p));
  return PRIVATE_ALIAS.test(real) ? real.slice('/private'.length) : real;
}

// Walk `p`'s ancestor chain until we find one that exists on disk, realpath it,
// then re-append the non-existent tail. Handles Write targets whose leaf file
// hasn't been created yet without giving up symlink resolution on the existing part.
function realpathAncestor(p: string): string {
  let cur = p;
  while (cur && cur !== '/' && cur !== dirname(cur)) {
    try { return realpathSync(cur) + p.slice(cur.length); }
    catch { cur = dirname(cur); }
  }
  return p;
}

function readPathInput(toolName: string, toolInput: unknown): string | undefined {
  const fields = PATH_INPUT_FIELDS[toolName];
  if (!fields) return undefined;
  const input = toolInput as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return undefined;
  for (const f of fields) {
    const v = input[f];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// What a denied Bash call needs before it would run: a rule for the clause nothing matched,
// a Write grant for the path it redirects to, or — `none` — nothing a rule can express, with
// `reason` saying what to fix in the command instead.
export type BashDenialCause =
  | { kind: 'clause'; clause: string }
  | { kind: 'redirect'; target: string }
  | { kind: 'none'; reason: string };

// The scopes that were in force when the call was denied. Every field is optional because
// the denial recorder knows the action and the session but not always the project cwd or the
// worktree; omitting one only ever makes the answer stricter, never looser.
export interface DenialContext {
  projectCwd?: string;
  actionName?: string;
  sessionId?: string;
  sessionWorktreePath?: string;
}

export interface AllowlistOpts {
  // Absolute path to the directory containing per-project allowlist JSON files.
  // Names follow the sanitization "/" → "-" convention. Optional; when absent,
  // project-scoped rules are inert.
  projectAllowlistDir?: string;
  // Bundled-defaults source for action-name allowlists. Read-only; the colocated
  // <action>/allowlist.json files are checked into the repo.
  actionRegistry?: ActionRegistry;
  // Hot-added override source for action names. Rules added via the API persist here.
  actionsStore?: ActionsStore;
}

// Match claude code's projects-dir sanitization so per-project allowlists key off
// the same path shape the user already sees in `~/.claude/projects/`.
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function emptyCompiled(): CompiledRules {
  return {
    alwaysAllow: new Set(),
    bashPatternSources: [],
    bashPatterns: [],
    mcpPatternSources: [],
    mcpPatterns: [],
    pathPatternSources: [],
    pathPatterns: [],
  };
}

function compileFromConfig(cfg: AllowlistConfig): CompiledRules {
  const pathSources = cfg.alwaysAllowPathPatterns ?? [];
  const pathRules: PathRule[] = [];
  for (const s of pathSources) {
    try { pathRules.push(parsePathRule(s)); }
    catch (e) { /* invalid persisted rule — ignore silently */ }
  }
  return {
    alwaysAllow: new Set(cfg.alwaysAllow),
    bashPatternSources: [...cfg.alwaysAllowBashPatterns],
    bashPatterns: cfg.alwaysAllowBashPatterns.map((s) => new RegExp(s)),
    mcpPatternSources: [...cfg.alwaysAllowMcpPatterns],
    mcpPatterns: cfg.alwaysAllowMcpPatterns.map((s) => new RegExp(s)),
    pathPatternSources: [...pathSources],
    pathPatterns: pathRules,
  };
}

// Redirection targets that create nothing and truncate nothing, so no Write grant can be
// the thing that authorises them. `2>/dev/null` is idiomatic in exactly the commands a
// read-only action runs, and no permission group grants Write anywhere — without this the
// redirect gate hard-denies `cat x 2>/dev/null` for every action in the catalog.
// Deliberately a fixed set of character devices, not a `/dev/` prefix: `/dev/sda` is a disk.
const DEVICE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

function isDeviceSink(path: string): boolean {
  return DEVICE_SINKS.has(path) || /^\/dev\/fd\/\d+$/.test(path);
}

// A clause clears the pattern bar when a rule matches its command body. A pure-assignment
// clause has no command to match, so it passes on its own.
function bashPatternsMatch(rules: CompiledRules, clauseText: string): boolean {
  const body = stripLeadingAssignments(clauseText);
  return body === '' || rules.bashPatterns.some((p) => p.test(body));
}

function rulesAllow(rules: CompiledRules, toolName: string, toolInput: unknown): boolean {
  if (rules.alwaysAllow.has(toolName)) return true;
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string })?.command;
    if (typeof cmd !== 'string') return false;
    const clauses = splitShellClauses(cmd);
    if (clauses === null || clauses.length === 0) return false;
    return clauses.every((c) => bashPatternsMatch(rules, c.text));
  }
  if (toolName.startsWith('mcp__')) {
    return rules.mcpPatterns.some((p) => p.test(toolName));
  }
  // Path-scoped rule: tool name must match AND the path-shaped input matches the regex.
  if (PATH_INPUT_FIELDS[toolName]) {
    const path = readPathInput(toolName, toolInput);
    // Neither `..` nor a symlink may walk out from under an anchored prefix rule:
    // `Write:^/tmp/` should not admit `/tmp/../etc/crontab`, nor `/tmp/link` when `link`
    // points at /etc/hosts. A relative path is tested as written — the daemon can't know the
    // cwd it resolves against, and every path rule is absolute-anchored, so it denies.
    const probe = path !== undefined && path.startsWith('/') ? canonicalPath(path) : path;
    if (probe !== undefined && rules.pathPatterns.some((r) => r.tool === toolName && r.pathRegex.test(probe))) {
      return true;
    }
  }
  return false;
}

function toConfigFromRules(rules: CompiledRules): AllowlistConfig {
  return {
    alwaysAllow: [...rules.alwaysAllow],
    alwaysAllowBashPatterns: [...rules.bashPatternSources],
    alwaysAllowMcpPatterns: [...rules.mcpPatternSources],
    alwaysAllowPathPatterns: [...rules.pathPatternSources],
  };
}

export class Allowlist {
  private readonly global: CompiledRules;
  // Lazy cache: project cwd → compiled rules. Populated on first allows()/addRule()
  // call for that cwd. No fs.watch — survives restart by re-reading the file.
  private readonly projects = new Map<string, CompiledRules>();
  // Session-scoped rules: in-memory only, cleared via clearSession() when the
  // session ends. Never serialized by toConfig().
  private readonly sessionRules = new Map<string, CompiledRules>();
  private readonly projectDir: string | undefined;
  private readonly actionRegistry: ActionRegistry | undefined;
  private readonly actionsStore: ActionsStore | undefined;

  constructor(cfg: AllowlistConfig, opts: AllowlistOpts = {}) {
    this.global = compileFromConfig(cfg);
    this.projectDir = opts.projectAllowlistDir;
    this.actionRegistry = opts.actionRegistry;
    this.actionsStore = opts.actionsStore;
  }

  private loadProject(cwd: string): CompiledRules {
    const cached = this.projects.get(cwd);
    if (cached) return cached;
    if (!this.projectDir) {
      const empty = emptyCompiled();
      this.projects.set(cwd, empty);
      return empty;
    }
    const path = join(this.projectDir, `${sanitizeCwd(cwd)}.json`);
    let rules: CompiledRules;
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8');
        const cfg = JSON.parse(raw) as AllowlistConfig;
        rules = compileFromConfig(cfg);
      } catch {
        rules = emptyCompiled();
      }
    } else {
      rules = emptyCompiled();
    }
    this.projects.set(cwd, rules);
    return rules;
  }

  ruleCount(): number {
    return this.global.alwaysAllow.size
      + this.global.bashPatterns.length
      + this.global.mcpPatterns.length;
  }

  // Every rule set that applies to this call, in no particular order — the checks
  // below are an OR across them.
  private scopesFor(projectCwd?: string, actionName?: string, sessionId?: string): CompiledRules[] {
    const scopes: CompiledRules[] = [this.global];
    if (projectCwd) scopes.push(this.loadProject(projectCwd));
    if (sessionId) {
      const rules = this.sessionRules.get(sessionId);
      if (rules) scopes.push(rules);
    }
    if (actionName) {
      // Bundled action defaults come first (colocated allowlist.json under actions/).
      const action = this.actionRegistry?.getAction(actionName);
      if (action) scopes.push(compileFromConfig(action.allowlist));
      // Then hot-added user overrides (~/.outpost/actions.json).
      if (this.actionsStore) scopes.push(compileFromConfig(this.actionsStore.get(actionName).allowlist));
    }
    return scopes;
  }

  // A bash pattern gates a clause by its leading command, which says nothing about a
  // redirection riding along inside it — `cat x > ~/.zshrc` matches `^cat `. So a clause
  // that creates or truncates a file has to clear a second bar: every target must be a
  // file the same caller could have written with the Write tool. No Write grant, no
  // redirection. Fd dups and input redirections aren't targets and don't reach here.
  private redirectsAllowed(cmd: string, scopes: CompiledRules[], sessionWorktreePath?: string): boolean {
    const clauses = splitShellClauses(cmd);
    if (clauses === null) return false;
    for (const clause of clauses) {
      for (const word of clause.writeTargets) {
        const path = literalRedirectPath(word);
        if (path === null) return false;
        if (isDeviceSink(path)) continue;
        const asWrite = { file_path: path };
        if (scopes.some((s) => rulesAllow(s, 'Write', asWrite))) continue;
        if (sessionWorktreePath && isPathUnder(path, sessionWorktreePath)) continue;
        return false;
      }
    }
    return true;
  }

  // Why a denied Bash command was denied, in the only terms a one-click grant can answer.
  // Order matters and mirrors the gates in allows(): a target no rule could ever name is
  // fatal whatever else is wrong, so it outranks the clause that also has no rule — grant
  // that clause and the call still dies at the redirect gate.
  bashDenialCause(cmd: string, ctx: DenialContext = {}): BashDenialCause {
    const scopes = this.scopesFor(ctx.projectCwd, ctx.actionName, ctx.sessionId);
    const clauses = splitShellClauses(cmd);
    if (clauses === null || clauses.length === 0) return { kind: 'none', reason: 'the command does not parse' };
    const targets: string[] = [];
    for (const clause of clauses) {
      for (const word of clause.writeTargets) {
        const path = literalRedirectPath(word);
        if (path === null) return { kind: 'none', reason: 'a redirect target that is not a literal absolute path' };
        if (!isDeviceSink(path)) targets.push(path);
      }
    }
    const unsafe = unsafeClauseReason(cmd);
    if (unsafe) return { kind: 'none', reason: unsafe };

    const unmatched = clauses.find((c) => !scopes.some((s) => bashPatternsMatch(s, c.text)));
    if (unmatched) return { kind: 'clause', clause: unmatched.text };

    for (const path of targets) {
      if (scopes.some((s) => rulesAllow(s, 'Write', { file_path: path }))) continue;
      if (ctx.sessionWorktreePath && isPathUnder(path, ctx.sessionWorktreePath)) continue;
      return { kind: 'redirect', target: path };
    }
    return { kind: 'none', reason: 'no rule would change the outcome' };
  }

  allows(toolName: string, toolInput: unknown, projectCwd?: string, actionName?: string, sessionWorktreePath?: string, sessionId?: string): boolean {
    const scopes = this.scopesFor(projectCwd, actionName, sessionId);
    if (toolName === 'Bash') {
      const cmd = (toolInput as { command?: string })?.command;
      // A whole-tool `Bash` grant is an explicit "run anything" — it already implies
      // arbitrary writes via `cp`/`rm`/an interpreter, so gating its redirections would
      // be theatre. The gate exists to stop *pattern*-matched clauses from smuggling one.
      if (typeof cmd === 'string' && !scopes.some((s) => s.alwaysAllow.has('Bash'))) {
        if (!this.redirectsAllowed(cmd, scopes, sessionWorktreePath)) return false;
        if (!clausesShellSafe(cmd)) return false;
      }
    }
    if (scopes.some((s) => rulesAllow(s, toolName, toolInput))) return true;
    // Session scope: path-shaped tool inputs inside the session's own worktree auto-allow.
    // Applies only when the daemon told us the session has a worktree — action-step sessions
    // provisioned by the orchestrator. Interactive PWA sessions don't have a worktree record
    // and fall through to the interactive approval queue. See worktree-manager.ts: primary
    // adoption is refused, so a WorktreeRecord's path only ever points inside outpost's root.
    if (sessionWorktreePath && PATH_INPUT_FIELDS[toolName]) {
      const path = readPathInput(toolName, toolInput);
      if (path && isPathUnder(path, sessionWorktreePath)) return true;
    }
    return false;
  }

  // Returns true if the rule was newly added; false if it duplicated an existing one.
  // Persists project writes via projectDir if set. Global writes are still persisted
  // by the caller (daemon writes config/allowlist.json or its configured override).
  addRule(kind: RuleKind, value: string, scope: RuleScope = 'global'): boolean {
    assertNotWriteShaped(kind, value);
    if (typeof scope === 'object' && 'action' in scope) {
      if (!this.actionsStore) throw new Error('action scope requires actionsStore');
      return this.actionsStore.addRule(scope.action, kind, value);
    }
    const target = scope === 'global' ? this.global
      : 'session' in scope ? this.loadSession(scope.session)
      : this.loadProject(scope.project);
    if (kind === 'tool') {
      if (target.alwaysAllow.has(value)) return false;
      target.alwaysAllow.add(value);
    } else if (kind === 'bash') {
      if (target.bashPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      target.bashPatternSources.push(value);
      target.bashPatterns.push(compiled);
    } else if (kind === 'mcp') {
      if (target.mcpPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      target.mcpPatternSources.push(value);
      target.mcpPatterns.push(compiled);
    } else {
      // path rule: validates shape + regex up front so a bad value rejects loudly.
      if (target.pathPatternSources.includes(value)) return false;
      const compiled = parsePathRule(value);
      target.pathPatternSources.push(value);
      target.pathPatterns.push(compiled);
    }

    if (typeof scope === 'object' && 'project' in scope) this.persistProject(scope.project, target);
    return true;
  }

  // Removes a rule; project scope re-persists the file, session scope is memory-only.
  // Returns false when the rule wasn't present.
  removeRule(kind: RuleKind, value: string, scope: RuleScope = 'global'): boolean {
    if (typeof scope === 'object' && 'action' in scope) {
      // Action-scoped rules persist via ActionsStore, which has no removal API yet —
      // they're managed through the action editor flow instead.
      return false;
    }
    const target = scope === 'global' ? this.global
      : 'session' in scope ? this.sessionRules.get(scope.session)
      : this.loadProject(scope.project);
    if (!target) return false;
    let removed = false;
    if (kind === 'tool') {
      removed = target.alwaysAllow.delete(value);
    } else {
      const [sources, compiled]: [string[], unknown[]] =
        kind === 'bash' ? [target.bashPatternSources, target.bashPatterns]
        : kind === 'mcp' ? [target.mcpPatternSources, target.mcpPatterns]
        : [target.pathPatternSources, target.pathPatterns];
      const i = sources.indexOf(value);
      if (i >= 0) {
        sources.splice(i, 1);
        compiled.splice(i, 1);
        removed = true;
      }
    }
    if (removed && typeof scope === 'object' && 'project' in scope) this.persistProject(scope.project, target);
    return removed;
  }

  // Drops every session-scoped rule for a session. Called when the session ends.
  clearSession(sessionId: string): void {
    this.sessionRules.delete(sessionId);
  }

  private loadSession(sessionId: string): CompiledRules {
    let rules = this.sessionRules.get(sessionId);
    if (!rules) {
      rules = emptyCompiled();
      this.sessionRules.set(sessionId, rules);
    }
    return rules;
  }

  private persistProject(project: string, target: CompiledRules): void {
    if (!this.projectDir) return;
    // 0o700 dir + 0o600 file: these files gate which tool calls auto-execute, so
    // only the daemon's user should be able to read or modify them. Other local
    // users seeing the list (or worse, writing to it) would let them either probe
    // for what's been blessed or grant themselves auto-execution.
    mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
    const path = join(this.projectDir, `${sanitizeCwd(project)}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(toConfigFromRules(target), null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  }

  // Serialize current state back to the on-disk JSON shape. Used by the daemon to persist
  // hot-added rules so they survive a restart. Action scope persists via ActionsStore;
  // this method only handles global + project.
  toConfig(scope: 'global' | { project: string } = 'global'): AllowlistConfig {
    return toConfigFromRules(scope === 'global' ? this.global : this.loadProject(scope.project));
  }
}

// Whether a call is one this config *gates* — i.e. it is only reachable because a gated
// group granted it, so it needs an approved pin before it may run. Deliberately ANY-clause
// (not every-clause like `allows`): `git status && git push` must gate on the push.
export function gatedMatch(cfg: ActionAllowlist, toolName: string, toolInput: unknown): boolean {
  const rules = compileFromConfig(cfg);
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: unknown })?.command;
    if (typeof cmd !== 'string') return false;
    // Mirrors rulesAllow's whole-tool shortcut so the two functions can't disagree about
    // the same config: a gated group handing out bare `alwaysAllow: ['Bash']` has granted
    // arbitrary external writes, so every command under it needs a pin, parseable or not.
    if (rules.alwaysAllow.has('Bash')) return true;
    const clauses = splitShellClauses(cmd);
    if (clauses === null) return false;
    return clauses.some((c) => rules.bashPatterns.some((p) => p.test(stripLeadingAssignments(c.text))));
  }
  return rulesAllow(rules, toolName, toolInput);
}
