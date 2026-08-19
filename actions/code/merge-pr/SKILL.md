---
name: code.merge-pr
description: Use when invoked as `/code.merge-pr` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.merge-pr"`. Confirm the PR the controller has shepherded to green + approved is still mergeable, draft the merge + remote-branch-delete via `mcp__outpost__submit_write_draft`, then run them verbatim once approved (see `SHARED-write-drafts.md`). Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  plannable: false
  permissions: [read, push]
  timeout_sec: 600
  retries: 0
---

# Merge the PR

This is the same session that implemented the PR and shepherded it through CI, review
comments and conflicts. `code.orchestrate-pr` has decided the PR is ready to land and
bound this round to you.

This is a bound-action round on the controller's own session (`type: "orchestrated"`), so
`writeGate` (see `~/.outpost/actions/SHARED-write-drafts.md`) sits at the **top level** of `$OUTPOST_ENVELOPE`,
not under a `typePayload`. Your job is exactly three things: confirm the PR is still
mergeable, draft the merge + remote-branch-delete for approval, then run exactly what the
user approved. Nothing else.

This action inherits the `push` permission group, which is broad — `git push`, `git commit`,
`gh pr comment`/`create`/`edit`/`close`/`review`, `gh issue create`, and more all pass its raw
allowlist. **That is not permission to use them.** The gate is what actually confines this
round: a call only runs once it matches a call the user approved in *this* round's draft, and
your draft should only ever contain the merge and the branch delete — **both** of them, as two
separate `calls` entries; see Step 3. `git push <remote> --delete <branch>` is itself part of
the `push` group, so it is gated exactly like the merge is — there is no "ordinary command"
path around the draft for it. Wanting to run anything else — `gh pr comment`, `gh api`, a
fresh `git push` of new commits — is a sign you're in the wrong round: hand it back (Step 5b)
rather than drafting it.

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PR_URL=$(jq -r '.pr.prUrl // empty' "$OUTPOST_ENVELOPE")
BRANCH=$(jq -r '.workspace.branch // empty' "$OUTPOST_ENVELOPE")
echo "$BRANCH"
```

**Read `$BRANCH`'s printed value and write it into the draft as a literal** (Step 3) — not as
`"$BRANCH"`. Separate Bash calls don't share shell state, so a variable set in this turn is not
set in the commit-phase turn; a literal is what makes the approved call reproducible there, and
it's also what lets the user actually see which branch they're approving the deletion of,
rather than an opaque variable name.

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`boundNote` is what the controller asked for this round — read it for a merge strategy
(`--squash` is the default; use `--merge` or `--rebase` only if `boundNote` names one) and
for anything it wants in the merge commit. `writeGate.feedback` (once you've drafted) carries
whatever the user wrote when proposing changes. `DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are
inherited. Your cwd is the worktree.

If `PR_URL` is empty there is nothing to merge — skip to Step 5b and hand it back.

## Step 2 — Confirm the PR is still landable

The facts in `pr` are as the watcher last saw them, which can be minutes stale. Re-read
them from GitHub before drafting:

```bash
gh pr view "$PR_URL" --json state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
```

- `state == "MERGED"` — somebody already merged it. Do **not** draft a merge — draft only the
  branch-delete call (Step 3 covers both shapes). This round is idempotent by design: a
  re-entry after a daemon bounce must not fail.
- `state == "CLOSED"` — nothing to merge. Hand it back (Step 5b) with that as the reason.
- `mergeable == "CONFLICTING"` — the base moved under you. Hand it back (Step 5b); the
  controller will bind a `code.resolve-conflicts` round.
- Anything else that blocks the merge (a required check that went red again, a stale
  approval, branch protection) — hand it back with the specific blocker named.

**Read the PR number off `PR_URL` and remember it.** The draft's merge call takes the number
as a literal digit string — not `"$PR_URL"`, not `$PR_NUM`. If the URL is ever ambiguous, ask
GitHub:

```bash
gh pr view "$PR_URL" --json number --jq .number
```

## Step 3 — Draft the merge + branch delete (`writeGate` absent, or `writeGate.phase === "draft"`)

Two calls, **both** drafted together — `git push <remote> --delete <branch>` is part of the
`push` group too, so it's gated exactly like the merge and there is no ungated path for it
(see the note above). Draft both now, even though Step 4 runs the delete only after a
confirmed merge:

