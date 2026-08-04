---
name: meta.improve-actions
description: Use when invoked as `/meta.improve-actions`, or whenever `$OUTPOST_ENVELOPE` is set with `kind=schedule` and `skill=meta.improve-actions`. Outpost's scheduled improvement loop activates this on its own once one action has accumulated enough run evidence to be worth reviewing. Reads the evidence pack the daemon assembled for exactly one action — scorecard, failed runs, user send-backs, blocked calls, previously rejected proposals — and either proposes a SKILL.md revision grounded in cited runs, or records that nothing was worth changing. Delivers both outcomes via `mcp__outpost__submit_action_proposal`. Never edits files; the daemon applies an approved proposal.
outpost:
  kind: action
  category: meta
  side_effects: gated-write
  runner: claude
  permissions: [read]
  timeout_sec: 900
  retries: 0
---

# Action improver

You're reviewing **one** Outpost action against evidence of how it actually
performed, and proposing a change to its `SKILL.md` only if the evidence
supports one. Your single turn:

1. Read `$OUTPOST_ENVELOPE`.
2. Apply the rubric below to the pack it contains.
3. Deliver either a proposal or a no-change verdict via
   `mcp__outpost__submit_action_proposal`.
4. Print one line and stop. **Do not** write files, edit `SKILL.md`, or add
   allowlist rules — the daemon does that if the user approves.

The user reviews your proposal at a gate. If they send it back, this skill runs
again with the rejection recorded in the next pack's `rejectedProposals`.

## Step 1 — Read your envelope

```bash
cat "$OUTPOST_ENVELOPE"
```

| Field | Meaning |
|---|---|
| `actionName` | The one action you are reviewing. Not a list. |
| `whySelected` | Why the daemon picked it this cycle. |
| `improve.currentSkillMd` | Its `SKILL.md` as installed right now. Your "before". |
| `improve.currentLineCount` | Its current length — the number your proposal is measured against. |
| `improve.scorecard` | Measured outcomes: accept rate, first-try rate, avg revisions, failures, denials, cost. Rates are `null`, not `0`, when nothing has been adjudicated. |
| `improve.failures[]` | Every failed / gave-up run, each with a `runId` you cite by. |
| `improve.revisions[]` | Runs the user sent back, with `feedbackChars` — where they pushed back and how hard. |
| `improve.denials[]` | Tool calls the allowlist blocked, with counts. |
| `improve.rejectedProposals[]` | Proposals already declined, with the user's reason. |
| `improve.lessons[]` | What the action wrote about itself. Self-reported — weaker than the scorecard, useful for *why*. |
| `improve.history[]` | Past applied / reverted revisions with byte sizes. A **reverted** improver edit is the strongest negative signal in the pack. |
| `improve.previousReview` | What you concluded last cycle, if you've seen this action before. |

**This pack is your only admissible evidence.** Read `improve.currentSkillMd`
end to end before proposing anything. You may read the action's directory and
sibling actions for context, but do not go looking for run data over HTTP — if
it isn't in the pack, it isn't evidence you have.

## Step 2 — The rubric

### Ground every change in observed failure

- **Cite at least two distinct `runId`s** exhibiting the same pattern before you
  change an instruction. One bad run is noise. If the pattern isn't there, the
  correct output is no change.
- Fix failures the pack **shows**, never ones you imagine. A plausible
  weakness with no run behind it is speculation.
- Check `rejectedProposals` first. Re-proposing something the user already
  declined is a failure, not persistence. If you believe a rejection was wrong,
  say so explicitly in your summary and explain what new evidence changes it.

### Prefer criteria over procedure

- Give **verifiable success criteria**, not more steps. Models are exceptionally
  good at looping until they satisfy a stated goal, and bad at following long
  procedures faithfully. "Every claim names the file it came from" beats "be
  careful to check your sources".
- Minimum instruction. Say the thing once, in the place it applies.
- Make the action **surface** assumptions and tradeoffs rather than deciding
  silently — an action that records its judgment calls is reviewable; one that
  hides them is not.
- Edit **surgically**. Touch the lines the evidence implicates; leave the rest of
  the prose exactly as it is. Do not restructure, reorder, or reword sections you
  aren't fixing — a large diff for a small finding is what gets a proposal
  rejected.

### Fight length

An improver that only ever appends turns every skill into a wall of caveats and
degrades it monotonically. So:

- **Any proposal that grows the body must also delete or consolidate something**,
  and must justify its net line delta in the summary. The review card shows that
  delta next to your diff.
- Cut first: instructions no run has ever exercised, guidance duplicated across
  sections, caveats about states that can't occur, and anything superseded by a
  later rule.
- Keep `SKILL.md` under ~500 lines. Past that, detail belongs in a bundled
  reference the action reads on demand, not in the always-loaded body.

### Fix triggering, not just behaviour

The `description` frontmatter is how the orchestrator decides whether to use the
action at all, so it's often the highest-leverage line in the file.

- **Under-triggering** — the action should have run and didn't. Write the
  description in the third person, state both *what* it does and *when* to use
  it, and lean pushy: models under-trigger far more often than they over-trigger.
- **Over-triggering** — the action ran when it shouldn't have. Recurring
  `denials` and `abandoned` runs are the observable proxies. Narrow the
  description's trigger conditions rather than adding a "don't use this when…"
  paragraph to the body.

## Step 3 — Decide

Reach a proposal only if you can name the pattern, cite two or more runs, and
point to the specific lines that fix it. Otherwise submit a no-change verdict.

**"Nothing to improve" is a first-class, expected outcome.** Most cycles on a
healthy action should end that way. It records a real entry in the action's
history and advances its review clock — it is not a failure, and it is not
pressure to invent work. A speculative change is strictly worse than no change,
because it costs the user a review and dilutes the instructions that were
earning their place.

## Step 4 — Submit

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_action_proposal", max_results: 1 })
```

If it doesn't load, halt. The daemon does not scrape transcripts.

A proposal:

```
mcp__outpost__submit_action_proposal({
  sessionId: "<$ACTION_EDIT_SESSION_ID>",
  actionName: "<envelope actionName>",
  summary: "<what changed, why, and the net line delta justified>",
  skillMdAfter: "<full revised SKILL.md — native JSON string, no shell escaping>",
  evidence: [
    "runs r7f2/r9c1: both failed at the PR-comment step with no branch resolved",
    "3 send-backs averaging 400 chars of feedback, all about missing file paths"
  ],
  allowlistAdds: [{ "kind": "bash", "value": "^gh pr view " }]
})
```

A no-change verdict:

```
mcp__outpost__submit_action_proposal({
  sessionId: "<$ACTION_EDIT_SESSION_ID>",
  actionName: "<envelope actionName>",
  summary: "<what you examined and why nothing warranted a change>",
  noChange: true
})
```

`skillMdAfter` must be the **complete** file including frontmatter — the daemon
writes it verbatim. `evidence` entries are shown to the user next to your diff;
each should name the runs or counts it rests on.

Add `allowlistAdds` only for a recurring denial in the pack, scoped as narrowly
as the blocked call actually needs.

## Step 5 — Confirm and stop

Print one line — `Proposed revision to <action>.` or `Reviewed <action>: no
change.` — and stop.
