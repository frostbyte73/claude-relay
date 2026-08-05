---
name: code.triage-pr-comments
description: Use when invoked as `/code.triage-pr-comments` in a session spawned by the Outpost work orchestrator inside an open-pr step's worktree, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=open-pr`, and `typePayload.round.kind == "pr-comments"`. Read it, for each comment recommend one of {reply, edit, ignore} with a short rationale and pre-drafted reply, call `mcp__outpost__submit_replies`, then exit.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# PR maintainer

This is the same session that implemented the PR, resumed now that review comments have arrived — you already have the full context of the change in this conversation. Your job for this round: for each comment, decide reply / edit / ignore, write a one-line rationale, and pre-draft a reply. The envelope re-states the comments and the original goal so you stay grounded even if the conversation was compacted; lean on your own memory of the code first, and use the envelope as the refresher.

**You only recommend. You do not edit files. You do not post comments.** Editing is the `code.fix-pr-comment` skill's job; posting replies is the orchestrator's job once the user clicks Reply.

## Step 1 — Read the envelope

```bash
test -r "$OUTPOST_ENVELOPE" || { echo "missing envelope: $OUTPOST_ENVELOPE"; exit 1; }
```

Relevant fields:

| Field | Meaning |
|---|---|
| `jobId`, `stepId` | Identifiers — POST them back. |
| `job.title`, `job.description`, `job.externalRef.url` | Original ticket context. |
| `goal`, `approach`, `risks` | The original spec for this step. Ground reply decisions in this. |
| `previousSteps[]` | Earlier `action` steps' `output` strings (only those with `forwardOutput: true`). High-signal context for grounding reply decisions. |
| `workspace.repoCwd`, `workspace.branch` | Parent repo path + branch name (your cwd is the worktree). |
| `typePayload.round.kind` | Should be `"pr-comments"`. If not, the orchestrator misrouted you — exit with an error. |
| `typePayload.round.comments` | Array of pending comments. Each: `{id, author, body, createdAt, file?, line?, diffHunk?}`. Already filtered to exclude already-responded/edited/locked. |
| `recentLessons` | Short lessons you wrote at the end of past code.triage-pr-comments runs. Skim them before drafting — they encode patterns about this reviewer or repo. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

```bash
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PENDING=$(jq -c '.typePayload.round.comments' "$OUTPOST_ENVELOPE")
```

`DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited from the original session spawn.

## Step 2 — Decide

For each comment in `pendingComments`:

**Pick `edit` when** the reviewer's concern is best resolved by changing code. "Good catch, this is broken — fix it" is `edit`, not `reply` + paragraph explaining the fix. The user can still override into Reply if they disagree, but your recommendation should match what serves the PR best.

**Pick `reply` when** the reviewer asks a question, you're pushing back, or you're explaining a trade-off the diff can't carry — anything where words add information the code can't.

**Pick `ignore` when** the comment is pure social affirmation ("nice work!"), already addressed by an intervening edit, or otherwise has no actionable content. Note that "ignore" here means "mark resolved internally" — it does not touch GitHub's resolved-thread state.

Always include a rationale. One sentence. Cite the comment text or thread state ("reviewer is asking about the migration path, not the implementation"). The rationale appears under every thread in the UI, so be specific — *"recommend reply — answer the question"* helps no one.

**Also draft a reply for every comment unless it's a pure affirmation.** The user might override your recommendation. The draft is what they'll see in the Reply composer if they do.

If you need the current diff to ground a recommendation:

```bash
git fetch origin && git diff origin/main..HEAD
```

**Never write scratch JSON (or any non-source files) into the worktree.** Use `/tmp/` for anything you need to materialize. Pipe through stdin where possible: `echo "$PENDING" | jq ...`.

Each draft:

```json
{
  "commentId": "<the id from pendingComments verbatim>",
  "recommendation": "reply" | "edit" | "ignore",
  "rationale": "<= 240 chars",
  "draftReply": "<reply body, or empty string for pure affirmations>",
  "confidence": "high" | "medium" | "low"
}
```

`confidence` is optional but strongly encouraged — it's how sure you are that `recommendation` is the right call. Reserve `low` for genuinely ambiguous threads (reviewer intent unclear, conflicting signals in `previousSteps`, or a domain judgment call outside what the diff/ticket tell you); most decisions should be `high` or `medium`. The user's Reply composer surfaces this so they know which threads to double-check before approving.

**Examples:**

*Reviewer says "this race condition could double-charge — wrap in a transaction":*
```json
{ "commentId": "...", "recommendation": "edit", "rationale": "Reviewer flagged a real bug (double-charge race); a reply alone doesn't help.", "draftReply": "You're right — wrapping in a transaction.", "confidence": "high" }
```

*Reviewer asks "why are we polling here instead of using the existing event?":*
```json
{ "commentId": "...", "recommendation": "reply", "rationale": "Reviewer is asking why, not requesting a change; needs an answer.", "draftReply": "The event isn't emitted on the migration path — `cmd/migrate.go` writes directly without going through the publisher. Polling is the workaround until we fix that separately.", "confidence": "high" }
```

*Reviewer suggests caching, you don't think it's worth it:*
```json
{ "commentId": "...", "recommendation": "reply", "rationale": "Pushback — explain why the cache isn't worth it given call rate.", "draftReply": "Skipping the cache here — this path runs once per session startup and the underlying call is ~3ms on the hot CockroachDB connection. Adding a cache would mean wiring invalidation through the config-reload listener, which doesn't pay for itself at this call rate.", "confidence": "medium" }
```

*Pure affirmation:*
```json
{ "commentId": "...", "recommendation": "ignore", "rationale": "Pure social affirmation — no actionable content.", "draftReply": "", "confidence": "high" }
```

When you do write a draftReply, keep it short (1–3 sentences) and specific. Cite filenames, line numbers, or measurements when they exist.

## Step 3 — Submit replies

The outpost MCP tools are deferred behind ToolSearch — load `submit_replies` (and `submit_journal`) first:

```
ToolSearch({ query: "select:mcp__outpost__submit_replies,mcp__outpost__submit_journal", max_results: 2 })
```

If the tool doesn't come back, halt. The daemon will not scrape the transcript.

Then call the `mcp__outpost__submit_replies` tool:

```
mcp__outpost__submit_replies({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  drafts: [ /* your drafts array, native JSON */ ]
})
```

Then write a one-line summary in chat: how many decisions, breakdown by kind, any uncertainty for the human.

## Step 4 — Journal one lesson

Before exiting, call `mcp__outpost__submit_journal` with one short lesson the *next* code.triage-pr-comments run should know. Skip entirely if there's nothing new.

```
mcp__outpost__submit_journal({
  action: "code.triage-pr-comments",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "drafted" | "all-ignored" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the step succeeded: it recurs identically on every future run of
this action until a human sees it, and this journal is the only place
`meta.improve-actions` looks. Name the exact command or field, not the category.

Reviewer-specific lessons are gold ("@avichalp consistently asks for benchmarks on perf claims — pre-draft them"). Don't pad.

## Step 5 — Exit

This skill doesn't wait for approval. The orchestrator publishes per-thread when the user clicks Reply in the PWA, queues an `EditJob` when they click Edit, and marks resolved when they click Ignore — all without messaging back to this session. If a new thread arrives or an existing one changes, the orchestrator resumes this session with a fresh round envelope.

## Failure modes

- **Envelope missing or unreadable.** Something went wrong upstream — exit with a brief error; the orchestrator will respawn on the next watcher tick.
- **A comment got deleted between read and decide.** Skip it — the orchestrator will see it's gone on the next watcher tick.
- **Hook server returns 401.** Daemon restarted mid-session. There's no recovery — print the situation and exit; the orchestrator will respawn on the next watcher cycle.
