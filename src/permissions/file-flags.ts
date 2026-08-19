// The flags whose payload is a FILE rather than inline text, the parser that reads which path
// each one points at, and the shape a path must have to be one of them.
//
// This lives in the permissions layer because two very different callers depend on the same
// answers and must never drift:
//   - `allows()` (allowlist.ts) gates a Bash call on every file flag in it resolving somewhere
//     the write-draft card could actually have shown the user (see `fileFlagsAllowed`);
//   - the write-draft path (work/write-draft.ts) pins the file's bytes by digest and writes the
//     user's approved body to it.
// Both used to sit in work/write-draft.ts, which made the permissions layer depend on the work
// layer to ask a permissions question. The direction is now the other way round.

import { findBacktickEnd, splitShellClauses } from './shell-split.js';

// The flags whose payload is arbitrary-length content a Bash literal can't carry inline —
// `gh api ... --input`, `gh pr merge ... --body-file`, `gh release create ... --notes-file`.
// The command-text pin (matchPinnedCall) covers the flag and the path; it says nothing about
// what's IN the file at execution time. One named list so no caller can drift on which flags
// this applies to.
// `-F` is gh's short form of `--body-file` on the pr/issue/release verbs. It was invisible to
// this list while `push` enumerated flags per verb (the short form simply had no allowed
// spelling); under verb anchors it is reachable, and `gh pr review 7 -F /etc/passwd` walked
// straight out of /tmp. On `gh api`, `-F` means `--field` instead — a `key=value`, which is not
// a path and therefore fails the /tmp check. That is the fail-closed direction and no shipped
// action uses it; the `@file` spelling of a field is handled below, where it belongs.
export const FILE_REFERENCING_FLAGS = ['--input', '--body-file', '--notes-file', '-F'] as const;

// gh's field flags read a file when their value is `@`-prefixed: `-f body=@/etc/passwd` posts
// that file's contents. Same exposure as `--body-file`, different syntax, so the path lands in
// the same list and faces the same /tmp bar.
const FIELD_FLAGS = ['-f', '--field', '--raw-field'] as const;

function fieldFileTarget(token: string, next: string | undefined): { path: string; consumed: boolean } | null {
  const eq = FIELD_FLAGS.find((f) => token.startsWith(`${f}=`));
  const bare = FIELD_FLAGS.find((f) => token === f);
  const value = eq ? token.slice(eq.length + 1) : bare ? next : undefined;
  if (value === undefined) return null;
  const at = value.indexOf('=@');
  if (at < 0) return null;
  return { path: value.slice(at + 2), consumed: !eq };
}

function unquote(raw: string): string {
  if (raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}

// One shell word out of a clause's text, quotes preserved verbatim, or `ok: false` when the
// scan can't trust what it found. Deliberately NOT `shell-split.ts`'s own `readWordAt` — this
// needs two things that reader doesn't do:
//
//   1. Treat an UNQUOTED backtick span as one atomic, opaque unit (jump straight to its
//      matching close via `findBacktickEnd` and copy the span verbatim), rather than walking
//      into its characters one at a time. `splitShellClauses` copies a backtick span's raw text
//      into the OUTER clause verbatim (`buf += s.slice(...)`) without the comment-stripping its
//      OWN recursive walk applies when that same span becomes its own separate clause — so a
//      stray quote hidden in a comment inside the backticks (an apostrophe in an ordinary
//      `# don't touch`) is real, uncommented text from THIS function's point of view. Walking
//      into it character-by-character would flip this scanner into quote mode on that
//      apostrophe and swallow the rest of the clause — including the real `--input` — into one
//      bogus token, silently returning `[]` (no reference found) instead of `null`. Since a
//      backtick span's content can never be part of THIS command's own argv (it's a separate,
//      independently-executed substitution), skipping it whole removes the desync at its
//      source rather than trying to out-think every way its contents could confuse a naive
//      quote tracker. `findBalancedParen` (used for `$(...)`) tracks quotes itself, so a `$(...)`
//      with the same hidden-quote trick makes `splitShellClauses` fail closed upstream before
//      this code ever runs — backtick's `findBacktickEnd` is the one span-finder in this file
//      that doesn't, which is why it is the one boundary that needs this special case.
//   2. Report when a quote (or a backtick span) is still open at the end of the clause instead
//      of silently returning whatever was accumulated. Under normal operation this can't
//      happen — `splitShellClauses` only flushes a clause when its own quote tracking is
//      balanced — so reaching it means THIS scan disagrees with what `splitShellClauses`
//      already decided about the same text: a desync of a shape this function didn't
//      specifically anticipate, exactly like backtick was before item 1 above. Failing closed
//      here is the backstop for the next one of those, not just this one.
function readTokenAt(s: string, start: number): { word: string; ok: boolean } {
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
    if (c === '`') {
      const end = findBacktickEnd(s, i);
      if (end < 0) return { word: out, ok: false }; // unterminated backtick span
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[\s;|&<>()]/.test(c)) break;
    out += c; i++;
  }
  return { word: out, ok: !sq && !dq };
}

