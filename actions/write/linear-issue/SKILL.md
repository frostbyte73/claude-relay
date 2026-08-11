---
name: write.linear-issue
description: File a new Linear issue against a named team. External-write — drafts the exact team/title/body via `mcp__outpost__submit_write_draft` and stops; files it only once the user approves the payload (see `SHARED-write-drafts.md`).
outpost:
  kind: action
  category: write
  side_effects: external-write
  runner: claude
  permissions: [push]
  timeout_sec: 120
  retries: 1
---

# write.linear-issue

Create a Linear issue. Returns the resulting issue identifier + URL.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `team` | yes | Linear team key (e.g. `CORE`, `CSCU`). Resolved to UUID internally. |
| `title` | yes | Short scannable title. |
| `body` | yes | Markdown body. |
| `labels` | no | Array of label names (resolved per-team). |
| `parent_ref` | no | Linear ID / URL of a parent issue to nest under. |

## The write-draft protocol

This action follows the shared draft/commit protocol — see
`~/.outpost/actions/SHARED-write-drafts.md` for the full mechanics (the tool shape, the
three outcomes, where `writeGate` lives, the rules that don't bend). This action has no
`Read`/`Grep` grant — `cat` the absolute path instead, reachable via `core`'s `^cat ` pattern
regardless of what else this action inherits. This is a standalone action step, so `writeGate`
is at `typePayload.writeGate` in `$OUTPOST_ENVELOPE`.

Load your tools first (deferred behind ToolSearch):

```
ToolSearch({ query: "select:mcp__outpost__submit_write_draft,mcp__outpost__submit_step_output", max_results: 2 })
```

If neither comes back, halt. The daemon marks the step failed when your turn ends.

### Draft phase (`typePayload.writeGate` absent, or `typePayload.writeGate.phase === "draft"`)

Compose the issue for review — do **not** file it.

1. Resolve `inputs.team` → `teamId` via `mcp__claude_ai_Linear__get_team`. If `inputs.labels`
   is set, resolve names → `labelIds` via `mcp__claude_ai_Linear__list_issue_labels`. If
   `inputs.parent_ref` is set, resolve it → `parentId` via `mcp__claude_ai_Linear__get_issue`.
   These are reads; they run before drafting so the pinned call carries real ids, not names the
   user would have to trust.
2. Build the exact `mcp__claude_ai_Linear__save_issue` arguments from the resolved `teamId` +
   `inputs.title` / `inputs.body` (+ resolved `labelIds`, `parentId` if present) — the
   **resolved ids**, not the raw `inputs.team` key or label/parent names. If
   `typePayload.writeGate.feedback` is non-empty (the user proposed changes — every round,
   oldest first), revise the arguments to address every point.
3. Call `mcp__outpost__submit_write_draft` with:
   - `summary`: `"File [<TEAM>] <title>"`.
   - `evidence`: the issue rendered as markdown — `**[TEAM] Title**\n\nbody\n\nLabels: …` —
     so the user reviews readable text, not raw JSON.
   - `calls`: `[{ label: "file issue", tool: { name: "mcp__claude_ai_Linear__save_issue", args: { …assembled args… } } }]`.
4. Stop. Do not call `save_issue` directly — the hook denies it with no pin.

### Commit phase (`typePayload.writeGate.phase === "commit"`)

Run `typePayload.writeGate.approvedCalls` verbatim — exactly the `save_issue` call the user
approved (they may have edited team/title/body/labels; use what's pinned, not what you
originally resolved).

1. Call `mcp__claude_ai_Linear__save_issue` with the pinned arguments, unchanged.
2. Call `mcp__outpost__submit_step_output` with `output` set to the JSON string
   `{"id": "CORE-1234", "url": "..."}` where `id` is the human identifier.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "write.linear-issue",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "filed" | "blocked",
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
