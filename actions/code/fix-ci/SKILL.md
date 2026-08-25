---
name: code.fix-ci
description: Use when invoked as `/code.fix-ci` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.fix-ci"`. Read the failing checks from the envelope's `pr.ciChecks`, pull their logs, fix the code, run the relevant tests locally, stage the fix, then draft the commit + push via `mcp__outpost__submit_write_draft` and stop — it pushes only once the user approves (see `SHARED-write-drafts.md`). Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  plannable: false
  permissions: [read, pull, edit, push]
  timeout_sec: 1800
  retries: 0
---

# Fix failing CI on an open PR

This is the same session that implemented the PR (and possibly triaged its comments
or resolved conflicts). CI on the branch is red and has settled — every check has
reported and at least one failed. Your job: diagnose the failing checks from their
logs, fix the code *correctly* using what you already know about why it exists, run
the relevant tests locally, stage the fix, then draft the commit + push for the user's
approval. If you cannot confidently fix it (infra flake, unclear cause, or a failure that
isn't a code problem), do NOT guess — report it unfixable and hand it back.

This is a bound-action round on the controller's own session (`type: "orchestrated"`), so
`writeGate` (see `~/.outpost/actions/SHARED-write-drafts.md`) sits at the **top level** of `$OUTPOST_ENVELOPE`,
not under a `typePayload`.

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
jq -r '.pr.ciChecks[]? | select(.state == "failure") | "\(.name)\t\(.url // "")"' "$OUTPOST_ENVELOPE"
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`goal` and `inputs.approach` restate the PR's intent — useful when a failure is ambiguous.
`boundNote` is what the controller asked for this round.
`DAEMON_AUTH` and `OUTPOST_HOOK_PORT` are inherited. Your cwd is the worktree.

## Step 2 — Pull the failing logs

For each failing check, fetch its log to see the actual error. Prefer the run tied to
the PR head:

```bash
gh pr checks --watch=false            # names + conclusions + detail URLs
gh run view --log-failed              # failed-step logs for the latest run on this branch
# or, from a check's detailsUrl run id:
gh run view <run-id> --log-failed
```

## Step 3 — Diagnose, fix, and stage

Fix the root cause in the code — not the CI config, unless the config is clearly the
bug. Use your knowledge of why this code exists. Run the relevant tests/build locally
to confirm the fix (the same command the failing check runs, e.g. `npm run test:unit`,
`npx tsc --noEmit`, `mage`, `go test ./...`). Once it's confirmed, stage it:

```bash
git add -A
```

Do not commit yet — that's the draft below.

**If the fix is a git submodule pin.** A red check whose cause is a stale vendored schema is
fixed by moving a gitlink, which has its own sanctioned sequence — `git update-index
--cacheinfo`, and specifically NOT `git -C <path> checkout` / `reset` / `switch` / `cd <path> &&
…`, all of which are denied and have no working spelling. Read it before your first attempt:

```bash
cat ~/.outpost/actions/SHARED-submodules.md
```

## Step 4 — Draft the commit + push (`writeGate` absent, or `writeGate.phase === "draft"`)

```
mcp__outpost__submit_write_draft({
  jobId: "<$JOB_ID>", stepId: "<$STEP_ID>",
  summary: "Fix <the failing check(s) you fixed>",
  evidence: "<output of `git diff --staged`>",
  calls: [
    { label: "commit", bash: "git commit -m \"fix: <what you fixed> to make CI pass\"" },
    { label: "push", bash: "git push origin <branch>" }
  ]
})
```

Then stop. `<branch>` is `workspace.branch` from the envelope, written in literally. If
`writeGate.feedback` is non-empty (the user asked for a different fix or message — every
round, oldest first), address it — re-diagnose/re-fix if the feedback is about the change
itself, re-stage, and draft again.

If you could not confidently fix it, skip the draft entirely and go to Step 6 (unfixable) —
there is nothing to commit.

## Step 5 — Commit: run the approved calls (`writeGate.phase === "commit"`)

Run `writeGate.approvedCalls` **verbatim**, in order — the exact commit message and push the
user approved. Never force-push (no `--force`, no `--force-with-lease`) — follow-up rounds
append and fast-forward, and neither pinned call spells one.

## Step 6 — Report

```
# fixed: committed + pushed a fix
# unfixable: could not confidently fix (flake / infra / unclear); include a reason
```

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`memo` carries the outcome — there is no status field. Say plainly whether you pushed a
fix or gave up, and why; the decision turn reads only this.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "pr_open",
  memo: "ci-fix: pushed <commit> fixing <checks> — OR — ci-fix: unfixable, <one-line reason>",
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to `code.orchestrate-pr` for a decision turn. It owns the ladder — which round runs next, and whether the user is asked to approve anything — so do not pick that yourself.

Report unfixable (with the reason in `memo`) rather than pushing a guessed fix.

## Step 7 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.fix-ci",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "fixed" | "unfixable",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the step succeeded: it recurs identically on every future run of
this action until a human sees it, and this journal is the only place
`meta.improve-actions` looks. Name the exact command or field, not the category.

## Failure modes

- **Envelope missing/unreadable:** exit with a brief error; the orchestrator marks the
  step on the next tick.
- **Fix doesn't stick (CI still red after push):** the daemon re-detects the settled
  failure and resumes this same round again — no separate retry logic needed here.
- **The draft is declined:** report unfixable-by-decline in `memo` (Step 6) and hand back —
  do not silently drop the fix or re-draft the same payload.
- **Hook server returns 401:** daemon restarted mid-session; print the situation and
  exit. The orchestrator resets the round state at boot and re-surfaces the failure.
