---
name: code.fix-pr-comment
description: Use when invoked as `/code.fix-pr-comment` in a session spawned by the Outpost work orchestrator inside an open-pr step's worktree, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=open-pr`, and `typePayload.editJob` populated. Read the envelope, edit files to address the PR comment, NEVER commit / push / post comments, then call `mcp__outpost__submit_edit_done`.
outpost:
  kind: action
  category: code
  side_effects: worktree-edit
  runner: claude
  permissions: [read, edit]
  timeout_sec: 1800
  retries: 0
---

# PR fix

This is the same session that implemented the PR and triaged its comments, resumed to apply one reviewer's requested change. You already know this code and you've seen the sibling comments from triage — so a comment like "same thing here" resolves against what you already discussed. The envelope names the specific comment to act on (and re-states the goal as a refresher after any compaction). Your job: edit files in the worktree to address that comment, then POST that you're done. Do not commit, do not push, do not reply on the PR — the user reviews the diff and pushes themselves.

## Step 1 — Read the envelope

```bash
test -r "$OUTPOST_ENVELOPE" || { echo "missing envelope: $OUTPOST_ENVELOPE"; exit 1; }
```

Fields you'll use:

| Field | Meaning |
|---|---|
| `jobId`, `stepId` | Identifiers — POST them back. |
| `workspace.repoCwd`, `workspace.branch` | Parent repo path + branch. Your cwd is the worktree. |
| `typePayload.editJob.id` | The edit-job id — POST back as `editId`. |
| `typePayload.editJob.comment` | Full `PrComment` — `{id, author, body, file?, line?, diffHunk?, createdAt}`. |
| `typePayload.editJob.userNote` | Optional user guidance — additional context, not an override. |
| `goal`, `approach` | Original step spec, for context if the comment is ambiguous. |
| `recentLessons` | Short lessons you wrote at the end of past code.fix-pr-comment runs. Skim them before editing. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

```bash
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
EDIT_ID=$(jq -r '.typePayload.editJob.id' "$OUTPOST_ENVELOPE")
COMMENT=$(jq -c '.typePayload.editJob.comment' "$OUTPOST_ENVELOPE")
USER_NOTE=$(jq -r '.typePayload.editJob.userNote // ""' "$OUTPOST_ENVELOPE")
```

`DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited from the spawn.

## Step 2 — Edit files

Make the minimum change that addresses the reviewer's concern. Same constraints as the implementer:

- Edit files in place; never `git add` / `git commit` / `git push`.
- Never run `gh pr comment` / `gh pr review` / any GitHub mutation. Replies are a separate path.
- Don't write scratch JSON or notes files anywhere in the worktree. Use `/tmp/` for anything you need to materialize.

The `comment.diffHunk` (when present) anchors the comment to a specific span of code; combined with `comment.file` and `comment.line` you have enough to find the spot in the worktree.

If you need fresh diff context:

```bash
git fetch origin && git diff origin/main..HEAD
```

If the edit is non-trivial and could regress something, run the project's own tests.

## Step 3 — Submit the edit result

The outpost MCP tools are deferred behind ToolSearch — load `submit_edit_done` (and `submit_journal` for the next step) first:

```
ToolSearch({ query: "select:mcp__outpost__submit_edit_done,mcp__outpost__submit_journal", max_results: 2 })
```

If the tool doesn't come back, halt. The daemon will not scrape the transcript.

On success:

```
mcp__outpost__submit_edit_done({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  editId: "<$EDIT_ID>",
  status: "done"
})
```

On failure (you couldn't figure out what to change, or the edit conflicts):

```
mcp__outpost__submit_edit_done({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  editId: "<$EDIT_ID>",
  status: "failed",
  failure: "<one-line reason>"
})
```

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
