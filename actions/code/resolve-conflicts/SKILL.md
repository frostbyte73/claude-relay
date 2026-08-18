---
name: code.resolve-conflicts
description: Use when invoked as `/code.resolve-conflicts` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.resolve-conflicts"`. Merge the base branch (default `origin/main`) into the branch, resolve conflicts using knowledge of why the code exists, stage the result, then draft the commit + push via `mcp__outpost__submit_write_draft` and run it once approved (see `SHARED-write-drafts.md`) — or `git merge --abort` and report unresolvable. Finish with `mcp__outpost__submit_step_progress`.
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
about why this code exists, stage the result, then draft the commit + push for the user's
approval — unless the round asks you not to push. If you cannot resolve confidently, abort
cleanly and hand it back — never draft a guessed resolution.

This is a bound-action round on the controller's own session (`type: "orchestrated"`), so
`writeGate` (see `~/.outpost/actions/SHARED-write-drafts.md`) sits at the **top level** of `$OUTPOST_ENVELOPE`,
not under a `typePayload`.

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
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

The base is `origin/main` unless `boundNote` names a different one — write whichever ref
applies **literally** into the `git merge` command below, in place of `origin/main`. Never
store it in a shell variable and pass that to `git merge` (e.g. `BASE=...; git merge "$BASE"`):
the allowlist only recognizes a literal ref in the command text, a shell variable's value is
opaque to it, and `boundNote` is not a trusted constant — a flag-shaped override (`-s ours`,
`--no-verify`, `-Xtheirs`) is parsed by git as a merge option rather than a ref, and quoting
the variable does not stop that.

```bash
git fetch origin        # skip this line if the base is a LOCAL branch — nothing to fetch
git merge origin/main   # replace `origin/main` here with the literal ref, if boundNote names one
```

- **Merge succeeds cleanly:** go to Step 3.
- **Merge reports conflicts:** resolve each conflicted file. You know why the PR's side
  looks the way it does — reconcile it with main's changes rather than blindly taking one
  side. After editing, `git add` the resolved files. If the resolution is non-trivial, run
  the project's tests before continuing.
- **Not confident** (semantics you can't reconcile, or the conflict is outside what this PR
  touched): abort and report unresolvable (Step 5b).

## Step 3 — Draft the commit + push (`writeGate` absent, or `writeGate.phase === "draft"`)

Unless `boundNote` explicitly says not to push:

```
mcp__outpost__submit_write_draft({
  jobId: "<$JOB_ID>", stepId: "<$STEP_ID>",
  summary: "Merge <BASE> into <branch>, resolving conflicts in <files>",
  evidence: "<which files conflicted and how you reconciled each — plus `git diff --staged` if it's not too large>",
  calls: [
    { label: "commit", bash: "git commit --no-edit" },
    { label: "push", bash: "git push" }
  ]
})
```

Git's default merge message (no `-m`) is what gets committed — don't compose your own. If
`boundNote` says not to push, draft only the `commit` call. Then stop. If
`writeGate.feedback` is non-empty (the user wants a different resolution — every round,
oldest first), redo the reconciliation as it asks, re-stage, and draft again.

If you were not confident enough to resolve at all, skip the draft — go to Step 5b.

## Step 4 — Commit: run the approved calls

`writeGate.phase === "commit"`. Run `writeGate.approvedCalls` **verbatim**, in order.

If the push is rejected (the branch moved again under you), you may re-run the same
approved `git push` call once — a rejected `git push` releases its own pin (see
`~/.outpost/actions/SHARED-write-drafts.md`'s note on a call that fails releasing its own
pin), so retrying it is running the same approved call again, not a new write. If it still
fails, do not re-merge and try to force a new commit through on the same approval — that would
be committing content the user never saw. Abort and report unresolvable (Step 5b) instead.

## Step 5a — Report resolved

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

## Step 5b — Report unresolvable

Leave the tree clean first, then report:

```bash
git merge --abort
```

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "conflict",
  memo: "conflicts UNRESOLVABLE: <files>, <one-line reason — or 'user declined the draft: <reason>' if that's why>; merge aborted, tree clean",
  next: { kind: "self-round" }
})
```

Then say in chat which files conflicted and why you couldn't reconcile them, so the user
can finish by hand.

## Step 6 — Journal one lesson

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
- **The draft is declined:** `git merge --abort` and report unresolvable (Step 5b) with the
  user's reason, rather than committing anyway.
- **Hook server returns 401:** daemon restarted mid-session; print the situation and exit.
  The orchestrator resets `conflictResolving` at boot and re-surfaces the conflict.
