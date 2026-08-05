---
name: write.run-github-workflow
description: Use when a job needs to trigger a specific GitHub Actions workflow (e.g. a deploy, release, e2e, or nightly pipeline) on a given branch/ref and then confirm it actually succeeded. Dispatches the named workflow with any required workflow_dispatch inputs, waits for the resulting run to reach a terminal state (may take seconds, minutes, or hours), and returns the conclusion plus failure logs. External-write — pair with an upstream human.gate confirming workflow/ref/inputs before invoking.
outpost:
  kind: action
  category: write
  side_effects: external-write
  runner: claude
  permissions: [pull]
  human_gate: true
  timeout_sec: 21600
  retries: 0
---

# write.run-github-workflow

Dispatch one GitHub Actions workflow and wait for it to finish. Returns whether
the run succeeded, its URL/id, timing, and — on failure — the failed-step logs.

This is an **external write**: `gh workflow run` triggers real CI, which may
deploy, publish, or mutate infrastructure. The orchestrator inserts a
`human.gate` before this step to confirm the workflow, ref, and inputs; do not
add your own confirmation prompt and do not re-dispatch on your own initiative.
`retries: 0` is set deliberately — a retry would fire the workflow a second
time.

## Step 1 — read inputs

```bash
cat "$OUTPOST_ENVELOPE"
```

The envelope's `inputs` field:

| Field | Required | Meaning |
|---|---|---|
| `workflow` | yes | The workflow to run — its file name (`deploy.yml`), its display name, or its numeric id. Passed straight to `gh workflow run`. |
| `ref` | yes | Branch or tag to run the workflow on (e.g. `main`, `release/1.4`). The workflow's `.yml` must exist on this ref, and `workflow_dispatch` must be enabled. |
| `repo` | no | `owner/name`. Omit to use the repo at `workspace.repoCwd` (or the current directory). |
| `inputs` | no | Object of `workflow_dispatch` input name → value. Each becomes a `-f name=value` flag. |
| `expect_conclusion` | no | Terminal conclusion that counts as success. Default `success`. |
| `workspace` | no | `{repoCwd}` — cd here so `gh` picks up the repo when `repo` is unset. |

**If `inputs` is missing** (older plans), fall back to the envelope's top-level
`goal`/`title`/`description` to identify the workflow and ref, and note the
assumption in your output. If you cannot determine a workflow name AND a ref,
do not guess — submit a failed step (see Step 5) explaining what was missing.

Build a `--repo <owner/name>` flag if `repo` is set; otherwise `cd` into
`workspace.repoCwd` when present so `gh` infers the repo from the checkout.

## Step 2 — dispatch the workflow

Record a UTC dispatch timestamp first (you'll use it to disambiguate the run):

```bash
gh run list --workflow "<workflow>" --branch "<ref>" --event workflow_dispatch \
  --limit 20 --json databaseId,createdAt,status [--repo <owner/name>]
```

Note the ids that already exist. Then dispatch:

```bash
gh workflow run "<workflow>" --ref "<ref>" \
  -f key1=value1 -f key2=value2 [--repo <owner/name>]
```

`gh workflow run` prints a confirmation but **does not** return the run id.

## Step 3 — find the run id

Poll `gh run list` (same filter as above) until a run appears that is NOT in the
pre-dispatch id set — that's your run. If several appear, pick the one whose
`createdAt` is newest and after your dispatch timestamp. Grab its `databaseId`.

If no new run shows up within ~60s of dispatching, the workflow likely rejected
the dispatch (wrong ref, `workflow_dispatch` not enabled, missing required
input). Capture the error and submit a failed step.

## Step 4 — wait for completion

The run can take seconds to hours. Prefer `gh run watch`, which polls
server-side and blocks until the run reaches a terminal state:

```bash
gh run watch <databaseId> --interval 60 --exit-status [--repo <owner/name>]
```

`--exit-status` makes `gh` exit non-zero when the run's conclusion is not
`success`. Because a single tool call is time-bounded, a very long run may
outlast one `gh run watch` invocation — that's fine: re-check with

```bash
gh run view <databaseId> --json status,conclusion,htmlUrl,startedAt,updatedAt [--repo <owner/name>]
```

and, while `status` is not `completed`, call `gh run watch` again (it resumes
from the current state). Do not busy-wait with `sleep`; let `gh run watch` do
the blocking, or the Monitor tool if available.

## Step 5 — report the result

Once `status == completed`, read `conclusion`. Success = `conclusion` equals
`expect_conclusion` (default `success`). On any other conclusion
(`failure`, `cancelled`, `timed_out`, …), pull the failed-step logs:

```bash
gh run view <databaseId> --log-failed [--repo <owner/name>]
```

Load the outpost MCP tool — it's deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
```

If it doesn't come back, halt — the daemon marks the step failed when your turn
ends. Do NOT try to return the result as your final chat message; the daemon
does not scrape transcripts.

Then submit a structured result:

```
mcp__outpost__submit_step_output({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  output: "{\"ok\": true, \"conclusion\": \"success\", \"runId\": 1234567890, \"url\": \"https://github.com/owner/name/actions/runs/1234567890\", \"workflow\": \"deploy.yml\", \"ref\": \"main\", \"durationSec\": 842, \"summary\": \"deploy.yml on main succeeded in 14m\"}"
})
```

On failure, set `ok: false`, include the `conclusion`, and put the trimmed
failed-step logs in a `failureLog` field with a one-line `summary`. Keep the log
excerpt focused on the erroring step — the next planner pass reads it to decide
whether to retry, fix, or abandon.

If dispatch itself failed (Step 2/3) so no run exists, prefer
`mcp__outpost__submit_step_failed` (load it the same way) with a message naming
the missing/invalid input; fall back to `submit_step_output` with
`{"ok": false, ...}` if that tool isn't available.

Stop after submitting. Do not commit, push, comment, or trigger anything else —
this action's only side effect is the one workflow dispatch.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "write.run-github-workflow",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "succeeded" | "failed" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, a documented command that didn't exist, anything you had to
guess at or work around. Journal it even when you recovered and the step succeeded. These
recur identically on every future run of this action until a human sees them, and this
journal is the only place `meta.improve-actions` looks.

Name the exact command or field. "`git clone` denied — this action's `allowlist.json` has
no clone rule" is actionable; "permissions were too tight" is not. Skip the journal only
when the run was genuinely unremarkable; don't pad.
