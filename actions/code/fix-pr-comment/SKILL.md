---
name: code.fix-pr-comment
description: Use when invoked as `/code.fix-pr-comment` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.fix-pr-comment"`. Read the envelope, edit files to address the PR comment, NEVER commit / push / post comments, then report via `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: worktree-edit
  runner: claude
  plannable: false
  permissions: [read, edit]
  timeout_sec: 1800
  retries: 0
---

# PR fix

This is the same session that implemented the PR and triaged its comments, resumed to apply one reviewer's requested change. You already know this code and you've seen the sibling comments from triage — so a comment like "same thing here" resolves against what you already discussed. `boundNote` names the specific comments to act on (and the envelope re-states the goal as a refresher after any compaction). Your job: edit files in the worktree to address them, then report that you're done. Do not commit, do not push, do not reply on the PR — the user reviews the diff and pushes themselves.

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

Fields you'll use:

| Field | Meaning |
|---|---|
| `jobId`, `stepId` | Identifiers — POST them back. |
| `workspace.repoCwd`, `workspace.branch` | Parent repo path + branch. Your cwd is the worktree. |
| `boundNote` | The comments to address this round, verbatim, with their files/lines and the change each needs. |
| `pr.comments` | Every comment on the PR — look the ones named in `boundNote` up here for their full body, file, line, and diff hunk. |
| `goal`, `inputs.approach` | Original step spec, for context if a comment is ambiguous. |
| `recentLessons` | Short lessons you wrote at the end of past code.fix-pr-comment runs. Skim them before editing. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

```bash
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
NOTE=$(jq -r '.boundNote // ""' "$OUTPOST_ENVELOPE")
COMMENTS=$(jq -c '.pr.comments // []' "$OUTPOST_ENVELOPE")
```

`DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited from the spawn.

## Step 2 — Edit files

Make the minimum change that addresses the reviewer's concern. Same constraints as the implementer:

- Edit files in place; never `git add` / `git commit` / `git push`.
- Never run `gh pr comment` / `gh pr review` / any GitHub mutation. Replies are a separate path — `code.reply-pr-comments` posts them, on a round the user approves separately.
- Don't write scratch JSON or notes files anywhere in the worktree. Use `/tmp/` for anything you need to materialize.

The `comment.diffHunk` (when present) anchors the comment to a specific span of code; combined with `comment.file` and `comment.line` you have enough to find the spot in the worktree.

If you need fresh diff context:

```bash
git fetch origin && git diff origin/main..HEAD
```

If the edit is non-trivial and could regress something, run the project's own tests.

## Step 3 — Submit the edit result

The outpost MCP tools are deferred behind ToolSearch — load `submit_step_progress` (and `submit_journal` for the next step) first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

If the tool doesn't come back, halt. The daemon will not scrape the transcript.

Say in `memo` which comments you addressed and how — that is the only durable record of
this round. On success:

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "pr_comments",
  memo: "<which comments you addressed and the edit each got>",
  next: { kind: "self-round" }
})
```

If you couldn't figure out what to change, or the edit conflicts, say so in `memo` and
hand back the same way — the decision turn decides whether that is retryable, and it is
the only thing that may fail the step:

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "pr_comments",
  memo: "could not address <comment>: <one-line reason>",
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to `code.orchestrate-pr` for a decision turn. It owns the ladder — which round runs next, and whether the user is asked to approve anything — so do not pick that yourself.

Then write a one-line summary in chat of what you changed (or why you gave up) — the user reads this in the activity stream.

## Step 4 — Journal one lesson

Before exiting, call `mcp__outpost__submit_journal` with one short lesson the *next* code.fix-pr-comment run should know. Skip entirely if there's nothing new.

```
mcp__outpost__submit_journal({
  action: "code.fix-pr-comment",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "done" | "failed" | "conflicted",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the step succeeded: it recurs identically on every future run of
this action until a human sees it, and this journal is the only place
`meta.improve-actions` looks. Name the exact command or field, not the category.

## Failure modes

- **Envelope missing or unreadable.** Something went wrong upstream — exit with a brief error; the orchestrator will mark the job failed on the next tick when it doesn't get a POST.
- **The comment references code that no longer exists.** That's an edit failure with reason `file/line no longer in worktree`. The user decides next steps (retry with a new note, fall back to a reply, or ignore).
- **Hook server returns 401.** Daemon restarted mid-session. There's no recovery — print the situation and exit; the orchestrator will respawn on the next tick.
