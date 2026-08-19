# Outpost

Background daemon that exposes Claude Code over HTTPS+WS on a Tailscale tailnet, with a PWA client. See `README.md` for the user-facing install/usage; this file is the orientation for Claude working inside the repo.

## Concepts

Three primitives. Everything else is implementation detail.

- **action** — atomic unit of work. One `SKILL.md` + `input.schema.json` + `output.schema.json` (+ an optional colocated `allowlist.json`), under `actions/<category>/<name>/`. Categories: `read`, `write`, `code`, `meta`.
- **job** — a running unit of work. Owns the editable plan + history. Lifecycle: `planning → plan_pending_review → executing → done`, plus terminal `failed` / `abandoned`. Steps in `executing` jobs are mutable via the plan editor (insert, skip, reorder).
- **step** — one row of a job's plan. Two shapes (`StepKind`, `src/work/work-types.ts`), and picking between them is the main modelling decision a plan makes:
  - **`action`** — spawn a session for one named action, take its output, settle. Everything that doesn't need to decide anything. (`meta.wait` is the exception that spawns nothing: a builtin runner that just parks the step in `waiting` until the user resumes or `resumeAt` elapses.) Terminal states include `declined` — the user denied this step's write draft, which is *not* a failure: the orchestrator's step-review gets the reason and re-plans around it.
  - **`orchestrated`** — a **controller** action owns the step end to end, deciding its own next move each turn. This is what `code.orchestrate-pr` / `code.orchestrate-review` are.

"Agent" and "skill" remain Claude Code primitives; they are not Outpost-level terms.

### The controller loop

An orchestrated step wakes, reads its envelope, and reports exactly one `NextMove` (`work-types.ts`) via `mcp__outpost__submit_step_progress`:

| move | meaning |
|---|---|
| `self-round` | keep going myself; optional `action` temporarily rebinds the session to a sub-action (`boundAction`) |
| `dispatch` | fan out to child action sessions (`Dispatch[]`); an identical `(action, brief)` needs an explicit `retryOf` |
| `wait` | park on `WaitSpec` — watched events (`pr-comments`, `ci`, `review-state`, `pr-state`, `head-moved`), all dispatches done, and/or `resumeAt` |
| `gate` | ask the user a question and hold (voluntary; distinct from the write-draft gate) |
| `resolve` / `fail` | settle the step |

What wakes it lands in `step.inbox` (`user-message`, `dispatch-done`, `external` from the PR watcher, `gate-resolved`, `timer`, `policy-rejection`); `lastDelivered` persists the batch so a cold resume can still show what woke it. The loop is bounded by `MAX_ROUNDS = 80` plus finer guards in `src/steps/orchestrated-policy.ts` — an unproductive-self-round cap and a two-strikes rule on policy rejections. Runtime lives in `src/work/orchestrated-runner.ts`; PR facts the controller reads (`step.pr`) are maintained by `src/integrations/pr-watcher.ts`, not by the controller itself.

### Orchestrator, schedules, run ledger

A job's **orchestrator** is just an action that emits the plan — `meta.orchestrate` (the job's `orchestratorAction`; the old `meta.plan-job` name survives only as a legacy id in `work-queue.ts` and a journal migration in `journal-store.ts`). The action catalog goes into its envelope so it can compose actions into a plan; no separate "playbook" primitive is needed.

**The catalog is scoped to its reader** (`buildActionCatalog` + `CatalogScope`, `src/work/envelope.ts`). It used to ship every action to everyone, which put a controller's internal rounds in front of the orchestrator as if they were plannable steps, and put each controller's roster in front of the other. Two slices now, and the scope argument is required so a new call site has to say which it is:

- **`plannable`** — what `meta.orchestrate` may emit as a job step. An action opts out with `outpost.plannable: false`, which marks it as reached some other way: a controller round (`code.implement`, `code.fix-ci`, …), a UI button (`meta.build-action`), a schedule (`meta.improve-actions`). The default is `true`, so a newly built action is visible to the planner without knowing the field exists — the failure mode of forgetting it is a visible extra entry, not a silently unplannable action.
- **`controller`** — what a step-orchestrator may rebind to or dispatch: its declared `outpost.roster` plus itself. An undeclared roster falls back to the whole catalog, because showing a controller *less* than it needs strands the step with no way to name what it wanted, while showing too much only costs tokens. `load()` rejects a roster naming an unknown action — that would be a rebind target the controller can never reach, failing mid-step after the work leading up to it.

Concretely: 27 entries / ~24k tokens unfiltered, versus 11 / ~4.7k for the orchestrator and 11 and 7 for the two controllers. `daemon.ts`'s separate catalog for the schedule builder stays unscoped on purpose — a schedule legitimately runs actions no job plan may emit. Pinned by `action-catalog-scope.test.ts`.

**Schedules** (`src/schedules/`, "routines" in the UI) fire work without a user asking. A `Trigger` is `cron` / `once` / `event` / `token-opportunistic` (fired by spare 5h/7d token headroom rather than a clock — see `headroom.ts` + `token-scheduler.ts`), `Guard[]` can veto a firing, and a `What` runs one of four things: a catalog `skill`, a free-text `prompt`, a `script` (no Claude session at all), or a `native` in-daemon handler (how the PR watchers are wired).

