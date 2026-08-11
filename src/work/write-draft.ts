import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isPlainObject } from '../routes/util.js';
import { findBacktickEnd, splitShellClauses } from '../permissions/shell-split.js';

export interface PinnedCall {
  id: string;
  label?: string;
  bash?: string;
  tool?: { name: string; args: Record<string, unknown> };
  // Session-drafted body content for one or more of `bash`'s file references, keyed by the
  // literal path — path -> content, not path -> digest. Only meaningful on the WIRE payload a
  // session (or the user's edited accept) submits: acceptDraft writes each entry to disk itself
  // and digests what it wrote, then drops `files` from the persisted PinnedCall (see
  // acceptDraft) — the pin is the digest, not a second copy of the body. A call that references
  // a file but omits an entry here falls back to digesting whatever is already on disk (the
  // pre-existing behavior, still used by actions that write their own /tmp file).
  files?: Record<string, string>;
  // sha256 (hex) of the CURRENT bytes of every file a `bash` call's payload references (see
  // FILE_REFERENCING_FLAGS), keyed by the literal path — computed once at accept time and
  // re-checked at execution. The pin covers command TEXT only; `--input /tmp/x.json` matches
  // whether or not `/tmp/x.json` still holds the content the user approved, so this is the
  // other half of the promise the hook backstop makes. Absent for a call with no file
  // reference (most MCP calls, most bash calls).
  fileDigests?: Record<string, string>;
  consumedAt?: number;
  // The tool_use_id PreToolUse allowed this pin for, recorded at consume time. A
  // PostToolUseFailure carries the same id — requiring it to match before releasing is what
  // makes the release exactly-once: immune to a duplicate/replayed failure delivery, and to two
  // identically-payloaded pins in one draft where only one of them was actually spent by this
  // particular call (payload alone can't tell them apart; the id can).
  consumedToolUseId?: string;
  // Decision-only, never persisted on a pin: the user marked this call as one they do NOT want
  // run. It rides in on the ACCEPT payload — a per-call verdict alongside the per-call edits,
  // so "post these two, skip the third" is one decision rather than a redraft round-trip.
  // acceptDraft partitions on it and drops it (its field-pick rebuild keeps only
  // id/label/bash/tool), and it is only parsed when the caller opts in — a SESSION cannot
  // pre-skip its own calls, because a call the action doesn't want run simply isn't drafted.
  skip?: boolean;
  // Set when a PostToolUseFailure released this pin. A non-zero exit or a thrown call means
  // the TOOL reported failure, not that the write provably never reached its destination (a
  // compound clause's first half can still have landed; an MCP write can throw after the
  // server already applied it) — so a released pin is a re-arm under uncertainty, not proof of
  // a clean retry. Surfaced through writeGateFor so the resumed session is told to verify
  // before blindly repeating it.
  releasedAfterFailure?: boolean;
}

export type DraftRaisedBy =
  | { kind: 'step' }
  | { kind: 'controller' }
  | { kind: 'dispatch'; dispatchId: string };

// Field compare, not `JSON.stringify(a) === JSON.stringify(b)` — the latter is key-order
// sensitive (a `{dispatchId, kind}` literal would silently stop matching a `{kind,
// dispatchId}` one) for no benefit, since DraftRaisedBy only ever has the one extra field.
export function sameRaiser(a: DraftRaisedBy, b: DraftRaisedBy): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'dispatch' && b.kind === 'dispatch' ? a.dispatchId === b.dispatchId : true;
}

// Push-notification dedupe key for a draft-ready alert. Keyed on the raiser, not just the
// step: an orchestrated step can have two dispatches parked simultaneously (see StepBase's
// `drafts` comment), and collapsing them onto one tag would silently replace the first
// dispatch's still-pending notification with the second's. Keying on the raiser also gives
// the redraft loop (propose changes → redraft → park again) the collapse it wants for free —
// same raiser, same tag, later notification replaces the earlier one.
export function draftNotificationTag(jobId: string, stepId: string, raisedBy: DraftRaisedBy): string {
  const raiser = raisedBy.kind === 'dispatch' ? `dispatch-${raisedBy.dispatchId}` : raisedBy.kind;
  return `draft-${jobId}-${stepId}-${raiser}`;
}

