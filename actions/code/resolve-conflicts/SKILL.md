---
name: code.resolve-conflicts
description: Use when invoked as `/code.resolve-conflicts` in a session spawned by the Outpost work orchestrator inside an open-pr step's worktree, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=open-pr`, and `typePayload.round.kind == "conflict"`. Merge the round's base branch (default `origin/main`) into the branch, resolve conflicts using knowledge of why the code exists, commit with the default merge message and push when the round asks (default yes) — or `git merge --abort` and report unresolvable. Finish with `mcp__outpost__submit_conflict_resolved`.
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

`goal`/`approach` restate the PR's intent — useful when a conflict hunk is ambiguous.
`DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited from the spawn. Your cwd is the worktree.

## Step 2 — Merge the base branch

The base to merge and whether to push are carried on the round:

```bash
BASE=$(jq -r '.typePayload.round.base // "origin/main"' "$OUTPOST_ENVELOPE")
PUSH=$(jq -r 'if .typePayload.round.push == false then "false" else "true" end' "$OUTPOST_ENVELOPE")
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

Commit with git's default merge message (no `-m`). Push only when the round asks for it
(a local squash-to-base handoff sets `push:false` — there's no PR branch to update):

```bash
git commit --no-edit
[ "$PUSH" != "false" ] && git push
```

If the push is rejected (branch moved again under you), you may re-run Step 2 once. If it
still fails, abort and report unresolvable.

## Step 4a — Report resolved

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_conflict_resolved,mcp__outpost__submit_journal", max_results: 2 })
```

```
mcp__outpost__submit_conflict_resolved({ jobId: "<$JOB_ID>", stepId: "<$STEP_ID>", status: "resolved" })
```

Write a one-line summary in chat of what conflicted and how you reconciled it — the user
reads this in the activity stream.

## Step 4b — Report unresolvable

Leave the tree clean first, then report:

```bash
git merge --abort
```

```
mcp__outpost__submit_conflict_resolved({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  status: "unresolvable",
  failure: "<one-line reason>"
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
