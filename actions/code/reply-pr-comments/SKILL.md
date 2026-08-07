---
name: code.reply-pr-comments
description: Use when invoked as `/code.reply-pr-comments` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step`, `type=orchestrated`, and `boundAction == "code.reply-pr-comments"`. Post the replies the user already approved to the PR's review threads — verbatim, nothing else — then report via `mcp__outpost__submit_step_progress`.
outpost:
  kind: action
  category: code
  side_effects: external-write
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# Post the approved PR replies

This is the same session that implemented the PR and triaged its comments.
`code.orchestrate-pr` decided the drafted replies are ready to go out and bound this round
to you. Because this action declares `side_effects: external-write`, the daemon held the
move at a user gate before you were resumed — **the user has already read the exact reply
bodies in `boundNote` and approved them.** Do not gate them again, do not ask, and do not
improve them.

Your job is exactly one thing: post the replies in `boundNote`, verbatim, to the threads
they name. Nothing else is granted. This action deliberately does **not** inherit the
`push` group; `git commit`, `git push`, `gh pr merge`, `gh pr review` and `gh pr create`
are all denied here. If you find yourself wanting one of those, this is the wrong round —
hand it back (Step 5b).

## Step 1 — Read the envelope

```bash
cat "$OUTPOST_ENVELOPE"
JOB_ID=$(jq -r '.jobId' "$OUTPOST_ENVELOPE")
STEP_ID=$(jq -r '.stepId' "$OUTPOST_ENVELOPE")
PR_URL=$(jq -r '.pr.prUrl // empty' "$OUTPOST_ENVELOPE")
```

Skim any lessons from past runs:

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

| Field | What it is |
|---|---|
| `boundNote` | **The approved payload.** One entry per reply: the comment id and the exact body to post. This is what the user approved at the gate — it wins over everything else. |
| `artifacts.draftedReplies` | The triage round's full drafts, for context. Only the ones named in `boundNote` are approved. |
| `artifacts.postedReplies` | What earlier rounds already posted. Never post one of these twice. |
| `pr.comments` | Every comment on the PR: `{id, author, body, file?, line?, diffHunk?, url?, inReplyTo?}`. Look each `boundNote` id up here for its `file`/`line`/`url`. |
| `pr.prUrl` | The PR to post against. |
| `gateFeedback` | Anything the user wrote when approving. If it asks for a wording change, apply it — that is also approved text. |

If `PR_URL` or `boundNote` is empty there is nothing to post — skip to Step 5b and hand it
back.

## Step 2 — Work out where each reply goes

Comment ids carry their own routing:

- **`issue:<n>`** — a top-level PR conversation comment. Reply as a new PR comment.
- **`review:<node-id>` with a `file`** — an inline review comment. It belongs in that
  thread, so reply *threaded* rather than starting a new conversation.
- **`review:<node-id>` with no `file`** — a review summary body. GitHub has no thread to
  reply into; post it as a PR comment and quote the reviewer's line so it reads as an answer.

The inline threads need GitHub's integer comment id, and the envelope stores the GraphQL
node id. Fetch the mapping once. Your cwd is the PR's worktree, so let `gh` fill in the
repo — `{owner}` and `{repo}` are `gh api`'s own placeholders, resolved from that
worktree's own remote, and they are the only repo spelling this action is granted:

```bash
gh pr view "$PR_URL" --json number --jq .number
gh api "repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments" --paginate --jq '.[] | "\(.node_id)\t\(.id)"'
```

**Read the PR number off that first command and type it in literally** — `<PR_NUMBER>` and
`<id>` below are digits you write yourself, not `$PR_NUM` or `"$PR_URL"`. A `$VAR` in a
target slot is whatever an earlier assignment put there, so the grant takes literals only;
substituting one is the difference between "reply to the PR the user approved" and "reply
to any PR on github.com".

## Step 3 — Post. Post ONLY what was approved.

Post the body **verbatim**. Do not add a preamble, a signature, a "as discussed" framing,
or an apology. The text in `boundNote` is what the user read and said yes to; anything you
add is unapproved text on a public PR.

Threaded reply to an inline review comment (`<id>` is the integer id from Step 2):

```bash
gh api --method POST "repos/{owner}/{repo}/pulls/comments/<id>/replies" -f body="<the approved reply, verbatim>"
```

Top-level PR comment (issue comments, review summaries):

```bash
gh pr comment <PR_NUMBER> --body "<the approved reply, verbatim>"
```

**A double-quoted body is read by the shell**, so `$VAR`, `$(…)` and backticks are denied
in one — a command substitution would put an unreviewed file's contents onto a public PR.
Reply text that needs them (markdown backticks, most often) has two escape hatches:

- **single-quote the body.** The shell expands nothing inside `'…'`, so
  `--body 'wrap the `insert` in a transaction'` is fine. Only an apostrophe in the text
  rules this out.
- **write the body to a file first**, then hand `gh` the path. This action may `Write` under
  `/tmp/` and read a body back from there, and nowhere else:

  ```bash
  gh pr comment <PR_NUMBER> --body-file /tmp/outpost-reply-<id>.md
  gh api --method POST "repos/{owner}/{repo}/pulls/comments/<id>/replies" --input /tmp/outpost-reply-<id>.json
  ```

  Use a literal filename directly under `/tmp/` (write the id in yourself). The `--input`
  payload is the endpoint's JSON body — `{"body": "…"}`.

Either way the text is still exactly what `boundNote` approved. The file is a transport, not
a licence to compose something new.

One command per reply, in the order `boundNote` lists them. If one fails, keep going with
the rest and record which failed — a partial post is a real outcome and the controller
needs to know exactly which threads still have no answer.

**Do not batch several replies into one comment**, and do not reply to a comment that is
not in `boundNote` — including comments authored by you on an earlier round.

## Step 4 — Verify

```bash
gh pr view "$PR_URL" --json comments --jq '.comments[-3:] | .[] | "\(.author.login): \(.body[0:80])"'
```

Confirm what landed before you report it. `gh` exiting zero is good evidence; this is the
confirmation.

## Step 5a — Report posted

Load the MCP tools (deferred behind ToolSearch), then report:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

`artifacts.postedReplies` is the **only** durable record that these replies went out — the
daemon does not mark the comments answered, and the controller's ladder reads this artifact
to know it is done with them. Write it as markdown, one line per comment id, and carry
forward everything that was already in `artifacts.postedReplies` so nothing is lost.

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "pr_comments",
  memo: "posted <n> replies (<comment ids>); <m> failed: <which and why>",
  artifacts: { postedReplies: "- review:ABC — posted (threaded)\n- issue:123 — posted\n- review:XYZ — FAILED: 404 on /replies" },
  next: { kind: "self-round" }
})
```

