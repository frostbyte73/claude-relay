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

A job's **orchestrator** is just an action that emits the plan — `meta.orchestrate` (the job's `orchestratorAction`; the old `meta.plan-job` name survives only as a legacy id in `work-queue.ts` and a journal migration in `journal-store.ts`). The full action catalog goes into its envelope so it can compose any action into a plan; no separate "playbook" primitive is needed.

**Schedules** (`src/schedules/`, "routines" in the UI) fire work without a user asking. A `Trigger` is `cron` / `once` / `event` / `token-opportunistic` (fired by spare 5h/7d token headroom rather than a clock — see `headroom.ts` + `token-scheduler.ts`), `Guard[]` can veto a firing, and a `What` runs one of four things: a catalog `skill`, a free-text `prompt`, a `script` (no Claude session at all), or a `native` in-daemon handler (how the PR watchers are wired).

Every action round is recorded: `action-run-ledger.ts` observes the job queue and writes one `ActionRunRecord` per round, with an outcome (`accepted`/`revised`/`denied`/`merged`/`failed`/…), cost, and denial count. That feeds `scorecard.ts` (the Library's skill detail pane) and `improvement-pack.ts`, which picks the single action most worth improving and assembles its evidence for `meta.improve-actions`. This is why the journal-blocker gotcha below matters — those entries are the qualitative half of that evidence.

### Permission groups

Each action declares its allowlist by inheriting named groups defined in `config/permission-groups.json`:

- **`core`** — implicit for every `runner: claude` action. Envelope-I/O baseline: `cat $OUTPOST_ENVELOPE`, `cat`, `jq`, the `mcp__outpost__*` submit tools (how a session reports results back to the daemon), and `ToolSearch`.
- **`read`** — local file reads + git-read-only (Read/Glob/Grep/LS, `ls`/`rg`/`grep`/`find`, `git status|log|diff|show|blame|branch|fetch|rev-parse|ls-files|grep|…`).
- **`pull`** — network **reads only** (WebFetch/WebSearch, MCP `get_/list_/search_` patterns for Linear/Datadog/GitHub/Notion/Slack/incident-io/Grafana, `gh pr view`/`gh pr checks`/`gh issue view`/…). Its `curl` and `gh api` rules are anchored whitelists: `curl` takes `-s/-S/-f/-L` (and their clusters), the `--silent/--fail/--show-error/--location/--compressed` spellings, `--max-time`/`--connect-timeout`/`-H` with a value, and an `http(s)://` or `$VAR`-rooted URL — no `-X`, `-d`, `-o`, `-O`, `-T`, `-F`, `-K`, `--next`. `gh api` takes the endpoint plus `--paginate`/`--slurp`/`--cache`/`--hostname`/`-H`/`--jq`/`--template` and `--method GET` only — no `-f`/`-F`/`--input` and no other method. A genuine write belongs in `push`, never in the action's own `allowlist.json`: `resolvePermissions` (`src/actions/registry.ts`) merges colocated `allowlist.json` extras into the action's plain allowlist but **never** into its `gated` set (see the `push` bullet below) — this exact mistake left 7 of 9 external-write actions ungated until it was caught. It's now refused rather than silent: `assertNotWriteShaped` (`src/permissions/write-shape.ts`) runs on every colocated `allowlist.json` at registry load, so a write-shaped extra fails the action's load instead of running unpinned. Keep `allowlist.json` for grants narrower than a whole group that aren't writes. (It's one of two doors into that trap — see "A gated write needs an approved pin" in Gotchas for the other.)
- **`edit`** — local writes + test runners (Edit/Write/MultiEdit path-scoped to `/tmp/`, mage/npm/yarn/pnpm/go/pytest/cargo, file ops `mkdir`/`mv`/`cp`/`rm`, local git `git rebase`/`checkout`/`merge`/`stash`/…). Edits inside the session's own worktree auto-allow via session scope — see `allows()` in `src/permissions/allowlist.ts`.
- **`push`** — external writes, each an anchored whitelist rather than a subcommand prefix, and **gated**: `push` is one of `GATED_GROUPS` (`src/actions/registry.ts`), so a call matching it is allowed only when it's also pinned by a write draft the user approved for that session (see the Gotchas entry below). Granting the group is now cheap — the gate, not the membership, is the control. `git push` takes a bare remote name and a branch — no force spelling at all (`--force`, `-f`, `--force-with-lease` are simply not granted), no URL remote; `git push <remote> --delete <branch>` (either argument order) *is* granted, same as everything else in the group, gated on the pin like any other call. `gh pr merge`/`review`/`comment`/`create`/`edit`/`close` and the `issue`/`release` verbs bind to the worktree's own repo: `--repo`/`-R`, a full PR URL and `owner/repo#n` are unreachable, `--admin` and `--delete-branch` are gone, and `--body-file` is pinned to `/tmp/` (it is otherwise an exfiltration primitive — `--body-file ~/.ssh/id_rsa` was allowed). MCP writes are an explicit tool list, not a `create_|update_` prefix.

