---
name: code.orchestrate-review
description: Use when invoked as `/code.orchestrate-review` in a session spawned by the Outpost work orchestrator, or whenever `$OUTPOST_ENVELOPE` is set with `kind=step` and `type=orchestrated` and `controller=code.orchestrate-review`. Owns the review of somebody else's PR end to end — fan out the review lenses, synthesize one comment set, post it, watch what the author does about it, then submit a verdict. Decides its own next move each turn and reports it via `mcp__outpost__submit_step_progress`.
outpost:
  kind: step-orchestrator
  category: code
  side_effects: none
  runner: claude
  permissions: [read, pull]
  timeout_sec: 900
  retries: 0
---

# Review somebody else's PR, from first read to verdict

You own a single `orchestrated` step end to end. The daemon runs you as a loop: it wakes you,
you take **one** move, you report it, your turn ends. It parks you until something happens,
then wakes you again with what changed. There is no run-to-completion — assume you will be
resumed cold, after a compaction, a daemon restart, or days of waiting for a PR author who is
in another timezone, and that everything you didn't write down is gone.

**This is not your PR.** You did not write the branch, you cannot push to it, and the author
is a person who will read every word you post. Two things go out under your name: one review
comment set, and one verdict. Both are written by rounds the daemon force-gates, so the user
approves the exact text before it lands. Everything you do between those two moments is
reading.

**Every turn ends with exactly one `mcp__outpost__submit_step_progress` call, then you stop.**
A turn that ends without one is read as a hang and fails the step. A turn that keeps working
after it has reported is racing the move it just declared.

## 1. Read `$OUTPOST_ENVELOPE` first — every turn, before anything else

```bash
cat "$OUTPOST_ENVELOPE"
```

| Field | What it is |
|---|---|
| `jobId`, `stepId` | Identify this step on every `mcp__outpost__*` call. |
| `inputs.prUrl` | **The PR under review.** Required, and required well-formed — see §1a. |
| `inputs.until` | `"approved"` (default) resolves the step at the verdict; `"closed"` keeps it open watching the PR afterwards. |
| `inputs.goal` / `goal` | What the reviewer is being asked to establish, when it is narrower than a general review. Absent means a general review. |
| `workspace` | `{"kind":"readonly","repoCwd":…,"ref":"refs/pull/<n>/head"}` — a detached checkout of the PR's head. Your cwd is already that worktree. **It has no branch and nothing uncommitted**; see §1b. |
| `phase` | The label you or your last bound round set. One of the strings in §3. |
| `memo` | What you wrote last turn. Your only durable memory (§5). Empty on your first turn. |
| `artifacts` | Named markdown blobs accumulated across turns, merged and never replaced. The ladder keys on five: `lenses` (yours), `review` (yours), `postedReview` (from `code.post-pr-review`), `resolutions` (`code.verify-resolutions`), `verdict` (`code.submit-pr-verdict`). Anything else you store is yours. |
| `delivered` | The inbox batch that woke you — why you are running right now. Absent on a plain continuation. |
| `dispatches` | Every lens you fanned out: `id`, `action`, `brief`, `status`, `output`, `failure`. |
| `pr` | The PR facts as the watcher last observed them: `prUrl`, `prState`, `ciState`, `ciChecks[]`, `reviewState`, `mergeable`, `headRefOid`, `comments[]`. `headRefOid` is the PR's head commit — the fact rung 8 turns on (§4). |
| `gateApproved` | `true` once the user has approved a gate. The gates on this step are ones the daemon imposed, not ones you opened (§3). |
| `gateFeedback` | Every note the user has attached to a gate, oldest first. |
| `roundsRemaining` | Turns left before the daemon refuses everything except `resolve` and `fail`. |
| `boundAction`, `boundNote` | Which hat you are wearing this turn (§2). |
| `actionCatalog` | Every action you may rebind to or dispatch — `name`, `description`, `side_effects`, `human_gate`, I/O schemas. The only valid action names; never invent one. |
| `previousSteps` | Findings from earlier steps of the job. |
| `recentLessons` | Journal lines from past runs of this action. |

```bash
jq -r '.recentLessons[]? | "[\(.outcome)] \(.lesson)"' "$OUTPOST_ENVELOPE"
```

`delivered` entries are one of: `user-message` (the user typed something — highest signal,
read it first, and it **overrides the ladder**, see §3), `dispatch-done` (a lens settled; read
its record in `dispatches`), `external` (the PR watcher, with `events[]` naming which signals
moved — see §4), `gate-resolved` (`approved` + optional `feedback`), `timer` (a `resumeAt`
elapsed), or `policy-rejection` (your last move was refused; `reason` says why, and you get
exactly one corrective turn — a second rejection with no accepted move in between fails the
step).

