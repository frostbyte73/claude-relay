---
name: code.post-pr-review
description: Use when invoked as `/code.post-pr-review` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.post-pr-review"`. Post the review comments the user already approved onto somebody else's PR as one GitHub review — verbatim, nothing added — and record exactly what landed in `artifacts.postedReview`. Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  permissions: [read, pull]
  timeout_sec: 600
  retries: 0
---

# Post the approved review

This is the same session that read the PR and worked out what was wrong with it.
`code.orchestrate-review` decided the comment set is ready to go out and rebound this
round to you — **this is not a fresh session and not a dispatch.** You keep the
controller's conversation, its worktree and its envelope; only the bound action changed
for one turn.

Because this action declares `side_effects: external-write`, the daemon held the move at a
user gate before you were resumed, and it rendered the controller's `note` into the gate
draft. **The user has already read the exact comment bodies in `boundNote` and approved
them.** Do not gate them again, do not ask, and do not improve them.

Your job is exactly one thing: post the comments in `boundNote`, verbatim, as one GitHub
review on the PR they belong to.

- **Do not re-review.** You are not deciding what is wrong with the PR on this turn; that
  decision is upstream and already approved.
- **Do not soften.** Not a hedge, not a "nit:" prefix that was not there, not an added
  compliment.
- **Do not add comments that were not approved** — including one you notice now. If
  something new matters, say so in the memo and let the controller run another round.

Nothing else is granted. This action deliberately does **not** inherit the `push` group;
`git commit`, `git push`, `gh pr merge`, `gh pr comment`, `gh pr create` and `gh pr review`
are all denied here. The verdict — approve or request changes — is a separate round
(`code.submit-pr-verdict`) with its own gate. If you find yourself wanting one of those,
this is the wrong round: hand it back (Step 6b).

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
| `boundNote` | **The approved payload.** One entry per comment: file path, line, and the exact body. This is what the user saw at the gate — it wins over everything else, including your own memory of the review. |
| `artifacts.review` | The synthesis round's full comment set, for context. Only the ones named in `boundNote` are approved. |
| `artifacts.postedReview` | What an earlier round already posted. Never post one of these twice. |
| `pr.prUrl` / `inputs.prUrl` | The PR to review. |
| `gateFeedback` | Anything the user wrote when approving. A wording change there is also approved text — apply it. |

If `PR_URL` or `boundNote` is empty there is nothing to post — skip to Step 6b and hand it
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

## Step 3 — Build the payload file

