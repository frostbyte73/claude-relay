import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isPlainObject } from '../routes/util.js';
import {
  FILE_REFERENCING_FLAGS, extractFileReferences, isValidTmpFilePath, tokenize,
} from '../permissions/file-flags.js';
import { writeFindings, type WriteFinding } from '../permissions/dangerous-writes.js';

// The file-flag parser and the `/tmp` path shape moved to the permissions layer, where
// `allows()` also needs them (see file-flags.ts). Re-exported so a caller reasoning about a
// draft's file handling still has one import site.
export { FILE_REFERENCING_FLAGS, extractFileReferences, isValidTmpFilePath, tokenize };

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
  // What is notable about this call, classified server-side when the draft is parsed (see
  // dangerous-writes.ts). Advisory only — the `refuse` half is enforced by `allows()` at
  // execution regardless of what the card rendered, so this is what puts the risk in front of
  // the person approving, not what stops it. Recomputed on every redraft, since parseDraftCalls
  // runs again; it therefore describes the payload as DRAFTED, not the user's in-progress edits
  // to the textarea.
  findings?: WriteFinding[];
  consumedAt?: number;
  // The tool_use_id PreToolUse allowed this pin for, recorded at consume time. A
  // PostToolUseFailure carries the same id — requiring it to match before releasing is what
  // makes the release exactly-once: immune to a duplicate/replayed failure delivery, and to two
  // identically-payloaded pins in one draft where only one of them was actually spent by this
  // particular call (payload alone can't tell them apart; the id can).
  consumedToolUseId?: string;
  // Decision-only, never persisted on a pin: the finding codes (see dangerous-writes.ts) the
  // user explicitly acknowledged for this call. A `confirm`-risk finding — a force-push, a
  // `--mirror`, a `gh pr merge --admin` — is pinnable only when its code appears here, so the
  // operation stays reachable for the rare case that needs it without being reachable by
  // clicking Approve out of habit. Verified in acceptDraft against the SUBMITTED command.
  ack?: string[];
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
      ...(bash !== undefined && writeFindings(bash).length > 0 ? { findings: writeFindings(bash) } : {}),
      ...(opts.allowSkip && c.skip === true ? { skip: true } : {}),
      // Same gate as `skip`: both are per-call verdicts that only mean anything on an accept
      // payload, so neither is accepted off a session's own draft submission.
      ...(opts.allowSkip && Array.isArray(c.ack)
        ? { ack: c.ack.filter((x): x is string => typeof x === 'string') }
        : {}),
    });
  }
  return calls;
}

// Exact match past outer trim: the pinned text is what the user approved, so collapsing
// whitespace would let a reformatted body or commit message pass as approved.
export function normalizeBash(cmd: string): string {
  return cmd.trim();
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
