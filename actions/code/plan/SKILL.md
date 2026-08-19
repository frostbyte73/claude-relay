---
name: code.plan
description: Use when invoked as `/code.plan` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.plan"`. Reads the envelope and the accepted spec, borrows the writing-plans methodology to decompose the change into right-sized tasks with concrete steps and file paths, self-reviews it, and reports it as the step's `implPlan` artifact via `mcp__outpost__submit_step_progress`. Read-only — no edits, no commits, no PR.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  plannable: false
  permissions: [read]
  timeout_sec: 1800
  retries: 0
---

# Plan drafter

You're running in the worktree `code.orchestrate-pr` owns, bound to the **plan round** — the second of three rounds (spec → plan → implement) that precede the actual diff. The spec round (this same session, earlier in the conversation) already produced a design spec and the user approved it. Your job: turn that approved spec into a task-by-task implementation plan and report it. You do not touch any files in the worktree. There is no review gate on the plan itself, so get it right.

**Never run `Edit`, `Write`, `git add`, `git commit`, `git push`, `gh pr create`, or any command that touches the worktree's files or the branch.** This round is pure thinking — the deliverable is a markdown string handed to `mcp__outpost__submit_step_progress`, not a file.

## Step 0 — Read your envelope and the spec

The orchestrator dropped a JSON envelope at `$OUTPOST_ENVELOPE`:

```bash
cat "$OUTPOST_ENVELOPE"
```

You'll find:

| Field | Meaning |
|---|---|
| `goal` | One paragraph — what this step needs to deliver. |
| `inputs.approach` | Two-three paragraphs on the planned approach. |
| `inputs.risks` | Optional — things the planner flagged for sanity-checks. |
| `artifacts.spec` | The accepted design spec, as markdown. This is the source of truth for this round — the user has already reviewed and approved it. |
| `workspace.branch` | The branch name this step will eventually implement against. |
| `workspace.repoCwd` | The parent repo's path (your cwd is the worktree, not the parent). |
| `previousSteps[]` | Earlier `action` steps' `output` strings (only those with `forwardOutput: true`). High-signal context. |
| `boundNote` | What the controller asked this round to do, in its own words. |
| `job.title`, `job.description`, `job.externalRef.url` | Original ticket context. |
| `recentLessons` | Short lessons from past runs of this action. Skim before starting. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

The spec you're planning against is also earlier in this conversation — you drafted it yourself in the spec round. `envelope.spec` and your own prior turns should agree; if the envelope's copy has drifted from what you remember writing (unlikely, but check), trust `envelope.spec` — it's the version the user actually approved at the gate.

## Step 1 — Orient

The spec round already read `CLAUDE.md`, the README, and the manifest, and named the files it expects to touch or add. Don't re-derive all of that from scratch, but do verify it against the current worktree before committing a plan to paper:

