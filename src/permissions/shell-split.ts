// Bash lexing for the allowlist: split a command into the clauses a rule must
// independently allow, and read the redirection targets each clause writes to. No
// knowledge of rules or scopes lives here — `allowlist.ts` is what judges the output.

import { resolve } from 'node:path';

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

export function matchRedirect(s: string, i: number): { len: number; kind: RedirKind } | null {
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
export function readWordAt(s: string, start: number): string {
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

// Skip the double-quoted string starting at `s[i] === '"'`, returning the index just past its
// closing quote (or s.length when unterminated). Substitutions inside carry quotes of their
// own, so they have to be skipped whole or the quote state comes out inverted.
export function skipDoubleQuoted(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === '`') { const e = findBacktickEnd(s, i); if (e < 0) return s.length; i = e + 1; continue; }
    if (c === '$' && s[i + 1] === '(') { const e = findBalancedParen(s, i + 1); if (e < 0) return s.length; i = e + 1; continue; }
    i++;
  }
  return s.length;
}

// Split a bash command into the per-clause list an allowlist must independently
// allow: top-level statements + inner commands of $(…), `…`, <(…), >(…), each with
// the redirection targets it writes to. Comments are dropped, as bash drops them. Null on
// unbalanced quotes / parens. Does not understand heredocs, `eval`, or `bash -c "…"` — the
// mitigation is to not allowlist those interpreters.
export function splitShellClauses(cmd: string): ShellClause[] | null {
  const clauses: ShellClause[] = [];

  // A comment's text is never executed, so it is dropped from the clause — but the
  // splitter can't tell a comment from a heredoc body line that merely starts with `#`,
  // and an unquoted-delimiter heredoc DOES expand `$(…)` on such a line. So the skipped
  // span is still walked for substitutions: they stay clauses even when the text around
  // them turns out to be a real comment (a false denial), because the alternative is
  // hiding a command bash actually runs.
  function walkSubstitutions(s: string): boolean {
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '`') {
        const end = findBacktickEnd(s, i);
        if (end < 0) return false;
        if (!walk(s.slice(i + 1, end))) return false;
        i = end + 1; continue;
      }
      if ((c === '$' || c === '<' || c === '>') && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        i = end + 1; continue;
      }
      i++;
    }
    return true;
  }

  function walk(s: string): boolean {
    let buf = '';
    let sq = false;
    let dq = false;
    let i = 0;
    // `#` opens a comment only at the start of a word — at the start of the input, after
    // unquoted whitespace, or after a metacharacter. `a#b`, `--format=%h#%s` and a URL
    // fragment are all plain text, and so is a `#` that follows a closing quote or a
    // substitution, which continue the word they are part of.
    let wordStart = true;
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
      wordStart = true;
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
      // A comment runs to the end of its LINE, not the end of the command, and a `\` inside
      // one does not continue it — bash ends the comment at the newline and runs what
      // follows. The newline is left for the separator below so the next line still becomes
      // its own clause.
      if (c === '#' && wordStart) {
        const nl = s.indexOf('\n', i);
        const end = nl < 0 ? s.length : nl;
        if (!walkSubstitutions(s.slice(i, end))) return false;
        i = end; continue;
      }
      // A line continuation splices the two lines into one, so whether a `#` on the next
      // line starts a word is decided by what preceded the backslash.
      if (c === '\\' && i + 1 < s.length) {
        buf += c + s[i + 1];
        if (s[i + 1] !== '\n') wordStart = false;
        i += 2; continue;
      }
      if (c === "'") { sq = true; buf += c; wordStart = false; i++; continue; }
      if (c === '"') { dq = true; buf += c; wordStart = false; i++; continue; }
      if (c === '`') {
        const end = findBacktickEnd(s, i);
        if (end < 0) return false;
        if (!walk(s.slice(i + 1, end))) return false;
        buf += s.slice(i, end + 1); wordStart = false; i = end + 1; continue;
      }
      if (c === '$' && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        buf += s.slice(i, end + 1); wordStart = false; i = end + 1; continue;
      }
      if ((c === '<' || c === '>') && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        buf += s.slice(i, end + 1); wordStart = false; i = end + 1; continue;
      }
      // Output redirection. Consuming the operator keeps `>|` from splitting on its `|`
      // and keeps `&>` from splitting on its `&`; the target word itself is left to the
      // main loop so substitutions inside it still get walked.
      const redir = matchRedirect(s, i);
      if (redir) {
        buf += s.slice(i, i + redir.len); i += redir.len;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) { buf += s[i]; i++; }
        marks.push({ start: buf.length, kind: redir.kind });
        // The operator ends the word before it, so a `#` here is a comment — bash rejects
        // `ls > #foo` for having no target. The mark then reads an empty target word, which
        // is what a redirection nothing can name should look like: unwritable.
        wordStart = true;
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
        buf += c; wordStart = false; i++; continue;
      }
      if (c === '&') { flush(); i++; continue; }
      buf += c;
      wordStart = c === ' ' || c === '\t';
      i++;
    }
    if (sq || dq) return false;
    flush();
    return true;
  }

  if (!walk(cmd)) return null;
  return clauses;
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

// Names a leading `NAME=value` may not carry. The prefix is peeled off before the clause is
// pattern-matched and every clause of one Bash call shares a shell, so a name the shell or an
// allowlisted program consults for program resolution turns `^cat ` into "run my binary" and
// `^git diff` into "run my diff driver". The influence surface is unbounded in general —
// every program reads its own environment — so this is the conservative shape: shell
// specials, the dynamic loaders, the tool families the permission groups actually grant, and
// the suffixes that name a path, a command, or an option list.
const UNSAFE_ASSIGN_EXACT = new Set([
  'PATH', 'IFS', 'ENV', 'CDPATH', 'GLOBIGNORE', 'HOME', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP',
  'SHELL', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4', 'POSIXLY_CORRECT',
  'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'LESS', 'LESSOPEN', 'LESSCLOSE',
  'GOFLAGS', 'GOROOT', 'GOBIN', 'GOCACHE', 'GOENV', 'GOPROXY', 'GOPRIVATE', 'GOMODCACHE', 'GOTMPDIR',
]);
const UNSAFE_ASSIGN_PREFIX = [
  'LD_', 'DYLD_', 'BASH_', 'GIT_', 'GH_', 'NODE_', 'PYTHON', 'PERL', 'RUBY', 'JAVA_',
  'NPM_', 'YARN_', 'CURL_', 'SSL_', 'SSH_', 'GPG_', 'RIPGREP_', 'GREP_',
];
const UNSAFE_ASSIGN_SUFFIX = [
  'PATH', 'OPTS', 'OPTIONS', 'PRELOAD', 'LIBRARIES', 'CONFIG', 'HOME', 'CMD', 'COMMAND',
  'SHELL', 'EDITOR', 'PAGER',
];

function isSafeAssignName(name: string): boolean {
  return !UNSAFE_ASSIGN_EXACT.has(name)
    && !UNSAFE_ASSIGN_PREFIX.some((p) => name.startsWith(p))
    && !UNSAFE_ASSIGN_SUFFIX.some((s) => name.endsWith(s));
}

// Peel leading bash NAME=value words off a clause so the allowlist gates on
// the command, not on the assignment prefix. Pure-assignment clauses return ''.
// Peeling stops at the first name that could redirect program resolution, so the clause is
// then matched with that assignment still in it — which no anchored pattern accepts.
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
    if (!isSafeAssignName(clause.slice(nameStart, i))) { i = nameStart; break; }
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
