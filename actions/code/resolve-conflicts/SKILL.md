---
name: code.resolve-conflicts
description: Use when invoked as `/code.resolve-conflicts` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.resolve-conflicts"`. Merge the base branch (default `origin/main`) into the branch, resolve conflicts using knowledge of why the code exists, commit with the default merge message and push — or `git merge --abort` and report unresolvable. Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  permissions: [read, edit, push]
  timeout_sec: 1800
  retries: 0
---

# Resolve PR merge conflicts

This is the same session that implemented the PR (and triaged its comments). Main has
advanced and the PR now conflicts, blocking the merge. Your job: bring the branch up to
date with the base branch, resolve the conflicts *correctly* using what you already know
about why this code exists, then commit and push if the round asks for it. If you cannot
resolve confidently, abort cleanly and hand it back — never push a guessed resolution.

## Step 1 — Read the envelope

```bash
test -r "$OUTPOST_ENVELOPE" || { echo "missing envelope: $OUTPOST_ENVELOPE"; exit 1; }
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`goal` and `inputs.approach` restate the PR's intent — useful when a conflict hunk is ambiguous.
`boundNote` is what the controller asked for this round.
`DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited from the spawn. Your cwd is the worktree.

## Step 2 — Merge the base branch

The base is `origin/main` unless `boundNote` names a different one:

```bash
BASE=origin/main    # override only if boundNote says so
case "$BASE" in */*) git fetch "${BASE%%/*}" ;; esac   # only remote refs need a fetch
git merge "$BASE"
```

- **Merge succeeds cleanly:** go to Step 3.
- **Merge reports conflicts:** resolve each conflicted file. You know why the PR's side
  looks the way it does — reconcile it with main's changes rather than blindly taking one
  side. After editing, `git add` the resolved files. If the resolution is non-trivial, run
  the project's tests before continuing.
- **Not confident** (semantics you can't reconcile, or the conflict is outside what this PR
  touched): abort and report unresolvable (Step 4b).

## Step 3 — Commit and push (confident resolution only)

Commit with git's default merge message (no `-m`), then push so the PR picks the merge up
— unless `boundNote` explicitly says not to:

```bash
git commit --no-edit
git push
```

If the push is rejected (branch moved again under you), you may re-run Step 2 once. If it
still fails, abort and report unresolvable.

## Step 4a — Report resolved

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`memo` carries the outcome — there is no status field. Say plainly that the conflicts are
resolved and what you reconciled; the decision turn reads only this.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "conflict",
  memo: "conflicts resolved: <files> reconciled by <how>; merge committed and pushed",
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to `code.orchestrate-pr` for a decision turn. It owns the ladder — which round runs next, and whether the user is asked to approve anything — so do not pick that yourself.

Write a one-line summary in chat of what conflicted and how you reconciled it — the user
reads this in the activity stream.

## Step 4b — Report unresolvable

Leave the tree clean first, then report:

```bash
git merge --abort
```

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "conflict",
  memo: "conflicts UNRESOLVABLE: <files>, <one-line reason>; merge aborted, tree clean",
  next: { kind: "self-round" }
})
```

Then say in chat which files conflicted and why you couldn't reconcile them, so the user
can finish by hand.

## Step 5 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.resolve-conflicts",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "resolved" | "unresolvable",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the step succeeded: it recurs identically on every future run of
this action until a human sees it, and this journal is the only place
`meta.improve-actions` looks. Name the exact command or field, not the category.

## Failure modes

- **Envelope missing/unreadable:** exit with a brief error; the orchestrator marks the step
  on the next tick.
- **`git push` rejected twice:** abort the merge and report unresolvable — don't force-push.
- **Hook server returns 401:** daemon restarted mid-session; print the situation and exit.
  The orchestrator resets `conflictResolving` at boot and re-surfaces the gate.