export interface WriteDraft {
  id: string;
  action: string;
  raisedBy: DraftRaisedBy;
  summary: string;
  calls: PinnedCall[];
  // The calls the user was shown and chose not to run, recorded at accept time. Never pinned
  // (nothing here can ever be consumed) — this is the durable answer to "why did only two of
  // the three replies I drafted go out", both for the resumed session (writeGateFor hands it
  // straight through) and for anyone reading the step later.
  skippedCalls?: PinnedCall[];
  evidence?: string;
  feedback?: string[];
  requestedAt: number;
  approvedAt?: number;
}

// submit_write_draft's `calls` boundary check. The MCP tool's inputSchema is advisory —
// nothing enforces it before this runs — so a session-controlled payload has to be rejected,
// not coerced: an empty/malformed array would park the step in gate_pending_approval with no
// way out (acceptDraft bails on `!calls.length`), an element with neither `bash` nor `tool`
// pins nothing, and one with BOTH is a single pin that could satisfy either a Bash command or
// an MCP call while the approval card can only render one — the user would be approving
// something they can't see. An empty/whitespace-only `bash` or `tool.name` is the same dead
// end by another spelling: typewise valid, but matchPinnedCall compares against a real command
// or tool name, so such a pin can never be consumed — writeGateFor would report `phase:
// 'commit'` forever with a call the session has no way to satisfy. Each PinnedCall is built by
// explicit field pick, never by spreading the caller's object, so a session cannot smuggle its
// own `id`/`consumedAt`/`consumedToolUseId`/`releasedAfterFailure` into a fresh pin.
//
// `allowSkip` opts the ACCEPT boundary into reading each call's `skip` verdict. It is off for
// the submit boundary on purpose: `skip` is the user's answer, and a session that could set it
// on its own draft would be pre-answering for them.
export function parseDraftCalls(raw: unknown, opts: { allowSkip?: boolean } = {}): PinnedCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: PinnedCall[] = [];
  for (const c of raw) {
    if (!isPlainObject(c)) return undefined;
    const bash = typeof c.bash === 'string' && c.bash.trim() ? c.bash : undefined;
    const tool = isPlainObject(c.tool) && typeof c.tool.name === 'string' && c.tool.name.trim() && isPlainObject(c.tool.args)
      ? { name: c.tool.name, args: c.tool.args }
      : undefined;
    if ((bash === undefined) === (tool === undefined)) return undefined; // exactly one of the two
    let files: Record<string, string> | undefined;
    if (c.files !== undefined) {
      // `files` only makes sense against a `bash` call's own file-referencing flags — a `tool`
      // call has no such flags, and an unparseable `bash` (extractFileReferences returning
      // null) means nothing here can be checked against it, so both refuse the whole draft
      // rather than silently drop `files` and fall back to the disk-read path.
      if (bash === undefined || !isPlainObject(c.files)) return undefined;
      const referenced = extractFileReferences(bash);
      if (referenced === null) return undefined;
      const referencedSet = new Set(referenced);
      files = {};
      for (const [path, content] of Object.entries(c.files)) {
        if (typeof content !== 'string') return undefined;
        if (!referencedSet.has(path)) return undefined;
        if (!isValidTmpFilePath(path)) return undefined;
        files[path] = content;
      }
    }
    calls.push({
      id: `c${calls.length + 1}`,
      ...(typeof c.label === 'string' ? { label: c.label } : {}),
      ...(bash !== undefined ? { bash } : {}),
      ...(tool !== undefined ? { tool } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(opts.allowSkip && c.skip === true ? { skip: true } : {}),
    });
  }
  return calls;
}

