# The write-draft protocol

Every action whose `description` or body says "external-write" follows this protocol. It
replaces the old mechanism where the daemon force-gated a write *before* your session ever
ran — that no longer happens. You now run unattended, compose the exact payload, and gate
**yourself** by drafting it. Each action's own `SKILL.md` says which calls it drafts and what
evidence it attaches; this file is the mechanics every one of them shares, stated once.

**Where this file lives.** `~/.outpost/actions/SHARED-write-drafts.md` — two levels above
your own action's directory, and outside what your `Read`/`Grep` grant (if you have one at all)
reaches. Use `cat` instead, with the tilde spelling, exactly as written:

```bash
cat ~/.outpost/actions/SHARED-write-drafts.md
```

Every `runner: claude` action inherits the `core` group's `^cat ` pattern regardless of what
else it's granted, so this reaches the file even for an action whose only other permission is
`push`. **Write the tilde exactly as shown, unquoted.** A bare (unquoted) `$VAR` — including
`cat $HOME/…` — is denied before any allowlist rule is even consulted; a *quoted*
`cat "$HOME/…"` does pass, but the tilde spelling above needs no quotes at all and is one
character shorter to get right. Don't improve it to either `$VAR` spelling.

## The tool

```
mcp__outpost__submit_write_draft({
  jobId: "<jobId>", stepId: "<stepId>",
  dispatchId: "<only if you are a dispatched child>",
  summary: "<one line naming what will happen>",
  evidence: "<optional markdown — read-only context for the decision>",
  calls: [
    { label: "<optional>", bash: "<literal command text, exactly as it will run>" },
    { label: "<optional>", tool: { name: "<mcp tool name>", args: { /* verbatim */ } } }
  ]
})
```

**If you are a dispatched child, `stepId` and `dispatchId` are the OPPOSITE of your own
envelope's field names — this is the one place they invert.** Your envelope's `stepId` is
YOUR OWN id, and `parentStepId` names the controller that dispatched you. Here it's reversed:
pass `stepId: "<your envelope's parentStepId>"` (the controller) and
`dispatchId: "<your envelope's own stepId>"` (you). Every other submit tool uses `stepId` to
mean "my own step" — this is the only one where a dispatched child's `stepId` names its
*parent* instead. Get this backwards and the call fails loudly (either id names nothing, or
names the wrong record) rather than silently drafting under the wrong identity.

- **`calls` is the ordered list of calls you will make once approved.** Each element sets
  **exactly one** of `bash` (the literal command text) or `tool` (an MCP tool name + its
  arguments, verbatim) — never both, never neither. The user sees every field of every call
  and may edit any of them before approving. If a `bash` call points `--input`/`--body-file`/
  `--notes-file` at a file, that element can also carry `files` — see "File-referencing
  payloads" below before writing that file yourself.
- **`summary`** is one line naming what will happen — the thing a person skimming a list of
  pending approvals needs to recognize this by.
- **`evidence`** is optional and read-only: a staged diff, a rendered preview, JSON you read
  to confirm the target. It is shown to the user for context; it is never executed and never
  compared against anything. Don't put a call's own payload only in `evidence` — if it isn't
  in `calls`, approving the draft doesn't approve running it.
- Submitting the draft **parks this unit for the user's decision. End your turn immediately
  after the call returns — do not perform any of the drafted calls, and do not call any other
  write tool, on the same turn or in the belief that "just this once" is faster.** The hook
  denies any write that doesn't match an approved pin regardless of what you intended.

## File-referencing payloads: draft the content, don't write the file

If a `bash` call's payload is too big for a command-line literal — `gh api ... --input`,
`gh pr merge ... --body-file`, `gh release create ... --notes-file` — the pin covers more than
the command text. The daemon also records a content digest of the file that flag points at,
computed at approval time and re-checked right before the call runs, because the command text
matching (`--input /tmp/review.json`) says nothing about whether `/tmp/review.json` still holds
what the user approved.

**Draft the body as `files` on that same call — don't write the file yourself:**

```
{ label: "Post the review", bash: "gh api --method POST ... --input /tmp/review.json",
  files: { "/tmp/review.json": "{\"body\": \"...\", \"event\": \"COMMENT\"}" } }
```

- Every key in `files` must be a path that same call's own `bash` already references via one
  of those flags, and must be under `/tmp/` — anything else refuses the **whole** draft, not
  just that entry.
- The user sees this as an editable text box in the approval card, right alongside the
  command — they can revise the body directly, the same way they can edit `bash` itself.
