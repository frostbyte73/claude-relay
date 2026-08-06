import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRegistry } from '../actions/index.js';

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
  const absPath = resolve(path);
  const absPrefix = resolve(prefix);
  const realPath = realpathAncestor(absPath);
  const realPrefix = (() => { try { return realpathSync(absPrefix); } catch { return absPrefix; } })();
  if (realPath === realPrefix) return true;
  const withSlash = realPrefix.endsWith('/') ? realPrefix : `${realPrefix}/`;
  return realPath.startsWith(withSlash);
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

export interface ShellClause {
  // Clause text as written, redirections included — what the bash patterns match against.
  text: string;
  // Verbatim (still quoted/escaped) target words of the clause's file-creating
  // redirections. fd duplications (`2>&1`, `>&2`) and input redirections contribute
  // nothing: neither can create or truncate a file.
  writeTargets: string[];
}

type RedirKind = 'write' | 'dup-out';

// Longest-first, so `&>>` wins over `&>` and `>>` over `>`. `<`, `<<`, `<<<` and `<&`
// are absent on purpose — they read. `<>` is not listed either: its `<` falls through
// to the buffer and the `>` is then matched here as a plain write, which is the
// conservative reading of a read-write open.
const REDIR_OPS: ReadonlyArray<readonly [string, RedirKind]> = [
  ['&>>', 'write'], ['&>', 'write'],
  ['>>', 'write'], ['>|', 'write'], ['>&', 'dup-out'], ['>', 'write'],
];

function matchRedirect(s: string, i: number): { len: number; kind: RedirKind } | null {
  const c = s[i];
  if (c !== '>' && !(c === '&' && s[i + 1] === '>')) return null;
  for (const [op, kind] of REDIR_OPS) {
    if (s.startsWith(op, i)) return { len: op.length, kind };
  }
  return null;
}

// Read one shell word out of `s` starting at `start`, keeping its quoting verbatim.
// Stops at unquoted whitespace or the next metacharacter — the same boundaries the
// splitter uses, so a target never swallows the operator that follows it.
function readWordAt(s: string, start: number): string {
  let out = '';
  let i = start;
  let sq = false;
  let dq = false;
  while (i < s.length) {
    const c = s.charAt(i);
    if (sq) { out += c; if (c === "'") sq = false; i++; continue; }
    if (dq) {
      if (c === '\\' && i + 1 < s.length) { out += c + s[i + 1]; i += 2; continue; }
      out += c; if (c === '"') dq = false; i++; continue;
    }
    if (c === '\\' && i + 1 < s.length) { out += c + s[i + 1]; i += 2; continue; }
    if (c === "'") { sq = true; out += c; i++; continue; }
    if (c === '"') { dq = true; out += c; i++; continue; }
    if (/[\s;|&<>()]/.test(c)) break;
    out += c; i++;
  }
  return out;
}

// `>&1`, `>&-`, `2>&3` name a file descriptor. Anything else after `>&` is bash's
// legacy spelling of `&>file` and is a real path write.
const FD_TARGET = /^(\d+-?|-)$/;

