---
name: meta.build-action
description: Use when invoked as `/meta.build-action`, or when the user asks to create, edit, scaffold, or revise an Outpost action. Outpost activates this skill whenever the user clicks "+ NEW ACTION" or submits "Feedback" on an existing one. Reads `$OUTPOST_ENVELOPE` for the inputs, drafts a proposal (new/revised `SKILL.md` text + allowlist additions), delivers it via `mcp__outpost__submit_action_proposal`, and exits the turn. The daemon shows the proposal inline; the user either approves (daemon writes the files) or sends new feedback (this skill runs again with the updated envelope).
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

# Action builder

You're being run because the user wants to **create or revise an Outpost
action** — a Claude Code skill that the Outpost orchestrator can pick from
its catalog and run as one step of a job. Your job in a single turn:

1. Read `$OUTPOST_ENVELOPE` for the inputs.
2. Draft a proposal (new full `SKILL.md` text + recommended allowlist
   additions + one-paragraph summary).
3. Deliver the proposal via `mcp__outpost__submit_action_proposal`.
4. Print a one-line confirmation in chat and stop — **do not** write any files,
   do not call `/api/allowlist/rules`. The daemon applies the proposal once
   the user approves it in the PWA.

If the user rejects the proposal and sends new feedback, the daemon re-invokes
this skill with the feedback in `$OUTPOST_ENVELOPE.userFeedback`. Treat each
invocation as a fresh draft from current inputs.

## Step 1 — Read your envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

Envelope shape:

| Field | Meaning |
|---|---|
| `kind` | Always `"action-edit"`. |
| `mode` | `"new"` (scaffold a new action) or `"edit"` (revise an existing one). |
| `actionName` | The existing action's name (edit mode). `null` for new mode. |
| `proposedName` | New mode only — the user's chosen name (kebab-case). Honor it unless it's invalid (then pick a corrected name and explain why). |
| `proposedCategory` | New mode only — the user's chosen category (`read`/`write`/`code`/`meta`), if they picked one. Honor it; otherwise choose the closest fit yourself. |
| `actionDir` | Absolute path to the action's directory (edit mode). |
| `actionsDir` | Absolute path to the parent actions directory (new mode). |
| `skillMdBefore` | Current `SKILL.md` text (edit mode). Empty for new mode. |
| `currentAllowlist` | Current allowlist (edit mode): `{ alwaysAllow, alwaysAllowBashPatterns, alwaysAllowMcpPatterns, alwaysAllowPathPatterns }`. |
| `userFeedback` | The user's free-text feedback that triggered this invocation. Treat it as the spec. |

`$OUTPOST_ACTION_NAME` is also set as an env var in edit mode for convenience.

## Step 2 — Understand the Outpost action contract

Any action you author must follow this contract — it's what the orchestrator
expects when it picks the action as a step in a job:

1. On launch, read `$OUTPOST_ENVELOPE` (a JSON file) containing job context
   (goal, approach, prior step findings) and the task for this step.
2. Run unsupervised — no clarifying questions, no user prompts.
3. Produce a proposal (working-tree edits, a structured plan, a comment draft —
   whatever the step type calls for). Do NOT commit, push, or post anything yet.
4. Deliver the proposal via an `mcp__outpost__submit_*` tool (the daemon exposes
   one per output shape — `submit_plan`, `submit_step_output`, `submit_step_progress`,
   `submit_action_proposal`).
5. The orchestrator runs a feedback/approval loop. When approved, execute the
   final proposal (apply edits, post comments, etc.).
6. Signal completion via the same MCP surface (e.g. `submit_step_output` /
   `submit_step_progress`).

Actions are 1:1 with plan steps. The orchestrator picks from the catalog when it
builds a job plan, so the action's `description:` frontmatter is what the
orchestrator reads to decide when to use it — write it accordingly.

Reference implementations live under `~/.outpost/actions/<category>/<name>/`:
`code.implement`, `code.fix-pr-comment`, `code.triage-pr-comments`,
`meta.orchestrate`. **Read one before authoring a new action** — the
envelope-reading + hook-posting boilerplate is identical across all of them.
Copy it verbatim; don't reinvent it.

## Step 3 — Draft `SKILL.md`

Required frontmatter:

