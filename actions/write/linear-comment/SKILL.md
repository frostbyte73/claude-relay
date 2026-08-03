---
name: write.linear-comment
description: Post a comment to a Linear issue. External-write — playbooks should insert a meta.wait before this step unless an upstream hold has already confirmed the body.
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

# write.linear-comment

Post a single comment back to a Linear issue. Returns the comment id + URL.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `issue_ref` | yes | Linear ID (`CSCU-432`) or URL. |
| `body` | yes | Markdown body. |
| `links` | no | Array of `{label, url}` rendered as a "Related" block at the bottom. |

## Behavior

1. Load the outpost MCP tool schema — it's deferred behind ToolSearch:

   ```
   ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
   ```

   If the tool doesn't come back, halt. The daemon will mark the step failed when your turn ends.

2. Resolve `issue_ref` to the Linear UUID via `mcp__claude_ai_Linear__get_issue` (handles both ID and URL).
3. If `links` is non-empty, append a `\n\n---\n**Related:**\n- [label](url)\n...` section to the body.
4. Call `mcp__claude_ai_Linear__save_comment` with the resolved UUID + body.
5. Call `mcp__outpost__submit_step_output` with `output` set to the JSON string `{"comment_id": "...", "url": "..."}`.

Never edit the issue itself, never resolve threads, never delete prior comments.
