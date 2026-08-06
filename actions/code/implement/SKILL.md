---
name: code.implement
description: Use when invoked as `/code.implement` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.implement"`. Reads the envelope (goal/approach/risks/branch + any previous-step findings) and edits files to implement the changes as uncommitted working-tree edits — NO git commit, NO git push, NO PR creation. The user reviews the diff via the PWA git view, then commits / pushes / opens the PR themselves. Finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: worktree-edit
  runner: claude
  permissions: [read, edit]
  timeout_sec: 3600
  retries: 0
---

# Project implementer

You're running in the worktree `code.orchestrate-pr` owns, bound to the *initial* implementation round of its step. Your job: implement the change as **uncommitted file edits** in the worktree, then hand the session back to the controller with `mcp__outpost__submit_step_progress`. The user reviews via the PWA's git view and handles every git operation themselves — `git add`, `git commit`, `git push`, `gh pr create`. Your output is files; the user takes it from there, and the controller parks on a `wait` until the PR appears.

**This round ends with exactly one `mcp__outpost__submit_step_progress` call, then you stop.** A round that ends without one is read as a hang and fails the whole step — the implementation included.

This skill handles the initial round. **This same session runs every later round** — when review comments arrive it is rebound to `code.triage-pr-comments`, and each fix round to `code.fix-pr-comment`. So leave your reasoning legible in the conversation as you work (why the code is shaped this way, tradeoffs you weighed) — future rounds inherit this context, and it's what lets a one-line review fix stay a one-line fix.

The worktree is a fresh branch under `~/.outpost/worktrees/<stepId>/`. Your cwd is already inside it. You can `Edit`, `Write`, and run any `Bash` command that doesn't move the branch.

**Never run `git add`, `git commit`, `git push`, `git tag`, `gh pr create`, or any command that stages, commits, or publishes the branch.** If the plan or your instincts push you toward "commit and open the PR", stop — that's the user's job, deliberately. Pending changes in the worktree IS the "PR isn't finished yet" signal. Read-only git (`git status`, `git diff`, `git log`, `git fetch`, `git rebase` only if needed) is fine.

**Don't drop scratch files into the worktree.** Plan notes, intermediate JSON, debug outputs — write to `/tmp/` (use `$STEP_ID` in the filename to avoid clashing). Only real source edits belong in the worktree.

## Step 0 — Read your envelope

The orchestrator dropped a JSON envelope at `$OUTPOST_ENVELOPE`:

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
```

You'll find:

| Field | Meaning |
|---|---|
| `goal` | One paragraph — what this step needs to deliver. |
| `inputs.approach` | Two-three paragraphs on the planned approach. |
| `inputs.risks` | Optional — things the planner flagged for sanity-checks. |
| `artifacts.spec` | The approved design spec, as markdown. You (or an earlier session) drafted it in the spec round and the user approved it at the gate. |
| `artifacts.implPlan` | The task-by-task implementation plan, as markdown. You (or an earlier session) drafted it in the plan round, against the approved spec. |
| `workspace.branch` | The branch name this step is implementing against. |
| `workspace.repoCwd` | The parent repo's path (your cwd is the worktree, not the parent). |
| `previousSteps[]` | Earlier `action` steps' `output` strings (only those with `forwardOutput: true`). High-signal context for the implementation. **Read these before charging ahead.** |
| `boundNote` | What the controller asked this round to do, in its own words. |
| `job.title`, `job.description`, `job.externalRef.url` | Original ticket context. |
| `recentLessons` | Short lessons you wrote at the end of past project-implementer runs. Skim them before starting — they encode mistakes worth not repeating. The envelope's actual instructions still win if they conflict. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

Treat `goal`/`approach` as your spec and `risks` as sanity-checks.

## Step 1 — Orient

An approved design spec (`envelope.spec`) and a task-by-task implementation plan (`envelope.implPlan`) precede this round — you authored both earlier in this same session (spec round, then plan round), and the user already approved the spec at its gate. Execute the plan task-by-task as **uncommitted** working-tree edits; it's the primary driver for Step 2, ahead of `$WORK_APPROACH`. If a plan step no longer fits reality once you look at the actual files (an API moved, a file doesn't exist, a task was based on a stale assumption), adapt and note why in your final summary — don't silently deviate.

Quickly read what's there before touching anything. Do this even if `$WORK_APPROACH` is detailed — the investigator was read-only and worked from a partial view; you're the one whose diff has to land.

- `git status` and `git log -3 --oneline` — confirm you're on a fresh worktree branch off `main` with no surprises.
- **`CLAUDE.md`** at the repo root (and any nested `CLAUDE.md` / `AGENTS.md` under the files you'll touch). This is non-negotiable — it's where the repo's owner documented conventions, build/test commands, gotchas, and any rules that override generic instincts. Read it before you read code. If a subdir under the area you're changing has its own `CLAUDE.md` or `AGENTS.md`, read that too; subdir guidance wins over the root.
- `README.md` and the language manifest (`package.json` / `go.mod` / `pyproject.toml` / etc.) — to confirm your assumptions match this repo (module name, language version, test runner, lint command).
- **House style for the code you write.** Default to **no comment** on internal code; never restate code, narrate mechanism, or write task/history/AI-tell preambles. Build only what's asked: no preemptive abstractions, no defensive checks against impossible states, no half-finished work, no backwards-compat shims inside a repo the owner controls. If the repo's `CLAUDE.md` or `AGENTS.md` contradicts any of this, the repo wins for that repo — but the vast majority of the time they align, and these fill in the silence.

If `$WORK_APPROACH` references specific files, `Read` them now. If anything in the orient pass contradicts the approach (file doesn't exist, API has moved, the repo's `CLAUDE.md` flags a constraint the investigator missed), note it — you'll act on the goal in Step 2 and surface the deviation in your summary.

## Step 2 — Implement

Apply `$WORK_APPROACH`. Use TDD where it makes sense (a test first, then the change, then the test passes), especially for backend logic and bug fixes. For UI tweaks or config changes, manual verification is fine.

When the approach is ambiguous, exercise judgment — you're the implementer, and the human reviews the diff before it merges. If you discover the approach is wrong (the file doesn't look how the investigator described, an API has changed, a dependency is missing), do the thing that solves the goal and note the deviation in your final summary. Don't paper over it.

Match the repo's existing conventions, then apply the house-style rules and the repo's `CLAUDE.md`/`AGENTS.md` you read in Step 1. Read a few neighboring files for tone before adding new ones — comment style, naming, error handling, where tests live. The common failure mode is over-commenting: if you find yourself writing `// fetch user` above `user := getUser()` or restating a function's name in its doc comment, delete it. Likewise resist adding helpers, options structs, or interfaces "in case someone needs them" — three similar lines beat a premature abstraction.