```yaml
---
name: <category>.<rest>      # must match the directory derivation actions/<category>/<rest>/
description: <one paragraph> # what the orchestrator reads — describe trigger conditions
outpost:
  kind: action
  category: <one of: read, write, code, meta>
  side_effects: <one of: none, gated-write, worktree-edit, external-write>
  runner: <claude or builtin>
---
```

`category` MUST be exactly one of `read | write | code | meta` — these are the
only categories the registry accepts, and they double as the on-disk directory
(`actions/<category>/<rest>/`). Never invent a new category (e.g. `script`,
`analyze`, `human`); the daemon rejects any action whose name isn't
`<read|write|code|meta>.<kebab-slug>`. Pick the closest fit: a script/tool
runner is `code`, an investigation is `read`, an external mutation is `write`.

The `description` is the orchestrator's only signal for picking this action. Lead
with the trigger ("Use when…"), then say what the action produces.

For **edit** mode, start from `skillMdBefore` (in the envelope) and apply the
feedback. Preserve everything the user didn't ask to change.

For **new** mode, scaffold a complete `SKILL.md` from scratch. If the envelope
includes `proposedName`, use it verbatim (it's what the user typed in the PWA's
new-action form). Otherwise pick a kebab-case name that matches the user's
intent. If the envelope includes `proposedCategory`, use it as the category;
otherwise choose the closest fit from `read | write | code | meta`. The final
`name:` is always `<category>.<rest>`. Mirror the structure of a reference action.

## Step 4 — Draft allowlist additions

Each action has an Outpost-managed allowlist of tool / bash / MCP / path
patterns that auto-approve so the action can run unsupervised. Without good
defaults, the action stalls on every `Read` or `curl` call.

For **edit** mode, look at `currentAllowlist` in the envelope — propose only
*additions* needed to address the user's feedback, not replacements.

For **new** mode, propose a starter set sized to the action's actual happy
path. Be conservative:

- `tool` — exact Claude Code tool name (`Read`, `Glob`, `Grep`). Most actions
  safely allow these unconditionally.
- `path` — path-scoped tool rule of shape `<ToolName>:<path-regex>` — applies
  to `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Glob`/`Grep`. Prefer
  path rules over blanket `tool: Write` / `tool: Edit` grants so writes are
  confined to the action's working area (e.g. `Edit:^/tmp/`,
  `Write:^/Users/[^/]+/repos/foo/`).
- `bash` — JavaScript regex matched against one clause of the bash command.
  Anchor with `^` and keep the pattern narrow. A rule that grants a **network
  or filesystem write** must be a positive whitelist pinned to its destination:
  name the exact host/path and enumerate the flags that may appear, anchored
  with `$`. A prefix rule grants everything after it — `^curl ` and even
  `^curl -fsS -X POST ` allow any method, any body, any URL, and `-o <path>`
  to overwrite any local file. Never write a rule that tries to *forbid* a
  flag: `-d`, `-d=x`, `"-d"`, `-d""`, `-d$X` and `-sd` all reach argv as the
  same flag, and a negative lookahead misses most of them.
- `mcp` — regex matched against the MCP tool id.

Prefer narrow path/bash rules over blanket tool grants.

## Step 5 — Submit the proposal

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_action_proposal", max_results: 1 })
```

If the tool doesn't come back, halt. The daemon will not scrape the transcript for a proposal.

Then call the `mcp__outpost__submit_action_proposal` tool:

```
mcp__outpost__submit_action_proposal({
  sessionId: "<$ACTION_EDIT_SESSION_ID>",
  actionName: "<chosen action name>",
  summary: "<one paragraph for the human reviewing the diff>",
  skillMdAfter: "<full new SKILL.md text — pass as a native JSON string, no shell escaping>",
  allowlistAdds: [
    { "kind": "tool", "value": "Read" },
    { "kind": "bash", "value": "^curl -fsS \"?https://api\\.example\\.com/v1/status\"?$" }
  ]
})
```

The tool returns `{ok: true}` on accept. A JSON-RPC error means the daemon refused the proposal — surface the message in chat and stop.

## Step 6 — Confirm + stop

Print one line: `Proposal posted; waiting for review.` Then stop. **Do not**
write `SKILL.md` to disk; **do not** add allowlist rules. The daemon does both
once the user approves the proposal in the PWA.

If the user sends new feedback later, this skill runs again with the updated
envelope — re-draft from scratch using `skillMdBefore` (or your previously
proposed text, which is now the canonical "before" view from the user's
perspective if they're refining it).

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "meta.build-action",
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