// Split a bash command into the per-clause list an allowlist must independently
// allow: top-level statements + inner commands of $(…), `…`, <(…), >(…), each with
// the redirection targets it writes to. Null on unbalanced quotes / parens. Does not
// understand heredocs, `eval`, or `bash -c "…"` — the mitigation is to not allowlist
// those interpreters.
export function splitShellClauses(cmd: string): ShellClause[] | null {
  const clauses: ShellClause[] = [];

  function findBalancedParen(s: string, openIdx: number): number {
    let depth = 0;
    let sq = false;
    let dq = false;
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i];
      if (sq) { if (c === "'") sq = false; continue; }
      if (dq) {
        if (c === '\\' && i + 1 < s.length) { i++; continue; }
        if (c === '"') dq = false;
        continue;
      }
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === "'") { sq = true; continue; }
      if (c === '"') { dq = true; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function findBacktickEnd(s: string, openIdx: number): number {
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) { i++; continue; }
      if (s[i] === '`') return i;
    }
    return -1;
  }

  function walk(s: string): boolean {
    let buf = '';
    let sq = false;
    let dq = false;
    let i = 0;
    // Offsets into `buf` where a redirection target word begins. Recorded rather than
    // consumed so the main loop still recurses into a `$(…)` sitting in the target.
    let marks: Array<{ start: number; kind: RedirKind }> = [];
    const flush = () => {
      const t = buf.trim();
      if (t) {
        const writeTargets: string[] = [];
        for (const m of marks) {
          const word = readWordAt(buf, m.start);
          if (m.kind === 'dup-out' && FD_TARGET.test(word)) continue;
          writeTargets.push(word);
        }
        clauses.push({ text: t, writeTargets });
      }
      buf = '';
      marks = [];
    };
    while (i < s.length) {
      const c = s[i];
      if (sq) {
        if (c === "'") sq = false;
        buf += c; i++; continue;
      }
      if (dq) {
        if (c === '\\' && i + 1 < s.length) { buf += c + s[i + 1]; i += 2; continue; }
        if (c === '"') { dq = false; buf += c; i++; continue; }
        if (c === '`') {
          const end = findBacktickEnd(s, i);
          if (end < 0) return false;
          if (!walk(s.slice(i + 1, end))) return false;
          buf += s.slice(i, end + 1); i = end + 1; continue;
        }
        if (c === '$' && s[i + 1] === '(') {
          const end = findBalancedParen(s, i + 1);
          if (end < 0) return false;
          if (!walk(s.slice(i + 2, end))) return false;
          buf += s.slice(i, end + 1); i = end + 1; continue;
        }
        buf += c; i++; continue;
      }
      if (c === '\\' && i + 1 < s.length) { buf += c + s[i + 1]; i += 2; continue; }
      if (c === "'") { sq = true; buf += c; i++; continue; }
      if (c === '"') { dq = true; buf += c; i++; continue; }
      if (c === '`') {
        const end = findBacktickEnd(s, i);
        if (end < 0) return false;
        if (!walk(s.slice(i + 1, end))) return false;
        buf += s.slice(i, end + 1); i = end + 1; continue;
      }
      if (c === '$' && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        buf += s.slice(i, end + 1); i = end + 1; continue;
      }
      if ((c === '<' || c === '>') && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        buf += s.slice(i, end + 1); i = end + 1; continue;
      }
      // Output redirection. Consuming the operator keeps `>|` from splitting on its `|`
      // and keeps `&>` from splitting on its `&`; the target word itself is left to the
      // main loop so substitutions inside it still get walked.
      const redir = matchRedirect(s, i);
      if (redir) {
        buf += s.slice(i, i + redir.len); i += redir.len;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) { buf += s[i]; i++; }
        marks.push({ start: buf.length, kind: redir.kind });
        continue;
      }
      if (c === ';' || c === '\n') { flush(); i++; continue; }
      if (c === '&' && s[i + 1] === '&') { flush(); i += 2; continue; }
      if (c === '|' && s[i + 1] === '|') { flush(); i += 2; continue; }
      if (c === '|') { flush(); i++; continue; }
      // `&` is only a job-control separator when it stands alone. Adjacent to `<`/`>`
      // it's part of an fd redirection — append it to the current clause instead of
      // splitting. matchRedirect above already swallows the output forms (`2>&1`,
      // `>&2`, `&>file`, `&>>file`); what still reaches here is `<&3`.
      if (c === '&' && (buf.endsWith('<') || buf.endsWith('>') || s[i + 1] === '>')) {
        buf += c; i++; continue;
      }
      if (c === '&') { flush(); i++; continue; }
      buf += c; i++;
    }
    if (sq || dq) return false;
    flush();
    return true;
  }

  if (!walk(cmd)) return null;
  return clauses;
}

export function splitShellCommand(cmd: string): string[] | null {
  return splitShellClauses(cmd)?.map((c) => c.text) ?? null;
}

// The literal filesystem path a redirection target names, or null when it can't be
// known statically. Expansions ($VAR, $(…), `…`, ~), globs, and relative paths all
// answer null: the daemon sees the command text, never the expanded value, and never
// the cwd the shell will actually be in by the time the clause runs (an earlier
// `cd` in the same command would move it). Unknowable means denied.
export function literalRedirectPath(word: string): string | null {
  let out = '';
  let i = 0;
  let sq = false;
  let dq = false;
  while (i < word.length) {
    const c = word.charAt(i);
    if (sq) {
      if (c === "'") { sq = false; i++; continue; }
      out += c; i++; continue;
    }
    if (dq) {
      if (c === '\\' && i + 1 < word.length) { out += word[i + 1]; i += 2; continue; }
      if (c === '"') { dq = false; i++; continue; }
      if (c === '$' || c === '`') return null;
      out += c; i++; continue;
    }
    if (c === '\\' && i + 1 < word.length) { out += word[i + 1]; i += 2; continue; }
    if (c === "'") { sq = true; i++; continue; }
    if (c === '"') { dq = true; i++; continue; }
    if (c === '$' || c === '`' || c === '~' || c === '*' || c === '?' || c === '[') return null;
    out += c; i++;
  }
  if (!out.startsWith('/')) return null;
  return resolve(out);
}