// Exact match past outer trim: the pinned text is what the user approved, so collapsing
// whitespace would let a reformatted body or commit message pass as approved.
export function normalizeBash(cmd: string): string {
  return cmd.trim();
}

// Every flag `push`'s own allowlist rules restrict to a `/tmp/...` path (see
// permission-groups.default.json) BECAUSE the payload behind it is arbitrary-length content a
// Bash literal can't carry inline — `gh api ... --input`, `gh pr merge ... --body-file`, `gh
// release create ... --notes-file`. The command-text pin (matchPinnedCall) covers the flag and
// the path; it says nothing about what's IN the file at execution time. One named list so the
// extractor and any future caller can't drift on which flags this applies to.
export const FILE_REFERENCING_FLAGS = ['--input', '--body-file', '--notes-file'] as const;

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

// The same shape the `push` group's own --input/--body-file/--notes-file rules anchor to
// (config/permission-groups.default.json): /tmp/, then segments that each START with an
// alnum/underscore — never a dot. That's what excludes a `..` segment (and a leading-dot
// segment generally) structurally, without a value blacklist a caller could work around with a
// different spelling. One pattern so a `files` key can never be pinned somewhere the daemon's
// own bash-writing flags couldn't have reached anyway.
const TMP_FILE_PATH_RE = /^\/tmp\/[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
export function isValidTmpFilePath(path: string): boolean {
  return TMP_FILE_PATH_RE.test(path);
}

// sha256 (hex) of a file's current bytes, or undefined if it can't be read (missing,
// permission error, not a regular file). The one function both accept-time pinning and
// execution-time verification call, so they can never compute the digest two different ways.
export async function hashFileContents(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return undefined;
  }
}

