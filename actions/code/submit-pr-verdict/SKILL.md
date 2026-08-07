---
name: code.submit-pr-verdict
description: Use when invoked as `/code.submit-pr-verdict` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.submit-pr-verdict"`. Submit exactly one verdict on the PR under review — `gh pr review --approve` or `--request-changes` — derived from `artifacts.resolutions`, then record it in `artifacts.verdict` and report via `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  permissions: [read, pull]
  timeout_sec: 600
  retries: 0
---

# Submit the verdict

This is the same session that reviewed the PR, posted the comments and verified which of
them the author addressed. `code.orchestrate-review` decided the review is finished and
rebound this round to you — **this is not a fresh session and not a dispatch.** You keep
the controller's conversation, its worktree and its envelope; only the bound action changed
for one turn.

Because this action declares `side_effects: external-write`, the daemon held the move at a
user gate before you were resumed, and it rendered the controller's `note` into the gate
draft. **The user has already read which verdict is going out and approved it.** Do not
gate it again, do not ask; submit it.

Your job is exactly one thing: submit **one** verdict — `APPROVE` or `REQUEST_CHANGES` —
with a body that says why. Nothing else is granted. This action deliberately does **not**
inherit the `push` group; `gh pr merge`, `gh pr comment`, `gh pr close`, `gh pr create`,
`git push` and `git commit` are all denied here, and so is `gh api` in every write form —
`POST /repos/{owner}/{repo}/pulls/{n}/reviews` is the REST spelling of this same verdict
and would walk straight around the whitelist below. If you find yourself wanting one of
those, this is the wrong round: hand it back (Step 5b).

There is no third verdict. `gh pr review --comment` is denied on purpose: a review that
neither approves nor requests changes leaves the PR author with nothing to act on, and the
step with nothing to resolve on.

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PR_URL=$(jq -r '.pr.prUrl // .inputs.prUrl // empty' "$OUTPOST_ENVELOPE")
jq -r '.artifacts.resolutions // empty' "$OUTPOST_ENVELOPE"
```

**Read the PR number off `PR_URL` and remember it.** Step 4 takes the number as a literal
digit string — not `"$PR_URL"`, not `$PR_NUM`. Everything else about this action is one
command, and that number is the only thing binding it to the right PR.

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

| Field | What it is |
|---|---|
| `artifacts.resolutions` | **What the verdict is derived from.** First line is `verified against <sha>` — the head those verdicts were judged at; carry it into your memo (Step 5a). Then one line per posted comment: `addressed` / `not-addressed` / `unclear` with evidence. |
| `artifacts.postedReview` | The comments this verdict is a verdict on. |
| `boundNote` | What the controller asked for this round — including, when it applies, the user's explicit waiver of an unresolved comment. |
| `gateFeedback` | Anything the user wrote when approving. If it changes the verdict, it wins — record that in the memo. |

If `PR_URL` is empty there is nothing to submit — skip to Step 5b and hand it back.

## Step 2 — Derive the verdict. Do not choose it.

The rule is mechanical, and it is the reason the verify round exists:

| `artifacts.resolutions` contains | Verdict |
|---|---|
| no `not-addressed` and no `unclear` | `APPROVE` |
| any `not-addressed` | `REQUEST_CHANGES` |
| any `unclear`, no `not-addressed` | `REQUEST_CHANGES`, with the unclear items asked as questions — unless `boundNote` says the user resolved them |

**Any `not-addressed` blocks an APPROVE.** The one exception is an explicit waiver: the
user told the controller to approve anyway and the controller recorded that in `boundNote`
("user waived src/pwa/app.js:88 — says the listener leak is pre-existing"). A waiver has to
be *in the note*; your own judgement that a comment was minor is not a waiver, and neither
is the author's reply. If you approve over a `not-addressed` item, name the waiver and the
item it covers in the body and in `artifacts.verdict`.

If `resolutions` is missing entirely, do not invent a verdict from memory — hand it back
(Step 5b) so the controller can run `code.verify-resolutions` first.

## Step 3 — Write the body

Anything longer than a sentence goes in a file, written with the **Write tool** to a path
directly under `/tmp/`, with a **literal** filename (write the PR number in yourself; a
shell variable in the path is denied):

```
Write({ file_path: "/tmp/outpost-verdict-<PR_NUMBER>.md", content: "…" })
```

Outside this step's own worktree, `/tmp/` is the only place this action may write. The
worktree auto-allows via session scope — a `Write` under it succeeds rather than denying —
but it is a throwaway detached PR-head checkout, `git worktree remove --force`d when the step
settles, and `--body-file` will not read from it anyway. `--body-file` is pinned to `/tmp/`
for the same reason `--input` is on `code.post-pr-review`: an unpinned `--body-file` publishes
any local file — `/etc/passwd`, `~/.outpost/.env` — as a review on somebody else's PR.

What the body should say, in this order:

1. The verdict in one line, and what it turns on.
2. Every `not-addressed` item: the comment, and the evidence from `resolutions` that the
   change does not do what was asked. Quote the hunk. This is the part the author will
   argue with, so it has to carry its receipts.
3. Every `unclear` item, as a question.
4. Anything waived, and that the user waived it.

Do not re-litigate comments already marked `addressed`, and do not add findings that were
never posted — those were never approved and never given to the author.

## Step 4 — Submit it

One line, in this exact order: `gh pr review`, the **literal PR number**, the verdict, then
at most one body flag.

```bash
gh pr review <PR_NUMBER> --request-changes --body-file /tmp/outpost-verdict-<PR_NUMBER>.md
```

or, for the approve path:

```bash
gh pr review <PR_NUMBER> --approve --body-file /tmp/outpost-verdict-<PR_NUMBER>.md
```

A one-line body can go inline instead — but only as a literal:
`gh pr review <PR_NUMBER> --approve --body "All four comments addressed in def4567."`

What is granted is exactly that shape:

| Allowed | Notes |
|---|---|
| the PR operand | **a bare number, typed literally.** Not a URL, not `"$PR_URL"`, not `$PR_NUM` |
| `--approve`, `--request-changes` | exactly one, and it is mandatory |
| `--body <literal text>` | quoted or bare; **no** `$VAR`, **no** `$(…)`, **no** backticks — a command substitution would put an unreviewed file's contents into a public review |
| `--body-file /tmp/<literal-filename>` | the file from Step 3 |

**Why a number and not the URL.** A bare number is resolved by `gh` against the remote of
the worktree you are standing in — the repo whose PR you reviewed. A URL names any repo on
github.com, and a `$VAR` names whatever was last assigned to it, so either one lets a
verdict the user approved for *this* PR land on a different one. `--repo` is denied for the
same reason. That binding is only as good as your cwd: **do not `cd` out of the worktree
before Step 4.**

Everything else denies — `--comment`, `--repo`, the `-a`/`-r`/`-c`/`-b`/`-F` shorthands,
both verdicts at once, a bare `gh pr review` with no operand (which would drop into an
interactive prompt and hang the step), a `\`-continued command split across lines, and a
second command chained with `&&`. Write it on **one line**. If you see a denial here, you
wrote something outside that table; drop it and re-run the plain form.

**One verdict, once.** If `gh` exits zero, you are done — do not submit a second review to
"clarify". If it fails, read Step 5b before doing anything else.

## Step 5a — Report the verdict

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`artifacts.verdict` is the durable record that the verdict went out; the controller's ladder
reads it to know the review is finished. Record the verdict *and* the body you submitted —
what the PR author was told is the whole outcome of this job.

**Your `memo` replaces the controller's, wholesale.** The daemon overwrites `memo` with
whatever this submit carries — it does not merge. That matters even here, at the end: if the
verdict does not land (Step 5b) the controller walks its ladder again, and the head sha it
compares against, what the review concluded, and any user waiver it recorded all live only in
the memo you are about to overwrite. Carry them forward on both paths.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "verdict_submitted",
  memo: "submitted REQUEST_CHANGES on <PR_URL>: 2 of 4 comments unaddressed. <then the controller's narrative, carried forward>",
  artifacts: { verdict: "REQUEST_CHANGES\n\n<the body exactly as submitted>" },
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to
`code.orchestrate-review` for a decision turn. It owns the ladder — and in particular it
owns whether the step resolves here or keeps watching the PR (`inputs.until`), so do not
resolve the step yourself.

## Step 5b — Report no verdict

Anything short of a submitted verdict. Same hand-back, with the reason in `memo` and **no**
`verdict` artifact:

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "verdict_pending",
  memo: "no verdict: <no resolutions artifact / gh said 'Can not approve your own pull request' / gh said '<stderr>'>. <then the controller's narrative, carried forward>",
  next: { kind: "self-round" }
})
```