- Re-open the files the spec names as touch points. Confirm they still look the way the spec describes — a plan built on a stale mental model produces a bad implementation round.
- If the spec left an assumption explicit (it should have — that's what the Assumptions section is for), treat it as settled; don't relitigate it here. The plan round isn't a second design pass.
- If orienting turns up something that actually contradicts the spec (a file the spec says exists doesn't, an API the spec assumed has moved), note the deviation plainly in the plan rather than silently re-designing around it — the implementer needs to know the ground shifted.

## Step 2 — Decompose into tasks

This borrows the **writing-plans** methodology: map the full set of files to touch, then decompose the change into right-sized tasks — each one a coherent, independently-verifiable unit of work, ordered so that earlier tasks unblock later ones (e.g., shared types before the code that uses them, a handler before the route that wires it in).

**Adapt for Outpost — this is the one place this plan departs from vanilla writing-plans:**

- **No `git commit` steps.** This repo's contract is that the implementer never commits — `code.implement` produces a single uncommitted diff that the user reviews via the PWA git view and commits themselves. Do not write "commit with message …" anywhere in the plan.
- **No TDD-commit rhythm ceremony.** Skip the red/green/refactor-then-commit loop as a structural requirement. Tests are still valuable and each task should say what to test and how — but frame it as "write the test, make it pass, move to the next task," not as a commit checkpoint.
- Each task still ends with a **verification** step (run the specific test file, run `tsc --noEmit`, exercise the code path) — that's the equivalent checkpoint without the commit.

For each task, write:

- **A short title** naming the unit of work.
- **Concrete steps** — not "implement the handler" but the actual edits: exact file paths (new files marked as new), the function/type signatures involved, and a real code sketch where the shape isn't obvious from the spec alone. Sketches should be concrete enough that the implementer isn't left guessing at names, but don't write the entire file for them — leave room for the implementer's own judgment on the mechanical parts.
- **Test intent** — what behavior gets pinned down and how (unit test file + what it asserts, or manual verification steps for UI/config changes that don't lend themselves to a unit test). Match this repo's existing test conventions (vitest for backend `src/`, playwright for e2e) rather than inventing a new pattern.
- **Verification** — the exact command(s) to run to confirm the task's slice works before moving on (e.g., `npx vitest run src/foo.test.ts`, `npx tsc --noEmit`, a manual repro).

Order tasks so dependencies flow forward. If two tasks are genuinely independent (touch disjoint files, no shared types), say so — the implementer can interleave them, but don't force a false ordering.

End the plan with a final task (or a short closing section) for whole-plan verification: the full test suite, typecheck, and any manual smoke test the change warrants — mirroring what a human would do right before opening a PR, minus the PR itself.

## Step 3 — Self-review before submitting

Read your own draft end-to-end before calling the submit tool. Check for:

- **Spec coverage** — walk the spec's own sections (architecture, data flow, error handling, testing, etc.) and confirm every one of them maps to at least one task. A spec section with no corresponding task is either an oversight or should have been called out as deliberately deferred — don't let it fall through silently.
- **Placeholders** — no `TODO`, `[fill in]`, `<...>`, or similar left in the text.
- **Type/name consistency** — function names, type names, and file paths are used the same way every time they're mentioned; a sketch in Task 2 doesn't contradict a signature assumed in Task 4.
- **No commit ceremony leaked in** — grep your own draft for `git commit`, `git push`, `gh pr` before submitting; none of those verbs belong in this plan.
- **Right-sized tasks** — no task is so large it bundles unrelated concerns, and no task is so small it's just administrative overhead (e.g., "update the import path" deserves a line inside a bigger task, not its own task).

Fix issues inline; don't submit a draft you'd flag in someone else's review.

## Step 4 — Submit and exit

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress", max_results: 1 })
```

Then report the plan as this step's `implPlan` artifact:

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "plan",
  memo: "<what the plan commits to, written for a cold-resumed you>",
  artifacts: { implPlan: "<full task-by-task implementation plan as markdown>" },
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to `code.orchestrate-pr` for a decision turn. It owns the ladder — which round runs next, and whether the user is asked to approve anything — so do not pick that yourself.

Do NOT write the plan to any file in the repo or worktree — the daemon stores it as step state, not a repo artifact, so the eventual PR diff stays pure implementation. Do NOT submit the plan as your final chat message; the daemon does not scrape transcripts. The implement round runs on this same session and inherits everything you and the spec round reasoned through — leave that reasoning legible in the conversation, then stop.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "code.plan",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "planned" | "blocked",
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

- **The spec itself is unactionable** (an assumption it recorded turns out to be wrong once you look at the actual files, or two of its sections genuinely conflict). Don't silently re-design around it — call out the conflict plainly in the plan's own text (a short "Deviations from spec" note near the top is enough) and plan against the interpretation a competent engineer would pick, so the implementer isn't blocked.
- **You catch yourself about to `Edit` or run a mutating git command.** Stop — this round has no file-editing surface. Reading and grepping to verify the spec's assumptions is fine; anything that changes state is out of bounds here.
