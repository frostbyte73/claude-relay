---
name: code.orchestrate-pr
description: Use when invoked as `/code.orchestrate-pr` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step` and `type=orchestrated` and `controller=code.orchestrate-pr`. Owns one PR-shaped step end to end — spec, plan, implement, then shepherd the PR through CI, comments, conflicts, and merge. Decides its own next move each turn and reports it via `mcp__outpost__submit_step_progress`.
outpost:
  kind: step-orchestrator
  category: code
  side_effects: none
  runner: claude
  roster:
    - code.spec
    - code.plan
    - code.implement
    - code.review-diff
    - code.triage-pr-comments
    - code.fix-pr-comment
    - code.reply-pr-comments
    - code.resolve-conflicts
    - code.fix-ci
    - code.merge-pr
  permissions: [read, push]
  timeout_sec: 900
  retries: 0
---

# Shepherd one PR from spec to merge

You own a single `orchestrated` step end to end. The daemon runs you as a loop: it wakes you,
you take **one** move, you report it, your turn ends. It parks you until something happens,
then wakes you again with what changed. There is no run-to-completion — assume you will be
resumed cold, after a compaction, a daemon restart, or hours of waiting, and that everything
you didn't write down is gone.

**Every turn ends with exactly one `mcp__outpost__submit_step_progress` call, then you stop** —
with one exception: a turn where you raise your own write draft ends with
`mcp__outpost__submit_write_draft` instead (row 5 — see
`~/.outpost/actions/SHARED-write-drafts.md`). A turn that ends without one of those two is
read as a hang and fails the step. A turn that keeps
working after it has reported is racing the move it just declared.

## 1. Read `$OUTPOST_ENVELOPE` first — every turn, before anything else

```bash
cat "$OUTPOST_ENVELOPE"
```

| Field | What it is |
|---|---|
| `jobId`, `stepId` | Identify this step on every `mcp__outpost__*` call. |
| `goal` | What this PR must accomplish. `inputs.approach` / `inputs.risks` carry the planner's framing when it had one. |
| `workspace` | `{"kind":"writable","repoCwd":…,"branch":…}` — the branch this PR lives on. Your cwd is already that worktree. |
| `phase` | The label you set last turn. One of the eight strings in §3. |
| `memo` | What you wrote last turn. Your only durable memory (§5). Empty on your first turn — and on a job migrated mid-flight. |
| `artifacts` | Named markdown blobs accumulated across turns, merged and never replaced. The ladder keys on five of them: `spec` (from `code.spec`), `implPlan` (`code.plan`), `implementation` (`code.implement`), `draftedReplies` (`code.triage-pr-comments`) and `postedReplies` (`code.reply-pr-comments`). Anything else you store is yours. |
| `delivered` | The inbox batch that woke you — why you are running right now. Absent on a plain continuation. |
| `dispatches` | Every child you have fanned out: `id`, `action`, `brief`, `status`, `output`, `failure`. |
| `pr` | The PR facts as the watcher last observed them: `prUrl`, `prState`, `ciState`, `ciChecks[]`, `reviewState`, `mergeable`, `headRefOid`, `comments[]`. |
| `gateApproved` | `true` once the user has approved a `gate` of yours. Absent until then (§3). |
| `gateFeedback` | Every note the user has attached to a gate, oldest first. |
| `roundsRemaining` | Turns left before the daemon refuses everything except `gate`, `resolve` and `fail`. |
| `boundAction`, `boundNote` | Which hat you are wearing this turn (§2). |
| `actionCatalog` | Every action you may rebind to or dispatch — `name`, `description`, `side_effects`, I/O schemas. This is your declared roster (`outpost.roster` in your own frontmatter) plus yourself, not the whole registry: an action missing here is one another controller owns. The only valid action names; never invent one. |
| `previousSteps` | Findings from earlier steps of the job. |
| `recentLessons` | Journal lines from past runs of this action. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`delivered` entries are one of: `user-message` (the user typed something — highest signal,
read it first), `dispatch-done` (a child settled; read its record in `dispatches`),
`external` (the PR watcher, with `events[]` naming which signals moved — see §4),
`gate-resolved` (`approved` + optional `feedback`), `timer` (a `resumeAt` elapsed), or
`policy-rejection` (your last move was refused; `reason` says why, and you get exactly one
corrective turn — a second rejection with no accepted move in between fails the step).

## 2. Two hats — is this turn a decision or the work?

Look at `boundAction`.

- **`boundAction === "code.orchestrate-pr"` — a decision turn.** Read the envelope, work out
  where the step stands, choose one move, report it, stop. Do not edit code, run builds, or
  do the work yourself on a decision turn; that is what the ladder's rounds are for.
- **`boundAction` is any other action — a work turn.** That action's `SKILL.md` is loaded and
  its permissions are yours for this turn only. You are that action now: do its work as it
  describes. `boundNote` is the instruction you left yourself when you asked for this round.

**Every turn ends the same way: `submit_step_progress`.** There is no round-specific submit
tool — a work turn puts what it produced into `artifacts` (`spec`, `implPlan`, `review`, …),
says what happened in `memo`, and declares the next move, exactly as a decision turn does. A
work turn that has nothing to decide hands the session back with `next: {kind:"self-round"}`
and no `action`, which resumes you under your own hat for the next decision turn.
`mcp__outpost__submit_journal` still works normally.

## 3. The phase ladder

Your six moves:

| Move | Payload | What the daemon does |
|---|---|---|
| `self-round` | `{kind:"self-round", action?, note?}` | Resumes *your* session, optionally rebound to `action`'s skill and permissions, with `note` as `boundNote`. |
| `dispatch` | `{kind:"dispatch", dispatches:[{action, brief, inputs?, workspace?, retryOf?}]}` | Spawns one fresh child session per entry and parks you until all settle. Each child sees **only its brief** — no memo, no artifacts, no envelope of yours. |
| `wait` | `{kind:"wait", wait:{reason, events?, untilAllDispatchesDone?, resumeAt?}}` | Parks the step until one of `events` fires, all dispatches settle, or `resumeAt` passes. `reason` is shown to the user. |
| `gate` | `{kind:"gate", draft, question}` | Parks the step for the user, showing `draft` as the thing being approved. |
| `resolve` | `{kind:"resolve", output}` | Step done — **the PR merged**. `output` is the summary the job keeps. Refused while `pr.prUrl` is set and `pr.prState` is not `merged` (§ Budgets). |
| `fail` | `{kind:"fail", reason}` | Step failed. Only when nothing else can move it forward. |

**Dispatched children are read-only; edits happen on your rounds.** The branch belongs to you
and your worktree is the only checkout holding it, so a child gets a detached checkout of that
same branch at its own path — the full code to read, no ability to change it. A dispatch that
asks for `workspace: {"kind":"writable"}` is rejected. Anything that touches the tree —
implementing, fixing CI, resolving conflicts, applying a review comment — is a `self-round`
bound to the action that does it, which runs in *your* worktree. Dispatch is for read-shaped
fan-out: reviews, investigations, second opinions across several files at once.

Because those rounds are sequential, a batch of review comments is a `code.fix-pr-comment`
round per group of related comments, not one per comment — put the comments verbatim, their
files and lines, and the change each needs into `boundNote`. Those rounds all sit in the same
`phase` and write no artifact, so they are exactly what the unproductive-self-round cap (below)
counts — group them rather than racing it.

**Phase vocabulary — use exactly these eight strings**, no others, no variants:
`spec`, `plan`, `implement`, `pr_open`, `pr_comments`, `conflict`, `merged`, `failed`.
Set `phase` on every submit so the UI and a cold-resumed you agree on where the step is.

The ladder, top to bottom — take the first row that matches. **Every row carries the
condition that turns it off**, because you re-walk the whole table from scratch every turn:
a row whose work is already done but which still matches is how a controller spends its
whole round budget re-running the same round. Read each row's "no longer true once" column
as part of its condition.

| # | Where the step stands | No longer true once | Move | `phase` |
|---|---|---|---|---|
| 1 | No `artifacts.spec` | the spec round writes it | `self-round` as `code.spec` | `spec` |
| 2 | `artifacts.spec` present, no `artifacts.implPlan`, `gateApproved` not `true` | you gate it and the user approves | `gate` with the spec text as `draft` | `spec` |
| 3 | `artifacts.spec` present, no `artifacts.implPlan`, `gateApproved === true` | the plan round writes `implPlan` | `self-round` as `code.plan` | `plan` |
| 4 | `artifacts.implPlan` present, no `artifacts.implementation` | the implement round writes `implementation` | `self-round` as `code.implement` | `implement` |
| 5 | `artifacts.implementation` present, no `pr.prUrl` | `pr.prUrl` appears (the watcher confirms the PR exists — whether you opened it or the user did by hand) | if the branch isn't pushed yet, `wait`; once it is, draft (or, once approved, run) opening the PR — see below | `implement` |
| 6 | `pr.prUrl` present and `pr.prState === "merged"` | — (terminal) | `resolve` with a summary and the PR URL | `merged` |
| 7 | `pr.prUrl` present and `pr.prState === "closed"` | — (terminal) | `fail` with "PR closed without merging" | `failed` |
| 8 | `pr.mergeable === "conflicting"` | the conflict round pushes a merge and the watcher clears it | `self-round` as `code.resolve-conflicts` | `conflict` |
| 9 | CI failure that has **settled** (every check in `pr.ciChecks` reported, at least one failed) | the fix round pushes and CI re-runs | `self-round` as `code.fix-ci` | `pr_open` |
| 10 | Comments in `pr.comments` that are not yours, not answered, and not covered by `artifacts.draftedReplies` | the triage round drafts them | `self-round` as `code.triage-pr-comments` | `pr_comments` |
| 11 | `artifacts.draftedReplies` holds `reply` drafts not listed in `artifacts.postedReplies` | the reply round posts them | `self-round` as `code.reply-pr-comments`, with the exact reply bodies in `note` | `pr_comments` |
| 12 | `artifacts.draftedReplies` holds `edit` recommendations your memo does not record as applied | your memo records the fix round covered them | `self-round` as `code.fix-pr-comment` | `pr_comments` |
| 13 | `pr.ciState === "success"`, `pr.reviewState === "approved"`, and your memo does **not** record a `code.merge-pr` round that came back unable to merge on these same facts | the merge round merges (it `resolve`s the step itself) | `self-round` as `code.merge-pr` | `pr_open` |
| 14 | Nothing above matches | a delivery wakes you | `wait` on `["ci","review-state","pr-state","pr-comments"]` | keep the current `phase` |

Three of these read a fact only *you* can record, so record it:

- **Row 11 → 12.** Both fire off `artifacts.draftedReplies`. Row 11 is falsified by
  `artifacts.postedReplies` (the reply round writes it); row 12 has no artifact, so your memo
  is the record — name the comments each `code.fix-pr-comment` round covered.
- **Row 13.** A merge that failed on a permanent blocker (branch protection wants a second
  approval, a required check nobody will re-run) leaves `ciState`/`reviewState` untouched, so
  the row matches again forever. If `code.merge-pr` handed back and nothing in `pr` has moved
  since, take row 14 and say in `reason` what the merge is blocked on — do not re-gate it.
- **Row 5** is the only row for "implemented, no PR yet", and it's the one row where you draft
  a write yourself instead of binding a round to another action — see the detail below.
  `code.implement` still deliberately leaves the edits uncommitted for the user to review,
  commit, and push themselves if they'd rather do it by hand; either way `pr.prUrl` appearing
  is what falsifies the row. Do **not** re-run `code.implement` to try to force it.

**A declined gate outranks the whole table — but check `source` first.** A `gate-resolved`
item with `approved: false` and no `source` field is YOUR OWN voluntary gate declined: redo
*that* work with the user's `feedback` — another `code.spec` round with the feedback in `note`
— and only then walk the ladder again, which re-gates the revised draft at row 2. Do not read
a decline as "row 2 again" and re-gate the same text.

`source: "write-draft"` on that same item is a DIFFERENT decision: the user vetoed a write
outright — the merge, a comment, a branch delete — not a spec or a plan. There is nothing to
redo with feedback; the draft is gone, and neither you nor the bound round that drafted it will
be asked to compose another for this decision. Take it as a fresh delivery on the ladder:
reconsider `pr`/`artifacts` from scratch and pick whatever row now matches — often the same row
that raised the draft, this time reasoning past the fact that the user said no, or row 14 if
nothing better applies — rather than assuming a redraft is expected.

**Rows below the one that matched still matter next turn.** The ladder is a priority order
re-evaluated from scratch on every decision turn, not a script you walk once. A conflict that
appears after CI went green sends you back up it. Rows 6-13 all presuppose `pr.prUrl`; until
it exists only rows 1-5 can match.

The happy path walks it once: 1 → 2 → 3 → 4 → 5 (draft `gh pr create`, or the user opens it by
hand) → 14 → comments and CI churn through 8-12 → 13 → the merge round resolves the step. If
you find yourself on a row you were on two turns ago with nothing new written, the row is
missing its falsifier — say so in `memo` and take row 14 rather than running it again.

### Row 5 in detail — opening the PR

`artifacts.implementation` existing does **not** mean the branch is pushed —
`code.implement` deliberately leaves its edits uncommitted for the user to review, and nothing
in the ladder commits or pushes on their behalf. Check the remote before drafting anything,
using only what this action is actually granted (`ls-remote` is **not** in the `read` group's
git allowlist and denies outright — `fetch` and `rev-parse` are):

```bash
git fetch origin
git rev-parse --verify origin/<branch>
```

- **Non-zero exit (no `origin/<branch>`):** the user hasn't pushed yet. Do not draft. There is
  no event this step can wait on for "the user pushed but hasn't opened a PR" — `pr-state` only
  fires once a PR actually exists (`discoverPr` finds nothing until then), so an event-only
  `wait` here would park the step permanently. Arm a bounded poll instead:
  `{kind:"wait", wait:{reason:"Implementation done — waiting for you to push (checking again in
  an hour)", events:["pr-state"], resumeAt:<now + 1 hour, epoch ms>}}`. Compute `resumeAt`
  yourself from the current time (`date +%s` gives seconds; multiply by 1000, add the offset) —
  there's no shell arithmetic needed since this is a plain field on the MCP call, not a Bash
  command. Re-run this check on every wake, whether it fired from the timer or from `pr-state`
  (the user may have pushed **and** opened the PR themselves, which also satisfies this row).
  If you're still re-arming this same wait after roughly six wakes (about half a day with no
  push), say so plainly in `memo` — how long it's been waiting — so the user sees it, rather
  than silently re-arming the same wait forever; if `roundsRemaining` is genuinely getting low
  by then, fall through to "Round budget nearly spent" (§ Failure modes) instead of continuing
  to poll.
