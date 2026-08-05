---
name: read.investigate
description: Investigate a bug, claim, alert, or customer incident using whatever read-shaped tools are relevant — Datadog logs/metrics, source-code grep + read, runbook lookup, Linear ticket history, GitHub issue/PR context. Decides which tools to reach for based on the subject. Returns a structured finding (markdown writeup + raw evidence + optional incident verdict). Read-only — runs no writes. Replaces the granular read.datadog-logs / read.repo-files / read.runbook / analyze.classify-incident actions; their separate composition was aspirational and the orchestrator doesn't actually chain them.
outpost:
  kind: action
  category: read
  side_effects: none
  runner: claude
  permissions: [read, pull]
  timeout_sec: 1800
  retries: 0
---

# read.investigate

A general-purpose investigation step. Given a subject (a Linear ticket, an alert URL, an error description, a service name, a code claim), reach for the read-shaped tools that fit and produce a structured finding. Read-only — never edits, never posts.

**When to use this as a step.** The orchestrator now investigates up front itself, so `read.investigate` is *not* the orchestrator's default first pass. Emit it as a plan step only when the investigation must run **during execution** — e.g. a health-verdict check between deploy rings feeding a downstream `meta.wait` — or when a tracked, re-runnable investigation is the deliverable itself.

## Step 1 — read inputs

```bash
cat "$OUTPOST_ENVELOPE"
```

The envelope's `inputs` field matches `input.schema.json`:

| Field | Required | Meaning |
|---|---|---|
| `subject` | yes | What to investigate. Free-form string — a ticket ID, an alert URL, a one-line bug description, a service name, a claim from a prior step. |
| `context` | no | Free-form prose context the orchestrator or user attached. Use as additional hints, not the primary spec. |
| `workspace` | no | Optional `{repoCwd}` — when set, grep/read the repo. Otherwise the action stays purely external. |
| `time_range` | no | Optional `{from, to}` (ISO-8601 or relative `now-2h`). When omitted, default to a sensible window based on the subject — last 2 hours for an active alert, last 30 days for a Linear ticket. |
| `expect` | no | One of `incident` / `bug` / `claim` / `general`. Hints the output shape — `incident` fills the `verdict` block; `claim` returns supporting/refuting evidence; `general` returns just findings + evidence. |