// Splits one clause's text into argv-shaped words, or `null` if any word in it can't be
// trusted (see `readTokenAt`). Scanning ARGV TOKENS, not raw command text, is what keeps a flag
// name that only appears inside a quoted argument from being read as a real flag — a plain
// "does this substring appear" regex over the whole command can't tell `--input` the flag from
// `--input` the fourteenth word of a commit message.
//
// Exported so the fail-closed-on-an-unterminated-word backstop (`readTokenAt`'s item 2) can be
// pinned directly against a hand-built clause string, independent of whether any real bash
// command can currently reach it through `splitShellClauses` — the whole point of a backstop
// for "a shape this function didn't anticipate" is that it has to be verified before that
// shape exists, not after.
export function tokenize(clauseText: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < clauseText.length) {
    while (i < clauseText.length && (clauseText[i] === ' ' || clauseText[i] === '\t')) i++;
    if (i >= clauseText.length) break;
    const { word, ok } = readTokenAt(clauseText, i);
    if (!ok) return null;
    // `readTokenAt` returns '' at `(`, `)`, `<`, `>` — a metacharacter it won't cross as a
    // word. Stopping the whole tokenize here would make everything after it invisible, which
    // for extractFileReferences is the DANGEROUS direction: a truncated scan can under-count
    // real flag occurrences and return `[]` (no reference at all) instead of failing closed,
    // and an empty list means no fileDigests get recorded on the pin. Skip the one character
    // and keep scanning the rest of the clause instead.
    if (!word) { i++; continue; }
    tokens.push(word);
    i += word.length;
  }
  return tokens;
}

// The literal path each FILE_REFERENCING_FLAGS occurrence in `bash` points at, or `null` if
// ANY occurrence can't be read with confidence. This is a security boundary — a payload this
// daemon can't verify is worse than one it refuses to pin — so ambiguity fails closed rather
// than silently skipping the flag it can't parse:
//   - a command the shared lexer itself can't parse (unbalanced quote/paren);
//   - a clause whose text disagrees with what the shared lexer already decided about it (see
//     `readTokenAt` — an open quote, or an unterminated backtick span, at the end of a scan);
//   - a flag with no attached value at all (`--input` at the end of a clause);
//   - a value containing `$`/`` ` `` (a variable or substitution — the daemon sees command
//     text, never the expanded value, so it cannot know what path will actually be opened).
export function extractFileReferences(bash: string): string[] | null {
  const clauses = splitShellClauses(bash);
  if (clauses === null) return null;

  const paths: string[] = [];
  for (const clause of clauses) {
    const tokens = tokenize(clause.text);
    if (tokens === null) return null;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      const field = fieldFileTarget(tok, tokens[i + 1] === undefined ? undefined : unquote(tokens[i + 1]!));
      if (field) {
        if (field.consumed) i++;
        if (!field.path || /[$`]/.test(field.path)) return null;
        paths.push(field.path);
        continue;
      }
      const eqFlag = FILE_REFERENCING_FLAGS.find((f) => tok.startsWith(`${f}=`));
      const bareFlag = FILE_REFERENCING_FLAGS.find((f) => tok === f);
      if (!eqFlag && !bareFlag) continue;
      let raw: string;
      if (eqFlag) {
        raw = tok.slice(eqFlag.length + 1);
      } else {
        const next = tokens[i + 1];
        if (next === undefined) return null;
        raw = next;
        i++; // the value token is consumed, not re-scanned as a word of its own
      }
      const value = unquote(raw);
      if (!value || /[$`]/.test(value)) return null;
      paths.push(value);
    }
  }
  return paths;
}

// `/tmp/`, then segments that each START with an alnum/underscore — never a dot. That's what
// excludes a `..` segment (and a leading-dot segment generally) structurally, without a value
// blacklist a caller could work around with a different spelling.
//
// This is the ONE predicate deciding where a file flag may point, and it is deliberately the
// same one that gates the `files` map a write draft carries (parseDraftCalls). That identity is
// the whole guarantee: a call may only reference a file whose contents the approval card can
// render inline, so the user is never asked to approve a payload they cannot see. Widening it
// on one side without the other would break that in the silent direction — the call would run
// with a body the card had no way to display.
const TMP_FILE_PATH_RE = /^\/tmp\/[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
export function isValidTmpFilePath(path: string): boolean {
  return TMP_FILE_PATH_RE.test(path);
}
