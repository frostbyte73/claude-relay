---
name: write.linear-issue
description: File a new Linear issue against a named team. External-write — the daemon hard-gates this step (human_gate), parking it for the user's approval of team/title/body before the session ever runs; no upstream meta.wait is required for that.
outpost:
  kind: action
  category: write
  side_effects: external-write
  runner: claude
  permissions: []
  human_gate: true
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

## Two-phase gate

This is a hard-gated external write. You run in **two phases**, driven by `typePayload.phase` in `$OUTPOST_ENVELOPE`. You never file the issue without the user's approval — and the daemon enforces it: in the draft phase the `save_issue` tool is **blocked** until approval, so calling it early just fails.

Load your tools first (deferred behind ToolSearch):

```
ToolSearch({ query: "select:mcp__outpost__submit_write_draft,mcp__outpost__submit_step_output", max_results: 2 })
```

If neither comes back, halt. The daemon marks the step failed when your turn ends.

### Draft phase (`typePayload.phase === "draft"`)

Compose the issue for review — do **not** file it. The `draft` you submit is the full issue as markdown so the user sees exactly what will be filed.

1. Build the draft from `inputs.team` / `inputs.title` / `inputs.body` (+ `inputs.labels`, `inputs.parent_ref` if present). Render it as markdown headed with the team + title, e.g. `**[TEAM] Title**\n\nbody\n\nLabels: …`. If `typePayload.feedback` is non-empty (the user proposed changes — most recent last), revise to address every point.
2. Call `mcp__outpost__submit_write_draft` with `draft` set to that markdown, then stop — the step parks for approval. Do NOT call `save_issue`; you may resolve `get_team`/`list_issue_labels` to validate, but the write is blocked here.

### Commit phase (`typePayload.phase === "commit"`)

The user approved. File the issue using the approved content (`typePayload.draft` is the reviewed rendering; the structured fields are still in `inputs`).

1. Resolve `team` → UUID via `mcp__claude_ai_Linear__get_team`.
2. If `inputs.labels` is set, resolve names → IDs via `mcp__claude_ai_Linear__list_issue_labels`.
3. If `inputs.parent_ref` is set, resolve → UUID via `mcp__claude_ai_Linear__get_issue`.
4. Call `mcp__claude_ai_Linear__save_issue` with the assembled payload (title/body from the approved draft).
5. Call `mcp__outpost__submit_step_output` with `output` set to the JSON string `{"id": "CORE-1234", "url": "..."}` where `id` is the human identifier.