**If `inputs` is missing or empty** (older plans, or an orchestrator that omitted them), fall back to the envelope's top-level `goal` / `title` / `description` as the subject and use the step's `workspace.repoCwd` (if any) for code-reading. Don't bail *on unspecified inputs* — produce the best finding you can from what's there, and note in `caveats` that inputs were unspecified. (This is about a thin *spec*; it does not override the Step 4 deliverable gate — if you can then obtain the evidence the goal needs, deliver it; if you can't, fail there.)

## Step 2 — pick the right tools

Don't run every tool. Pick based on the subject.

- **Linear ticket reference** (`CSCU-432`, `linear.app/...`) → fetch via `mcp__claude_ai_Linear__get_issue` + `list_comments`. Follow any Slack thread link in the body.
- **Alert / incident** (incident.io URL, alert ID, "egress is paging") → search `incident-io` MCP, pull the runbook from Notion/repo via `WebFetch` if one is referenced.
- **Log-shaped evidence** (timestamps, request IDs, error messages from logs) → query Datadog. Use `mcp__claude_ai_DataDog_MCP__load_datadog_skill skill_name="datadog/logs"` first to get current syntax, then `search_datadog_logs` filtered on the most specific ID. Cluster with `use_log_patterns: true` when the query is broad.
- **Code claim** ("X function does Y", "we don't handle Z") + `workspace.repoCwd` set → grep + read the named files. Always read the repo's `CLAUDE.md` first. **Read the code at `origin/<base>`, not at whatever the checkout happens to be.** A user's repo can sit days behind on an unrelated feature branch, so `git fetch origin` first, then read through the fresh ref (`git show origin/main:path/to/file.go`, `git grep <pat> origin/main`) — or state in `caveats` which ref you read. A finding describing code that upstream already changed is worse than no finding: the step acting on it will branch from fresh main and not recognize the tree you described.
- **Customer incident (CSCU ticket)** → all of the above, plus pay attention to the customer name in `customerNeeds[].customer.name`, the Slack thread, and timestamps in the customer's timezone.

Stop at "enough to support a verdict." This is investigation, not deep root-causing — when more depth is needed, surface that gap in your finding so the user can spawn a follow-up.

## Step 3 — synthesize

Build a structured finding matching `output.schema.json`:

```jsonc
{
  "findings": "## What I found\n\n— markdown writeup. Be specific. Cite log lines / file:line / Linear comments.\n— Treat the filer's framing as a hypothesis, not a finding. State what you verified vs. inherited.\n— If `expect: incident`, include a timeline (one row per meaningful event, UTC).",
  "evidence": [
    { "kind": "datadog-logs",  "source": "https://app.datadoghq.com/logs?query=...", "summary": "47 connection-refused errors clustered 14:02–14:09" },
    { "kind": "repo-file",     "source": "cloud-egress/handler/session.go:142", "summary": "Default timeout is 600s — matches the customer's 10-minute cutoff" },
    { "kind": "linear-comment", "source": "CSCU-432#42", "summary": "Customer reports recordings consistently truncate at the 10-min mark" }
  ],
  "verdict": {
    "kind": "service-bug",
    "confidence": 0.85,
    "responsible_team": "CORE",
    "suggested_title": "egress: hardcoded 10-minute session timeout truncates long recordings",
    "writeup": "<markdown for the eventual bug body — repro, root cause, impact>",
    "customer_summary": "<short markdown for the eventual customer-facing comment>"
  },
  "caveats": [
    "Couldn't verify whether the customer's account has any custom timeout override — would need to check cloud-config."
  ]
}
```

`verdict` is optional. Include it when `expect: incident` or when the investigation reaches a clear classification. Omit for general fact-finding.

`caveats` lists what you couldn't verify or what's missing. Be explicit — better to say "no Datadog data for this time window" than to paper over the gap.

`caveats` is for **secondary** gaps, not for a missing deliverable. "Couldn't confirm the customer's account has a timeout override" is a caveat. "Couldn't obtain the measured p99 the goal was defined to produce" is not a caveat — it means the step **failed**. See Step 4.

## Step 4 — Deliver or fail — do NOT paper over a missing deliverable

Before you submit anything, check the step's `goal` / `title` / `description` against what you actually hold in hand. A step exists to produce a specific deliverable; the plan's downstream steps and human gates were laid down assuming that deliverable will exist.

- **You produced the deliverable the goal names** — the verdict, the requested data, an answer to the claim — *or* the goal was open-ended fact-finding and you gathered the relevant evidence → submit via `mcp__outpost__submit_step_output` (below).
- **The goal names a concrete, load-bearing deliverable and you could not obtain it** — the metric doesn't exist, every query path is blocked, the logs for the window are gone, the tool you need isn't in your allowlist, the ticket/source you had to read is unreachable → **the step failed.** Call `mcp__outpost__submit_step_failed`. Do **NOT** call `submit_step_output`.

**A step whose reason for existing was "get X" has not succeeded if you did not get X.** A resolved step *advances* the plan (and, if it's the last step, marks the job `done`); a failed step *halts* it so the user can unblock — fix the allowlist, run the query interactively, re-scope — and re-run. Submitting a plausible-looking writeup that substitutes engineering judgment for the missing X lets the job march to `done` on a hole. That is the exact failure this gate prevents.

| Thought | Reality |
|---|---|
| "I found a lot of other useful things, so I'll submit_step_output." | The step is judged by its goal's deliverable, not by incidental findings. Missing the deliverable = failed, however much else you turned up. |
| "I'll give provisional / judgment-based numbers and flag them in `caveats`." | Substituting judgment for the deliverable the plan depends on IS the hole. If the goal wanted measured data, judgment is not the data. Fail the step. |
| "Failing feels like giving up / wasting the work." | The work isn't wasted — it goes in the `reason`. A failed step with a precise, actionable reason is worth more than a `done` that hides the gap. |
| "The blocker is a tool/allowlist problem, not my fault." | True and irrelevant to the outcome. A blocked deliverable is still an unmet deliverable — fail with the reason so it gets fixed. |

When you fail, make `reason` actionable: what the goal needed, why it's unobtainable, the concrete unblock (e.g. "add `mcp__grafana__grafana_api_request` to the read.investigate allowlist and re-run" or "run these queries interactively on datasource `thanos`: …"), and the partial findings you *did* gather so the re-run starts ahead. Load the schema first, then call it:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_failed", max_results: 1 })

mcp__outpost__submit_step_failed({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  reason: "Goal was measured p50–p99.9 for StartEgress/StartRoutedEgress; not obtained — query_prometheus is broken and grafana_api_request/Bash aren't in this action's allowlist. Unblock: add mcp__grafana__grafana_api_request to read.investigate, or run <queries> interactively on `thanos`. Partial: metric is Prometheus-only, histogram le-buckets cap at 10s (can't measure the slow tail)."
})
```

### Submitting a finding (the success path)

The `output` field is a single string — the daemon stores it verbatim and forwards it as `previousSteps[].output` to the next orchestrator pass. Pass your full structured finding as that string (the orchestrator reads markdown well, but if you want it strictly typed, JSON-stringify the object instead). Most calls just send the markdown writeup as the output.

The outpost MCP tools are deferred behind ToolSearch — load the schema first, then invoke:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
```

If the tool doesn't come back, halt — the daemon will mark the step failed when your turn ends. Do NOT try to submit the finding as your final text message; the daemon does not scrape transcripts.

Then call the `mcp__outpost__submit_step_output` tool:

```
mcp__outpost__submit_step_output({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  output: "## What I found\n\n— markdown writeup here …\n\n## Evidence\n- …\n\n## Verdict (optional)\n…\n\n## Caveats\n- …"
})
```

The tool call accepts native JSON — no shell escaping, no jq, no heredocs. Pass the markdown writeup as a JSON string; embed newlines as `\n` (the LLM tool-input layer handles that for you).

If you're tempted to introspect (`echo $VAR`, `ls -la ~/...`), don't. Trust the envelope — `cat "$OUTPOST_ENVELOPE"` is the only introspection you need, and it's pre-allowed.

Stop. Don't make recommendations beyond the finding — downstream steps (or the next orchestrator pass) act on what you returned.

## Epistemic discipline

- **Treat the subject's framing as a hypothesis, not a finding.** Phrases like "X is broken," "Y must be the bug" — these are leads to verify. Find the specific log line / code path / measurement that supports or refutes each load-bearing claim before promoting it to a finding.
- **Convert customer-reported timestamps to UTC** when investigating customer incidents. Cross-check against the actual log timestamps.
- **Calibrate confidence honestly.** A `verdict.confidence` of 0.5 with a clear caveat is more useful than a confident wrong call. If the inputs don't support a classification, return `verdict.kind: "unknown"` with the missing-data caveats.
