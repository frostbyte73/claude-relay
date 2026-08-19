---
name: meta.build-schedule
description: Use when invoked as `/meta.build-schedule`, or when the user asks to create a scheduled task. Outpost activates this skill when the user submits a prompt from "New schedule". Reads `$OUTPOST_ENVELOPE`, drafts a schedule (trigger + a directly-executed `script`, an LLM `prompt`, or a catalog `skill`), delivers it via `mcp__outpost__submit_schedule_proposal`, and exits. The user tests the script and either saves it or sends the failure back for a redraft.
outpost:
  kind: action
  category: meta
  side_effects: gated-write
  runner: claude
  plannable: false
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# Schedule builder

You're being run because the user wants to **create a scheduled task** — a
cron- or one-off-triggered routine the daemon runs unattended. Your job in a
single turn:

1. Read `$OUTPOST_ENVELOPE` for the prompt (and, on redraft, the prior draft +
   the test failure).
2. Draft a proposal: `{ name, trigger, what }` plus a one-paragraph summary.
3. Deliver the proposal via `mcp__outpost__submit_schedule_proposal`.
4. Print a one-line confirmation in chat and stop — **do not** write any
   files, do not persist the schedule. The daemon shows the draft in the
   schedule editor; the user tests it and either saves it (daemon persists)
   or sends the failed test output back (daemon re-invokes this skill with
   `mode: "redraft"`).

## Step 1 — Read your envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

Envelope shape:

| Field | Meaning |
|---|---|
| `kind` | Always `"schedule-edit"`. |
| `mode` | `"new"` (draft from scratch) or `"redraft"` (fix a failed test). |
| `prompt` | The user's free-text description of what they want scheduled and how often. Treat it as the spec. |
| `actionCatalog` | Every action in the registry (`name`, `description`, `category`, `runner`, `side_effects`, `input_schema`, `output_schema` per entry) — unfiltered, so it includes ones no job plan may use but a schedule legitimately can, like `meta.improve-actions`. Use it to check whether an existing action already does what the user wants. |
| `currentDraft` | Redraft mode only — the previous `{ name, trigger, what }` you (or a prior turn) proposed. |
| `testError` | Redraft mode only — the real stdout/stderr from the user's Test click on `currentDraft`. |
| `scheduleEditSessionId` | Pass this straight through to the submit call — it's how the daemon matches your proposal back to the editor that's waiting on it. |
| `proposalRoute` | Informational — confirms `/work/schedule-proposal` is where the daemon expects the proposal; you don't call this yourself, the submit tool does. |

## Step 2 — Understand the schedule contract

A schedule proposal is a draft `ScheduleRecord`, reduced to the three fields
the user is editing: `{ name, trigger, what }`.

### `trigger`

- `{ kind: 'cron', expr }` — the default. Pick a standard 5-field cron
  expression matching the cadence in the prompt (e.g. "every morning at 9" →
  `0 9 * * *`; "every 15 minutes" → `*/15 * * * *`; "every Monday at 8am" →
  `0 8 * * 1`). Use UTC unless the prompt implies a specific timezone — add
  `tz` (IANA name) only if the user names one.
