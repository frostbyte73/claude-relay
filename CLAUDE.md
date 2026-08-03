# Outpost

Background daemon that exposes Claude Code over HTTPS+WS on a Tailscale tailnet, with a PWA client. See `README.md` for the user-facing install/usage; this file is the orientation for Claude working inside the repo.

## Concepts

Two primitives. Everything else is implementation detail.

- **action** — atomic unit of work. One `SKILL.md` + `input.schema.json` + `output.schema.json` + `allowlist.json`, colocated under `actions/<category>/<name>/`. Categories: `read`, `write`, `code`, `meta`.
- **job** — a running unit of work. Owns the editable plan + history. Lifecycle: `planning → plan_pending_review → executing → done`. Steps in `executing` jobs are mutable via the plan editor (insert, skip, reorder).

A **planner** is just an action whose job is to emit the plan — typically `meta.plan-job`, but a trigger can route to any planner-category action. The full action catalog is passed into the planner's envelope so it has visibility into every other action it can compose into a plan; no separate "playbook" primitive is needed.

"Agent" and "skill" remain Claude Code primitives; they are not Outpost-level terms.

### Permission groups

Each action declares its allowlist by inheriting named groups defined in `config/permission-groups.json`:

- **`core`** — implicit for every `runner: claude` action. Envelope-I/O baseline: `cat $OUTPOST_ENVELOPE`, `cat`, `jq`, the `mcp__outpost__*` submit tools (how a session reports results back to the daemon), and `ToolSearch`.
- **`read`** — local file reads + git-read-only (Read/Glob/Grep/LS, `ls`/`rg`/`grep`/`find`, `git status|log|diff|show|blame|branch|fetch|rev-parse|ls-files|grep|…`).
- **`pull`** — network reads (WebFetch/WebSearch, MCP `get_/list_/search_` patterns for Linear/Datadog/GitHub/Notion/Slack/incident-io/Grafana, `curl -s`, `gh pr view`/`gh pr checks`/`gh issue view`/`gh api`).
- **`edit`** — local writes + test runners (Edit/Write/MultiEdit path-scoped to `/tmp/`, mage/npm/yarn/pnpm/go/pytest/cargo, file ops `mkdir`/`mv`/`cp`/`rm`, local git `git rebase`/`checkout`/`merge`/`stash`/…). Edits inside the session's own worktree auto-allow via session scope — see `allows()` in `src/permissions/allowlist.ts`.
- **`push`** — external writes (`gh pr comment/merge/review/create`, `git push/commit/tag`, MCP write patterns for Linear/GitHub/Slack/Notion).

An action's frontmatter declares which groups it inherits:

```yaml
outpost:
  runner: claude
  permissions: [read, pull]  # core is implicit; this gets core + read + pull
```

Action-specific extras (narrower than a whole group) go in the colocated `allowlist.json`. The registry resolves `final = core (if claude) ∪ each group ∪ extras` and feeds that to the `Allowlist` checker.

## Commands

```bash
npm run dev          # tsx watch, reloads on change
npm start            # one-shot daemon
npm test             # vitest + playwright
npm run test:unit    # vitest only
npm run test:e2e     # playwright only
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
    {git,jobs,sessions,projects,push,runs,schedules,meta,util}.ts
  session/               # session lifecycle
    session-{manager,store}.ts, claude-proc.ts, stream-json.ts, event-log.ts
  work/                  # job orchestration
    orchestrator.ts, work-{queue,types}.ts, envelope.ts, reconcile.ts
  permissions/           # hook plumbing + gates
    hook-{handler,server}.ts, allowlist.ts, approval-mode.ts, approvals.ts
  git/                   # worktree + git ops + diff
    worktree-manager.ts, git-ops.ts, diff-{parser,endpoint}.ts
  integrations/          # external polling
    linear-{api,poller,writer}.ts, pr-watcher.ts, user-prs-watcher.ts, usage-{poller,ledger}.ts
  schedules/             # cron/event-triggered agent runs (routines)
    scheduler.ts, schedules-store.ts, guards.ts, routing.ts, types.ts, wiring.ts
  storage/               # persisted stores
    {journal,project-registry,actions,runs}-store.ts, runs-capture.ts, stop-hook-tracker.ts, recurrence-tracker.ts
  actions/, steps/, jobs/  # action registry + step handlers + job lifecycle

  pwa/                   # static client (plain ES modules, no bundler)
    app.js, index.html, sw.js, app-bridge.js, util.js, markdown.js, session-filter.js, deep-links.js
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
      ask-card.js, tool-use-tile.js, todos-{core,sheet}.js, sheet-utils.js,
      mobile-header.js, approvals-mobile.js, cwd-picker.js, theme-picker.js
    vm/                    # view-models (D2): pure derivations from raw store snapshots → row/card shapes.
                           # One file per surface ({cockpit,tracked,sessions,schedules,library,settings,runs}.js) + work-predicates.js.
                           # Zero DOM. Renderers are layout-agnostic; mobile-shell arranges the SAME renderers
                           # desktop's shell/surfaces.js uses — never a second copy.
    state/                 # store singletons (sessions, approvals, subagents, work, usage, settings, git,
                           # schedules, runs, actions, library, grants, nav, ...)
    net/                   # fetch wrappers per resource (actions, meta, runs, schedules, triggers, work)
    ws/                    # dispatch.js: WS message → store mutations
    layout/                # mobile vs desktop pick
    css/                   # base.css (tokens + global chrome), primitives.css (the canonical .o-* components),
                           # overlays.css (shared sheet/modal/popover chrome), app-shell.css (pre-JS bootstrap shell),
                           # shell-desktop.css, shell-mobile.css, desktop.css, palette.css, session-view.css,
                           # surfaces/{cockpit,tracked,sessions,schedules,library,settings,runs,diff}.css
                           # (legacy-components.css was dissolved into these per-surface sheets — see DESIGN.md, codename Signal)
    utils/                 # formatting.js, usage-bar.js (shared tier thresholds/popover), overflow-menu.js
```

