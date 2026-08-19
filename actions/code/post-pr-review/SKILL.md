---
name: code.post-pr-review
description: Use when invoked as `/code.post-pr-review` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.post-pr-review"`. Draft the exact review comments via `mcp__outpost__submit_write_draft`, then post them onto somebody else's PR as one GitHub review — verbatim, nothing added — once approved (see `SHARED-write-drafts.md`), and record exactly what landed in `artifacts.postedReview`. Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  plannable: false
  permissions: [read, pull, push]
  timeout_sec: 600
  retries: 0
---

# Post the approved review

This is the same session that read the PR and worked out what was wrong with it.
`code.orchestrate-review` decided the comment set is ready to go out and rebound this
round to you — **this is not a fresh session and not a dispatch.** You keep the
controller's conversation, its worktree and its envelope; only the bound action changed
for one turn.

This is a bound-action round on the controller's own session (`type: "orchestrated"`), so
`writeGate` (see `~/.outpost/actions/SHARED-write-drafts.md`) sits at the **top level** of `$OUTPOST_ENVELOPE`,
not under a `typePayload`. Your job is exactly one thing: draft the comments in `boundNote`
for the user's approval, then post exactly what they approved, verbatim, as one GitHub
review on the PR they belong to.

- **Do not re-review.** You are not deciding what is wrong with the PR on this turn; that
  decision is upstream, already in `boundNote`.
- **Do not soften.** Not a hedge, not a "nit:" prefix that was not there, not an added
  compliment — draft exactly what `boundNote` says.
- **Do not add comments that were not in `boundNote`** — including one you notice now. If
  something new matters, say so in the memo and let the controller run another round.

This action inherits the `push` permission group, which is broad — `git commit`, `git push`,
`gh pr merge`, `gh pr comment`, `gh pr create` and more all pass its raw allowlist. **That is
not permission to use them.** The gate is what actually confines this round: only the review
POST you draft and the user approves will run. The verdict — approve or request changes — is
a separate round (`code.submit-pr-verdict`) with its own draft. If you find yourself wanting
one of those, this is the wrong round: hand it back (Step 7b).

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PR_URL=$(jq -r '.pr.prUrl // .inputs.prUrl // empty' "$OUTPOST_ENVELOPE")
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

| Field | What it is |
|---|---|
| `boundNote` | **The payload to draft.** One entry per comment: file path, line, and the exact body. This is what the user reads at the draft — it wins over everything else, including your own memory of the review. |
| `artifacts.review` | The synthesis round's full comment set, for context. Only the ones named in `boundNote` are to be drafted. |
| `artifacts.postedReview` | What an earlier round already posted. Never post one of these twice. |
| `pr.prUrl` / `inputs.prUrl` | The PR to review. |
| `writeGate.feedback` | Anything the user wrote when proposing changes to the draft, once you've drafted. A wording change there is also approved text once accepted — apply it. |

If `PR_URL` or `boundNote` is empty there is nothing to post — skip to Step 7b and hand it
back.

## Step 2 — Pin the commit you are reviewing

A review's line comments are anchored to a commit. Read the PR's current head rather than
trusting the worktree, which was provisioned when the step started and may be behind:

```bash
gh pr view "$PR_URL" --json number,headRefOid,baseRefName,files
```

Note the PR number and `headRefOid`. If `headRefOid` has moved since the findings were
written, say so in the memo — the line numbers may no longer line up, and Step 5 is where
you will find out.

## Step 3 — Compose the payload

