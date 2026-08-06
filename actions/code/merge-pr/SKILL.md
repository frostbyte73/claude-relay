---
name: code.merge-pr
description: Use when invoked as `/code.merge-pr` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.merge-pr"`. Land the PR the controller has shepherded to green + approved — `gh pr merge` on its own (NEVER `--delete-branch`), then delete the remote branch as a separate best-effort command. Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# Merge the PR

This is the same session that implemented the PR and shepherded it through CI, review
comments and conflicts. `code.orchestrate-pr` has decided the PR is ready to land and
bound this round to you. Because this action declares `side_effects: external-write`, the
daemon held the move at a user gate before you were resumed — **the user has already
approved this merge.** Do not gate it again, do not ask; land it.

Your job is exactly three things: confirm the PR is still mergeable, merge it, then make a
best-effort attempt at deleting the remote branch. Nothing else — and nothing else is
granted. This action inherits neither the `push` group nor `pull`: its whole grant is
`read` plus four rules of its own — `gh pr view`, the `gh pr merge` whitelist below, and
the two `git push --delete` shapes. So `git commit`, `git push` of new commits,
`gh pr comment/close/create` and `gh release create` are all denied here, and so is
`gh api` in every form — that is deliberate, because `gh api -X PUT …/pulls/12/merge` is
the REST spelling of the merge and would walk straight around the whitelist. If you find
yourself wanting one of those, this is the wrong round: hand it back (Step 5b).

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PR_URL=$(jq -r '.pr.prUrl // empty' "$OUTPOST_ENVELOPE")
BRANCH=$(jq -r '.workspace.branch // empty' "$OUTPOST_ENVELOPE")
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`boundNote` is what the controller asked for this round — read it for a merge strategy
(`--squash` is the default; use `--merge` or `--rebase` only if `boundNote` names one) and
for anything it wants in the merge commit. `gateFeedback` carries whatever the user wrote
when they approved. `DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited. Your cwd is the
worktree.

If `PR_URL` is empty there is nothing to merge — skip to Step 5b and hand it back.

## Step 2 — Confirm the PR is still landable

The facts in `pr` are as the watcher last saw them, which can be minutes stale. Re-read
them from GitHub before writing:

```bash
gh pr view "$PR_URL" --json state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
```

- `state == "MERGED"` — somebody already merged it. Do **not** merge again; go straight to
  Step 4 (remote branch cleanup) and then report merged in Step 5a. This round is
  idempotent by design: a re-entry after a daemon bounce must not fail.
- `state == "CLOSED"` — nothing to merge. Hand it back (Step 5b) with that as the reason.
- `mergeable == "CONFLICTING"` — the base moved under you. Hand it back (Step 5b); the
  controller will bind a `code.resolve-conflicts` round.
- Anything else that blocks the merge (a required check that went red again, a stale
  approval, branch protection) — hand it back with the specific blocker named.

## Step 3 — Merge. Merge ONLY.

```bash
gh pr merge "$PR_URL" --squash
```

There is no second route to a merge: `gh api` is not granted, so the REST endpoint
(`PUT /repos/{owner}/{repo}/pulls/{n}/merge`) is denied too. `gh pr merge` is the merge.

**NEVER pass `--delete-branch`.** This is not a style preference; it is a bug Outpost
already shipped once and had to fix. `gh pr merge --delete-branch` also deletes the
*local* branch, and this step's branch is still checked out in this worktree, so git
refuses with `cannot delete branch '…' used by worktree at '…'`. That makes the **whole
`gh` invocation exit non-zero even though the PR merged on GitHub** — so the caller reads
a failure, the step never leaves its merge gate, and the PWA shows nothing happening until
the PR watcher reconciles the merge much later. The merge and the branch cleanup must be
two separate commands so a cleanup failure can never be mistaken for a merge failure.

This is not left to your good intentions. The allowlist does not *blocklist* `-d` — a flag
parser accepts too many spellings of it (`-d`, `-sd`, `-d=true`, `-db"msg"`, `"-d"`, `-d$X`)
for a blocklist to hold. It **whitelists**: `gh pr merge` is granted only when every word
after it is one the action is meant to use, and anything else is denied by default. What is
allowed:

| Allowed | Notes |
|---|---|
| the PR operand | a URL, a number, or `"$PR_URL"` / `$PR_URL` |
| `--squash`, `--merge`, `--rebase` | the strategy; `--squash` unless `boundNote` says otherwise |
| `--auto` | |
| `--subject <text>`, `--body <text>` | the squash commit message, when `boundNote` asks for one |

Everything else is denied — including `--delete-branch` and every `-d` spelling, `--admin`,
the `-s`/`-m`/`-r` shorthands, and a `\`-continued command split across lines. Write the
merge on **one line**. If you see a denial here, you wrote something outside that table —
drop it and re-run the plain merge, then do Step 4.

If `gh pr merge` itself fails, the PR did **not** merge. Do not retry blindly; `--admin`
(bypassing branch protection) is denied for the same reason it is a bad idea. Hand it back
(Step 5b) with `gh`'s stderr in the memo.

## Step 4 — Delete the remote branch (best effort — failure is not a failure)

Separate command, run only after the merge succeeded. Its outcome does not change the
outcome of this round:

```bash
git push origin --delete -- "$BRANCH"
```

The **only** branch you may delete is this step's own — `workspace.branch`, which is what
`$BRANCH` holds. The grant is shaped to match: an explicit remote, `--delete`, and exactly
**one** branch operand. No extra arguments, no second branch, no bare `git push --delete`,
and the literal names `main`, `master`, `HEAD`, `trunk`, `develop` and `release/…` are
denied outright — as is any `heads/…` or `refs/heads/…` spelling, since git resolves
`heads/main` to `refs/heads/main` just as readily as the bare name. If you ever find
yourself typing a branch name that
isn't `$BRANCH`, stop — that is not this round's job.

Expect this to fail sometimes and **ignore it when it does**: GitHub's "automatically
delete head branches" setting may have already reaped it, or the repo may protect the
branch. Note it in the memo, then carry on as merged.

Leave the **local** branch alone. It is still checked out here, and the worktree teardown
that follows the step resolving is what reaps it.

## Step 5a — Report merged

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

A confirmed merge ends the step, so this round resolves it rather than handing back a
decision. That is deliberate: `pr.prState` comes from the PR watcher, which may not
re-poll for an hour, so a controller resumed on stale facts would match the "green +
approved" rung again and ask the user to approve merging a PR that is already merged. You
read `state == "MERGED"` from GitHub itself — that is the ground truth the controller
would be waiting for.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "merged",
  memo: "merged <PR_URL> (squash); remote branch <BRANCH> deleted — OR — remote branch delete failed (<reason>), merge stands",
  next: { kind: "resolve", output: "Merged <PR_URL>: <one line on what shipped>." }
})
```