**`gh pr review` cannot approve your own PR.** GitHub answers
`422 Can not approve your own pull request`. That is a real, permanent refusal — the account
`gh` is authenticated as authored the PR. Do **not** retry it, do not fall back to
`gh pr comment` (denied), and do not downgrade the verdict to get around it. Report it here
with that reason and let the controller decide; the user may want to approve by hand, or
may want the review body posted a different way.

## Step 6 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.submit-pr-verdict",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "resolved" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

Use `blocked` for anything short of a submitted verdict (the Step 5b path) — that is the
string the Library and `meta.improve-actions` read as a blocker.

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or ambiguous
envelope field, anything you had to guess at or work around. Journal it even when you
recovered and the verdict landed: it recurs identically on every future run of this action
until a human sees it, and this journal is the only place `meta.improve-actions` looks.
Name the exact command or field, not the category.

## Failure modes

- **Envelope missing or unreadable.** Say so in one line and exit; the engine settles the
  step on the next tick.
- **`gh pr review` succeeded but the session died before reporting.** The round re-runs.
  Read `gh pr view "$PR_URL" --json reviews,reviewDecision` first: if your verdict is
  already there, record it in `artifacts.verdict` rather than submitting a second one.
- **Approving your own PR.** See Step 5b — permanent refusal, not a retry.
- **The PR was merged or closed while the gate was open.** GitHub still accepts a review,
  but it changes nothing. Hand it back (Step 5b) with that as the reason and let the
  controller decide whether the verdict is still worth submitting.
- **The author pushed new commits while the gate was open.** The verdict is now about a
  commit that is not the head. Hand it back (Step 5b); the controller will run
  `code.verify-resolutions` again and re-gate.
- **Hook server returns 401.** Daemon restarted mid-session; print the situation and exit.
  Do not submit on a session that cannot report what it submitted — a duplicate verdict on
  somebody else's PR is worse than a delayed one.
