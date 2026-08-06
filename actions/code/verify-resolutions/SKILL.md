---
name: code.verify-resolutions
description: Use when invoked as `/code.verify-resolutions` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.verify-resolutions"`. For each comment in `artifacts.postedReview`, judge from the pushed diff — never from the author's reply — whether it was actually addressed, and record `addressed` / `not-addressed` / `unclear` with evidence in `artifacts.resolutions`. Read-only; finish with `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read, pull]
  timeout_sec: 900
  retries: 0
---

# Did the author actually fix it?

This is the same session that reviewed the PR and posted the comments.
`code.orchestrate-review` saw new commits land and rebound this round to you — **this is
not a fresh session and not a dispatch.** You keep the controller's conversation, its
worktree and its envelope; only the bound action changed for one turn.

**That is deliberate and it is the whole reason this action exists as a self-round.** The
judgement it makes — "does this change actually answer what I meant?" — needs the review
reasoning that lives in this conversation. A comment reads, on its own, as a one-line
request; what makes it satisfiable or not is the thing you understood about the code when
you wrote it. A dispatched subagent gets the comment text and the diff and has to
re-derive the intent, which is exactly where "they touched that line, close enough" comes
from. **Do not "optimise" this into a dispatch.**

You write nothing. Not to the PR, not to disk. Your entire output is the `resolutions`
artifact. `gh pr review`, `gh pr comment`, `gh api --method POST`, `git push`,
`git commit` — all denied here, and this action has no `allowlist.json` rules of its own at
all. The verdict is a later round (`code.submit-pr-verdict`) behind its own user gate.

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PR_URL=$(jq -r '.pr.prUrl // .inputs.prUrl // empty' "$OUTPOST_ENVELOPE")
jq -r '.artifacts.postedReview // empty' "$OUTPOST_ENVELOPE"
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

| Field | What it is |
|---|---|
| `artifacts.postedReview` | **The comment set to verify.** The review id and one line per comment: path, line, outcome, first 80 chars of the body. Every line is one item you must return a verdict for. |
| `artifacts.resolutions` | An earlier round's verdicts, if this is not the first pass. Carry forward everything still true and re-judge only what the new commits could have changed. |
| `pr.comments` | Every comment on the PR, including the author's replies. Context only — see Step 3. |
| `boundNote` | Which comments the controller wants re-checked this round, if it narrowed the set. |

If `postedReview` is empty there is nothing to verify — skip to Step 4b and hand it back.
Do not verify comments you never posted.

## Step 2 — Find what changed since the review

The review was anchored to a commit; `postedReview` records it. Everything that could
address a comment is in the range from that commit to the PR's current head.

```bash
gh pr view "$PR_URL" --json headRefOid,commits,state,comments
gh pr diff "$PR_URL"
```

`gh pr diff` is the reliable read here: it renders the PR's full diff server-side, so it is
current even though this worktree was provisioned when the step started and is now behind.
For per-commit detail:

```bash
gh api "repos/{owner}/{repo}/compare/<review-commit>...<headRefOid>"
```

Local `git log` / `git show` / `git diff` work too for anything already fetched — but never
report a comment as unaddressed on the strength of a local read that might just be stale.
If the local repo does not have the new commits, use the `gh` reads.

## Step 3 — Judge the diff, not the reply

For each comment in `postedReview`, one verdict:

| Verdict | When |
|---|---|
| `addressed` | A change in the range does the thing the comment asked for. You can name the commit and the hunk. |
| `not-addressed` | Nothing in the range changes the behaviour the comment was about — **including when the author replied saying it was fixed.** |
| `unclear` | Something changed nearby, or the comment was a question rather than a request, and you cannot tell from the diff whether it is answered. |

**A reply is not evidence.** "Good catch, fixed" with no matching change is
`not-addressed`, and saying so is the entire value of this round — a review that accepts
reply text as proof is a review that does nothing. Read the author's replies for what they
*claim*, then go find whether the code agrees.

**`unclear` is a legitimate verdict; use it.** It costs the user one question. A wrong
`addressed` ships a bug and a wrong `not-addressed` picks a fight with the PR author. Do
not guess to make the list look decisive. If three of eight are `unclear`, return three
`unclear`.

Two shapes worth naming, because they are the common ways this goes wrong:

- **Adjacent-but-not-the-thing.** The author refactored the function the comment pointed
  at, but the specific behaviour you flagged is unchanged. That is `not-addressed`, not
  `addressed`.
- **Addressed somewhere else.** The fix landed in a different file than the one you
  commented on. That is `addressed` — cite the hunk that actually does it.

For each verdict collect the evidence you will cite: the commit sha, the file, and a short
diff hunk or a one-line description of what that hunk does. A verdict with no evidence is
an opinion, and the verdict round has to be able to quote it back to the author.

## Step 4a — Report the verdicts

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`artifacts.resolutions` is what the controller's ladder reads to know this rung is done —
it is falsified only when every comment in `postedReview` has a verdict here. Keep it one
comment per line, in `postedReview`'s order, so the two can be diffed by eye.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "resolutions_checked",
  memo: "verified <n> comments against <k> new commits: <a> addressed, <b> not-addressed, <c> unclear",
  artifacts: { resolutions: "- src/work/orchestrator.ts:412 — addressed — def4567 wraps the mutate() call in the queue drain, so the re-entrancy is gone\n- src/pwa/app.js:88 — not-addressed — author replied \"fixed in 9ab1234\", but 9ab1234 only renames the handler; removeEventListener is still never called\n- src/git/git-ops.ts:210 — unclear — the timeout moved to a constant, but nothing shows whether the 30s value was the point of the comment" },
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to
`code.orchestrate-review` for a decision turn. It owns the ladder — whether to wait for
more commits, post a follow-up, or move to the verdict — so do not pick that yourself, and
do not state a verdict of your own in the memo.

## Step 4b — Report nothing verified

Nothing to verify, or you could not read the PR. Same hand-back, with the reason in `memo`
and **no** `resolutions` artifact — a partial artifact would falsify the controller's rung
and the unverified comments would never be looked at again:

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "resolutions_pending",
  memo: "verified nothing: <postedReview was empty / no prUrl / gh said '<stderr>'>",
  next: { kind: "self-round" }
})
```

## Step 5 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.verify-resolutions",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "resolved" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or ambiguous
envelope field, anything you had to guess at or work around. Journal it even when you
recovered: it recurs identically on every future run of this action until a human sees it,
and this journal is the only place `meta.improve-actions` looks. Name the exact command or
field, not the category.

## Failure modes

- **Envelope missing or unreadable.** Say so in one line and exit; the engine settles the
  step on the next tick.
- **No new commits since the review.** Every comment is `not-addressed` and that is a real
  answer, not a failure. Say so in the memo so the controller does not immediately re-run
  you.
- **The PR was force-pushed.** The review commit is gone and `compare` fails. Fall back to
  `gh pr diff` against the current head and judge the comments against the whole PR diff;
  note in the memo that history was rewritten, because line-anchored comments may now be
  orphaned on GitHub too.
- **`postedReview` lists a `degraded-to-body` comment.** It has no line anchor on GitHub,
  but it is still a comment the user approved and the author was asked to fix. Verify it
  like any other, against the file and line the body names.
- **The worktree is at a stale commit.** Expected — it was provisioned at the head as of
  step start. Prefer `gh pr diff`; never conclude `not-addressed` from a stale local read.
- **Hook server returns 401.** Daemon restarted mid-session; print the situation and exit.
