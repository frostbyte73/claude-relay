---
name: code.fix-ci
description: Use when invoked as `/code.fix-ci` in a session spawned by the Outpost work orchestrator inside an open-pr step's worktree, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=open-pr`, and `typePayload.round.kind == "ci-fix"`. Read the failing checks from the envelope, pull their logs, fix the code, run the relevant tests locally, then commit and push (append — never force-push). Finish with `mcp__outpost__submit_ci_fixed`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  permissions: [read, pull, edit, push]
  timeout_sec: 1800
  retries: 0
---

# Fix failing CI on an open PR

This is the same session that implemented the PR (and possibly triaged its comments
or resolved conflicts). CI on the branch is red and has settled — every check has
reported and at least one failed. Your job: diagnose the failing checks from their
logs, fix the code *correctly* using what you already know about why it exists, run
the relevant tests locally, then commit and push so CI re-runs. If you cannot
confidently fix it (infra flake, unclear cause, or a failure that isn't a code
problem), do NOT guess — report it unfixable and hand it back.

## Step 1 — Read the envelope

```bash
test -r "$OUTPOST_ENVELOPE" || { echo "missing envelope: $OUTPOST_ENVELOPE"; exit 1; }
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
jq -r '.typePayload.round.checks[] | "\(.name)\t\(.url // "")"' "$OUTPOST_ENVELOPE"
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`goal`/`approach` restate the PR's intent — useful when a failure is ambiguous.
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

## Step 3 — Diagnose and fix

Fix the root cause in the code — not the CI config, unless the config is clearly the
bug. Use your knowledge of why this code exists. Run the relevant tests/build locally
to confirm the fix (the same command the failing check runs, e.g. `npm run test:unit`,
`npx tsc --noEmit`, `mage`, `go test ./...`).

## Step 4 — Commit and push

Append a commit and push. NEVER force-push (no `--force`, no `--force-with-lease`) —
follow-up rounds append and fast-forward.

```bash
git add -A
git commit -m "fix: <what you fixed> to make CI pass"
git push
```

## Step 5 — Report

```
# fixed: committed + pushed a fix
# unfixable: could not confidently fix (flake / infra / unclear); include a reason
```

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_ci_fixed,mcp__outpost__submit_journal", max_results: 2 })
```

```
mcp__outpost__submit_ci_fixed({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  status: "fixed" | "unfixable",
  failure: "<one-line reason, only when unfixable>"
})
```

Use `unfixable` (with a short `failure`) rather than pushing a guessed fix.

## Step 6 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.fix-ci",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "fixed" | "unfixable",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

## Failure modes

- **Envelope missing/unreadable:** exit with a brief error; the orchestrator marks the
  step on the next tick.
- **Fix doesn't stick (CI still red after push):** the daemon re-detects the settled
  failure and resumes this same round again — no separate retry logic needed here.
- **Hook server returns 401:** daemon restarted mid-session; print the situation and
  exit. The orchestrator resets the round state at boot and re-surfaces the failure.