```
mcp__outpost__submit_write_draft({
  jobId: "<$JOB_ID>", stepId: "<$STEP_ID>",
  summary: "Merge PR #<n> (<strategy>) and delete branch <branch>",
  evidence: "<the gh pr view output from Step 2, or a short note on why it's landable>",
  calls: [
    { label: "merge", bash: "gh pr merge <PR_NUMBER> --squash" },
    { label: "delete-branch", bash: "git push origin --delete -- \"<branch>\"" }
  ]
})
```

(`<branch>` above is a placeholder — substitute the real value `$BRANCH` printed in Step 1.
Draft the literal branch name, not a realistic-looking one: this call is destructive, and a
placeholder that reads as a real branch is a hazard to copy verbatim by mistake.)

If Step 2 found the PR **already merged**, draft only the `delete-branch` call — there is
nothing left to merge, and drafting a merge call that will never run just confuses the
approval card.

Every value in both calls is literal — the PR number a bare digit, the strategy exactly one of
`--squash` / `--merge` / `--rebase` (default `--squash` unless `boundNote` names another), the
branch name the real string from Step 1's `$BRANCH`, and, if `boundNote` asks for a
merge-commit message, a literal `--subject`/`--body`. **Do not draft `"$BRANCH"` (the variable
name) even quoted** — the allowlist would let it through syntactically, but two other things
wouldn't: separate Bash calls don't share shell state, so a variable this turn set is not set
in the commit-phase turn (which would try to expand an empty/undefined `$BRANCH` and delete the
wrong thing, or nothing); and the approval card would show the user a variable name instead of
the branch they're actually approving the deletion of. Substitute the real value before you
draft. Then stop.

If `writeGate.feedback` is non-empty (the user asked for a different strategy, message, or to
skip the delete — every round, oldest first), redraft addressing it.

**Never draft `--delete-branch` on the `gh pr merge` call itself.** This is not a style
preference; it is a bug Outpost already shipped once and had to fix. `gh pr merge
--delete-branch` also deletes the *local* branch, and this step's branch is still checked out
in this worktree, so git refuses with `cannot delete branch '…' used by worktree at '…'` —
which makes the **whole `gh` invocation exit non-zero even though the PR merged on GitHub**.
That is exactly why the merge and the branch delete are two separate `calls` entries rather
than one: a cleanup failure must never be mistaken for a merge failure, and each needs its own
pass/fail in Step 4's report.

## Step 4 — Commit: merge, then delete the remote branch

`writeGate.phase === "commit"`. Run `writeGate.approvedCalls` **verbatim**, in order — the
exact calls the user approved, unchanged.

```bash
gh pr merge <PR_NUMBER> --squash
```

(Skip this one if Step 2 already found the PR merged and you only drafted the delete.) If it
fails, the PR did **not** merge — do not retry blindly (`--admin`, bypassing branch protection,
is not something to reach for here). Hand it back (Step 5b) with `gh`'s stderr, and do not run
the delete call.

Once the merge succeeds (or Step 2 found it already merged), run the approved delete call —
the exact literal branch name text from the pin, unchanged:

```bash
git push origin --delete -- "<branch>"
```

Its outcome does not change the outcome of this round — it's a best-effort cleanup, not a
second chance to fail the merge.

**The allowlist rule for this is shape-only, not name-aware.** It checks "an explicit remote, a
literal `--delete`, exactly one branch operand" — it does **not** refuse `main`, `master`,
`HEAD`, or any other protected-looking name by content (an earlier version of the rule tried a
name blacklist and it was removed as unsound, see `tests/unit/permission-group-push.test.ts`).
The **only** thing standing between an approved draft and deleting the wrong ref is that the
branch name you drafted is `workspace.branch`, written as a literal, and that the user read and
approved that exact literal name before anything ran — never draft any other branch name here,
and never let this call's target be anything but this step's own branch. Expect the delete to
fail sometimes anyway and **ignore it when it does** — GitHub's "automatically delete head
branches" setting may have already reaped it, or the repo may protect the branch. Note it in
the memo, then carry on as merged. Leave the **local** branch alone; the worktree teardown
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
the step — so do not pick that yourself, and never re-draft the merge on your own.

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
- **The draft is declined:** hand back (Step 5b) with the reason the user gave, rather than
  re-drafting the same merge.
- **Remote branch delete fails:** not a failure of this round. Report merged, mention it.
- **Hook server returns 401:** daemon restarted mid-session; print the situation and exit.
  Do not merge on a session that cannot report the result — re-check Step 2 on the resume.