Every action round is recorded: `action-run-ledger.ts` observes the job queue and writes one `ActionRunRecord` per round, with an outcome (`accepted`/`revised`/`denied`/`merged`/`failed`/…), cost, and denial count. That feeds `scorecard.ts` (the Library's skill detail pane) and `improvement-pack.ts`, which picks the single action most worth improving and assembles its evidence for `meta.improve-actions`. This is why the journal-blocker gotcha below matters — those entries are the qualitative half of that evidence.

### Permission groups

Each action declares its allowlist by inheriting named groups defined in `config/permission-groups.json`:

- **`core`** — implicit for every `runner: claude` action. Envelope-I/O baseline: `cat`, `jq`, the `mcp__outpost__*` submit tools (how a session reports results back to the daemon), and `ToolSearch`. Its two bash rules are bare verb anchors (`^cat `, `^jq `) — *which file* they may open is decided structurally by `readArgsAllowed` (`allowlist.ts`), not spelled into the pattern. A `^cat ` rule is otherwise every file on the machine, and `^jq ` is the same reach in a second spelling, so narrowing one regex and not the other would be theatre. It grants no network access: an action that POSTs back to the daemon carries its own anchored `curl` rule in its `allowlist.json`.
- **`read`** — local file reads + git-read-only (Read/Glob/Grep/LS, `ls`/`rg`/`grep`/`find`, `git status|log|diff|show|blame|branch|fetch|rev-parse|ls-files|grep|…`).
- **`pull`** — network **reads only** (WebFetch/WebSearch, MCP `get_/list_/search_` patterns for Linear/Datadog/GitHub/Notion/Slack/incident-io/Grafana, `gh pr view`/`gh pr checks`/`gh issue view`/…, plus `kubectl get`/`describe`/`logs`/`top`/`version`/`api-resources`/`api-versions`/`config view` and Notion's `query-data-sources`). Its `curl` and `gh api` rules are anchored whitelists: `curl` takes `-s/-S/-f/-L` (and their clusters), the `--silent/--fail/--show-error/--location/--compressed` spellings, `--max-time`/`--connect-timeout`/`-H` with a value, and an `http(s)://` or `$VAR`-rooted URL — no `-X`, `-d`, `-o`, `-O`, `-T`, `-F`, `-K`, `--next`. `gh api` takes the endpoint plus `--paginate`/`--slurp`/`--cache`/`--hostname`/`-H`/`--jq`/`--template` and `--method GET` only — no `-f`/`-F`/`--input` and no other method. A genuine write belongs in `push`, never in the action's own `allowlist.json`: `resolvePermissions` (`src/actions/registry.ts`) merges colocated `allowlist.json` extras into the action's plain allowlist but **never** into its `gated` set (see the `push` bullet below) — this exact mistake left 7 of 9 external-write actions ungated until it was caught. It's now refused rather than silent: `assertNotWriteShaped` (`src/permissions/write-shape.ts`) runs on every colocated `allowlist.json` at registry load, so a write-shaped extra fails the action's load instead of running unpinned. Keep `allowlist.json` for grants narrower than a whole group that aren't writes. (It's one of two doors into that trap — see "A gated write needs an approved pin" in Gotchas for the other.)
- **`edit`** — local writes + test runners (Edit/Write/MultiEdit path-scoped to `/tmp/`, mage/npm/yarn/pnpm/go/pytest/cargo, file ops `mkdir`/`mv`/`cp`/`rm`). Local git is an anchored whitelist, not a verb prefix: `git rebase <ref>` (bare ref only — no `--exec`/`-x`, no other flag reachable), `git checkout -- <path>`, `git merge <ref>` / `git merge --abort`, `git add -A` / `git add <path>` — no `-C <path>` prefix (a destructive verb against a repo other than the session's own is not reachable at all), and no `stash`/`reset`/`restore`/`cherry-pick`/`revert`/`clean`/`switch`/`apply`/`mv`/`rm` — none evidenced by any `edit`-inheriting `SKILL.md` (see `permission-group-edit-ceiling.test.ts`). Edits inside the session's own worktree auto-allow via session scope — see `allows()` in `src/permissions/allowlist.ts`.
- **`push`** — external writes, and **gated**: `push` is one of `GATED_GROUPS` (`src/actions/registry.ts`), so a call matching it is allowed only when it's also pinned by a write draft the user approved for that session (see the Gotchas entry below). Granting the group is cheap — the gate, not the membership, is the control.

  Its rules are **verb anchors** (`^gh pr (create|edit|merge|review|comment|close|ready)(\s|$)`, 8 rules / 323 chars), not flag enumerations. They used to be nineteen anchored whitelists totalling 4457 characters, the longest 388, each naming every flag its verb could take — because a prefix rule grants everything after it and a regex denylist loses to spelling. That was doing a job the gate already does better: every call here stops for a pin, and the card shows the exact command text, so enumerating `--repo` or `--admin` in a rule only decided whether the user saw a proposal or the model saw a denial to work around. It also made the group unreadable on the Permissions page it is meant to be edited from.

  **A push rule must match writes ONLY.** `gatedMatch` decides "does this need a pin?" against these rules, so a rule matching a read makes that read impossible without a draft. That's why `gh api` is pinned to the method-bearing form and `git tag` excludes `-l`/`--list` — `^gh api(\s|$)` and `^git tag(\s|$)` each demanded an approval before an action could read. Pinned by `permission-group-push.test.ts`.

  Two bars are enforced **in code** instead of being restated per rule (a new rule cannot forget them):
  - `fileFlagsAllowed` (`allowlist.ts`) confines `--input`/`--body-file`/`--notes-file`, their short form `-F`, and `-f key=@path` to `/tmp`. This one is *not* redundant with the gate: the card renders a path, not the file behind it, so `--body-file ~/.ssh/id_rsa` reads as an ordinary approval and posts a private key. The predicate is deliberately the same `isValidTmpFilePath` that gates a draft's inline `files` map — so a call may only reference a file whose contents the card can display.
  - `dangerous-writes.ts` sorts every other risk into **three tiers**, split by what the user can *do* about it — not by how bad the operation sounds:
    - **`refuse`** — a correct alternative exists, or the approver structurally cannot evaluate the call. Confirming harder fixes neither, so `allows()` says no and no pin authorises it. Currently `--delete-branch` (a *liveness* bug, not a danger — gh also deletes the local branch, git refuses while the worktree holds it, the step strands at its gate, and `git push <remote> --delete` does the job correctly) and a payload built by command substitution (same invisibility problem as the file flag; quote-aware, so a markdown code span in a single-quoted body still passes).
    - **`confirm`** — rare but real, and the user *can* judge it from the command text: a force-push (any spelling, including clustered `-fu`), `--mirror`, `gh pr merge --admin`. `allows()` deliberately does **not** refuse these — refusing there would make the confirmed case unreachable. Instead `acceptDraft` requires a per-finding acknowledgement (`PinnedCall.ack`, a decision-only wire field gated behind `allowSkip` exactly like `skip`), recomputed via `confirmationsRequired` from the **submitted** command, so a force flag typed into the textarea after the draft was raised still trips it. The ack governs whether a pin is created and is never persisted onto one.
    - **`warn`** — visible in the text, ordinary judgment: merging, deleting a ref, a foreign `--repo`/`--hostname`, a raw API write, a URL remote, pushing to a default branch, a quoted `$VAR` operand.

  Findings are attached to the `PinnedCall` at parse time and rendered by `write-draft-card.js` above the payload; only `confirm` carries an affordance (a checkbox), because it is the only tier where the user has something to decide that the server will actually check. MCP writes remain an explicit tool list, not a `create_|update_` prefix.

  Known trade: `push` is now coarser across its nine inheritors. It grants the method-bearing `gh api` as one rule instead of two endpoint-pinned ones, so an action taking `push` for its Linear MCP writes can also *propose* a GitHub API write (gated and warned, so nothing runs unapproved). Closing that properly means splitting `push` per destination, not re-enumerating endpoints.

Group descriptions live in `config/permission-groups.json` itself now (no separate lookup table). Groups are editable at runtime through `PUT /api/permission-groups/:name` (`src/routes/meta.ts`), which re-lints the whole group with `validateGroupUpdate` — the same three classifiers `assertNotWriteShaped` runs, minus the gated-group carve-out — reloads the registry against the edit in memory *before* writing `config/permission-groups.json` to disk (a rejected edit must never reach disk, or it silently takes effect at the next daemon restart with no audit row), and only then appends one row to the revision log at `~/.outpost/permission-group-revisions.jsonl`. `GET /api/permission-groups/:name/revisions` lists that history; `POST /api/permission-groups/:name/revert/:revisionId` re-applies an old `after` snapshot through the same `validateGroupUpdate` + reload-then-write path — it re-validates rather than trusting the snapshot, so a revision recorded before a rule tightened can't reinstate a grant the current lint would now refuse.

An action's frontmatter declares which groups it inherits:

```yaml
outpost:
  runner: claude
  permissions: [read, pull]  # core is implicit; this gets core + read + pull
```

Action-specific extras (narrower than a whole group) go in the colocated `allowlist.json`. The registry resolves `final = core (if claude) ∪ each group ∪ extras` and feeds that to the `Allowlist` checker — and for an action-bound call, that resolved set (plus session scope) is *all* it may do: `scopesFor` (`src/permissions/allowlist.ts`) never falls back to global or project scope the way an unbound interactive call does, so a declared `permissions:` list is the only thing granting an action anything.

`config/permission-groups.json` is gitignored per checkout (see "Testing changes from a git worktree"), but its content is not hand-maintained forever: on each boot, `permission-groups-loader.ts` merges the tracked `config/permission-groups.default.json` back in, using `config/permission-groups.seeded.json` (a snapshot of the default the live file was last reconciled against) to tell a local addition apart from a local removal — `live − seeded` is a rule the user hot-added, `seeded − live` is a default-derived rule the user deleted via the group editor. Both survive the merge: an addition is re-appended, a removal stays removed even if the unmodified default still carries it (a later default that replaces the removed rule with a differently-worded tightened one still lands — that's a different string, not a reinstatement of what was removed). Local additions are the only half of this linted — the tracked default is reviewed repo content and is trusted as-is — so a write-shaped rule hand-added to a non-gated group is dropped with a `console.warn` rather than surviving into the merged file. The group **description** rides the same live-vs-seeded comparison as the four rule arrays: it's editable through the group editor, so reconciling only the arrays (as the merge first did) made it default-owned and silently reverted every description edit at the next boot, with the revision log still claiming the edit had applied. A description that differs from the seeded snapshot is a local override and wins over the default's — prose grants nothing, so preferring the user's is free.

**What the lint actually covers, per rule kind** (`src/permissions/write-shape.ts` — `lintPermissionRule` is the shared entry point every rule-entry door runs). It is a bound, not a proof, and the four kinds are deliberately uneven:

- **`bash`** — a probe corpus: compile the candidate regex and run real dangerous command strings through it. No length or backtracking bound, and that is measured rather than lazy: any degree bound tried refuses 33 of the 76 shipped patterns, which answer in 0.32ms because their repeated groups pin each iteration to a mandatory literal.
- **`mcp`** — the same corpus, derived from `MCP_WRITE_TOOLS` so a tool added there is covered automatically, plus the backtracking bound. The corpus is an enumerated list, so an unenumerated server's write tool passes.
- **`path`** — a different question from the other kinds: not *"does this pattern span a write"* but *"does this pattern's matched set escape the allowed roots"*. A `<Tool>:<regex>` rule for a path-**write** tool must be `^`-anchored, absolute, end its literal prefix at a `/` under a scratch root, and carry nothing past that prefix which broadens it. An unknown or non-path-scoped tool name is refused structurally — it could only ever be a dead rule that answers 200. Read-tool patterns are not write-shaped and still pass.
- **`tool`** — a whole-tool grant of X is the widest possible grant of X, so it must be at least as hard to install as the narrowest rule naming X. `Bash`, the path-write tools, and every `MCP_WRITE_TOOLS` name are refused; `alwaysAllow` is otherwise open by construction, since every MCP server a user connects contributes names this repo cannot enumerate.

`path` and `mcp` additionally carry a **backtracking bound**: `backtrackingDegree` parses the pattern and scores *choice points* — an alternation whose branches can match the same text multiplies along the concatenation rather than taking a max over branches, so `(a|a)+` and `(a|a)(a|a)…` score the same. Overlap is decided fail-closed (unenumerable atoms count as overlapping). This exists because an accepted pattern is later run by `allows()` **synchronously on the daemon's only thread inside the PreToolUse gate every tool call funnels through**, so one bad rule stalls every session, not just the one that owns it.

**The Permissions page** (Settings > Permissions, `src/pwa/components/permissions/`) is the sanctioned door that replaced the deleted Allow button, in three blocks. *Groups* edits the five groups inline against `PUT /api/permission-groups/:name`, rendering a refusal's lint message verbatim against the offending row — a generic failure would make the page a wall, and walls are what produce ad-hoc grants. *Pending classifications* lists every unresolved denial across all actions (`GET /api/permissions/pending`, denials only and synchronous; the MCP half is fetched separately from `/api/mcp/catalog` so a slow `tools/list` probe can never block the paint) and offers the three verdicts. *Grants* carries inline edit (`PUT /api/allowlist/rules/:id`, whose response carries a NEW id since the id encodes the value), revoke that now works at action scope too, and a promote-to-group that pre-fills the group editor rather than writing a rule itself, so there is exactly one path into a group.

Two things about that page are easy to get wrong, and both were shipped wrong once:

- **A verdict must do what its label says.** `never` records the decision and grants nothing — that's the whole job. `promote` is the only one that widens the system, so it's visually distinct behind a group picker plus a gated sign-off, and the picker offers **only the groups the action inherits** (`denial.groups` on the pending payload, from `ActionRegistry.inheritedGroups`). A promote elsewhere is refused by `resolveDenialVerdict`, because an action's grants are `core ∪ its declared groups`: promoting into a group it doesn't declare resolved the denial, widened that group for every action that *does* declare it, and left the original call blocked — strictly worse than doing nothing, answered 200. `fix-action` grants nothing either, but a **user's** `fix-action` must also queue the fix: it starts a `meta.build-action` edit session seeded with the blocked call (`startActionEdit`, shared with `POST /api/actions/:name/edit`) and the client navigates there. Stamping it alone was a silent discard — `DenialsStore.unresolved` keys on verdict presence, so the stamp deletes the denial from the only evidence `meta.improve-actions` reads, i.e. the "Dismiss" button Ship 6 retired wearing a better word. The improver's own `fix-action` (including `shellArtifactVerdict`'s auto-stamp) deliberately queues nothing. Every branch stamps the verdict **last**, so a failed group edit or a failed spawn leaves the evidence intact.
- **The *Grants* subtitle has to be true of the rows beneath it.** Confinement (Ship 2) took action-bound calls away from global and project scope — **not** from action scope: `scopesFor` still consults `actionsStore` for an action-bound call, so an `action · <name>` row *is* a live grant to that one action on top of its groups, and those rows are listed and revocable right there. The subtitle said "sessions and skills only, a grant here never reaches an action", which was false about exactly the rows it sat above (and that wrong sentence was in this file too). It now says global/project reach sessions and skills only and names the action-scope exception. Nothing can be *added* from that block either way — a group is the only door for new action permissions.

**A bash rule does not say which files a clause touches.** That gap is closed by four structural bars in `allows()` (`src/permissions/allowlist.ts`), not by making the rules cleverer — a pattern gates a clause by its leading command, and no amount of regex on the command line reliably answers "what does this open". Each bar carries an exemption for the whole-tool grant that already implies it, since gating under that would deny nothing:

| bar | question | exempt under |
|---|---|---|
| `redirectsAllowed` | where may `>` create or truncate? | whole-tool `Bash` |
| `fileOpArgsAllowed` | where may `mv`/`cp`/`rm`/`chmod` act? | whole-tool `Bash` |
| `readArgsAllowed` | where may `cat`/`jq`/`head`/… read from? | whole-tool `Read` |
| `fileFlagsAllowed` | where may `--body-file`/`--input`/`-F`/`-f k=@p` point? | whole-tool `Bash` |

`readArgsAllowed` is why `core` needs no regex: `cat`/`jq` may open `"$OUTPOST_ENVELOPE"` (recognised by spelling in ONE place — the checker sees command text, never the expansion), a path inside the session's own worktree, or a path a `Read:` rule grants. The whole-tool `Read` exemption means it binds exactly the actions inheriting `core` and no read grant — today `write.linear-comment`, `write.linear-issue`, `write.run-github-workflow`, none of which read anything but their envelope. Global scope carries `Read`, so interactive sessions are unaffected. `walkOperands` is the shared operand finder behind the read and file-op bars: they ask different questions, but the *finding* (a `<(…)` that isn't a literal path, a `--flag=value` hiding one, an unparseable metacharacter) is where the subtle failures live, so it exists once. See `allowlist-read-scope.test.ts`.

**A bash rule does not grant shell redirection.** A bash pattern judges a clause by its leading command, which says nothing about a redirection riding along inside it — `cat x > ~/.zshrc` matches `^cat `. So a clause that creates or truncates a file (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, or `>&` with a non-fd target) must clear a second bar: every target has to be a path the same caller could have written with the `Write` tool — covered by an `alwaysAllowPathPatterns` `Write:` rule (`Write:^/tmp/`), or an **absolute** path under the session's own worktree. Targets that can't be resolved statically — `$VAR`, `$(…)`, backticks, `~`, globs, and **any relative path, including one inside your own worktree** (`> out.log` denies) — deny before any rule is consulted: the checker sees the command text, not the expanded value, and not the cwd the clause will actually run in. Character-device sinks (`/dev/null`, `/dev/stderr`, `/dev/fd/N`) are exempt — they create nothing. Input redirection (`<`, `<<`, `<<<`, `<&`) and fd duplication (`2>&1`, `>&2`) are ungated: neither writes a file. A whole-tool `Bash` grant is exempt from the whole thing — it already means "run anything". See `redirectsAllowed` in `src/permissions/allowlist.ts`.

## Commands

```bash
npm run dev          # tsx watch, reloads on change
npm start            # one-shot daemon
npm test             # vitest + playwright
npm run test:unit    # vitest only
npm run test:e2e     # playwright only
npx tsc --noEmit     # NOT in the test gate — `npm test` never typechecks; run this yourself
```

## Repo layout

Backend is clustered by concern under `src/`. Do NOT drop new files at the root of `src/` — pick the cluster or create a new one.

```
src/
  daemon.ts              # entrypoint; wires modules; installs route factories
  server.ts              # HTTPS + WS surface for the PWA
  mcp-server.ts          # MCP surface for spawned Claude sessions
  config.ts, env-file.ts, claude-config.ts, settings-gen.ts, tailscale.ts
  setup-actions.ts, setup-agents.ts
  push-{keys,sender,subscriptions}.ts

  routes/                # HTTP route factories: registerXRoutes(server, deps)
    {git,jobs,sessions,projects,push,runs,schedules,meta,util,actions,preferences}.ts
    action-revisions.ts, schedule-edits.ts
  session/               # session lifecycle
    session-{manager,store}.ts, claude-proc.ts, stream-json.ts, event-log.ts
  work/                  # job orchestration
    engine.ts, work-{queue,types}.ts, envelope.ts, reconcile.ts, write-draft{,-runner}.ts
    orchestrated-runner.ts # the controller loop's runtime (see Concepts)
    launch-governor.ts     # who gets to spawn next, under token headroom
    job-liveness.ts, workspace.ts, pr-url.ts, action-run-{derive,ledger}.ts
  permissions/           # hook plumbing + gates
    hook-{handler,server}.ts, approval-mode.ts, approvals.ts
    allowlist.ts           # scopes + rules; shell-{split,safety}.ts are its bash lexer +
                           # argv/expansion bar, denial-suggestion.ts the rule offered on a miss
    file-flags.ts          # which flags name a FILE, and the /tmp shape one may name — the
                           # predicate allows() and the write-draft pin must never disagree on
    dangerous-writes.ts    # deny-vs-warn for external writes: refusedWrite() feeds allows(),
                           # writeFindings() rides out on the draft for the approval card
  ws/                    # inbound PWA WebSocket frames
    client-messages.ts     # decode + dispatch; isolated because a throw in ws.on('message') kills the daemon
  git/                   # worktree + git ops + diff
    worktree-manager.ts, git-ops.ts, diff-{parser,endpoint}.ts
    known-cwd.ts           # is this caller-supplied path one the daemon already knows? gate for spawn/shell-out
  integrations/          # external polling
    linear-{api,writer}.ts, pr-watcher.ts, user-prs-watcher.ts, usage-{poller,ledger}.ts
    gh-cli.ts              # the shared `gh` shell-out both PR integrations run through
    pr-file-patches.ts     # per-file PR diffs, fetched on demand + cached by head sha (NOT persisted
                           # onto the job); what lets a review comment render inside its hunk
  schedules/             # cron/event/token-triggered runs (routines) — dependency-free of work/
    scheduler.ts, schedules-store.ts, guards.ts, routing.ts, types.ts, wiring.ts
    headroom.ts, token-scheduler.ts  # opportunistic firing off spare 5h/7d token capacity
    native-handlers.ts, script-runner.ts, schedule-envelope.ts, setup-schedules.ts
  storage/               # persisted stores
    {journal,project-registry,actions,runs,preferences}-store.ts, runs-capture.ts
    stop-hook-tracker.ts, recurrence-tracker.ts, job-event-log.ts, jobs-migrate.ts
    action-{revisions,edits}-store.ts  # SKILL.md version history + revert; durable half of the in-flight edit map
    action-runs-store.ts, denials-store.ts  # per-round run rows + every allowlist miss — the improvement loop's evidence
  actions/               # registry + types; scorecard.ts, improvement-pack.ts, proposal-intake.ts, skill-diff.ts
  steps/                 # step handlers: action.ts, orchestrated{,-policy,-inbox}.ts
  jobs/                  # lifecycle.ts

  pwa/                   # static client (plain ES modules, no bundler); DESIGN.md lives here
    app.js, index.html, sw.js, app-bridge.js, util.js, markdown.js, session-filter.js,
    deep-links.js, session-launch.js, test-hooks.js
    components/            # per-feature UI modules — one dir per surface/overlay
      shell/                 # desktop chrome: topbar, sidebar, surface registry/frame, keyboard, list-filter
      mobile-shell/          # mobile chrome: bottom tab bar, header, FAB, More screen, screen stack
      cockpit/               # home surface (waiting/in-flight/upcoming/finished)
      tracked/               # jobs list + detail + focus rail
      sessions-surface/      # sessions list/detail/rail
      schedules/             # schedules list/detail/create-dialog + routing/trigger/what/runs cards
      library/               # skills list/detail + runs-history detail
      settings-surface/      # settings sections + detail cards
      palette/               # ⌘K command palette (new session/project, jump-to)
      session-view/          # live transcript + composer — shared core for desktop and mobile
      diff-overlay/, agents-sheet/, push/, work/  # diff review; subagent sheet; push-notif setup;
                                                   # job-detail sub-widgets (step-card, thread-card, ...) used by tracked/
      ask-card.js, ask-flow.js, tool-use-tile.js, todos-{core,sheet}.js, sheet-utils.js,
      mobile-header.js, approvals-mobile.js, cwd-picker.js, theme-picker.js,
      diff-review-format.js
    vm/                    # view-models (D2): pure derivations from raw store snapshots → row/card shapes.
                           # One file per surface ({cockpit,tracked,sessions,schedules,library,settings,runs}.js) + work-predicates.js.
                           # Zero DOM. Renderers are layout-agnostic; mobile-shell arranges the SAME renderers
                           # desktop's shell/surfaces.js uses — never a second copy.
    state/                 # store singletons (sessions, approvals, subagents, work, usage, settings, git,
                           # schedules, runs, actions, library, grants, nav, ...)
    net/                   # fetch wrappers per resource (actions, meta, preferences, runs, schedules, work)
    ws/                    # dispatch.js: WS message → store mutations
    layout/                # mobile vs desktop pick
    css/                   # base.css (tokens + global chrome), primitives.css (the canonical .o-* components),
                           # overlays.css (shared sheet/modal/popover chrome), app-shell.css (pre-JS bootstrap shell),
                           # shell-desktop.css, shell-mobile.css, desktop.css, palette.css, session-view.css,
                           # surfaces/{cockpit,tracked,sessions,schedules,library,settings,runs,diff}.css
                           # (legacy-components.css was dissolved into these per-surface sheets —
                           #  see src/pwa/DESIGN.md, codename Signal)
    utils/                 # formatting.js, usage-bar.js (shared tier thresholds/popover), overflow-menu.js,
                           # autogrow.js, context-usage.js, hotkey.js, keyed-rows.js, row-activation.js,
                           # diff-window.js (which slice of a PR diff sits under a review comment)
```

### Where new code goes

- **New HTTP route** → factory function in `src/routes/<group>.ts`; wire it in `daemon.ts` (`registerXRoutes(server, deps)`). Do not inline routes into `daemon.ts`.
- **New action** → `actions/<category>/<name>/` **and** `~/.outpost/actions/<category>/<name>/` — both, always (see Gotchas). A step that must decide its own next move is a controller (`type: 'orchestrated'`); anything else is a plain `action` step. If it's only ever reached from a controller round, a UI button, or a schedule, set `outpost: plannable: false` so it stays out of the orchestrator's catalog; if it IS a controller, add its sub-actions to `outpost: roster` and add it to the same roster whenever you add a round that binds it.
- **New backend concern** → the matching cluster subdir. If nothing fits, create a new subdir rather than dropping a file at `src/` root.
- **New PWA surface** → its own dir under `src/pwa/components/<surface>/index.js`, exporting `renderList`/`renderDetail`/`renderContext` as needed and registered in `shell/surfaces.js` (desktop) — `mobile-shell/index.js` mounts the *same* exports as a pushed screen, it does not reimplement the surface.
- **New PWA view-model** → `src/pwa/vm/<surface>.js`, pure functions only (no DOM, no store reads inside — callers pass raw snapshots in). This is what keeps desktop and mobile rendering the same derived data through different chrome.
- **Cross-module callback** a component needs from `app.js` → add a key to `src/pwa/app-bridge.js`'s bridge object and wrapper function, installed via `installAppBridge()` at boot. Don't import `app.js` from a component (creates cycles).
- **New PWA util** → `src/pwa/utils/<name>.js` if pure. Don't add another top-level `util.js`.
- **State stores** → `src/pwa/state/<name>.js`. Use the existing store shape (subscribable snapshot + typed mutators).

### Keep modules small

- Files hitting ~500 LOC should be looked at for extraction. `daemon.ts` and `app.js` used to be 2365 / 6501 lines; both were refactored (they're ~1330 / ~990 now), and `app.js`'s WS handling has since moved out entirely into `pwa/ws/dispatch.js`. Regressing to that shape is a code smell.
- Route handlers larger than ~30 lines? Extract the handler body into a named function in the same route file.
- `WorkEngine` is the one remaining monolith — extraction is welcome but non-trivial (see Deferred below).

## Testing changes from a git worktree

The daemon runs as a launchd LaunchAgent (`local.outpost.$USER`) and holds the runtime state in `~/.outpost/`. Don't try to "replace" the running daemon during dev — fight a side-by-side instance on alternate ports instead.

From the worktree:

```bash
OUTPOST_HTTPS_PORT=8543 \
OUTPOST_HOOK_PORT=8544 \
npx tsx src/daemon.ts
```

Open `https://<host>:8543` to drive the test instance. It shares `~/.outpost/` with the prod daemon, so both see the same sessions and worktree index — keep only one running at a time to avoid racing on those files (stop launchd first: `launchctl bootout gui/$UID/local.outpost.$USER`, restart after with `bootstrap`). The allowlist and permission groups are the exception: each checkout has its own gitignored `config/allowlist.json` and `config/permission-groups.json`, seeded from `config/{allowlist,permission-groups}.default.json`, so rules hot-added (or setup-specific integrations) in the worktree don't leak into prod (and vice versa).

When the worktree is merged, bounce the real daemon:

```bash
launchctl kickstart -k gui/$UID/local.outpost.$USER
```

`unload`/`load` trips on the `KeepAlive` race; `kickstart -k` is the clean way.

## Gotchas

- **Don't loosen the sessionId/branch regexes in `src/git/worktree-manager.ts`.** They're a defense-in-depth check against path traversal and git argv-flag smuggling (a session id starting with `-` would be parsed as a flag). The `--` separator on the git command is the second layer; keep both.
- **Hook server is loopback + secret.** Any new endpoint added to `src/permissions/hook-server.ts` must validate the secret header — the PWA-facing server (`server.ts`) is the only thing exposed on the tailnet.
- **State lives in `~/.outpost/`** (override: `OUTPOST_RUNTIME_DIR`). `index.json` files use atomic rename for persistence — preserve that pattern in any new persisted store.
- **`~/.outpost/.env`** is sourced at daemon startup (see `env-file.ts`). It exists because launchd strips shell env, so this is how secrets like `GITHUB_TOKEN` reach subprocesses (`gh pr view`, etc.) without baking them into the plist. Plist > .env > defaults.
- **`$OUTPOST_API_URL` is exported into `process.env` at daemon startup**, so every spawned session inherits the loopback base URL (`claude-proc.ts` merges `process.env` under its per-session vars). That's how an action step POSTs back to the daemon — it has no other way to learn the port. Actions that use it must allowlist the `$OUTPOST_API_URL` *and* `127.0.0.1:<port>` spellings; the checker sees the command text, not the expanded value.
- **A blocker always lands in the action's journal — except a denied write draft.** `WorkEngine.onStepFailed` appends a `blocked` entry unless the session already journaled for that step, so the Library's "Self-reported lessons" is never empty for an action that keeps failing (which is the only signal `meta.improve-actions` reads). Pass `{ journal: false }` for failures the action didn't cause — a daemon bounce, a workspace that wouldn't provision. A user **deny** of a write draft is the carve-out: `denyDraft` (`src/work/write-draft-runner.ts`) journals a `denied` outcome against whoever *chose* to run the action — the controller, or the job's `orchestratorAction` (`meta.orchestrate`) — never against the write action itself, because the reason is feedback on the decision to run it, not on how it ran. A separate `gated_denied` outcome (`journalGatedDenial` in `engine.ts`) records a mid-run allowlist/pin miss against the acting action instead; both `denied` and `gated_denied` are deliberately excluded from `onStepFailed`'s one-entry-per-step `blocked` slot so a self-authored lesson is never crowded out by either.
- **Every catalog action must live in the repo's `actions/`, not just `~/.outpost/actions/`.** The runtime dir is what the registry reads, but `ensureActionsInstalled` skips existing real dirs — so a repo-only edit never reaches the daemon, and a runtime-only action doesn't exist on a fresh install. Write both. `tests/unit/action-effective-allowlist.test.ts` pins the resolved grant of the actions whose group defaults alone don't cover their own SKILL.md.
- **A rule that grants a network or filesystem write must be a positive whitelist pinned to its destination.** Anchor it `^…$`, name the exact host/path, and enumerate every flag that may appear — anything unrecognised then denies. A prefix rule grants everything after it: `^curl ` (and `^curl -s `, and `^curl -fsS -X POST `) is every method, every body, every URL, plus `-o <path>` overwriting any local file and `--next` starting a second request with fresh flags. Never write a rule that tries to *forbid* a flag — `-d`, `-d=x`, `"-d"`, `-d""`, `-d$X`, `-sd` all reach argv as the same flag, so quoted spellings must be refused by the whitelist too (`gh api "-X" PUT …` is a merge). `.` doesn't match a newline and a `\`-continuation stays inside one clause, so `.*` guards leak across lines. `tests/unit/permission-group-pull.test.ts` pins this for the `pull` group.
- **A gated write needs an approved pin, not just an allowlist hit.** The registry resolves a second allowlist per action, `gated` — the subset of its grants that came from a `GATED_GROUPS` group (currently just `push`; see `resolvePermissions` in `src/actions/registry.ts`). For an action-bound session, the PreToolUse hook checks `gated` *first*: a call matching it is allowed only if it also matches an unconsumed `PinnedCall` on an approved `WriteDraft` for that session (`matchPinnedCall` in `src/work/write-draft.ts` — Bash on exact command text past an outer trim; any other tool name matches on itself plus deep-equal args, which in practice means MCP, since that's the only other shape a draft pins) **and** independently clears the ordinary `allows()` check. So an action that "improves" the user's edited payload before running it — reformats the body, adds a flag — gets denied: the pin is for the text the user actually approved, not a paraphrase of it. The pin is consumed at allow time; a `PostToolUseFailure` releases it (keyed on `tool_use_id`, exactly-once) if the call failed, so an identical retry needs no second approval — it does **not** release on a user interrupt, since it's unknown whether the write landed. A `bash` call whose payload is too big for the command line (`--input`/`--body-file`/`--notes-file`, the short `-F`, and `-f key=@path` — see `FILE_REFERENCING_FLAGS` in `src/permissions/file-flags.ts`) is additionally pinned by a sha256 digest of the referenced file's bytes (`PinnedCall.fileDigests`, re-verified before the pin is consumed) — command-text matching alone says nothing about whether the file still holds what was approved; the session drafts that body inline as `PinnedCall.files` (path → content) instead of writing it itself, the user edits it directly in the approval card, and `acceptDraft` (`src/work/write-draft-runner.ts`) writes the approved bytes to disk itself before hashing them, so the digest can never drift from what was actually approved.

  **Two ways a write escapes the pin check.** (1) The global/project half of this closed with confinement: for an action-bound call, `scopesFor` (`src/permissions/allowlist.ts`) no longer touches global or project scope at all — an action's grants are `core ∪ its declared groups ∪ its colocated allowlist.json` (plus session scope), full stop; global/project only apply to a call with no `actionName`, where there is no `gated` set to bypass in the first place. `gatedMatch` (`src/permissions/hook-handler.ts`) still consults only the action's static `gated` set, computed once at registry load, while the `allows()` fallback right below it consults those confined scopes — the colocated `allowlist.json`, hot-added per-action overrides in `~/.outpost/actions.json`, and session scope — none of which ever populate `gated`. A *new* write-shaped rule can no longer be installed into either remaining scope: `assertNotWriteShaped` (`src/permissions/write-shape.ts`) is enforced at `Allowlist.addRule`, `ActionsStore.addRule`, and the registry's colocated `allowlist.json` reader (checked on every load, so this one applies to pre-existing files too — see the `pull` bullet above). What's left: a write-shaped rule already persisted in `~/.outpost/actions.json` *before* this lint shipped still loads and still runs ungated — `auditPersistedRules` (`src/storage/actions-store.ts`) only logs a startup `console.warn` naming it, it does not refuse the load. (2) Anything not shaped like the `Bash`/MCP call the hook can inspect — see the `edit`-group ceiling in Deferred.
- **Two daemons can't run on the same `~/.outpost/`.** Use alternate ports for side-by-side testing, but stop the launchd instance first.
- **A review comment's `diff_hunk` is not the diff around it.** GitHub's field runs from the hunk's START to the COMMENTED LINE — so it holds nothing after the comment (often the half that says what the comment is about), and on an added file the hunk starts at line 1, so a comment on line 302 arrives carrying 302 lines of file body. The card rendered it verbatim, uncapped, until this was fixed. `pr-file-patches.ts` fetches the real per-file `patch` on demand so `utils/diff-window.js` can anchor the comment inside its hunk and take a window with lines on both sides; `diff_hunk` is now only the fallback, windowed to its tail. Don't "simplify" the fetch away as redundant with a field that's already in the payload — it isn't the same data. Note also that a **collapsed** `<details>` still costs its full markup in every repaint's `innerHTML`, so the expanders render 20 rows, not the rest of the hunk (see `project_pwa_subagent_repaint_cost` — the same shape caused a timeline stutter before).
- **PWA modules extracted from `app.js` use a deps-injection pattern.** `initX({ callbackA, callbackB })` is how the extracted module gets app-side functions it can't cleanly import (would create cycles). `app-bridge.js` is the other half of this — a shared reserved-keys object for callbacks *multiple* components need, installed once via `installAppBridge()` rather than threaded through every `initX`. Follow one of these two patterns when adding more.

## Deferred

Legitimate remaining work (previously stale items pruned):

- **WorkEngine split.** `WorkEngine` in `src/work/engine.ts` is over 2500 lines with methods that call each other via `this.mutate`/`this.appendEvent`. Splitting into plan/execution/pr/edits helper modules needs class-surgery — deferred.
- **Linear-write retry queue.** `engine.ts` awaits `linearWriter.setState` and re-queues on next tick if it fails — fine because the call is rare and idempotent, but a backgrounded retry queue would let dispatch continue without blocking on Linear.
- **Restoring a deleted action from its history.** `DELETE /api/actions/:name` records a `deleted` event and keeps the final `SKILL.md` body, but a deleted action leaves the catalog, so its history has no entry point in the UI and nothing can restore it.
- **e2e coverage gaps from the redesign.** 75 tests across 36 spec files as of Aug 2026; the six long-failing specs were all stale selectors, since retargeted. What's still missing is coverage, not correctness: no e2e for the desktop shell (`.o-topbar`/`.o-sidebar`/`.o-frame`) or the mobile shell's tab bar, and none for the controller loop's gate/wait/dispatch moves beyond `orchestrated-gate.spec.ts`.
- **Default approval mode doesn't reach a session opened outside the palette.** `app.js`'s `openSession()` is the only place that arms `pendingDefaultPush`, and `startSession()` doesn't carry the default itself — the ⌘K palette compensates by passing `approvalMode` explicitly. Every other `startSession()` caller opens an existing session, so nothing user-facing is broken today, but a new desktop launcher that forgets the explicit pass would silently strand the session on `ask`.
- **`edit`'s direct interpreters are anchored; its test runners are not, and that's inherent, not deferred.** `pull` and `push` are anchored whitelists, and Ship 5 closed `edit`'s direct escapes: interpreters are anchored (`node -e`, `go run`, bare `npx`, `make` all dropped entirely — see `permission-group-edit.test.ts`), every bash file op (`cp`/`mv`/`ln`/`chmod`/`rm`/`rmdir`/`touch`) is path-scoped to the session worktree, and local git is an anchored whitelist rather than a verb prefix, closing `git rebase --exec`/`-x` (an eval flag by another name), `git apply --directory=`/`--unsafe-paths` (an out-of-worktree write with no interpreter at all), and the free `-C <path>` prefix that reached any repo on the machine (see `permission-group-edit-ceiling.test.ts`). No direct interpreter grant remains. What's left: `npm test`, `npm run <script>`, `go build`, `cargo test`, `pytest` all execute whatever code the action itself just wrote to the worktree with `Edit`/`Write` — an action that authors a file and then runs its own test/build command can make that file do anything, and no rule enumerates what a test script may contain. That isn't a gap to anchor away; it's what the group is *for* — "run the code you just wrote and see if it passes" is arbitrary execution by definition, scoped only to the worktree the action already owns. Closing it would mean sandboxing execution, not scoping arguments — a project, not a patch. Treat `push`'s narrowing as defence-in-depth, not a boundary, for the same reason: this is escape (2) from the gated-write gotcha below — an action granted both `edit` and `push` can still get an external write to run by authoring it into a script and executing that, which the `gated` allowlist never inspects — so the gate's promise that "the payload you approved is the payload that runs" holds only for writes shaped as an inspectable `Bash`/MCP call.
- **`discoverPr` polls unbounded for the life of a live writable step.** A miss-cap was implemented and then reverted (see the comment at the top of `syncStep` in `src/integrations/pr-watcher.ts`): the canonical flow parks the controller on a `wait` for `pr-state`, so nothing bumps the round count, any miss-based cap expires mid-wait, and discovery is then the only thing that could ever wake the step. That holds even now that `code.orchestrate-pr`'s row 5 drafts `gh pr create` itself once the branch is confirmed pushed (`actions/code/orchestrate-pr/SKILL.md`): the approved call's stdout is never captured into `prUrl` anywhere, so the controller still falls back to the same `wait` on `pr-state` afterward, and `discoverPr`'s `gh pr list` remains the only path that ever resolves the URL — whether the PR was opened by the controller's own draft or by the user's own hand. The cost is one `gh pr list` per sweep per live writable step, and every controller holding a writable workspace does open a PR one way or the other — so the population a cap would save is empty. Re-arming on a real signal (the branch's remote head moving) is the only version worth building.
- **`PinnedCall.releasedAfterFailure` is dead code in the shipped UI.** It's only ever stamped by `releasePin` (`engine.ts`) on a call belonging to a draft that already has `approvedAt` set, nothing anywhere clears `approvedAt` back to unset, and a redraft rebuilds `calls` by explicit field pick (`parseDraftCalls` in `src/work/write-draft.ts`) so the flag can't carry forward regardless — meanwhile both PWA render sites (`step-card.js`'s `draftsHtml`, `tracked.js`'s `draftFor`) only render drafts with `!d.approvedAt`. So the "this call may already have taken effect" warning (`write-draft-card.js`'s `releasedNote`) can never actually reach a user. The session still learns of the release on its next resume, via its own envelope, so the safety behaviour works end to end there — a same-turn retry has no envelope rewrite to learn from, but that's the ordinary "read the envelope fresh each turn" discipline, not a hole specific to this flag. It's the user-facing half that's missing, and closing it needs a read-only view of an approved draft's in-flight calls, not a change to the stamping logic.
- **`GateRequest.deferredMove` is a migration shim with an expiry date.** The removed pre-run force-gate stashed the move it was holding there; `resolveGate` (`src/work/orchestrated-runner.ts`) still replays one on approval so gates parked before the write-draft cutover don't drop the move the user is being asked to approve. Nothing writes the field — once every surviving legacy gate is resolved, the field, the replay branch, and their two tests come out. **Two jobs still carry one as of 2026-08-17** (`CS-1608`, `REL-19`); re-check with `grep -l deferredMove ~/.outpost/jobs/*.json` before ripping it out.

## Conventions

- ESM (`"type": "module"`), import paths end in `.js` even for `.ts` source. When moving files, update every importer.
- No comments restating code; comments only for non-obvious WHY (see existing files for tone).
- Errors at the boundary (user input, git, filesystem) — trust internal calls.
- Prefer editing existing files over creating new ones — but when a file is heading toward monolith territory (see "Keep modules small"), extract instead of adding to it.
