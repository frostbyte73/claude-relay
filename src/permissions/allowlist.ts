import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRegistry } from '../actions/index.js';
import type { ActionAllowlist } from '../actions/types.js';
import { literalRedirectPath, readWordAt, splitShellClauses, stripLeadingAssignments } from './shell-split.js';
import { clausesShellSafe, unsafeClauseReason } from './shell-safety.js';
import { extractFileReferences, isValidTmpFilePath } from './file-flags.js';
import { refusedWrite } from './dangerous-writes.js';
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
export const PATH_INPUT_FIELDS: Record<string, ReadonlyArray<string>> = {
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

// The bash verbs `edit`'s `^(mkdir|mv|cp|touch|rm|rmdir|ln|chmod)(\s|$)` pattern hands out with
// no path scoping at all. `Write` and `Edit` are already confined to the session worktree (or
// a `Write:`-style path grant); this is the same treatment for their bash equivalents.
//
// `mkdir` is deliberately excluded (Ship 5 round 4). It cannot overwrite an existing file,
// expose one, or destroy one — the worst it can do unscoped is bring an empty directory into
// existence, and the clause is still gated by whatever bash rule granted it in the first place
// (e.g. `write.add-project`'s own `^mkdir -p[ \t]+...` pattern, which already anchors the shape
// of path it accepts). Folding `mkdir` into this set anyway forced every action that legitimately
// creates a directory outside its worktree to also carry a `Write:`-style path rule — but that
// rule is the *same* one the `Write` tool check consults, so "may `mkdir` here" and "may `Write`
// here" collapsed into one grant. Three review rounds (see the ship's report) each tried to
// scope that one rule narrowly enough to cover only the directory-creation case and each still
// over-granted the `Write` tool — `Write:^/Users/[^/]+/` (any home directory), then a version
// unconstrained below its first segment (`/Users/testuser/livekit/.git/hooks/post-commit` writable),
// then one unconstrained on `/Users/Shared`, other users' homes, and unbounded repo-tree depth.
// The mechanism, not the regex, was wrong: one path-rule vocabulary was being asked to answer two
// different questions ("may this directory be created" vs "may this file be written"). `rmdir`
// stays scoped — it acts on an existing directory, not the low-damage "doesn't exist yet" case.
const SCOPED_FILE_OPS = new Set(['mv', 'cp', 'touch', 'rm', 'rmdir', 'ln', 'chmod']);

// Commands whose operands are files they READ. The read-side mirror of SCOPED_FILE_OPS, and
// deliberately a superset of what `core` grants today (`cat`, `jq`): a bar that only covered
// the two commands currently reachable would have to be revisited the first time a reading
// verb is added to a group, which is exactly when nobody is looking.
const READ_COMMANDS = new Set([
  'cat', 'jq', 'head', 'tail', 'nl', 'xxd', 'od', 'wc', 'file', 'stat', 'sort', 'cut', 'uniq',
]);

// The one path an action may name without being able to resolve it. Double-quoted only: bare
// `$OUTPOST_ENVELOPE` is refused upstream as an unquoted expansion (shell-safety.ts), and the
// single-quoted spelling would reach the program as a literal filename that does not exist.
const ENVELOPE_WORDS: ReadonlySet<string> = new Set([
  '"$OUTPOST_ENVELOPE"', '"${OUTPOST_ENVELOPE}"',
]);

// chmod's first non-flag word is a mode (`777`, `+x`, `u+rwx,go-w`), not a path — recognising
// it is what keeps chmod usable at all once its paths are scoped. Anything that doesn't match
// falls through to the same strict default every other argument gets: treated as a path and
// required to be in scope.
const CHMOD_MODE_RE = /^(?:[0-7]{1,4}|[ugoa]*[+\-=][rwxXstugo]*(?:,[ugoa]*[+\-=][rwxXstugo]*)*)$/;

// A `--flag=value` word starting with `-` reads as a flag to the classifier below, which would
// let `cp --target-directory=/etc file` smuggle a destination past it. Only worth the extra
// look when the value has a shape a path or an unresolvable expansion would have — a bare
// word like `--preserve=mode` is neither and isn't worth flagging.
function looksPathLike(value: string): boolean {
  return value.includes('/') || /^[~$`]/.test(value);
}

// A redirect operator at the current scan position, optionally preceded by a bare fd number
// with no space (`2>`, `0<` — a space there means something else, e.g. `2 > file` is three
// plain words). Longest-first so `<<<` doesn't read as `<<` plus a stray `<`. Input forms are
// included (unlike `matchRedirect`, which is write-only) because this scan has to step over
// every redirect in the clause, read or write, to keep reading the operand words after it.
const REDIRECT_AT_START = /^([0-9]*)(<<<|<<|<&|<|&>>|&>|>>|>\||>&|>)/;

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
  //
  // An action's declared permission groups are the whole of what it may do. Global and
  // project scope accumulate from interactive approvals, which no action participated in
  // and no action's frontmatter declares — consulting them silently widens every action
  // past its own declaration. Session scope stays: it is explicitly granted in-session and
  // dies with it.
  private scopesFor(projectCwd?: string, actionName?: string, sessionId?: string): CompiledRules[] {
    const scopes: CompiledRules[] = [];
    if (actionName) {
      // Bundled action defaults come first (colocated allowlist.json under actions/).
      const action = this.actionRegistry?.getAction(actionName);
      if (action) scopes.push(compileFromConfig(action.allowlist));
      // Then hot-added user overrides (~/.outpost/actions.json).
      if (this.actionsStore) scopes.push(compileFromConfig(this.actionsStore.get(actionName).allowlist));
    } else {
      scopes.push(this.global);
      if (projectCwd) scopes.push(this.loadProject(projectCwd));
    }
    if (sessionId) {
      const rules = this.sessionRules.get(sessionId);
      if (rules) scopes.push(rules);
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

  // The third bar, and the one that lets `push`'s rules be verb-anchored instead of
  // flag-by-flag enumerations. A file-referencing flag (`--input`/`--body-file`/`--notes-file`)
  // names a file whose CONTENTS travel to the destination, while the command text — all the
  // write-draft card can show, and all `matchPinnedCall` pins — says only which path. So
  // `gh pr create --body-file /Users/you/.ssh/id_rsa` reads as an ordinary approval and posts a
  // private key to a public PR.
  //
  // `isValidTmpFilePath` is deliberately the SAME predicate `parseDraftCalls` gates a draft's
  // inline `files` map with, and that identity is the entire guarantee: a call may only
  // reference a file whose contents the approval card is able to render, so the user is never
  // asked to approve a path standing in for a payload they cannot see. Enforced structurally
  // here rather than spelled into every rule, because it was previously re-stated in ten
  // separate `push` patterns and a new rule that forgot it silently reopened the hole.
  //
  // Unresolvable input fails closed: extractFileReferences returns null for a command that
  // doesn't parse, a flag with no value, or a value carrying `$`/backtick — the checker sees
  // command text, never the path that will actually be opened.
  private fileFlagsAllowed(cmd: string): boolean {
    const paths = extractFileReferences(cmd);
    if (paths === null) return false;
    return paths.every(isValidTmpFilePath);
  }

  // The read-side counterpart of fileOpArgsAllowed, and the reason `core` can keep `^cat ` and
  // `^jq ` as two-word rules instead of growing a regex that tries to spell out which file an
  // action may open. A bash rule gates a clause by its leading command, which says nothing
  // about the paths it reads — `^cat ` is every file on the machine, and `^jq ` is the same
  // reach in a second spelling, so narrowing one and not the other would be theatre.
  //
  // Exempt under a whole-tool `Read` grant, exactly as redirectsAllowed is under a whole-tool
  // `Bash` one: `alwaysAllow: ['Read']` is an explicit "read anything", so gating its bash
  // equivalents would deny nothing while breaking every action that legitimately reads a repo.
  // In practice that means this bar applies to precisely the actions that inherit `core` and
  // no read grant — the ones that never declared a wish to read files at all.
  private readArgsAllowed(cmd: string, scopes: CompiledRules[], sessionWorktreePath?: string): boolean {
    if (scopes.some((s) => s.alwaysAllow.has('Read'))) return true;
    const clauses = splitShellClauses(cmd);
    if (clauses === null) return false;
    for (const clause of clauses) {
      const body = stripLeadingAssignments(clause.text);
      const head = readWordAt(body, 0);
      if (!head || !READ_COMMANDS.has(head)) continue;
      const ok = this.walkOperands(
        body.slice(head.length),
        head === 'jq' ? () => true : undefined,
        (operand) => this.readArgAllowed(operand, scopes, sessionWorktreePath),
      );
      if (!ok) return false;
    }
    return true;
  }

  // One operand of a read command. `$OUTPOST_ENVELOPE` is the single path an action can name
  // without knowing its value — the daemon exports it into every spawned session
  // (claude-proc.ts) — and the checker sees command text, never the expansion, so it is
  // recognised by spelling. That recognition lives HERE, in one place, rather than in every
  // rule that wants to permit reading the envelope.
  private readArgAllowed(word: string, scopes: CompiledRules[], sessionWorktreePath?: string): boolean {
    if (ENVELOPE_WORDS.has(word)) return true;
    const path = literalRedirectPath(word);
    if (path === null) return false;
    if (sessionWorktreePath && isPathUnder(path, sessionWorktreePath)) return true;
    return scopes.some((s) => rulesAllow(s, 'Read', { file_path: path }));
  }

  // A second bar a scoped file-op clause has to clear, mirroring redirectsAllowed: `mkdir`,
  // `mv`, `cp`, `touch`, `rm`, `rmdir`, `ln`, `chmod` are granted against any path on the
  // machine today — `cp ~/.ssh/id_rsa /tmp/x`, `rm -rf ~/Documents`, `chmod 777 /etc/passwd`
  // all auto-approve. Every argument that isn't confidently a flag is treated as a path and
  // must resolve inside the session worktree or a granted Write-style path rule; getting that
  // wrong in the permissive direction is exactly the hole this closes, so the default is strict.
  private fileOpArgsAllowed(cmd: string, scopes: CompiledRules[], sessionWorktreePath?: string): boolean {
    const clauses = splitShellClauses(cmd);
    if (clauses === null) return false;
    for (const clause of clauses) {
      const body = stripLeadingAssignments(clause.text);
      // The command word is always readable cleanly here: bashPatternsMatch already required
      // one of `^(mkdir|mv|…)` to match this same `body` for the clause to have gotten this
      // far, which means it starts with a plain word, not a redirect or a metacharacter.
      const head = readWordAt(body, 0);
      if (!head || !SCOPED_FILE_OPS.has(head)) continue;
      if (!this.scopedOperandsAllowed(body.slice(head.length), head, scopes, sessionWorktreePath)) return false;
    }
    return true;
  }

  // Walks the rest of a clause after its command word, classifying every token as a redirect
  // (skipped whole — redirectsAllowed already owns write targets, and an input redirect writes
  // nothing so neither needs scoping here), a flag, or an operand, and hands each operand to
  // `check`. A token this scan can't account for — a process substitution standing in for a
  // path bash would generate dynamically at runtime, or a stray shell metacharacter — denies
  // rather than ending the scan early: treating "I could not parse this" as "there is nothing
  // left to check" is exactly the class of bug this whole gate exists to close, one layer up.
  //
  // Shared by the write-side scoping (fileOpArgsAllowed) and the read-side one
  // (readArgsAllowed). They ask different questions ABOUT the operands, but they have to FIND
  // them identically, and the finding is where the subtle failures live.
  //
  // `firstOperandNotAPath` covers the commands whose leading operand isn't a file: chmod's mode
  // (`777`, `u+rwx`) and jq's filter (`.pr.number`). Consulted once, on the first operand only.
  private walkOperands(
    rest: string,
    firstOperandNotAPath: ((word: string) => boolean) | undefined,
    check: (operand: string) => boolean,
  ): boolean {
    let i = 0;
    let sawFirstOperand = false;
    let sawDoubleDash = false;
    while (i < rest.length) {
      if (rest[i] === ' ' || rest[i] === '\t') { i++; continue; }
      const redir = REDIRECT_AT_START.exec(rest.slice(i));
      if (redir && rest[i + redir[0].length] !== '(') {
        i += redir[0].length;
        while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
        const target = readWordAt(rest, i);
        if (!target) {
          if (i >= rest.length) break; // nothing left after the redirect — a genuine end
          return false; // a redirect target this scan can't read — e.g. another bare metachar
        }
        i += target.length;
        continue;
      }
      // `<(...)`/`>(...)`: bash substitutes a dynamically generated path (`/dev/fd/N`) here,
      // never a literal one this checker can resolve or scope — so it can't be trusted as
      // either a flag or an in-scope operand. Deny rather than guess at where its span ends.
      if ((rest[i] === '<' || rest[i] === '>') && rest[i + 1] === '(') return false;
      const word = readWordAt(rest, i);
      if (!word) return false; // a shell metacharacter this scan doesn't otherwise account for
      i += word.length;
      if (!sawDoubleDash && word === '--') { sawDoubleDash = true; continue; }
      if (!sawDoubleDash && word.startsWith('-')) {
        const eq = word.indexOf('=');
        const value = eq >= 0 ? word.slice(eq + 1) : '';
        if (eq < 0 || !looksPathLike(value)) continue;
        if (!check(value)) return false;
        continue;
      }
      if (!sawFirstOperand) {
        sawFirstOperand = true;
        if (firstOperandNotAPath?.(word)) continue;
      }
      if (!check(word)) return false;
    }
    return true;
  }

  private scopedOperandsAllowed(
    rest: string, head: string, scopes: CompiledRules[], sessionWorktreePath?: string,
  ): boolean {
    return this.walkOperands(
      rest,
      head === 'chmod' ? (w) => CHMOD_MODE_RE.test(w) : undefined,
      (operand) => this.pathArgAllowed(operand, scopes, sessionWorktreePath),
    );
  }

  // One argument word, resolved exactly like a redirect target: unresolvable ($VAR, $(…),
  // backtick, ~, glob, or any relative path — the checker sees command text, never the cwd the
  // clause will actually run in) denies before any rule is consulted; otherwise it must be
  // under the session's own worktree or covered by a granted Write-style path rule.
  private pathArgAllowed(word: string, scopes: CompiledRules[], sessionWorktreePath?: string): boolean {
    const path = literalRedirectPath(word);
    if (path === null) return false;
    if (sessionWorktreePath && isPathUnder(path, sessionWorktreePath)) return true;
    return scopes.some((s) => rulesAllow(s, 'Write', { file_path: path }));
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

    const refused = refusedWrite(cmd);
    if (refused) return { kind: 'none', reason: refused.message };

    if (!this.readArgsAllowed(cmd, scopes, ctx.sessionWorktreePath)) {
      return {
        kind: 'none',
        reason: 'a read of a file outside this action\'s reach — cat/jq may open '
          + '"$OUTPOST_ENVELOPE", a path inside the session\'s own worktree, or a path a Read: '
          + 'rule grants; an action that needs more should inherit the `read` group',
      };
    }

    // Fatal whatever else is wrong, and no rule can express a fix — the constraint is
    // structural (see fileFlagsAllowed), so it outranks a missing clause rule the same way
    // an unresolvable redirect target does.
    const fileRefs = extractFileReferences(cmd);
    if (fileRefs === null) {
      return { kind: 'none', reason: 'a --input/--body-file/--notes-file path this checker cannot read literally' };
    }
    const offending = fileRefs.find((p) => !isValidTmpFilePath(p));
    if (offending !== undefined) {
      return {
        kind: 'none',
        reason: `--input/--body-file/--notes-file must point under /tmp/ so the approval card can `
          + `show the body being sent; got "${offending}"`,
      };
    }

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
        if (!this.fileOpArgsAllowed(cmd, scopes, sessionWorktreePath)) return false;
        if (!this.readArgsAllowed(cmd, scopes, sessionWorktreePath)) return false;
        if (!this.fileFlagsAllowed(cmd)) return false;
        // The short refuse-list (see dangerous-writes.ts): the handful of writes where a
        // human clicking approve is not an outcome worth having, so no pin can authorise
        // them. Everything else dangerous is surfaced as a warning on the draft instead.
        if (refusedWrite(cmd)) return false;
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
      if (!this.actionsStore) throw new Error('action scope requires actionsStore');
      return this.actionsStore.removeRule(scope.action, kind, value);
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