// Every path a Bash command would create or truncate by redirection, skipping the ones
// that can't be resolved statically. Used to suggest a grant after a denial; the gate
// itself treats an unresolvable target as fatal, which this can't express.
export function resolvableWriteTargets(cmd: string): string[] {
  const clauses = splitShellClauses(cmd);
  if (!clauses) return [];
  const out: string[] = [];
  for (const c of clauses) {
    for (const w of c.writeTargets) {
      const p = literalRedirectPath(w);
      if (p !== null) out.push(p);
    }
  }
  return out;
}

// Peel leading bash NAME=value words off a clause so the allowlist gates on
// the command, not on the assignment prefix. Pure-assignment clauses return ''.
export function stripLeadingAssignments(clause: string): string {
  let i = 0;
  while (i < clause.length) {
    while (i < clause.length && (clause[i] === ' ' || clause[i] === '\t')) i++;
    if (i >= clause.length) break;
    const nameStart = i;
    if (!/[A-Za-z_]/.test(clause.charAt(i))) break;
    i++;
    while (i < clause.length && /[A-Za-z0-9_]/.test(clause.charAt(i))) i++;
    if (clause[i] !== '=') { i = nameStart; break; }
    i++; // consume '='
    // consume one shell word as value: until unquoted whitespace.
    let sq = false;
    let dq = false;
    while (i < clause.length) {
      const c = clause[i];
      if (sq) { if (c === "'") sq = false; i++; continue; }
      if (dq) {
        if (c === '\\' && i + 1 < clause.length) { i += 2; continue; }
        if (c === '"') dq = false;
        i++; continue;
      }
      if (c === ' ' || c === '\t') break;
      if (c === '\\' && i + 1 < clause.length) { i += 2; continue; }
      if (c === "'") { sq = true; i++; continue; }
      if (c === '"') { dq = true; i++; continue; }
      if (c === '$' && clause[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        while (j < clause.length) {
          if (clause[j] === '(') depth++;
          else if (clause[j] === ')') { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
        i = j; continue;
      }
      if (c === '`') {
        let j = i + 1;
        while (j < clause.length && clause[j] !== '`') {
          if (clause[j] === '\\' && j + 1 < clause.length) j++;
          j++;
        }
        i = j + 1; continue;
      }
      i++;
    }
  }
  return clause.slice(i).trimStart();
}

function rulesAllow(rules: CompiledRules, toolName: string, toolInput: unknown): boolean {
  if (rules.alwaysAllow.has(toolName)) return true;
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string })?.command;
    if (typeof cmd !== 'string') return false;
    const clauses = splitShellCommand(cmd);
    if (clauses === null || clauses.length === 0) return false;
    return clauses.every((c) => {
      const body = stripLeadingAssignments(c);
      if (body === '') return true;
      return rules.bashPatterns.some((p) => p.test(body));
    });
  }
  if (toolName.startsWith('mcp__')) {
    return rules.mcpPatterns.some((p) => p.test(toolName));
  }
  // Path-scoped rule: tool name must match AND the path-shaped input matches the regex.
  if (PATH_INPUT_FIELDS[toolName]) {
    const path = readPathInput(toolName, toolInput);
    // `..` must not walk out from under an anchored prefix rule: `Write:^/tmp/` should not
    // admit `/tmp/../etc/crontab`. A relative path is tested as written — the daemon can't
    // know the cwd it resolves against, and every path rule is absolute-anchored, so it denies.
    const probe = path !== undefined && path.startsWith('/') ? resolve(path) : path;
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
        const asWrite = { file_path: path };
        if (scopes.some((s) => rulesAllow(s, 'Write', asWrite))) continue;
        if (sessionWorktreePath && isPathUnder(path, sessionWorktreePath)) continue;
        return false;
      }
    }
    return true;
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