// Writes the user's (possibly edited) approved body to the path the command references. Errors
// are swallowed into `false`, not thrown — acceptDraft treats a write failure as a refusal
// reason, the same shape as a missing file in the no-`files` fallback path, not an exception
// that would skip the rest of the accept's bookkeeping.
export async function writeFileContents(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Re-checks every file an approved call's payload referenced against the digest recorded at
// approval. A rewritten file (digest mismatch) and a since-deleted one (unreadable now) fail
// the same way: the payload about to run is not provably the one the user approved. No
// `fileDigests` (the call never referenced a file) always passes.
export async function verifyFileDigests(fileDigests: Record<string, string> | undefined): Promise<boolean> {
  if (!fileDigests) return true;
  for (const [path, expected] of Object.entries(fileDigests)) {
    if (await hashFileContents(path) !== expected) return false;
  }
  return true;
}

// Order-insensitive on object keys, order-SENSITIVE on arrays: a reordered
// `--reviewer` list is a different request, a reordered JSON body is not.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.prototype.hasOwnProperty.call(b, k)
    && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// The draft currently relevant to `raisedBy` on a step: the one still awaiting a decision if
// there is one, else the most recently approved (the write in progress). Shared by every site
// that needs to pick a step's "current" draft for a given raiser — engine.ts's pin resolution
// and resume paths, and each step handler's own envelope builder — so they can't drift on
// which draft that is. Takes a structural `{ drafts? }` rather than `Step` to avoid an import
// cycle (work-types.ts already imports WriteDraft from this file).
//
// `boundAction`, when given, additionally requires the APPROVED candidate's own `action` to
// match it — an ActionStep or a dispatch is one action for its whole life, so this only ever
// matters for a controller, the one raiser whose session rebinds across rounds. Without it, an
// approved-but-partially-consumed draft from an earlier round (bound to `code.merge-pr`, say)
// would still surface as "the current draft" once the controller rebinds to a DIFFERENT action
// (`code.fix-ci`) for an unrelated later round — handing that later round a writeGate (and, if
// this same scoping weren't also applied at the pin-match site, a live pin) for a write it never
// drafted and the user never saw it running. A still-PENDING draft is never scoped by this: the
// step can't accept a new move while one is unresolved (see applyMove's gate_pending_approval
// guard), so a pending draft's raiser is always the round that's currently live.
export function currentDraftForRaiser(
  step: { drafts?: WriteDraft[] }, raisedBy: DraftRaisedBy, boundAction?: string,
): WriteDraft | undefined {
  const owned = (step.drafts ?? []).filter((d) => sameRaiser(d.raisedBy, raisedBy));
  const pending = owned.find((d) => !d.approvedAt);
  if (pending) return pending;
  const approved = boundAction === undefined ? owned : owned.filter((d) => d.action === boundAction);
  // `>=`, not `>`: on an exact tie (a clock with coarser resolution than two real approvals),
  // prefer the one that sorts later in `drafts` — new entries are always appended, so that's
  // still the more-recently-approved one.
  return approved.reduce<WriteDraft | undefined>((latest, d) => {
    if (!d.approvedAt) return latest;
    return !latest || d.approvedAt >= latest.approvedAt! ? d : latest;
  }, undefined);
}

// The first unconsumed pin this call satisfies, or undefined. An unapproved draft never
// matches: the pins only exist once the user has accepted them.
export function matchPinnedCall(
  draft: WriteDraft, toolName: string, toolInput: unknown,
): PinnedCall | undefined {
  if (!draft.approvedAt) return undefined;
  return draft.calls.find((c) => {
    // `!== undefined`, not truthy — consistent with releaseConsumedPin's own consumedAt check
    // (engine.ts). Harmless either way since an epoch-0 timestamp never occurs, but one spelling.
    if (c.consumedAt !== undefined) return false;
    if (toolName === 'Bash') {
      const cmd = (toolInput as { command?: unknown })?.command;
      return typeof c.bash === 'string' && typeof cmd === 'string'
        && normalizeBash(c.bash) === normalizeBash(cmd);
    }
    return c.tool?.name === toolName && deepEqual(c.tool.args, toolInput ?? {});
  });
}

// What a resumed session's envelope needs to know about the draft raised for it: whether it's
// drafting (compose the payload and call submit_write_draft again, seeing the user's own
// redraft feedback) or committing (perform exactly the approved calls, nothing else). Shared
// by every resume path (engine.ts's dispatchResume and controller resume, and steps/action.ts's
// ActionStep resume) so they can't drift on what a session is told mid-draft.
export interface WriteGatePayload {
  phase: 'draft' | 'commit';
  approvedCalls?: PinnedCall[];
  // Calls the user was shown and declined to run. Distinct from "not drafted": the session
  // proposed these, the user said no to these specific ones, and the answer is final for this
  // draft — a commit round records them as skipped and must not re-draft them.
  skippedCalls?: PinnedCall[];
  feedback: string[];
}

// An approved draft is kept around forever (so a spent pin stays inspectable), so a controller
// resumes on every later, unrelated round with the same "you're in the commit phase" payload
// unless a fully-consumed one is reported as spent — undefined, same as no draft at all. A
// PARTIALLY consumed draft still reports `commit`: there are approved calls left to make, and
// `approvedCalls` is narrowed to only those, so the resumed session isn't told to re-attempt one
// the hook has already spent (matchPinnedCall would deny it, burning a round for nothing).
export function writeGateFor(draft: WriteDraft | undefined): WriteGatePayload | undefined {
  if (!draft) return undefined;
  if (!draft.approvedAt) return { phase: 'draft', feedback: draft.feedback ?? [] };
  const remaining = draft.calls.filter((c) => !c.consumedAt);
  if (remaining.length === 0) return undefined;
  return {
    phase: 'commit',
    approvedCalls: remaining,
    ...(draft.skippedCalls?.length ? { skippedCalls: draft.skippedCalls } : {}),
    feedback: draft.feedback ?? [],
  };
}
