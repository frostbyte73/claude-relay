---
name: code.review-diff
description: Read the uncommitted diff in a worktree and return a structured list of issues (severity, file, line, comment) plus a one-paragraph summary. Read-only — recommends only, does not edit. Extracted from code.implement's self-review step so any code-writing playbook can reuse it.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# code.review-diff

Self-review of an uncommitted working-tree diff. Does not modify files.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `workspace.repoCwd` | yes | Parent repo path. |
| `workspace.branch` | yes | Branch under review. |
| `context` | no | Optional `{goal, approach, risks}` from the step that produced the diff. |
| `diffRange` | no | Git diff range to review instead of the uncommitted diff — see below. |

## What to look for

If `diffRange` is absent, run `git status` + `git diff` to see the changes — this is the default, unchanged behavior: an uncommitted working-tree diff. If `diffRange` is set, run `git diff <diffRange>` instead (e.g. `git diff abc123...def456`) and skip `git status` — there's nothing uncommitted to report, the range itself is the diff under review.

`diffRange` exists for reviewing a PR's worktree, which is a clean detached checkout with no uncommitted changes — reviewing `git diff` there finds nothing and this action would report "no issues" on a diff it never looked at. The caller is expected to pass the three-dot form, `<merge-base>...<head>`, not `<base>..<head>` (two dots). Three dots is "what this branch actually changed since it forked" — `git diff A...B` *means* `git diff $(git merge-base A B) B`. That expansion is the semantics, not a recipe: `git merge-base` is not in this action's grant and running it is denied, so write the three dots and let git find the base itself. Two dots would also pull in every commit that landed on the base branch after the fork, and you'd flag someone else's code as if the PR author wrote it.

Read CLAUDE.md (and any `AGENTS.md`) to ground the review in conventions before you flag style issues. Then scan for:

- Stray debug prints / commented-out code / "// removed: previously did X" epitaphs.
- Comments that restate code, name-restate functions, or narrate task history (`// fix for ENG-123`).
- Half-finished slices, dead branches added "just in case", backwards-compat wrappers inside a repo the owner controls.
- Files touched off-target (auto-format sweeps, accidental dependency bumps).
- Bugs (off-by-one, missed null cases, race conditions, resource leaks) — these get `severity: "error"`.

Be sparing with `severity: "error"` — reserve it for things that would actively break. Most lint-style findings are `info` or `warn`.

## Output

```jsonc
{
  "summary": "Five files changed; one off-by-one in pagination, two stale comments to delete.",
  "issues": [
    { "severity": "error", "file": "src/page.ts", "line": 47, "comment": "loop ends at length-1, drops the last row." },
    { "severity": "info",  "file": "src/page.ts", "line": 12, "comment": "Comment restates the function name." }
  ]
}
```

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
```

If the tool doesn't come back, halt. The daemon will mark the step failed when your turn ends. Do NOT try to submit the review as your final text message.

Then call `mcp__outpost__submit_step_output` with `output` set to the JSON-stringified review object. Stop.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "code.review-diff",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "reviewed" | "blocked",
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
