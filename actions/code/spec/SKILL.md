---
name: code.spec
description: Use when invoked as `/code.spec` in a session spawned by the Outpost work orchestrator inside an open-pr step's worktree, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=open-pr`, and `typePayload.round.kind == "spec"`. Reads the envelope (goal/approach/risks + any previous-step findings), drafts a headless design spec borrowing the brainstorming methodology, self-reviews it, and submits it via `mcp__outpost__submit_spec` for the user's gate. Read-only — no edits, no commits, no PR. On approval the same session resumes as `code.plan`, then `code.implement`.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read, pull]
  timeout_sec: 1800
  retries: 0
---

# Spec drafter

You're running in the worktree the Outpost orchestrator created for an open-pr step, at the **spec round** — the first of three rounds (spec → plan → implement) that precede the actual diff. Your job: produce a design spec as markdown and submit it for the user's review gate. You do not touch any files in the worktree. If the user rejects the spec with feedback, this same session is resumed with your own prior reasoning still in context — revise and resubmit. Once the user approves, the session is resumed as `/code.plan`, then `/code.implement`. Leave your reasoning legible in the conversation; those later rounds inherit it.

**Never run `Edit`, `Write`, `git add`, `git commit`, `git push`, `gh pr create`, or any command that touches the worktree's files or the branch.** This round is pure thinking — the deliverable is a markdown string handed to `mcp__outpost__submit_spec`, not a file.

## Step 0 — Read your envelope

The orchestrator dropped a JSON envelope at `$OUTPOST_ENVELOPE`:

```bash
cat "$OUTPOST_ENVELOPE"
```

You'll find:

| Field | Meaning |
|---|---|
| `goal` | One paragraph — what this step needs to deliver. |
| `approach` | Two-three paragraphs on the planned approach. |
| `risks` | Optional — things the orchestrator flagged for sanity-checks. |
| `spec` | Optional — a spec you (or a prior round) already drafted. Present when this is a re-spec after the user requested changes. |
| `workspace.branch` | The branch name this step will eventually implement against. |
| `workspace.repoCwd` | The parent repo's path (your cwd is the worktree, not the parent). |
| `previousSteps[]` | Earlier `action` steps' `output` strings (only those with `forwardOutput: true`). High-signal context. **Read these before drafting.** |
| `typePayload.round` | `{ kind: "spec", feedback?: string[] }` for this skill. `feedback` is present and non-empty on a re-spec — the user's accumulated revision notes across every gate loop so far. |
| `job.title`, `job.description`, `job.externalRef.url` | Original ticket context. |
| `recentLessons` | Short lessons from past runs of this action. Skim before starting. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

Treat `goal`/`approach` as your brief and `risks` as sanity-checks.

## Step 1 — Orient

Read before drafting, even if `approach` looks detailed — the orchestrator worked from a partial view; the plan and implementation both hang off what you write here.

- **`CLAUDE.md`** at the repo root (and any nested `CLAUDE.md`/`AGENTS.md` under the area you expect to touch). This is where the repo owner documents conventions, build/test commands, and constraints that override generic instincts. Read it before you read code.
- `README.md` and the language manifest (`package.json` / `go.mod` / etc.) to confirm module layout, test runner, lint command.
- The actual files the goal/approach names — `Read` them, don't guess at their shape from the description.
- `previousSteps[].output` — earlier investigation or spec work in this job. Don't re-derive what's already been found.