- `{ kind: 'once', at }` — for a one-off ("remind me tomorrow at 3pm", "run
  this once"). `at` is an epoch-millisecond timestamp; compute it from the
  current time plus the offset the user described.

Do not author `{ kind: 'event' }` or `{ kind: 'token-opportunistic' }`
triggers — those are wired by the daemon itself (external triggers, token
headroom), not something a user drafts through this flow.

### `what`

Prefer, in this order:

1. **`{ kind: 'script', script, cwd }`** — for shell tasks (polling an API,
   running a CLI, curling a webhook). This is almost always the right choice
   for anything the user describes as "check X and do Y" or "run this
   command periodically". The script runs **directly on the cron tick — no
   Claude session, no LLM cost**. It gets `OUTPOST_HOOK_PORT` and
   `DAEMON_AUTH` in its environment. To have the script enqueue an Outpost
   job (e.g. one job per item found by a poll), have it call the daemon's own
   create-job hook:

   ```bash
   curl -fsS -X POST "http://127.0.0.1:$OUTPOST_HOOK_PORT/work/create-job" \
     -H "x-daemon-auth: $DAEMON_AUTH" -H 'content-type: application/json' \
     -d '{"source":"my-schedule","title":"...","dedupeKey":"..."}'
   ```

   Write the `-d` body as a literal (or a `$VAR` you built) — a `$(…)` or
   backtick substitution there is denied, because a command substitution in
   a request body is a local file read pointed at the network. Same for
   `-H` values.

   `dedupeKey` is the idempotency key: a create-job call whose `dedupeKey`
   already maps to an existing job no-ops instead of duplicating it. Reuse a
   **stable, path-safe token** per external item (alphanumeric, dot, dash,
   underscore — no `..`) — e.g. a ticket id or issue identifier — so re-runs
   of the same tick don't spawn duplicate jobs for items already seen.

2. **`{ kind: 'skill', skill }`** — when the prompt names (or clearly maps
   to) an existing action from `actionCatalog`, e.g. "run my PR review action
   every hour". `skill` is that action's `name` verbatim.

3. **`{ kind: 'prompt', prompt, cwd }`** — for an LLM-driven scheduled task
   (the prompt runs as a job in `cwd`) when the work needs reasoning rather
   than a shell script — e.g. "summarize my inbox every morning" or "check if
   anything looks off in the logs and tell me". `prompt` is the free-text
   instructions dispatched as a job; pick `cwd` by the same rule as `script`.

Do **not** author `{ kind: 'native', handler }` — native handlers are
builtin-only (`pr-watcher`, `user-prs-watcher`, the Claude-updater), wired by
the daemon itself, not something this skill scaffolds.

### `cwd` rule

A script's or prompt's `cwd` must be a path the user actually works in — a
registered project directory, or their home directory (`~`) for tasks that
don't touch a repo. **Never** point `cwd` at the Outpost daemon's own
checkout — a misbehaving script or job there could corrupt the thing running
it. If the prompt doesn't name a project, default `cwd` to the user's home
directory.

## Step 3 — Redraft mode

When `mode: 'redraft'`:

1. Start from `currentDraft` verbatim — same `name`, same `trigger`, same
   `what` — and change only what `testError` demands. Don't rewrite parts of
   the script that already worked.
2. Read `testError` as the script's actual failure: a missing binary, a bad
   flag, an auth header the target API rejected, a `cwd` that doesn't exist,
   JSON the script emitted that the receiving endpoint rejected, etc. Fix the
   root cause, not just the symptom.
3. If the error suggests the whole approach was wrong (e.g. the target
   command doesn't exist at all), it's fine to change `what.kind` — but
   explain the pivot in `summary`.

## Step 4 — Submit the proposal

The outpost MCP tool is deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_schedule_proposal", max_results: 1 })
```

If the tool doesn't come back, halt. The daemon will not scrape the
transcript for a proposal.

Then call it:

```
mcp__outpost__submit_schedule_proposal({
  scheduleEditSessionId: "<scheduleEditSessionId from the envelope>",
  name: "<short human-readable schedule name>",
  summary: "<one paragraph for the human reviewing the draft>",
  trigger: { kind: "cron", expr: "0 9 * * *" },
  what: { kind: "script", script: "...", cwd: "/Users/testuser/some-project" }
})
```

The tool returns `{ok: true}` on accept. A JSON-RPC error means the daemon
refused the proposal — surface the message in chat and stop.

## Step 5 — Confirm + stop

Print one line: `Draft posted; test it in the editor.` Then stop. **Do not**
write any files, do not persist the schedule — the daemon only writes the
schedule record once the user clicks Save in the editor. If the user's test
fails, the daemon re-invokes this skill with `mode: "redraft"` and the
failure in `testError`; treat that as a fresh turn starting from Step 1.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "meta.build-schedule",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "proposed" | "blocked",
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