`next: {kind:"self-round"}` with no `action` hands the session back to
`code.orchestrate-pr` for a decision turn. It owns the ladder — which round runs next, and
whether anything else needs approving — so do not pick that yourself.

## Step 5b — Report nothing posted

Nothing to post, or every post failed. Same hand-back, with the reason in `memo`, and no
`postedReplies` artifact:

```
mcp__outpost__submit_step_progress({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  phase: "pr_comments",
  memo: "posted nothing: <boundNote was empty / no prUrl / gh said '<stderr>'>",
  next: { kind: "self-round" }
})
```

## Step 6 — Journal one lesson

```
mcp__outpost__submit_journal({
  action: "code.reply-pr-comments",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "resolved" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, anything you had to guess at or work around. Journal it even
when you recovered and the replies landed: it recurs identically on every future run of
this action until a human sees it, and this journal is the only place
`meta.improve-actions` looks. Name the exact command or field, not the category.

## Failure modes

- **Envelope missing or unreadable.** Say so in one line and exit; the engine settles the
  step on the next tick. Don't guess at what to post.
- **The comment was deleted between triage and now** (`404` on the replies endpoint). Not a
  failure of the round — record it in `postedReplies` as skipped and carry on.
- **The session died after posting but before reporting.** The round re-runs. Read
  `pr.comments` first: if your reply text is already there under your own author name,
  record it as posted rather than posting it twice.
- **Hook server returns 401.** Daemon restarted mid-session; print the situation and exit.
  Do not post on a session that cannot report what it posted — a duplicate reply on a
  public PR is worse than a delayed one.