- On accept, the daemon writes whatever the user approved (their edit, or your original if
  they left it alone) to that exact path itself, then digests those exact bytes. You never see
  or need the written file — don't `cat` it back to "confirm," and don't write your own copy
  to the same path before or after drafting. If you do, it's simply overwritten by the
  daemon's write at accept time — harmless, but if you were trying to change what gets
  approved, editing the file after drafting does nothing; only a re-drafted `files` value (via
  `submit_write_draft` again) or the user's own edit in the card changes what's pinned.
- **Recovery on a digest mismatch is re-draft, not retry.** If the hook denies a commit-phase
  call because the file's content no longer matches what was approved, don't retry the same
  command — the content is gone or wrong from the daemon's perspective either way, and running
  it again won't change that. Draft again with the current content.

A call that references one of these flags but carries no `files` entry for that path keeps the
older behavior: the file must already exist on disk when the draft is accepted (you wrote it
yourself, the way every such action worked before `files` existed), and its current bytes are
what get hashed. Nothing about that path is wrong — `files` is the better default for anything
new, not a requirement for every file-referencing call.

## Three outcomes, one resume each

- **Accept.** You resume with `writeGate.phase === "commit"` and `writeGate.approvedCalls` —
  the calls the user approved, possibly edited, narrowed to whichever are still unconsumed.
  **Run these verbatim, in the order given.** "Verbatim" means the exact command text (after
  outer whitespace trim) or the exact tool name + deep-equal arguments — not a reformatted,
  "improved," or re-derived equivalent. The hook compares the literal call you attempted
  against the pinned ones and denies anything that doesn't match one exactly; a call that
  fails that match is treated as an unapproved write, not as your draft with better wording.
  Re-drafting instead of running the pin costs the user a second approval on a payload they
  already approved — don't call `submit_write_draft` again on a commit-phase turn.
- **Propose changes.** You resume with `writeGate.phase === "draft"` and
  `writeGate.feedback` — every round of feedback the user has left on this draft, oldest
  first (not just the latest). Revise `summary` / `evidence` / `calls` to address every point,
  then call `submit_write_draft` again. This is the same shape as your first draft, just
  revised.
- **Deny.** The draft is discarded and the write never happens. You are not resumed to try a
  different payload for the same decision — whatever reports the outcome upstream (the
  step's own failure/decline path, or the controller that chose to run you) handles it; your
  job here is done.

## Where `writeGate` lives

The field name is always `writeGate`, but its position in `$OUTPOST_ENVELOPE` depends on what
kind of step you are:

- **A standalone action step** (`kind: "step"`, `type: "action"` — a `write.*` action run
  directly, or a controller's *dispatched* child) — `writeGate` is nested at
  **`typePayload.writeGate`**.
- **An orchestrated controller** (`kind: "step"`, `type: "orchestrated"`) — whether it's the
  controller's own top-level draft or a bound sub-action's round (`boundAction` set to
  something other than the controller's own name) — `writeGate` sits at the **top level**,
  a sibling of `boundAction`, **not** under `typePayload` (there is no `typePayload` on this
  envelope shape at all).

Read the wrong location and you'll see `undefined` where a real gate is waiting, and default
to the draft phase forever. Check your own envelope's `type` before you check `writeGate`.

## First turn: no `writeGate` at all

If `writeGate` is absent from the envelope entirely, there is no draft in flight for you right
now — same whether none was ever raised, or your last one was fully consumed. Compose the
draft and submit it; there is no separate "first-time" signal to look for.

## Rules that don't bend

- **A gated write attempted with no approved pin is denied**, no matter how confident you are
  or how narrow the change. The permission group an action inherits (e.g. `push`) means "may
  *propose* this write for approval," not "may run it outright" — approval is a separate,
  per-call pin, not a standing grant.
- **Never attempt the real call before drafting it**, and never retry it after a denial with a
  different spelling, a workaround, or a helper script. Both are read as an attempt to route
  around the gate, not persistence.
- A **partial commit** can happen (a session interrupted mid-way through `approvedCalls`, then
  resumed): `approvedCalls` on the resumed envelope is narrowed to only the calls not yet
  consumed, in their original order. Run what's listed; don't re-derive or re-run the whole
  original set from memory.
- **A call that fails releases its own pin.** A non-zero exit (Bash) or a thrown error (an MCP
  tool call) un-consumes that specific approved call — it reappears in `approvedCalls` on the
  next envelope read, exactly as if it had not run yet. This is a re-arm under uncertainty, not
  proof the write never landed (a compound shell clause can partially succeed; an MCP write can
  throw after the server already applied it) — verify against the real target before blindly
  repeating a released call, the same way you'd verify before any other retry. It does mean
  that retrying the *same* approved call after it fails is running an approved call again, not
  a fresh, undrafted write — you don't need to re-draft to retry it.
