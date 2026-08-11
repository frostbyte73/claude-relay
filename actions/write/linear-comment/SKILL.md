---
name: write.linear-comment
description: Post a comment to a Linear issue. External-write — drafts the exact comment body via `mcp__outpost__submit_write_draft` and stops; posts it only once the user approves the payload (see `SHARED-write-drafts.md`).
outpost:
  kind: action
  category: write
  side_effects: external-write
  runner: claude
  permissions: [push]
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

Compose the exact comment body — do **not** post it.

1. Resolve `issue_ref` to the Linear UUID via `mcp__claude_ai_Linear__get_issue` (handles ID
   and URL) — a read, so it's safe to do before drafting.
2. Start from `inputs.body`. If `inputs.links` is non-empty, append a
   `\n\n---\n**Related:**\n- [label](url)\n...` section. If `typePayload.writeGate.feedback`
   is non-empty (the user proposed changes — every round, oldest first), revise the body to
   address every point.
3. Call `mcp__outpost__submit_write_draft` with:
   - `summary`: `"Comment on <issue_ref>"`.
   - `evidence`: omit, or the issue's current title/state if it adds useful context.
   - `calls`: `[{ label: "post comment", tool: { name: "mcp__claude_ai_Linear__save_comment", args: { issueId: "<resolved UUID>", body: "<final markdown body>" } } }]`.
4. Stop. Do not call `save_comment` directly — the hook denies it with no pin.

### Commit phase (`typePayload.writeGate.phase === "commit"`)

Run `typePayload.writeGate.approvedCalls` verbatim — exactly the `save_comment` call the user
approved (they may have edited the body; use what's pinned).

1. Call `mcp__claude_ai_Linear__save_comment` with the pinned arguments, unchanged.
2. Call `mcp__outpost__submit_step_output` with `output` set to the JSON string
   `{"comment_id": "...", "url": "..."}`.

Never edit the issue itself, never resolve threads, never delete prior comments.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "write.linear-comment",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "posted" | "blocked",
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