- **Zero exit (`origin/<branch>` exists):** the push has landed — draft the PR.

Once the branch is confirmed pushed, draft one yourself rather than sitting in a `wait` for the
user to run `gh pr create` by hand — see `SHARED-write-drafts.md` for the draft/commit
mechanics this shares with every other write action. `mcp__outpost__submit_write_draft` is
deferred behind ToolSearch like the other `mcp__outpost__*` tools — load it the same way as
§8's tools before you call it. On this decision turn, if `writeGate` is absent (or
`writeGate.phase === "draft"`), call `mcp__outpost__submit_write_draft` instead of
`submit_step_progress` and stop:

```
mcp__outpost__submit_write_draft({
  jobId: "<jobId>", stepId: "<stepId>",
  summary: "Open a PR for <branch> against <base>",
  evidence: "<title + body you'd use, and why — the spec/implementation summary is a good source>",
  calls: [{ label: "open PR", bash: "gh pr create --title \"<title>\" --body \"<body>\" --base <base> --head <branch>" }]
})
```

Write every value literally — no `$VAR`. If `writeGate.feedback` comes back non-empty (the
user wants a different title/body — every round, oldest first), redraft addressing it. If the
user instead just pushes and opens the PR by hand while your draft sits pending, `pr.prUrl`
appears from the watcher regardless — take that as the row's falsifier and don't bother
re-drafting or worrying about the abandoned draft.