Don't expand scope. A bug fix fixes the bug; it doesn't refactor the surrounding function. If you spot something else worth changing while you're in there, mention it in your final summary — don't bundle it into the diff.

Run the project's tests at least once before declaring done. If the repo has linting or type-checking, run that too. The command lives in the repo's `CLAUDE.md` / `README.md` / `package.json` scripts — use what the repo defines, not a guess.

## Step 3 — Self-review the diff

Before finishing, read your own working-tree diff (`git diff`) end-to-end. Things to actively look for:

- Stray debug prints, commented-out code, or `// removed: previously did X` epitaphs (the house style forbids these).
- Comments that restate code, name-restate functions, or narrate task history (`// fix for ENG-123`). Delete them — context belongs in the PR description, not in code.
- Half-finished slices, dead branches you added "just in case", or backwards-compat wrappers inside a repo the owner controls.
- Files you didn't mean to touch (auto-format sweeps that touched unrelated files, accidental dependency bumps). Revert anything off-target with `git checkout -- <path>` — that's a working-tree reset, not a ref change, and is fine.

A 30-second review here saves the user from having to do it themselves.

## Step 4 — Report the round

The outpost MCP tools are deferred behind ToolSearch — load them first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

If `submit_step_progress` doesn't come back, say so and stop — the daemon does not scrape the transcript, and a round that never submits fails the step.

`artifacts.implementation` is the **only** durable signal that the implementation is finished. Nothing else in the envelope can say so: the edits are uncommitted, there is no PR yet, and `phase` is just a label. The controller's ladder reads this artifact to stop running implement rounds and start waiting for the PR — so write it, and make it a real summary rather than "done":

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "implement",
  memo: "<what you changed, any deviation from the plan and why, what to look for in review>",
  artifacts: { implementation: "<the same summary as markdown: files touched, what each change does, deviations, what you could not finish>" },
  next: { kind: "self-round" }
})
```

Write `artifacts.implementation` even when you could **not** finish — say plainly what is done, what is broken, and what you gave up on. A blocked implementation the controller can see beats a silent round it has to re-run.

`next: {kind:"self-round"}` with no `action` hands the session back to `code.orchestrate-pr` for a decision turn. It owns the ladder — whether to wait for the PR, ask you for more, or fail the step — so do not pick that yourself. Do not try to open the PR, and do not wait for approval messages.

Then write a one-paragraph human summary to the chat: what changed, any deviations from the approach, anything to look for in review. The user reads that in the activity stream, reviews the uncommitted diff via the PWA's git view, then commits / pushes / opens the PR themselves.

## Step 5 — Journal one lesson

Call `mcp__outpost__submit_journal` with one short lesson the *next* project-implementer run should know. Skip entirely if there's nothing new.

```
mcp__outpost__submit_journal({
  action: "code.implement",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "implemented" | "partial" | "blocked" | "deviated",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the step succeeded: it recurs identically on every future run of
this action until a human sees it, and this journal is the only place
`meta.improve-actions` looks. Name the exact command or field, not the category.

Concrete > generic. "Server repo's lint step requires running `mage proto` first if proto files changed" beats "watch out for build steps". Don't pad.

## Failure modes

- **Tests fail and you can't make them pass.** Don't paper over it. Leave the diff, say exactly what's broken in `memo` and `artifacts.implementation`, and still submit — the controller decides whether to send you back or park for the user.
- **Worktree drift** (parent moved on `origin/main` while you worked). `git fetch origin && git rebase origin/main` is fine — rebase moves the worktree's `HEAD`, not a published ref. If the rebase conflicts and you can't resolve them with confidence, note it in your summary and let the user decide.
- **You accidentally ran `git commit` / `git push` / `gh pr create`.** Stop immediately and tell the user in plain language what happened. Don't try to silently undo it — they need to know what state the branch is in so they can clean up.