A multi-comment review is nested JSON — an array of comment objects — so it cannot be
expressed with `gh api -f` flags, and a heredoc is not usable either (the allowlist's
`splitShellCommand` does not understand heredocs, so a heredoc'd command is denied). Compose
it as a string now; Step 4 hands it to `submit_write_draft` as `files` rather than writing it
yourself — see "File-referencing payloads: draft the content, don't write the file" in
`~/.outpost/actions/SHARED-write-drafts.md`. The daemon writes it, once approved, to a literal
path under `/tmp/` (write the PR number into the filename yourself — a shell variable in the
path is denied at Step 5).

The payload shape:

```json
{
  "commit_id": "<headRefOid from Step 2>",
  "event": "COMMENT",
  "body": "<the approved summary line, if boundNote has one — otherwise omit>",
  "comments": [
    { "path": "src/work/orchestrator.ts", "line": 412, "side": "RIGHT", "body": "<approved body, verbatim>" }
  ]
}
```

**`"event"` is always `"COMMENT"` on this round.** `APPROVE` and `REQUEST_CHANGES` are
verdicts, and the verdict is `code.submit-pr-verdict`'s round, drafted and approved
separately so the user sees the verdict as a verdict. The allowlist cannot see inside this
file — it pins *where* the file comes from, not what is in it — so this instruction is the
actual guardrail, exactly like `code.merge-pr`'s "never draft `--delete-branch`". Writing
`"event": "APPROVE"` here approves somebody else's PR on a draft the user read as "post these
comments".

For a comment on a multi-line span use `"start_line"` + `"line"`. For a comment on the
left (deleted) side use `"side": "LEFT"`. Do not invent `position` offsets — `line` +
`side` is the modern spelling and the one GitHub validates cleanly.

## Step 4 — Draft the post (`writeGate` absent, or `writeGate.phase === "draft"`)

```
mcp__outpost__submit_write_draft({
  jobId: "<$JOB_ID>", stepId: "<$STEP_ID>",
  summary: "Post <n> review comments on <PR_URL>",
  evidence: "<the comment set rendered as markdown — file, line, body, one per comment, plus the summary line if any>",
  calls: [{
    label: "post review",
    bash: "gh api --method POST \"repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews\" --input /tmp/outpost-review-<PR_NUMBER>.json",
    files: { "/tmp/outpost-review-<PR_NUMBER>.json": "<the payload from Step 3>" }
  }]
})
```

`{owner}` and `{repo}` are `gh api`'s own placeholders, filled from the remote of the repo
your cwd sits in — write them literally, exactly as spelled above. A spelled-out
`repos/<owner>/<repo>/…` would let this round post the review the user approved for *this*
PR onto a PR in a repo it was never shown. `<PR_NUMBER>` is a literal digit, and the
`--input` path — the same literal path used as the `files` key — has no `$VAR` anywhere in
it. Do not `cd` out of the worktree before drafting or before Step 5.

Then stop. If `writeGate.feedback` is non-empty (the user wants a comment reworded or
dropped — every round, oldest first), revise `boundNote`'s content, update `files`, and draft
again — the payload changes, the command doesn't.

## Step 5 — Commit: post the review

`writeGate.phase === "commit"`. Run `writeGate.approvedCalls` **verbatim** — the exact `gh
api` call the user approved. The `--input` file is already on disk with the approved
(possibly user-edited) payload — the daemon wrote it at accept time, so there is nothing to
rebuild here even on a fresh turn.

## Step 6 — Handle comments GitHub refuses

If a `path`/`line` is not part of the PR's diff, GitHub answers `422` and **rejects the
whole review** — nothing is posted. That is not a reason to drop the comment silently, and
it is not a new write to draft from scratch — the approved text doesn't change, only where
it lands.

1. Read the `422` body; it names the offending comment(s)
   (`pull_request_review_thread.line must be part of the diff`).
2. Move each offending comment out of `comments` and into the review `body`, prefixed with
   the file and line it was meant for, e.g.
   `**src/work/orchestrator.ts:412** — <approved body, verbatim>`.
3. **This is a new payload, so it needs a new draft — not a silent rewrite-and-retry.** The
   failed call already released its own pin (see SHARED-write-drafts.md's "Rules that don't
   bend"), but the file's approved-content digest still points at the ORIGINAL placement; a
   changed payload against the same path is exactly the "changed since the draft was
   approved" case the hook exists to deny, unapproved-and-silent is not an option here anyway.
   Go back to Step 4 with the reshaped payload as the new `files` value (same command, same
   `/tmp/` path, moved comments) and get it approved before Step 5 runs again.
4. Record every degraded comment in `postedReview` (Step 7a) as `degraded-to-body` with the
   reason.

The body text stays verbatim; only its *placement* changed — do not use this recovery path to
reword, drop, or add anything. A comment the user approved and that never reached the PR is a
silent failure of this whole step, and `postedReview` is the only place anyone would ever
see it.

If the post fails for any other reason, do not retry blindly — hand it back (Step 7b) with
`gh`'s stderr.

## Step 7a — Report what landed

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`artifacts.postedReview` is the **only** durable record that these comments went out, and
the controller's ladder reads it to know this rung is done. It also has to be
machine-checkable, because `code.verify-resolutions` walks it comment by comment on a later
round.

**First line: the review id and the commit you posted against**, exactly
`review: <id> (commit <headRefOid from Step 2>)`. The commit is not decoration, and it does
two jobs the daemon cannot do for you. The controller's rung 8 fires on `pr.headRefOid` (the
watcher's current head) differing from the last head verified — and until a verify round has
run, *this* line is the last head verified, so it is where the comparison starts. Separately,
`code.verify-resolutions` uses the same sha as the left-hand side of its compare range: it is
the commit the review was anchored to, which no later fact can reconstruct. A `postedReview`
whose first line has no commit leaves that rung unreadable, and an unreadable rung either never
fires (the controller waits forever while the author pushes fix after fix) or fires on every
wake.

Then one line per comment: path, line, outcome, and the first 80 characters of the body.

**Your `memo` replaces the controller's, wholesale.** The daemon overwrites `memo` with
whatever this submit carries — it does not merge, and there is no second copy. Everything the
controller was keeping there is gone unless you write it again: what the review concluded and
why, and any waiver or instruction the user gave it. Carry that narrative
forward and add your line to it. A memo that is only a status line costs the controller a
whole round to rebuild, and costs the review's reasoning outright.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "review_posted",
  memo: "posted review <id> on <PR_URL> against head <headRefOid>: <n> line comments, <m> degraded to body. <then the controller's own narrative, carried forward verbatim: what the review concluded, and any user override it had recorded>",
  artifacts: { postedReview: "review: 2314567890 (commit abc1234)\n- src/work/orchestrator.ts:412 — posted — \"This re-enters mutate() while the previous mutation is still…\"\n- src/pwa/app.js:88 — degraded-to-body (line not in diff) — \"The listener is never removed, so a second boot double-fires…\"" },
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to
`code.orchestrate-review` for a decision turn. It owns the ladder — whether to wait, verify
resolutions, or submit a verdict — so do not pick that yourself.

## Step 7b — Report nothing posted

Nothing to post, the draft was declined, or the post failed. Same hand-back, with the reason
in `memo`, and **no** `postedReview` artifact — an empty artifact would falsify the
controller's rung and it would never retry. This is the path where the memo matters most: the
controller's rows 7 and 10 have no artifact to read, so your line *is* the record, and it
still replaces everything that was there. Name what happened, then carry the controller's
narrative forward.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "review_pending",
  memo: "posted nothing: <boundNote was empty / no prUrl / user declined the draft (<reason>) / gh said '<stderr>'>. <then the controller's narrative, carried forward>",
  next: { kind: "self-round" }
})
```

## Step 8 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.post-pr-review",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "resolved" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or ambiguous
envelope field, anything you had to guess at or work around. Journal it even when you
recovered and the review landed: it recurs identically on every future run of this action
until a human sees it, and this journal is the only place `meta.improve-actions` looks.
Name the exact command or field, not the category.

## Failure modes

- **Envelope missing or unreadable.** Say so in one line and exit; the engine settles the
  step on the next tick. Don't guess at what to post.
- **The session died after posting but before reporting.** The round re-runs. Read
  `gh pr view "$PR_URL" --json reviews` first: if a review of yours is already there at
  that commit, record it in `postedReview` rather than posting it twice.
- **The PR head moved between the findings and now.** Post against the *current*
  `headRefOid`; comments whose lines no longer exist come back as `422` and go through
  Step 6. Say in the memo that the head moved.
- **The PR was closed or merged while the draft was pending.** GitHub still accepts a review
  on a merged PR, but it is noise. Hand it back (Step 7b) and let the controller decide.
- **Hook server returns 401.** Daemon restarted mid-session; print the situation and exit.
  Do not post on a session that cannot report what it posted.