## Step 5b — Report not merged

Anything short of a confirmed merge hands the session back to `code.orchestrate-pr` for a
decision turn. It owns the ladder — whether to fix CI, resolve conflicts, re-gate, or fail
the step — so do not pick that yourself, and never re-gate the merge on your own.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "pr_open",
  memo: "merge NOT done: <specific blocker — conflicting / check X went red / gh said '<stderr>'>; PR still open",
  next: { kind: "self-round" }
})
```

## Step 6 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.merge-pr",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "resolved" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

Use `blocked` for anything short of a merge (the Step 5b path). That is the string the
Library and `meta.improve-actions` read as a blocker; a merge-specific word like
`not-merged` reads to them as a success.

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the merge landed: it recurs identically on every future run of this
action until a human sees it, and this journal is the only place `meta.improve-actions`
looks. Name the exact command or field, not the category.

## Failure modes

- **Envelope missing/unreadable:** exit with a brief error; the orchestrator marks the
  step on the next tick.
- **`gh pr merge` succeeded but the session died before reporting:** the round re-runs,
  Step 2 sees `state == "MERGED"`, and it reports merged without merging twice.
- **Remote branch delete fails:** not a failure of this round. Report merged, mention it.
- **Hook server returns 401:** daemon restarted mid-session; print the situation and exit.
  Do not merge on a session that cannot report the result — re-check Step 2 on the resume.