Once approved, `writeGate.phase === "commit"` — run `writeGate.approvedCalls` verbatim, then
report with `submit_step_progress` as usual (`next: {kind:"wait", wait:{reason: "PR opened —
confirming the watcher picked it up", events:["pr-state"]}}`) so a delayed watcher poll
doesn't leave you re-drafting a PR that already exists.

**External-write rounds you bind to another action.** `code.fix-ci`, `code.resolve-conflicts`,
`code.reply-pr-comments` and `code.merge-pr` each run unattended and draft their own payload
via `mcp__outpost__submit_write_draft` before doing anything — see each one's own `SKILL.md`
and `SHARED-write-drafts.md`. That is expected: the round parks itself, and the daemon runs
back exactly the calls the user approved. Do not wrap one of these rounds in a `gate` of your
own — that asks the same person for the same approval twice, and it's the bound action's job
to draft the payload, not yours. That is why the merge rung is a `code.merge-pr` round and not
a `gate` of your own: the user still approves before anything lands, and the round that they
approved is the one that can actually merge.

**The bound action's draft shows the user your `note`.** Whatever you put in `note` when you
bind a round (row 11's reply bodies, the merge strategy, a conflict-resolution instruction) is
what that action reads to compose its draft — see each action's own Step 1 for exactly which
field it reads it into. That is the whole reason row 11 puts the reply bodies verbatim into
`note` rather than summarizing them: the bound action drafts precisely that text, the user
reads it at the draft, approves once, and `code.reply-pr-comments` posts it. Two approvals for
one write is a bug, not caution. Whenever a bound round is about to draft a write, write `note`
as the exact thing that should be drafted, not as a memo to yourself.

`code.merge-pr` re-reads the PR from GitHub, and on a confirmed merge it `resolve`s the step
itself rather than handing you back a decision —
`pr.prState` can lag the real merge by up to an hour, and a controller re-deciding on those
stale facts would match this same rung again and ask the user to approve a merge that already
happened. If it could *not* merge, it hands back with the blocker in the memo and you take it
from there.

**Approval of your own `gate` is a delivered item.** A `gate-resolved` item with
`approved: true` (and any `feedback` the user attached) shows up in `delivered` on the turn
that resumes you — read it the same way you read any other delivery, and it's the primary
signal that the gate was approved. `gateApproved` also durably becomes `true` the moment the
user approves — a redundant, durable copy for a turn that reads it later without the original
delivery in hand, not the only place the approval shows up. It clears back to `undefined` on
either of two events, not just one: the moment you open your next `gate`, **or** the moment any
write-draft denial lands (a `gate-resolved` item carrying `source: "write-draft"` — see "A
declined gate outranks the whole table" above). Either one means it no longer answers a live
question, so don't read a stale `true` as still meaning "yes" once either has happened. The
memo is still your record of *which* draft that approval was for, so keep writing what you
gated on and what an approval would mean ("gated the spec; on approval, run `code.plan`"). A
**decline of your own gate** arrives the same way — a `gate-resolved` item with
`approved: false` and no `source` field: fold the `feedback` into the memo and redo the work
with it — e.g. another `code.spec` round with the feedback in `boundNote` — rather than
re-gating the same draft. A `gate-resolved` item with `source: "write-draft"` is not this one;
see above for what it means instead.

**Cold resume into a phase you never set.** Jobs migrated from the old hardcoded PR-step
machinery arrive mid-flight with a `phase` the daemon stamped, an empty `memo`, and no history
you wrote. Do not assume `phase` reflects a turn you took. When `phase` disagrees with
`artifacts` and `pr`, **the artifacts and the PR facts are ground truth** — `phase` is a
label, they are the state. Re-derive your position from the ladder against `artifacts.spec`,
`artifacts.implPlan` and `pr`, then write the memo you wish you had found.

**Budgets.** `roundsRemaining` counts down from 80 — every move you make costs one, and so
does every wake the daemon delivers you; at zero it accepts only `gate`, `resolve` or `fail`, so
leave headroom rather than discovering the wall. **`gate` stays open at zero on purpose: running
out of rounds is a reason to hand the step to the user, never a reason to call it done.**

**A `resolve` while your PR is still open is refused.** Once `pr.prUrl` is set, the daemon allows
`resolve` only when `pr.prState === "merged"` — the sole exception being the `code.merge-pr` round
itself, which re-reads GitHub and so knows about a merge the watcher has not swept yet. You own
this PR; resolving marks the step done and takes it out of the user's cockpit with work left on
it. If you are near the wall and the PR is not merged, `gate` with an honest account of where it
landed (that is what keeps it in front of the user), or `fail` with what is outstanding. Do not
reach for `resolve` because it reads better than `fail` — a rejected resolve costs you a round
and a policy strike, and a second violation with no accepted move in between fails the step
outright. Separately, at most **three**
*unproductive* `self-round`s in a row. A round counts as productive when the submit that ends
it moves `phase` or writes an `artifacts` entry whose content differs from what was already
there — a redraft under the same key counts, a byte-identical resubmit does not. Anything else
— same phase, nothing new written — charges the count. A `dispatch`, `wait`, or `gate` (yours),
or a delivery carrying a fresh *external* event (a watcher tick, a user message, a dispatch
finishing), resets it outright. **Raising your own write draft (row 5) is invisible to this
counter either way** — that turn ends via `mcp__outpost__submit_write_draft`, not
`submit_step_progress`, so it neither charges nor resets `consecutiveSelfRounds`; the count is
exactly what it was before you drafted. (Row 5's follow-up `wait` once the PR is open does
reset it, same as any other `wait`.) A delivery that only hands back your own last move — a
policy rejection, a declined gate, a declined draft — deliberately does **not** reset it
either, so you cannot clear the count by tripping a rejection between rounds.
Walking the ladder (`spec` → `plan` → `implement`) never approaches the cap; three rounds that
show nothing new do, and that is the signal to park on a `wait`, gate it, or dispatch it — not
to push a fourth.

## 4. Events wake you; facts tell you what happened

An `external` inbox item names *which signal moved*, not what it means. Always re-read `pr`
before deciding — never infer the state of the world from the event name.

The five signals are `ci`, `review-state`, `pr-state`, `pr-comments` and `head-moved`.

**Silence is not the absence of change.** The daemon wakes you when a signal reaches a value
this ladder has a row for — not every time one moves — because every wake costs you a round.
Three things deliberately happen without waking you:

- **CI going to `pending`.** Your own `code.fix-ci` push causes it, and no row reads it.
- **CI going green while review has not approved.** Row 13 is the only row that reads
  `success`, and it needs the approval too. When the approval lands, `review-state` wakes you
  and `pr.ciState` is already green — so read both, never assume the green was announced.
- **A comment posted by the account this daemon writes as.** Your own replies are not news.

So `pr` in your envelope can legitimately be *ahead* of anything you were ever told about. That
is the same discipline §4 already demands — re-derive from `pr`, never from the event name —
just with more riding on it.

**Wakes are batched.** A watcher event is held for a short quiet period so a reviewer leaving
four comments over two minutes costs one round, not four. One `external` item can therefore
stand for several changes at once, and its `events[]` is the union of them.

**`head-moved` is not for you — wait on the four.** It fires when the PR's head commit changes,
and on this step the head moves because *you* moved it: `code.fix-ci` and
`code.resolve-conflicts` both push. Naming it in a `wait` means every fix you dispatch wakes you
to be told your own push landed, at one round each. It exists for `code.orchestrate-review`,
which watches somebody else's branch and has no other way to see the author push. Row 14 waits
on `["ci","review-state","pr-state","pr-comments"]` and that is the right set. (`pr.headRefOid`
is still worth *reading* — it is how you tell whether a dispatched fix actually pushed.)

This matters most for **`mergeable`, which has no event of its own and rides on `pr-state`**.
A `pr-state` wake means the PR closed, *or* merged, *or* started conflicting. Never read
`pr-state` as "the PR closed". Disambiguate yourself:

```bash
jq -r '.pr | "prState=\(.prState) mergeable=\(.mergeable) ci=\(.ciState) review=\(.reviewState) head=\(.headRefOid)"' "$OUTPOST_ENVELOPE"
```

Expect spurious wakes in general — a `wait` on one signal can fire for a neighbouring one, and
a batch can carry several events at once. Re-derive your position from `pr` + `artifacts`
every time; if nothing you care about actually changed, `wait` again with the same spec rather
than inventing work.

The same caution applies to CI: `pr.ciState === "failure"` is only actionable once the run has
**settled** — every check in `pr.ciChecks` has reported. A failure mixed with `pending` checks
is a partial rollup; wait for the rest rather than dispatching a fix at a moving target. Read
the detail with the reads you are granted:

```bash
gh pr view --json state,mergeable,statusCheckRollup,reviewDecision
gh pr checks
```

## 5. Write `memo` every turn

The memo is replayed to you and is the only thing that survives a compaction or a cold resume.
Rewrite it in full each turn — it is a narrative, not an append-only log. Write for a version
of you that remembers nothing:

- Why the code looks the way it does — the shape the spec settled on and what was rejected.
- Which comments you have already answered, and how.
- What you are waiting for, and what would end the wait.
- What you gated on, and what an approval means (`gateApproved` says yes; only the memo says
  what to).
- Which dispatches failed, why you decided it was transient or not, and what you did about it.

Vague memos ("continuing work on the PR") cost a whole round to rebuild. Be specific.

## 6. Never write without drafting, and never take over a bound round's write

You inherit the `push` permission group yourself now (row 5 needs it to draft `gh pr create`),
so the old "your own grant is reads only" line is no longer literally true — but the rule that
matters hasn't changed: **any write, from any turn, must go through
`mcp__outpost__submit_write_draft` and stop for approval first** — see
`SHARED-write-drafts.md`. Never `git push`, `git commit`, post a PR or Linear comment, or merge
directly, on a decision turn or a work turn, without having drafted it and been resumed with
`writeGate.phase === "commit"`.

And even where you technically *could* draft something yourself, most of these writes are not
yours to draft. `code.fix-ci` and `code.resolve-conflicts` own the commit-and-push loop (they
carry the diagnosis and the "confirm before re-trying" logic that belongs with the fix, not
here); `code.reply-pr-comments` and `code.post-pr-review` own posting comments (they carry the
exact-body-verbatim discipline); `code.merge-pr` owns the merge (it carries the
already-merged idempotency check that keeps a stale resume from asking to merge twice). Bind a
round to the action that owns the write rather than drafting it yourself just because your
grant now allows it. The one write that genuinely is yours is opening the PR (row 5) — nothing
else in the catalog does that. If a rung seems to need a write no action covers and isn't row
5's job either, that is a gap to `fail` or `wait` on and journal — not to draft around.

## 7. When a dispatch fails, choose deliberately between three responses

The daemon will not let you repeat yourself by accident: a second dispatch with the same
`(action, brief)` is **rejected**, costs a turn, and burns your one corrective strike. So read
the failed dispatch's `failure` and decide which of these it is.

1. **Transient — retry the same brief.** An MCP server that wasn't authenticated, a network
   blip, an infra hiccup, a workspace that wouldn't provision. Re-dispatch the *identical*
   brief with `retryOf` set to that dispatch's `id`. This is the only way an identical
   `(action, brief)` gets through. The rules: `retryOf` must name a **failed** dispatch of the
   **same action**, and it must be the **most recent attempt** — if you already retried it
   once, name the retry, not the original. Attempts are hard-capped at 2; past that, further
   retries are refused.
2. **The child misunderstood — re-brief it.** It solved the wrong problem, edited the wrong
   file, or asked a question the brief should have answered. Do **not** retry: a verbatim
   re-run fails the same way. Write a better brief — more context, the specific file, the
   reasoning it was missing — and dispatch that. A materially different brief is a fresh
   dispatch and needs no `retryOf`.
3. **Neither — stop dispatching.** The action can't do this, or the attempt cap is spent. Do
   the work yourself in a `self-round` bound to an action that can, or `fail` the step with a
   reason that names the specific failure. Retrying past the cap is refused, and grinding the
   round budget down to zero leaves the user with nothing.

`retryOf` is a deliberate, bounded, justified act — never a reflex. If you can't say in one
sentence why the failure was environmental rather than the brief's fault, it isn't a retry.

**Write briefs that stand alone.** A child gets a fresh session whose entire context is its
brief — it cannot see your memo, artifacts, envelope, or the other children. For a
`code.review-diff` child, name the branch and what the change is trying to do; for an
investigation, put the question, the files you already suspect, and what an answer looks like,
in that one brief. Tell the child to finish by calling `mcp__outpost__submit_step_output` with
its findings — a dispatched child that ends its turn without submitting is recorded as failed,
and its **output is the whole point**, since it cannot change the tree itself.

## 8. Report — load the tools, then submit

The `mcp__outpost__*` tools are deferred behind ToolSearch. Load them before you need them:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_progress,mcp__outpost__submit_journal", max_results: 2 })
```

If `submit_step_progress` doesn't come back, say so and stop — the daemon does not scrape the
transcript for a move.

```
mcp__outpost__submit_step_progress({
  jobId: "<jobId>",
  stepId: "<stepId>",
  phase: "spec" | "plan" | "implement" | "pr_open" | "pr_comments" | "conflict" | "merged" | "failed",
  memo: "<rewritten in full this turn>",
  artifacts: { spec: "…markdown…" },        // only what this turn produced; merged, not replaced
  next: { kind: "self-round", action: "code.plan", note: "Spec approved; plan against it." }
})
```

Other `next` shapes:

```
{ kind: "self-round", action: "code.fix-pr-comment", note: "<the comment verbatim, file+line, the change to make>" }
{ kind: "self-round", action: "code.reply-pr-comments",
  note: "review:ABC — \"<the exact reply body>\"\nissue:123 — \"<the exact reply body>\"" }   // the bound round drafts this text for the user's approval
{ kind: "dispatch", dispatches: [ { action: "code.review-diff", brief: "…everything the child gets…" } ] }
{ kind: "dispatch", dispatches: [ { action: "code.review-diff", brief: "…identical…", retryOf: "<failed dispatch id>" } ] }
{ kind: "wait", wait: { reason: "PR open — watching CI, reviews, and comments",
                        events: ["ci", "review-state", "pr-state", "pr-comments"] } }
{ kind: "wait", wait: { reason: "PR opened — confirming the watcher picked it up",
                        events: ["pr-state"] } }   // after row 5's draft commits — see §3
{ kind: "gate", draft: "<the spec>", question: "Approve this spec?" }
{ kind: "resolve", output: "Merged <prUrl>: <what shipped>." }
{ kind: "fail", reason: "<specific, actionable>" }
```

Exactly one move. Then journal one lesson, if you have one worth keeping:

```
mcp__outpost__submit_journal({
  action: "code.orchestrate-pr",
  jobId: "<jobId>",
  stepId: "<stepId>",
  outcome: "resolved" | "blocked" | "failed",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or ambiguous
envelope field, anything you had to guess at or work around. Journal it even when you
recovered: it recurs identically on every future run until a human sees it, and this journal
is the only place `meta.improve-actions` looks. Name the exact command or field.

## Failure modes

- **Envelope missing or unreadable.** Say so in one line and exit; the engine settles the step
  on the next tick. Don't guess at the state from the worktree.
- **Woken with nothing new.** Re-derive from `pr` + `artifacts`. If your position is unchanged,
  `wait` again with the same spec — don't manufacture a round.
- **`policy-rejection` in `delivered`.** Read `reason`, fix the move it names, submit the
  corrected one this turn. A second rejection with no accepted move in between fails the step.
- **Round budget nearly spent.** Stop opening new fronts. `gate` the current state so the user
  can take over — it is accepted even at zero, and it is the right move whenever the PR is open
  but unmerged, which is also the only move the daemon will take from you there besides `fail`.
  `resolve` is for a merged PR and nothing else. A precise handover is worth more than a rushed
  extra round, but it has to be a handover the user can see and act on: a resolved step reads as
  finished and drops out of the cockpit.
- **PR closed without merging** (`pr.prState === "closed"`). That is a `fail` with the reason,
  not a wait — nothing further will wake you.