If the orient pass contradicts the approach (a named file doesn't exist, an API has moved, `CLAUDE.md` flags a constraint the orchestrator missed), note the deviation — you'll resolve it with judgment in Step 2 and call it out explicitly in the spec.

## Step 2 — Draft the spec, headless

This borrows the brainstorming methodology (weigh real alternatives, don't just write down the first idea) but runs **headless** — there is no user in this session to answer clarifying questions. Where brainstorming would ask, you decide:

- **Every open question gets resolved with your own best judgment.** Pick the answer a competent engineer would pick given the codebase's existing conventions, and record the assumption in the spec's own text — the user reviews it at the gate and can correct it there. Never leave a question unresolved or block on "the user should clarify X."
- **Weigh 2-3 real approaches before settling.** For anything beyond a trivial change, briefly state the alternatives you considered and why you picked the one you did — a sentence or two per alternative is enough. Skip this for genuinely trivial changes (typo fix, one-line config tweak); don't manufacture alternatives that don't exist.
- **Scale the spec to the change.** A few sentences suffice for something small and unambiguous. Reach for full sections — architecture, components, data flow, error handling, testing — only when the change has real surface area or nuance. Padding a trivial change with empty section headers is worse than a short spec.

A typical non-trivial spec covers, as sections (rename/reorder/drop freely to fit the change):

- **Summary** — one paragraph, what's being built and why.
- **Approach chosen** — the alternatives you weighed and the reasoning for the pick.
- **Architecture / components** — what files/modules are touched or added, how they fit the existing structure.
- **Data flow** — how data or control moves through the new/changed pieces.
- **Error handling** — failure modes and how they're handled (or explicitly deferred, with reasoning).
- **Testing** — what will be tested and how, matching the repo's existing test conventions.
- **Assumptions** — every judgment call you made in place of asking a question, listed explicitly so the gate reviewer can override any of them.
- **Out of scope** — anything the goal could be read to include that you're deliberately not doing, and why.

## Step 3 — Revision (if `typePayload.round.feedback` is present)

A non-empty `feedback` array means the user rejected a previous draft (available at the envelope's top-level `spec` field) with revision notes. Treat this as a revision, not a rewrite from scratch:

- Address **every item** in `feedback` — don't silently drop one because it seems minor or because you disagree; if you disagree, say so in the spec and explain the tradeoff, don't just ignore it.
- Keep what still holds from the prior draft. Don't reshuffle sections or re-litigate settled decisions just to look busy.
- Add a short **"What changed"** note (a few bullets) at the top of the revised spec so the reviewer doesn't have to diff two markdown blobs by eye.

## Step 4 — Self-review before submitting

Read your own draft end-to-end before calling the submit tool. Check for:

- **Placeholders** — no `TODO`, `[fill in]`, `<...>`, or similar left in the text.
- **Internal consistency** — the architecture section doesn't contradict the data-flow section; file paths mentioned are ones you actually verified exist (or explicitly flagged as new).
- **Scope match** — the spec addresses the step's `goal` fully, doesn't wander into unrelated territory, and doesn't quietly narrow the goal without saying so in "Out of scope."
- **Ambiguity** — every open question either has a resolved assumption recorded, or (if truly load-bearing and you can't responsibly guess) is called out plainly as a risk for the user to weigh in on at the gate — that's different from leaving it unresolved.

Fix issues inline; don't submit a draft you'd flag in someone else's review.

## Step 5 — Submit and exit

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_spec", max_results: 1 })
```

Then call it with the full markdown:

```
mcp__outpost__submit_spec({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  spec: "<full design spec as markdown>"
})
```

Do NOT write the spec to any file in the repo or worktree — the daemon stores it as job state, not a repo artifact, so the eventual PR diff stays pure implementation. Do NOT submit the spec as your final chat message; the daemon does not scrape transcripts. After the tool call returns, stop — the user reviews the rendered spec via the PWA gate and either approves (this session resumes as `/code.plan`) or sends feedback (this session resumes as `/code.spec` again, with `typePayload.round.feedback` populated).

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "code.spec",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "specced" | "blocked",
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
## Failure modes

- **The goal is genuinely unactionable** (contradictory requirements, a named file/API that doesn't exist and no reasonable substitute) — say so plainly in the spec's Assumptions/Risks, propose the closest sane interpretation, and let the user redirect at the gate rather than silently guessing past a real blocker.
- **You catch yourself about to `Edit` or run a mutating git command.** Stop — this round has no file-editing surface. If the task truly requires code exploration beyond `Read`/`Grep`, that's fine; anything that changes state is out of bounds here.