Group descriptions live in `config/permission-groups.json` itself now (no separate lookup table). Groups are editable at runtime through `PUT /api/permission-groups/:name` (`src/routes/meta.ts`), which re-lints the whole group with `validateGroupUpdate` — the same three classifiers `assertNotWriteShaped` runs, minus the gated-group carve-out — reloads the registry against the edit in memory *before* writing `config/permission-groups.json` to disk (a rejected edit must never reach disk, or it silently takes effect at the next daemon restart with no audit row), and only then appends one row to the revision log at `~/.outpost/permission-group-revisions.jsonl`. `GET /api/permission-groups/:name/revisions` lists that history; `POST /api/permission-groups/:name/revert/:revisionId` re-applies an old `after` snapshot through the same `validateGroupUpdate` + reload-then-write path — it re-validates rather than trusting the snapshot, so a revision recorded before a rule tightened can't reinstate a grant the current lint would now refuse.

An action's frontmatter declares which groups it inherits:

```yaml
outpost:
  runner: claude
  permissions: [read, pull]  # core is implicit; this gets core + read + pull
```

Action-specific extras (narrower than a whole group) go in the colocated `allowlist.json`. The registry resolves `final = core (if claude) ∪ each group ∪ extras` and feeds that to the `Allowlist` checker.

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
  ws/                    # inbound PWA WebSocket frames
    client-messages.ts     # decode + dispatch; isolated because a throw in ws.on('message') kills the daemon
  git/                   # worktree + git ops + diff
    worktree-manager.ts, git-ops.ts, diff-{parser,endpoint}.ts
    known-cwd.ts           # is this caller-supplied path one the daemon already knows? gate for spawn/shell-out
  integrations/          # external polling
    linear-{api,writer}.ts, pr-watcher.ts, user-prs-watcher.ts, usage-{poller,ledger}.ts
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
                           # autogrow.js, context-usage.js, hotkey.js, keyed-rows.js, row-activation.js
