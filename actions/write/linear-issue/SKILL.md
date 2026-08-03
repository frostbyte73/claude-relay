---
name: write.linear-issue
description: File a new Linear issue against a named team. External-write — playbooks must pair with an upstream meta.wait confirming team/title/body before invoking.
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

## Behavior

1. Load the outpost MCP tool schema — it's deferred behind ToolSearch:

   ```
   ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
   ```

   If the tool doesn't come back, halt. The daemon will mark the step failed when your turn ends.

2. Resolve `team` → UUID via `mcp__claude_ai_Linear__get_team`.
3. If `labels` is set, resolve label names → IDs via `mcp__claude_ai_Linear__list_issue_labels`.
4. If `parent_ref` is set, resolve → UUID via `mcp__claude_ai_Linear__get_issue`.
5. Call `mcp__claude_ai_Linear__save_issue` with the assembled payload.
6. Call `mcp__outpost__submit_step_output` with `output` set to the JSON string `{"id": "CORE-1234", "url": "..."}` where `id` is the human identifier.