### 1a. Turn 1: assert the PR URL, loudly

Before anything else on your **first** turn, check the URL:

```bash
jq -r '.inputs.prUrl // .pr.prUrl // empty' "$OUTPOST_ENVELOPE"
```

It must match, exactly and with nothing after the number:

```
^https://github\.com/<owner>/<repo>/pull/<n>$
```

If neither `inputs.prUrl` nor `pr.prUrl` matches that, your first and only move is **`fail`**,
with a reason that names the field:

```
{ kind: "fail", reason: "code.orchestrate-review needs inputs.prUrl as https://github.com/<owner>/<repo>/pull/<n>; got \"<what was there>\" (or nothing). Re-add the step with a well-formed prUrl." }
```

Do not try to recover it. Do not strip a `/files` suffix and carry on, do not derive it from
the worktree's remote, and do not `wait` in the hope one shows up.

**Why this is a hard stop rather than a shrug.** `PrWatcher` polls a readonly review step by
this URL alone — a detached PR-head checkout has no branch of its own, so there is nothing to
discover a PR from — and it tests the URL against an anchored regex before it will poll. A
step whose `prUrl` is missing or shaped even slightly wrong is skipped on every sweep,
silently: no `external` deliveries, no error anywhere, no wake. You would post a review and
then `wait` forever for a response the daemon will never tell you about. Failing closed is
correct; failing *quietly* is the bug this assertion exists to close. The spellings that
actually turn up and are all wrong: `…/pull/12/files`, `…/pull/12/commits/abc`,
`…/pull/12#discussion_r1`, `…/pull/12/` with a trailing slash, `github.com/o/r/pull/12`
without the scheme, and a bare `12`.

### 1b. Your worktree is a read-only PR head

`workspace.kind` is `readonly` and `ref` is the PR's head. That means:

- **There is no uncommitted diff.** `git status` is clean and `git diff` is empty. The change
  under review is `<base>...<head>`, which is why every lens you dispatch gets an explicit
  `inputs.diffRange` (§3). A lens dispatched without one reviews an empty working tree, finds
  nothing, and reports success — the worst failure this step has.
- **There is no branch.** Nothing here is yours to edit, commit or push, and no action in this
  step's ladder edits the tree at all.
- **The checkout can be behind.** It was provisioned when the step started. For anything
  current, read GitHub (`gh pr view`, `gh pr diff`), not the worktree.

## 2. Two hats — is this turn a decision or the work?

Look at `boundAction`.

- **`boundAction === "code.orchestrate-review"` — a decision turn.** Read the envelope, work
  out where the step stands, choose one move, report it, stop. Reading the PR and reasoning
  over what your lenses reported *is* the decision — do that here. Do not try to do a bound
  round's job yourself.
- **`boundAction` is any other action — a work turn.** That action's `SKILL.md` is loaded and
  its permissions are yours for this turn only. You are that action now: do its work as it
  describes. `boundNote` is the instruction you left yourself when you asked for this round.

**Every turn ends the same way: `submit_step_progress`.** There is no round-specific submit
tool — a work turn puts what it produced into `artifacts` (`postedReview`, `resolutions`,
`verdict`), says what happened in `memo`, and declares the next move, exactly as a decision
turn does. Each of the three bound rounds ends with `next: {kind:"self-round"}` and no
`action`, which resumes you under your own hat for the next decision turn.
`mcp__outpost__submit_journal` still works normally.

**The three bound rounds share this session on purpose.** `code.post-pr-review` posts comments
*you* wrote and understand; `code.verify-resolutions` judges whether a push answers what *you*
meant; `code.submit-pr-verdict` states the conclusion of the review *you* did. None of them is
a dispatch, and none of them should be turned into one — a fresh child would have to re-derive
the intent behind every comment from its text, which is exactly where "they touched that line,
close enough" comes from.

## 3. The phase ladder

Your six moves:

| Move | Payload | What the daemon does |
|---|---|---|
| `self-round` | `{kind:"self-round", action?, note?}` | Resumes *your* session, optionally rebound to `action`'s skill and permissions, with `note` as `boundNote`. |
| `dispatch` | `{kind:"dispatch", dispatches:[{action, brief, inputs?, workspace?, retryOf?}]}` | Spawns one fresh child session per entry and parks you until all settle. A child's envelope is built fresh: its brief (as `goal` and `description`), whatever you put in `inputs`, its workspace, the job's `source`/`title`/`description`/`externalRef`, and journal lessons for its own action. **Nothing of yours travels with it** — no memo, no artifacts, no `pr` facts, no sibling's output, and `previousSteps` is empty. |
| `wait` | `{kind:"wait", wait:{reason, events?, untilAllDispatchesDone?, resumeAt?}}` | Parks the step until one of `events` fires, all dispatches settle, or `resumeAt` passes. `reason` is shown to the user. |
| `gate` | `{kind:"gate", draft, question}` | Parks the step for the user. **You never need this one** — see below. |
| `resolve` | `{kind:"resolve", output}` | Step done. `output` is the summary the job keeps. |
| `fail` | `{kind:"fail", reason}` | Step failed. Only when nothing else can move it forward. |

**Never open your own `gate` in front of a write.** `code.post-pr-review` and
`code.submit-pr-verdict` both declare `side_effects: external-write`, so the daemon holds those
self-rounds at a user gate *for* you, before the round runs, and executes the move **verbatim**
on approval. That force-gate **is** the user's approval of what goes out. Adding a `gate` of
your own in front of it asks the same person for the same permission twice, and tells them the
SKILL and the daemon disagree about who is in charge. If you find yourself drafting a `gate`,
you are on the wrong move.

**The gate shows the user your `note`**, under the line "Run `<action>` on this step's
session." So `note` is not a memo to yourself — it is the artifact the user reads and approves.
For the post round it carries every comment, each with its file, line and exact body. For the
verdict round it carries the verdict, what it turns on, and every unresolved item. Whatever is
not in `note` was not approved and must not go out.

**Dispatch is for the lenses, and only the lenses.** Children are read-only by construction
(`workspace: {"kind":"writable"}` on a dispatch is rejected) and nothing in this step edits a
tree anyway, so the whole fan-out is the three review lenses in rung 3. Everything after that
is a self-round in *your* session, because it needs the review reasoning that lives here.

**Phase vocabulary.** Seven you set yourself: `triage`, `lenses`, `synthesis`,
`awaiting_response`, `watching`, `done`, `failed`. Six more are set by the bound rounds and
you carry them forward unchanged until the ladder moves you off them: `review_posted`,
`review_pending`, `resolutions_checked`, `resolutions_pending`, `verdict_submitted`,
`verdict_pending`. No others, no variants. Set `phase` on every submit where the ladder says
to, so the UI and a cold-resumed you agree on where the step is.

The ladder, top to bottom — take the first row that matches. **Every row carries the
condition that turns it off**, because you re-walk the whole table from scratch every turn:
a row whose work is already done but which still matches is how a controller spends its whole
round budget re-running the same round. Read each row's "no longer true once" column as part
of its condition.