```

### Where new code goes

- **New HTTP route** → factory function in `src/routes/<group>.ts`; wire it in `daemon.ts` (`registerXRoutes(server, deps)`). Do not inline routes into `daemon.ts`.
- **New action** → `actions/<category>/<name>/` **and** `~/.outpost/actions/<category>/<name>/` — both, always (see Gotchas). A step that must decide its own next move is a controller (`type: 'orchestrated'`); anything else is a plain `action` step.
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
- **A gated write needs an approved pin, not just an allowlist hit.** The registry resolves a second allowlist per action, `gated` — the subset of its grants that came from a `GATED_GROUPS` group (currently just `push`; see `resolvePermissions` in `src/actions/registry.ts`). For an action-bound session, the PreToolUse hook checks `gated` *first*: a call matching it is allowed only if it also matches an unconsumed `PinnedCall` on an approved `WriteDraft` for that session (`matchPinnedCall` in `src/work/write-draft.ts` — Bash on exact command text past an outer trim; any other tool name matches on itself plus deep-equal args, which in practice means MCP, since that's the only other shape a draft pins) **and** independently clears the ordinary `allows()` check. So an action that "improves" the user's edited payload before running it — reformats the body, adds a flag — gets denied: the pin is for the text the user actually approved, not a paraphrase of it. The pin is consumed at allow time; a `PostToolUseFailure` releases it (keyed on `tool_use_id`, exactly-once) if the call failed, so an identical retry needs no second approval — it does **not** release on a user interrupt, since it's unknown whether the write landed. A `bash` call whose payload is too big for the command line (`--input`/`--body-file`/`--notes-file`) is additionally pinned by a sha256 digest of the referenced file's bytes (`PinnedCall.fileDigests`, re-verified before the pin is consumed) — command-text matching alone says nothing about whether the file still holds what was approved; the session drafts that body inline as `PinnedCall.files` (path → content) instead of writing it itself, the user edits it directly in the approval card, and `acceptDraft` (`src/work/write-draft-runner.ts`) writes the approved bytes to disk itself before hashing them, so the digest can never drift from what was actually approved.

  **Two ways a write escapes the pin check.** (1) is now partly closed: `gatedMatch` (`src/permissions/hook-handler.ts`) still consults only the action's static `gated` set, computed once at registry load, while the `allows()` fallback right below it still consults every runtime scope `scopesFor` assembles (`src/permissions/allowlist.ts`) — global, project, session, and hot-added per-action overrides in `~/.outpost/actions.json` — none of which ever populate `gated`. But a *new* write-shaped rule can no longer be installed into any of those scopes: `assertNotWriteShaped` (`src/permissions/write-shape.ts`) is enforced at `Allowlist.addRule`, `ActionsStore.addRule`, the registry's colocated `allowlist.json` reader (checked on every load, so this one applies to pre-existing files too — see the `pull` bullet above), and `PUT /api/permission-groups/:name`. What's left: a write-shaped rule already persisted in `~/.outpost/actions.json` *before* this lint shipped still loads and still runs ungated — `auditPersistedRules` (`src/storage/actions-store.ts`) only logs a startup `console.warn` naming it, it does not refuse the load. Global- and project-scope persisted rules get no audit at all; nothing walks those files at startup. (2) Anything not shaped like the `Bash`/MCP call the hook can inspect — see the `edit`-group ceiling in Deferred.
- **Two daemons can't run on the same `~/.outpost/`.** Use alternate ports for side-by-side testing, but stop the launchd instance first.
- **PWA modules extracted from `app.js` use a deps-injection pattern.** `initX({ callbackA, callbackB })` is how the extracted module gets app-side functions it can't cleanly import (would create cycles). `app-bridge.js` is the other half of this — a shared reserved-keys object for callbacks *multiple* components need, installed once via `installAppBridge()` rather than threaded through every `initX`. Follow one of these two patterns when adding more.

## Deferred

Legitimate remaining work (previously stale items pruned):

- **WorkEngine split.** `WorkEngine` in `src/work/engine.ts` is over 2500 lines with methods that call each other via `this.mutate`/`this.appendEvent`. Splitting into plan/execution/pr/edits helper modules needs class-surgery — deferred.
- **Linear-write retry queue.** `engine.ts` awaits `linearWriter.setState` and re-queues on next tick if it fails — fine because the call is rare and idempotent, but a backgrounded retry queue would let dispatch continue without blocking on Linear.
- **Action-scoped allowlist rules can't be revoked from Settings.** `DELETE /api/allowlist/rules/:id` (`src/routes/meta.ts:256`) handles global/project grants; action-scoped rules still answer 409 pointing at the action editor. `ActionsStore.removeRule()` now exists (revision revert uses it — `src/routes/action-revisions.ts:108`), so wiring it into that route is a small follow-up rather than a missing primitive.
- **Restoring a deleted action from its history.** `DELETE /api/actions/:name` records a `deleted` event and keeps the final `SKILL.md` body, but a deleted action leaves the catalog, so its history has no entry point in the UI and nothing can restore it.
- **e2e coverage gaps from the redesign.** 75 tests across 36 spec files as of Aug 2026; the six long-failing specs were all stale selectors, since retargeted. What's still missing is coverage, not correctness: no e2e for the desktop shell (`.o-topbar`/`.o-sidebar`/`.o-frame`) or the mobile shell's tab bar, and none for the controller loop's gate/wait/dispatch moves beyond `orchestrated-gate.spec.ts`.
- **Default approval mode doesn't reach a session opened outside the palette.** `app.js`'s `openSession()` is the only place that arms `pendingDefaultPush`, and `startSession()` doesn't carry the default itself — the ⌘K palette compensates by passing `approvalMode` explicitly. Every other `startSession()` caller opens an existing session, so nothing user-facing is broken today, but a new desktop launcher that forgets the explicit pass would silently strand the session on `ask`.
- **The `edit` group is the real permission ceiling, and it is not closed.** `pull` and `push` are now anchored whitelists, but `edit` grants `node`, `npx`, `make`, `go`, `cargo` and unscoped `cp`/`mv`/`ln`/`chmod`/`rm` — so `node -e "require('fs').writeFileSync('/Users/you/.zshrc', …)"` is auto-approved for any action inheriting it, and a force-push is reachable through an interpreter no matter what `push` grants. Note the internal inconsistency: `Write` is path-scoped to `/tmp/` while `cp` is not. That is defensible for a group whose whole purpose is local mutation by code-writing actions, and closing it means path-scoping every file op and every interpreter — a project, not a patch. Until then, treat `push`'s narrowing as defence-in-depth, not a boundary. This is escape (2) from the gated-write gotcha: an action granted both `edit` and `push` can shell out through one of those interpreters to do the write itself, which the `gated` allowlist never sees — so the gate's promise that "the payload you approved is the payload that runs" holds only for writes shaped as an inspectable `Bash`/MCP call.
- **`discoverPr` polls unbounded for the life of a live writable step.** A miss-cap was implemented and then reverted (see the comment at the top of `syncStep` in `src/integrations/pr-watcher.ts`): the canonical flow parks the controller on a `wait` for `pr-state`, so nothing bumps the round count, any miss-based cap expires mid-wait, and discovery is then the only thing that could ever wake the step. That holds even now that `code.orchestrate-pr`'s row 5 drafts `gh pr create` itself once the branch is confirmed pushed (`actions/code/orchestrate-pr/SKILL.md`): the approved call's stdout is never captured into `prUrl` anywhere, so the controller still falls back to the same `wait` on `pr-state` afterward, and `discoverPr`'s `gh pr list` remains the only path that ever resolves the URL — whether the PR was opened by the controller's own draft or by the user's own hand. The cost is one `gh pr list` per sweep per live writable step, and every controller holding a writable workspace does open a PR one way or the other — so the population a cap would save is empty. Re-arming on a real signal (the branch's remote head moving) is the only version worth building.
- **`PinnedCall.releasedAfterFailure` is dead code in the shipped UI.** It's only ever stamped by `releasePin` (`engine.ts`) on a call belonging to a draft that already has `approvedAt` set, nothing anywhere clears `approvedAt` back to unset, and a redraft rebuilds `calls` by explicit field pick (`parseDraftCalls` in `src/work/write-draft.ts`) so the flag can't carry forward regardless — meanwhile both PWA render sites (`step-card.js`'s `draftsHtml`, `tracked.js`'s `draftFor`) only render drafts with `!d.approvedAt`. So the "this call may already have taken effect" warning (`write-draft-card.js`'s `releasedNote`) can never actually reach a user. The session still learns of the release on its next resume, via its own envelope, so the safety behaviour works end to end there — a same-turn retry has no envelope rewrite to learn from, but that's the ordinary "read the envelope fresh each turn" discipline, not a hole specific to this flag. It's the user-facing half that's missing, and closing it needs a read-only view of an approved draft's in-flight calls, not a change to the stamping logic.
- **`GateRequest.deferredMove` is a migration shim with an expiry date.** The removed pre-run force-gate stashed the move it was holding there; `resolveGate` (`src/work/orchestrated-runner.ts`) still replays one on approval so gates parked before the write-draft cutover don't drop the move the user is being asked to approve. Nothing writes the field — once every surviving legacy gate is resolved, the field, the replay branch, and their two tests come out. **Two jobs still carry one as of 2026-08-17** (`CS-1608`, `REL-19`); re-check with `grep -l deferredMove ~/.outpost/jobs/*.json` before ripping it out.

## Conventions

- ESM (`"type": "module"`), import paths end in `.js` even for `.ts` source. When moving files, update every importer.
- No comments restating code; comments only for non-obvious WHY (see existing files for tone).
- Errors at the boundary (user input, git, filesystem) — trust internal calls.
- Prefer editing existing files over creating new ones — but when a file is heading toward monolith territory (see "Keep modules small"), extract instead of adding to it.