### Where new code goes

- **New HTTP route** → factory function in `src/routes/<group>.ts`; wire it in `daemon.ts` (`registerXRoutes(server, deps)`). Do not inline routes into `daemon.ts`.
- **New backend concern** → the matching cluster subdir. If nothing fits, create a new subdir rather than dropping a file at `src/` root.
- **New PWA surface** → its own dir under `src/pwa/components/<surface>/index.js`, exporting `renderList`/`renderDetail`/`renderContext` as needed and registered in `shell/surfaces.js` (desktop) — `mobile-shell/index.js` mounts the *same* exports as a pushed screen, it does not reimplement the surface.
- **New PWA view-model** → `src/pwa/vm/<surface>.js`, pure functions only (no DOM, no store reads inside — callers pass raw snapshots in). This is what keeps desktop and mobile rendering the same derived data through different chrome.
- **Cross-module callback** a component needs from `app.js` → add a key to `src/pwa/app-bridge.js`'s bridge object and wrapper function, installed via `installAppBridge()` at boot. Don't import `app.js` from a component (creates cycles).
- **New PWA util** → `src/pwa/utils/<name>.js` if pure. Don't add another top-level `util.js`.
- **State stores** → `src/pwa/state/<name>.js`. Use the existing store shape (subscribable snapshot + typed mutators).

### Keep modules small

- Files hitting ~500 LOC should be looked at for extraction. `daemon.ts` and `app.js` used to be 2365 / 6501 lines; both were refactored (Dec 2026), and `app.js`'s WS handling has since moved out entirely into `pwa/ws/dispatch.js`. Regressing to that shape is a code smell.
- Route handlers larger than ~30 lines? Extract the handler body into a named function in the same route file.
- `Orchestrator` is the one remaining monolith — extraction is welcome but non-trivial (see Deferred below).

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
- **Two daemons can't run on the same `~/.outpost/`.** Use alternate ports for side-by-side testing, but stop the launchd instance first.
- **PWA modules extracted from `app.js` use a deps-injection pattern.** `initX({ callbackA, callbackB })` is how the extracted module gets app-side functions it can't cleanly import (would create cycles). `app-bridge.js` is the other half of this — a shared reserved-keys object for callbacks *multiple* components need, installed once via `installAppBridge()` rather than threaded through every `initX`. Follow one of these two patterns when adding more.

## Deferred

Legitimate remaining work (previously stale items pruned):

- **Orchestrator split.** `Orchestrator` in `src/work/orchestrator.ts` is ~1300 lines with methods that call each other via `this.mutate`/`this.appendEvent`. Splitting into plan/execution/pr/edits helper modules needs class-surgery — deferred.
- **Linear-write retry queue.** `orchestrator.ts` awaits `linearWriter.setState` and re-queues on next tick if it fails — fine because the call is rare and idempotent, but a backgrounded retry queue would let dispatch continue without blocking on Linear.
- **Action-scoped allowlist rules can't be revoked from Settings.** `DELETE /api/allowlist/rules/:id` handles global/project grants; action-scoped rules answer 409 pointing at the action editor, because removal needs an `ActionsStore.removeRule()` persistence method that doesn't exist yet.
- **e2e coverage gaps from the redesign.** `tests/e2e/expandable-projects.spec.ts` and half of `project-list.spec.ts` still target pre-redesign selectors (`.project-section`, `#add-project`) — add-project/new-session now live in the ⌘K palette. There's also no e2e coverage yet for the new desktop shell (`.o-topbar`/`.o-sidebar`/`.o-frame`) or the mobile shell's tab bar.

## Conventions

- ESM (`"type": "module"`), import paths end in `.js` even for `.ts` source. When moving files, update every importer.
- No comments restating code; comments only for non-obvious WHY (see existing files for tone).
- Errors at the boundary (user input, git, filesystem) — trust internal calls.
- Prefer editing existing files over creating new ones — but when a file is heading toward monolith territory (see "Keep modules small"), extract instead of adding to it.