A multi-comment review is nested JSON — an array of comment objects — so it cannot be
expressed with `gh api -f` flags, and a heredoc is not usable either (the allowlist's
`splitShellCommand` does not understand heredocs, so a heredoc'd command is denied). Write
the payload with the **Write tool** to a path directly under `/tmp/`:

```
Write({ file_path: "/tmp/outpost-review-<PR_NUMBER>.json", content: "…" })
```

Outside this step's own worktree, `/tmp/` is the only place this action may write. The
worktree auto-allows via session scope — an `Edit`/`Write` under it succeeds rather than
denying — but it is a throwaway detached PR-head checkout, `git worktree remove --force`d
when the step settles: nothing you leave there survives, and nothing there reaches the PR.
The payload has to be somewhere `gh` can still read it and somewhere the allowlist pins, so
put it in `/tmp/`, and make the filename a **literal** — write the PR number into it yourself
rather than letting the shell expand a variable, or the post in Step 4 is denied.

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
verdicts, and the verdict is `code.submit-pr-verdict`'s round, gated separately so the user
approves the verdict as a verdict. The allowlist cannot see inside this file — it pins
*where* the file comes from, not what is in it — so this instruction is the actual
guardrail, exactly like `code.merge-pr`'s "never write `--delete-branch`". Writing
`"event": "APPROVE"` here approves somebody else's PR on a gate the user read as
"post these comments".

For a comment on a multi-line span use `"start_line"` + `"line"`. For a comment on the
left (deleted) side use `"side": "LEFT"`. Do not invent `position` offsets — `line` +
`side` is the modern spelling and the one GitHub validates cleanly.

## Step 4 — Post the review

One command, one line, literal PR number:

```bash
gh api --method POST "repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews" --input /tmp/outpost-review-<PR_NUMBER>.json
```

`{owner}` and `{repo}` are `gh api`'s own placeholders, filled from the repo your cwd sits
in. If the worktree's remote is not the PR's repo, write `repos/<owner>/<repo>/…`
literally instead — both spellings are granted.

What is granted is exactly that shape and nothing around it:

| Allowed | Notes |
|---|---|
| `--method POST` / `-X POST` | the only method |
| `repos/<owner>/<repo>/pulls/<n>/reviews` | the only endpoint |
| `--input /tmp/<literal-filename>` | the only payload source |

Anything else denies — a second flag (`--hostname`, `--jq`, another `--method`), a
`--input` path outside `/tmp/`, a `\`-continuation across lines, or a second command
chained with `&&`. That closure is the point: `--input` is a file read, so an unpinned one
would publish `/etc/passwd` or `~/.outpost/.env` as review text on a public PR.

## Step 5 — Handle comments GitHub refuses

If a `path`/`line` is not part of the PR's diff, GitHub answers `422` and **rejects the
whole review** — nothing is posted. That is not a reason to drop the comment silently.

1. Read the `422` body; it names the offending comment(s)
   (`pull_request_review_thread.line must be part of the diff`).
2. Move each offending comment out of `comments` and into the review `body`, prefixed with
   the file and line it was meant for, e.g.
   `**src/work/orchestrator.ts:412** — <approved body, verbatim>`.
3. Rewrite the payload file and post again.
4. Record every degraded comment in `postedReview` (Step 6a) as `degraded-to-body` with the
   reason.

The body text stays verbatim; only its *placement* changed. A comment the user approved and
that never reached the PR is a silent failure of this whole step, and `postedReview` is the
only place anyone would ever see it.

If the post fails for any other reason, do not retry blindly — hand it back (Step 6b) with
`gh`'s stderr.

## Step 6a — Report what landed

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`artifacts.postedReview` is the **only** durable record that these comments went out, and
the controller's ladder reads it to know this rung is done. It also has to be
machine-checkable, because `code.verify-resolutions` walks it comment by comment on a later
round.

**First line: the review id and the commit you posted against**, exactly
`review: <id> (commit <headRefOid from Step 2>)`. The commit is not decoration. The
controller's rung 8 fires on "the PR's head differs from the last head I verified", and this
line is where it initialises that value; `code.verify-resolutions` uses the same sha as the
left-hand side of its compare range. A `postedReview` whose first line has no commit leaves
that rung unreadable, and an unreadable rung either never fires (the controller waits forever
while the author pushes fix after fix) or fires on every wake.

Then one line per comment: path, line, outcome, and the first 80 characters of the body.

**Your `memo` replaces the controller's, wholesale.** The daemon overwrites `memo` with
whatever this submit carries — it does not merge, and there is no second copy. Everything the
controller was keeping there is gone unless you write it again: the head sha, what the review
concluded and why, and any waiver or instruction the user gave it. Carry that narrative
forward and add your line to it. A memo that is only a status line costs the controller a
whole round to rebuild, and costs the review's reasoning outright.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "review_posted",
  memo: "posted review <id> on <PR_URL> against head <headRefOid>: <n> line comments, <m> degraded to body. Last verified head: <headRefOid>. <then the controller's own narrative, carried forward verbatim: what the review concluded, and any user override it had recorded>",
  artifacts: { postedReview: "review: 2314567890 (commit abc1234)\n- src/work/orchestrator.ts:412 — posted — \"This re-enters mutate() while the previous mutation is still…\"\n- src/pwa/app.js:88 — degraded-to-body (line not in diff) — \"The listener is never removed, so a second boot double-fires…\"" },
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to
`code.orchestrate-review` for a decision turn. It owns the ladder — whether to wait, verify
resolutions, or submit a verdict — so do not pick that yourself.

## Step 6b — Report nothing posted

Nothing to post, or the post failed. Same hand-back, with the reason in `memo`, and **no**
`postedReview` artifact — an empty artifact would falsify the controller's rung and it
would never retry. This is the path where the memo matters most: the controller's rows 7 and
10 have no artifact to read, so your line *is* the record, and it still replaces everything
that was there. Name what `gh` said, then carry the controller's narrative forward.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "review_pending",
  memo: "posted nothing: <boundNote was empty / no prUrl / gh said '<stderr>'>. <then the controller's narrative, carried forward>",
  next: { kind: "self-round" }
})
```

## Step 7 — Journal one lesson

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
  that commit, record it in `postedReview` rather than posting it twice. A duplicate review
  on somebody else's PR is worse than a delayed one.
- **The PR head moved between the findings and now.** Post against the *current*
  `headRefOid`; comments whose lines no longer exist come back as `422` and go through
  Step 5. Say in the memo that the head moved.
- **The PR was closed or merged while the gate was open.** GitHub still accepts a review on
  a merged PR, but it is noise. Hand it back (Step 6b) and let the controller decide.
- **Hook server returns 401.** Daemon restarted mid-session; print the situation and exit.
  Do not post on a session that cannot report what it posted.