| # | Where the step stands | No longer true once | Move | `phase` |
|---|---|---|---|---|
| 1 | Neither `inputs.prUrl` nor `pr.prUrl` matches the PR-URL shape (§1a) | — (terminal) | `fail` naming `inputs.prUrl` | `failed` |
| 2 | `pr.prState` is `"merged"` or `"closed"` | — (terminal) | `resolve` — the verdict if you have one, otherwise "PR \<state\> before the review finished" | `done` |
| 3 | No `artifacts.lenses` | this turn's submit writes it | triage the PR **on this turn**, then `dispatch` the lenses you picked, recording them in `artifacts.lenses` | `lenses` |
| 4 | A lens dispatch is `failed` and your memo does not record giving up on it | it settles `done`, or the memo records the decision | §7 — retry, re-brief, or stop | `lenses` |
| 5 | Every lens dispatch settled, no `artifacts.review` | this turn's submit writes it | synthesize **on this turn**, write `artifacts.review`, and `self-round` as `code.post-pr-review` with the whole comment set in `note` | `synthesis` |
| 6 | `artifacts.review` present, no `artifacts.postedReview`, and your memo does **not** record a post round that handed back unable to post | the post round writes `postedReview` | `self-round` as `code.post-pr-review`, whole comment set in `note` | keep |
| 7 | `artifacts.review` present, no `artifacts.postedReview`, and your memo **does** record a post round that handed back | — (terminal) | `fail` with `gh`'s reason verbatim | `failed` |
| 8 | `artifacts.postedReview` present, no `artifacts.verdict`, and `pr.headRefOid` differs from the **last verified head** (§4) | the verify round writes `resolutions` with the new head on its first line | `self-round` as `code.verify-resolutions` | keep |
| 9 | `artifacts.resolutions` has a verdict line for every comment in `postedReview`; no `artifacts.verdict`; your memo records no verdict round that handed back; **and** either nothing is `not-addressed`/`unclear`, or the user waived what is left, or `roundsRemaining <= 10` | the verdict round writes `verdict` | `self-round` as `code.submit-pr-verdict`, the verdict and every unresolved item in `note` | keep |
| 10 | No `artifacts.verdict` and your memo records a verdict round that handed back without submitting | — (terminal) | `resolve` if `artifacts.postedReview` exists (the comments reached the author; only the verdict didn't), else `fail` — with `gh`'s reason either way | `done` / `failed` |
| 11 | `artifacts.verdict` present and `inputs.until !== "closed"` | — (terminal) | `resolve` with the verdict and the PR URL | `done` |
| 12 | `artifacts.verdict` present and `inputs.until === "closed"` | `pr.prState` reaches `merged`/`closed` (row 2), or the user marks the step resolved | `wait` on `["pr-state"]` — unless `roundsRemaining <= 4`, then `resolve` with the verdict and a line saying the PR was still open | `watching` |
| 13 | Nothing above matches | a delivery wakes you | `wait` on `["head-moved","pr-comments","ci","pr-state"]` | `awaiting_response` |

Two of these rows read a fact only *you* can record, so record it (§5):

- **Rows 7 and 10's "handed back."** `code.post-pr-review` and `code.submit-pr-verdict` write
  **no** artifact when they could not do their job — deliberately, so an empty artifact can't
  falsify a rung. That leaves your memo as the only record that the round ran and failed. Name
  what `gh` said. Both failures are permanent in practice ("Can not approve your own pull
  request", a repo you have no write access to), which is why rows 7 and 10 are terminal
  rather than a retry.
- **Row 9's waiver.** "Approve it anyway, the listener leak is pre-existing" is a user message,
  and `code.submit-pr-verdict` will only approve over a `not-addressed` item if the waiver is
  *in `boundNote`*. Carry it there verbatim, and say in the memo which item it covers.

**A `user-message` outranks the whole table.** The user watching this step can steer it, and
that is the point of running a review this way rather than in one shot. "Ignore that failing
CI check, approve it" jumps you straight to row 9 with the waiver in `note`, whatever rung you
were on. "Drop the comment about the naming, it's our house style" edits `artifacts.review`
before the post round. "Stop, they're going to rewrite this anyway" is a `resolve`. Honour it
on the turn it arrives, and **write in `memo` that you did and why** — otherwise the
cold-resumed you re-walks the ladder, finds the rung the user overrode still matching, and
undoes them.

**Rows below the one that matched still matter next turn.** The ladder is a priority order
re-evaluated from scratch on every decision turn, not a script you walk once. An author who
pushes after your verdict sends you back up it. Rows 8-12 all presuppose
`artifacts.postedReview`; until it exists only rows 1-7 can match.

The happy path walks it once: 3 → (lenses run) → 5 → (gate, post) → 13 → the author pushes
(`head-moved`) → 8 → 9 → (gate, verdict) → 11. If you find yourself on a row you were on two turns ago with
nothing new written, the row is missing its falsifier — say so in `memo` and take row 13
rather than running it again.

### Rung 3 in detail — triage and the lens fan-out

Do the reads on this decision turn; they cost no round.

```bash
gh pr view "$PR_URL" --json number,title,body,author,baseRefName,headRefName,headRefOid,state,files
gh pr diff "$PR_URL" --name-only
git fetch origin <baseRefName>
```

Pick the lenses from the file list:

- `code.review-diff` — always.
- `code.security-review` — always. Somebody else's PR is exactly the case where you do not get
  to assume good faith about a dependency bump or a new endpoint.
- `code.review-ui` — only when the PR touches PWA paths (`src/pwa/**`, `*.css`, `*.html`, or
  the equivalent in whatever repo this is). Dispatching it against a backend-only diff spends
  a child session to be told there is no UI.

Then dispatch them **in one move**, in parallel:

```
{ kind: "dispatch", dispatches: [
  { action: "code.review-diff",      brief: "…", inputs: { workspace: { repoCwd: "<envelope workspace.repoCwd>", branch: "<headRefName>" }, diffRange: "origin/<baseRefName>...<headRefOid>" } },
  { action: "code.security-review",  brief: "…", inputs: { … same shape … } },
  { action: "code.review-ui",        brief: "…", inputs: { … same shape … } }
] }
```

**`inputs.diffRange` is not optional here.** Omit `workspace` on the dispatch entry — a child
inherits your readonly PR-head ref, which is what you want — but `diffRange` you must set, in
the **three-dot** form. `git diff A...B` *means* `git diff $(git merge-base A B) B`: what this
branch actually changed since it forked. That expansion is the semantics, not a command —
`git merge-base` is not granted to this action or to any lens, and running it is denied. Write
the three dots and let git find the base. Two dots would drag in everything that landed on the
base branch after the fork and the lens would flag other people's code as the PR author's.
`origin/<baseRefName>...<headRefOid>` is the spelling to use, after the `git fetch` above. If
`origin/<baseRefName>` doesn't resolve in this checkout, take the merge base from GitHub
instead — `gh api "repos/{owner}/{repo}/compare/<base>...<head>"`, field
`.merge_base_commit.sha` — and pass `<mergeBaseSha>...<headRefOid>`.

**Write briefs that stand alone, and that say what the other lenses are covering.** A child's
context is its brief plus the job's own title and description: it cannot see your memo, your
artifacts, the `pr` facts, or the other two children.
Each brief needs the PR URL and number, its title and what its description claims it does, the
author, the base branch, the file list (or its shape, if it is long), `inputs.goal` if the
review is narrower than general, and **one line naming the other lenses running in parallel and
what each owns**. Without that line all three report the same missing error handling from three
angles and you spend the synthesis round deleting duplicates. Tell each child to finish by
calling `mcp__outpost__submit_step_output` with its findings — a dispatched child that ends its
turn without submitting is recorded as failed, and its output is the whole point.

Record in `artifacts.lenses` which lenses you dispatched, why you skipped any, the `diffRange`
you passed, and the head sha it pins. That artifact is what falsifies this rung.

### Rung 5 in detail — synthesis, then the post round

The three lens outputs are in `dispatches[].output`. Reading and reconciling them is reasoning
over what the envelope already holds, so do it on this turn rather than spending a round on a
self-round to go think.

- **Dedupe across lenses.** The same defect seen by `review-diff` and `security-review` is one
  comment, phrased once, at the severity the stronger reading justifies.
- **Drop the low-value nits.** You are spending someone else's attention. A comment that would
  not change the code if the author agreed with it should not be posted. House-style opinions
  the repo's own CLAUDE.md/AGENTS.md doesn't hold go too.
- **Rank by severity**, and say which are blocking. The verdict later is mechanical from
  `resolutions`, but the author needs to know now which comments are the ones that matter.
- **Anchor each to a file and a line that are in the diff.** A comment on a line the PR did
  not touch is rejected by GitHub and degraded into the review body (see
  `code.post-pr-review` Step 5) — usable, but weaker. Check against the diff you already read.

Write the whole set into `artifacts.review`, then move to the post round in the same submit,
with every comment in `note`: file, line, and the exact body, plus the summary line if you
want one. The user reads `note` at the force-gate and approves that text. Nothing you leave
out of `note` gets posted.

### Rungs 8, 9, 13 in detail — the response loop and its budget

Row 13 parks you on `["head-moved","pr-comments","ci","pr-state"]`. `head-moved` is the one
that matters: the watcher fires it when the PR's head commit changes, which is exactly "the
author pushed." A silent fixup on a repo with no CI checks, a force-push, an amend — all of
them move the head and all of them wake you, with no timer and no polling of your own.

**Do not arm a `resumeAt` on this row.** A wait on `head-moved` ends on its own when the thing
you are waiting for happens, so a timer adds nothing but cost: every timer wake that finds an
unchanged head burns two rounds (the delivery, plus the `wait` you re-arm) out of eighty. An
indefinite wait costs zero until something real happens. If the author never pushes, the step
should sit there — that is the correct outcome, and the user's "Mark resolved" is the way out
of it, the same as rung 12's vigil.

When a delivery arrives, compare `pr.headRefOid` against the **last verified head** (§4) rather
than trusting the event name. A batch can carry several events, a `wait` on one signal can fire
for a neighbour, and `head-moved` on its own does not tell you how far the head moved.

**A reply is not a push.** An author writing "good catch, fixed" moves `pr.comments` but not
the head, and row 8 correctly does not fire: `code.verify-resolutions` judges the diff, never
the reply, so there is nothing new for it to judge. Say so in the memo and wait again rather
than spending a verify round to re-derive the same verdicts.

**What one cycle costs.** A wait move (1) + the delivery that wakes you (1) + the self-round to
`code.verify-resolutions` (1) + that round's hand-back (1) = **four rounds per cycle** out of
`MAX_ROUNDS = 80`. Fixed overhead is eight: the fan-out, the delivery that ends it, the
synthesis-and-post move, the post round's hand-back, the first wait, then the verdict move,
its hand-back, and the resolve. (The two force-gates are free — an approved gate runs its
deferred move without charging a round.) So the loop has room for about eighteen rounds of
push-and-recheck, which is more than any real review needs, and you should never be near the
wall on an honest one. Every one of those rounds is spent on a real push, because nothing but
a real change wakes you — the other half of why rung 13 arms no timer.

**If you are near it anyway, submit the verdict you have.** Row 9's `roundsRemaining <= 10`
clause exists for exactly this: at ten rounds left you stop waiting for the author, take the
verdict round, and list every still-`not-addressed` and `unclear` item in `note` so the verdict
body carries them as the reasons for REQUEST_CHANGES. Ten leaves room for the verdict round
(one), its hand-back (one), the `resolve` (one), and slack for a stray delivery or one
corrective turn. **Do not `fail` the step at the wall** — a review that found real problems and
then evaporated because it ran out of turns is worse than a REQUEST_CHANGES that says "these
three are still open."

### Rung 12 in detail — the `until: "closed"` vigil

With `inputs.until === "closed"` the step stays alive after the verdict as the live handle on
the PR: it is `wait`ing on `pr-state` and will resolve when the PR merges or closes (row 2).
That is a deliberately open-ended vigil, and **the user's "Mark resolved" is the intended way
out of it** — not a timeout you invent, and not a `resumeAt` you arm to give yourself an
excuse. The one bound: at `roundsRemaining <= 4` resolve with the verdict and a line saying the
PR was still open, because a step that runs its budget to zero and then can only `fail` hands
the user a red step for a review that actually went fine.

**Budgets.** `roundsRemaining` counts down from 80 — every move you make costs one, and so
does every wake the daemon delivers you; at zero it accepts only `resolve` or `fail`, so leave
headroom rather than discovering the wall. Separately, at most **three** *unproductive*
`self-round`s in a row. A round counts as productive when the submit that ends it moves `phase`
or writes an `artifacts` entry whose content differs from what was already there. A **gate**
resets the count outright — including one the daemon imposed on you — and so does a delivery
that wakes you from a `wait` or a fan-out. A *corrective* delivery does not: a
`policy-rejection` or a declined gate deliberately leaves the counter where it was, so a
controller can't dodge the cap by tripping a rejection between rounds. Walking this ladder
never comes close: the counter tops out at two, on the worst chain there is (a wake, the
verify-resolutions proposal, then a verify round that found nothing new to say), and the next
move from there is always a `wait` or a force-gated round, both of which zero it. Three rounds
in a row that show nothing new is the signal to park on a `wait` — not to push a fourth.

## 4. Events wake you; facts tell you what happened

An `external` inbox item names *which signal moved*, not what it means. Always re-read `pr`
before deciding — never infer the state of the world from the event name.

```bash
jq -r '.pr | "prState=\(.prState) ci=\(.ciState) review=\(.reviewState) head=\(.headRefOid) comments=\(.comments|length)"' "$OUTPOST_ENVELOPE"
```

Expect spurious wakes — a `wait` on one signal can fire for a neighbouring one, and a batch can
carry several events at once. Re-derive your position from `pr` + `artifacts` every time; if
nothing you care about actually changed, `wait` again on the same events rather than inventing
work.

The five signals you can wait on are `head-moved`, `ci`, `review-state`, `pr-state` and
`pr-comments`.

**Rung 8 is a comparison between two shas, and both are in the envelope.**

- **The current head** is `pr.headRefOid` — the watcher reads it on every poll and pushes a
  `head-moved` event when it changes. You do not need to run `gh pr view` to learn it, and you
  should not: the fact and the event are derived from the same poll, so they always agree with
  each other, while a read of your own can disagree with the sha the event was about.
- **The last verified head** is the sha on `artifacts.resolutions`' first line
  (`verified against <sha>`) if a verify round has run, otherwise the commit on
  `artifacts.postedReview`'s first line (`review: <id> (commit <sha>)`). Artifacts are **merged
  and never replaced**, so both survive a cold resume, a compaction, and a bound round's submit
  — unlike `memo`, which is overwritten wholesale every turn. Read the sha out of the artifact;
  do not carry it in `memo` and do not trust a copy there over the artifact.

Rung 8 fires when those two differ. `pr.ciState` flipping to `pending` with an empty `ciChecks`
is a useful corroboration — the watcher clears a stale rollup when the head moves — but
`headRefOid` is the fact.

CI on somebody else's PR is context, not your problem to fix: nothing in this step's ladder can
push, and `code.fix-ci` belongs to `code.orchestrate-pr`, not here. A red check is something
the verdict mentions and the author fixes.

## 5. Write `memo` every turn

The memo is replayed to you, and along with `artifacts` it is all that survives a compaction or
a cold resume. Rewrite it in full each turn — it is a narrative, not an append-only log, and the daemon
**replaces** it with each submit rather than merging. That includes the submits your three bound
rounds make: they are told to carry your narrative forward, but the mechanism is them rewriting
it, not the daemon preserving it. Write for a version of you that remembers nothing.

Because it is replaced rather than merged, the memo is the wrong home for anything a rung
*keys on* — put that in an artifact, which is merged. The head shas live on `postedReview`'s
and `resolutions`' first lines for exactly that reason (§4). This step's memo has four jobs no
artifact does:

- **What the review actually concluded** — the shape of the change, what you decided was wrong
  with it and why, and what you looked at and deliberately did not comment on. This is what
  makes `code.verify-resolutions` able to tell "they fixed it" from "they touched that line."
- **Whether a bound round handed back, and what `gh` said.** Rows 7 and 10 have no artifact to
  read; this is the record.
- **Any user message you honoured, and what it overrode.** Otherwise the next decision turn
  re-walks the ladder and undoes them.
- **What you are waiting for, and what would end the wait.**

Vague memos ("waiting on the PR author") cost a whole round to rebuild, and on this step they
cost the review's reasoning, which nothing else holds. Be specific.

## 6. Never write from a controller turn

Do not post a comment, submit a review, merge, close, push, or commit. Not from a decision
turn, and not "just this once" from a work turn whose bound action doesn't do it. This is
somebody else's repository. Everything your own grant reaches is a read — the worktree, the
envelope, and `gh pr view` / `gh pr diff` / `gh pr checks` / `gh api` in its GET form. The two
writes this step makes belong to `code.post-pr-review` and `code.submit-pr-verdict`, which carry
the permissions for them and which the daemon gates before they run.

The one thing that *is* writable is this step's own worktree: paths under it auto-allow via
session scope, so an `Edit`/`Write` there succeeds rather than denying. Don't read that as
permission to do anything. It is a throwaway detached PR-head checkout with no branch,
`git worktree remove --force`d the moment the step settles — nothing you leave in it reaches
the PR, reaches the author, or is still there next round. Editing somebody else's code in it is
pure noise that a later `git diff` will then mislead you with.

In particular: **do not "just add a note" on the PR** between the review and the verdict. There
is no third write in this step's catalog, and there is no gate that would have shown it to the
user. A write attempt from here is denied, costs you a turn, and is worth journalling. If a
rung seems to need a write no action covers, that is a gap to `wait` on or `fail` and journal —
not to work around.

## 7. When a dispatch fails, choose deliberately between three responses

The daemon will not let you repeat yourself by accident: a second dispatch with the same
`(action, brief)` is **rejected**, costs a turn, and burns your one corrective strike. So read
the failed lens's `failure` and decide which of these it is.

1. **Transient — retry the same brief.** A network blip, an infra hiccup, a workspace that
   wouldn't provision. Re-dispatch the *identical* brief with `retryOf` set to that dispatch's
   `id`. This is the only way an identical `(action, brief)` gets through. The rules: `retryOf`
   must name a **failed** dispatch of the **same action**, and it must be the **most recent
   attempt** — if you already retried it once, name the retry, not the original. Attempts are
   hard-capped at 2; past that, further retries are refused.
2. **The child misunderstood — re-brief it.** It reviewed the wrong range, or reported "no
   changes found" (which on this step almost always means the `diffRange` was wrong or
   missing — check it before blaming the child). Do **not** retry: a verbatim re-run fails the
   same way. Write a better brief and dispatch that; a materially different brief needs no
   `retryOf`.
3. **Neither — go on with the lenses you have.** Two lenses that reported are a review. Record
   in `artifacts.lenses` which one you gave up on and what it would have covered, say so in
   the review's summary line so the author knows the security pass didn't run, and take rung 5.
   A review that never gets posted because one lens wouldn't start is worth less than a review
   with a stated gap.

`retryOf` is a deliberate, bounded, justified act — never a reflex. If you can't say in one
sentence why the failure was environmental rather than the brief's fault, it isn't a retry.

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
  phase: "triage" | "lenses" | "synthesis" | "awaiting_response" | "watching" | "done" | "failed"
       | "review_posted" | "review_pending" | "resolutions_checked" | "resolutions_pending"
       | "verdict_submitted" | "verdict_pending",
  memo: "<rewritten in full this turn>",
  artifacts: { lenses: "…markdown…" },      // only what this turn produced; merged, not replaced
  next: { kind: "dispatch", dispatches: [ … ] }
})
```

Other `next` shapes:

```
{ kind: "dispatch", dispatches: [
    { action: "code.review-diff", brief: "…everything the child gets…",
      inputs: { workspace: { repoCwd: "/Users/x/repo", branch: "feature/y" }, diffRange: "origin/main...def4567" } } ] }
{ kind: "dispatch", dispatches: [ { action: "code.review-ui", brief: "…identical…", retryOf: "<failed dispatch id>" } ] }
{ kind: "self-round", action: "code.post-pr-review",
  note: "src/work/orchestrator.ts:412 — \"<the exact comment body>\"\nsrc/pwa/app.js:88 — \"<the exact comment body>\"" }   // the user reads this at the forced gate
{ kind: "self-round", action: "code.verify-resolutions",
  note: "Head moved abc1234 → def4567 (3 commits). Re-check all 5 comments." }
{ kind: "self-round", action: "code.submit-pr-verdict",
  note: "REQUEST_CHANGES — 2 of 5 unaddressed: src/pwa/app.js:88 (listener still never removed), src/git/git-ops.ts:210 (unclear, ask). User waived src/work/orchestrator.ts:412 — says the re-entrancy is pre-existing." }
{ kind: "wait", wait: { reason: "Review posted — watching for the author's push",
                        events: ["head-moved", "pr-comments", "ci", "pr-state"] } }   // no timer: head-moved is the push
{ kind: "wait", wait: { reason: "Verdict submitted — holding the step open until the PR merges or closes",
                        events: ["pr-state"] } }
{ kind: "resolve", output: "REQUEST_CHANGES on <prUrl>: 2 of 5 comments unaddressed." }
{ kind: "fail", reason: "<specific, actionable>" }
```

Exactly one move. Then journal one lesson, if you have one worth keeping:

```
mcp__outpost__submit_journal({
  action: "code.orchestrate-review",
  jobId: "<jobId>",
  stepId: "<stepId>",
  outcome: "resolved" | "blocked" | "failed",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or ambiguous
envelope field, anything you had to guess at or work around. Journal it even when you
recovered: it recurs identically on every future run until a human sees it, and this journal is
the only place `meta.improve-actions` looks. Name the exact command or field.

## Failure modes

- **`inputs.prUrl` missing or malformed.** Row 1: `fail` on turn 1, naming the field. See §1a
  for why this is not something to work around.
- **Envelope missing or unreadable.** Say so in one line and exit; the engine settles the step
  on the next tick. Don't guess at the state from the worktree.
- **A lens reports "no changes to review."** The `diffRange` was wrong or never passed. Do not
  accept it as a clean bill of health — that is the failure this whole step is shaped to avoid.
  Re-derive the range (§ rung 3) and re-brief the lens.
- **Woken with nothing new.** Re-derive from `pr.headRefOid` + `artifacts`. If your position is
  unchanged, `wait` again on the same events — don't manufacture a round, and don't reach for a
  `resumeAt` to feel like you did something.
- **The author force-pushed.** The commit `postedReview` anchored to is gone, your line comments
  may be orphaned on GitHub, and `compare` against it fails. `code.verify-resolutions` handles
  this by falling back to the whole PR diff, and records the new head on `resolutions`' first
  line — which is all rung 8 needs. Let it.
- **`policy-rejection` in `delivered`.** Read `reason`, fix the move it names, submit the
  corrected one this turn. A second rejection with no accepted move in between fails the step.
- **A force-gate is declined.** The move is dropped and you are resumed with the user's
  `feedback`. Redo the work with it — a revised comment set in `artifacts.review`, then the post
  round again with the new text in `note` — rather than re-proposing the same move.
- **The PR closes or merges mid-review.** Row 2. `resolve` with what you have; the review is
  moot and there is nothing to fail about.
- **`gh pr review` refuses to approve your own PR.** Permanent, not transient — the account
  `gh` is authenticated as authored the PR. The verdict round hands back with that reason;
  take row 10 and `resolve`, since the comments did reach the author.
- **Round budget nearly spent.** Rows 9 and 12 handle it. Submit the verdict you have; never
  let the step hit the wall with an unposted conclusion.
