---
name: write.linear-comment
description: Post a comment to a Linear issue. External-write — the daemon hard-gates this step (human_gate), parking it for the user's approval of the body before the session ever runs; no upstream meta.wait is required for that.
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

## Two-phase gate

This is a hard-gated external write. You run in **two phases**, driven by `typePayload.phase` in `$OUTPOST_ENVELOPE`. You never post without the user's approval — and the daemon enforces it: in the draft phase the `save_comment` tool is **blocked** until approval, so calling it early just fails.

Load your tools first (deferred behind ToolSearch):

```
ToolSearch({ query: "select:mcp__outpost__submit_write_draft,mcp__outpost__submit_step_output", max_results: 2 })
```

If neither comes back, halt. The daemon marks the step failed when your turn ends.

### Draft phase (`typePayload.phase === "draft"`)

Compose the exact comment body — do **not** post it.

1. Start from `inputs.body`. If `typePayload.feedback` is non-empty (the user proposed changes on a previous draft — most recent last), revise the body to address every point.
2. If `inputs.links` is non-empty, append a `\n\n---\n**Related:**\n- [label](url)\n...` section.
3. Call `mcp__outpost__submit_write_draft` with `draft` set to the final markdown body. Then stop — the step parks for the user's approval. Do NOT call `save_comment`; you may `get_issue` to sanity-check the target, but the write is blocked here.

### Commit phase (`typePayload.phase === "commit"`)

The user approved. `typePayload.draft` is the approved body — post it verbatim.

1. Resolve `issue_ref` to the Linear UUID via `mcp__claude_ai_Linear__get_issue` (handles ID and URL).
2. Call `mcp__claude_ai_Linear__save_comment` with the resolved UUID + `typePayload.draft`.
3. Call `mcp__outpost__submit_step_output` with `output` set to the JSON string `{"comment_id": "...", "url": "..."}`.

Never edit the issue itself, never resolve threads, never delete prior comments.
