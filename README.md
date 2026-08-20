# Outpost

**A command center for Claude Code.** Outpost is a background daemon that runs on your Mac and exposes a PWA — one control surface for starting, watching, approving, and shipping Claude Code work across every project on the machine.

It started as a remote transcript viewer. It's now three things stacked: a **session** client (drive Claude interactively, approve its tool calls, review the diff, open the PR), a **job** runner (hand it a goal, it plans a multi-step change and shepherds the PR through CI, review comments, conflicts, and merge — stopping at you for every external write), and a **scheduler** (work that fires on a cron, on an event, or on spare token headroom without anyone asking).

![Cockpit — everything parked on a human, in one place](docs/screenshots/cockpit.png)

## Concepts

Three primitives; everything else is detail.

- **action** — one atomic unit of work: a `SKILL.md` plus input/output schemas, under `actions/<category>/<name>/`. Categories are `read`, `write`, `code`, `meta`.
- **job** — a running unit of work with an editable plan and a history. Goes `planning → plan_pending_review → executing → done`.
- **step** — one row of a plan. Either a plain **action** step (spawn a session for one named action, take its output, settle) or an **orchestrated** step, where a *controller* action owns the step end to end and decides its own next move each turn — that's how a PR gets shepherded from spec through merge.

"Agent" and "skill" stay Claude Code's terms. They aren't Outpost-level concepts.

## Features

### The Cockpit is the only page you have to watch

Everything parked on a human lands in one inbox: pending tool approvals, jobs holding a write draft, steps sitting on a gate, plans waiting to be reviewed, anything that broke — alongside what's currently in flight. Nothing is persisted and nothing is ever "marked read"; a row is open because a predicate over live state holds, and it disappears when it stops holding.

(Screenshot above.)

### One launcher, three destinations

⌘K opens the palette: pick a project (recent, ephemeral worktrees, or known repos — or add one), type the prompt, pick a model, choose in-place or a fresh worktree. Then choose what it becomes:

- **↵** — an interactive session.
- **⌘⇧↵** — a tracked job. Auto-flips to a worktree; the orchestrator plans it.
- **⇧⌘S** — a schedule, seeded with the same prompt/cwd/model.

![⌘K palette with a composed prompt and the three launch actions](docs/screenshots/palette.png)

### Tracked jobs, with a plan you can edit

Hand Outpost a goal and the orchestrator investigates it, then emits a typed, ordered plan. You review the plan before anything runs. Once it's executing, the plan stays mutable — insert a step, skip one, reorder.

A controller step then runs its own loop: spec → plan → implement, then watch the PR. It reads what the PR watcher records (CI checks, review state, new comments, head moves) and picks its next move each turn — keep going, fan out to sub-actions, park on an event, ask you a question, or settle. A step is only allowed to call itself done when the PR it owns actually merged.

The right rail is the job's ledger: what needs you, every session the job has spawned, the branch/PR/age at a glance, and the recent activity trail down to which step registered which repo.

Jobs also arrive without you: an interactive session can be promoted to a job (⌘⇧P), and the built-in Linear routine files one per issue assigned to you.

![Tracked job: plan, an approval-gated merge draft, and the focus rail](docs/screenshots/tracked.png)

### Every external write stops for the exact payload

Actions can't post, push, merge, or file anything on their own. An action that wants an external write **drafts** it — the literal command, or the literal comment body — and stops. That's the card in the middle of the shot above: `code.merge-pr` proposing a squash merge and a branch delete, each command shown in full, with the evidence it based them on, and Accept / Propose changes / Deny.

You can edit the payload in place before accepting. Then the approved bytes are what runs, pinned: a session that "improves" the command after you approved it gets denied. Bodies too big for a command line are drafted inline and hashed, so the card always shows the actual content behind a `--body-file`. Risky calls are sorted by what you can *do* about them — some are refused outright because a correct alternative exists, some need a per-finding acknowledgement (a force-push, an `--admin` merge, `--mirror`), and the rest just carry a visible warning.

### Source control, without a terminal

A full git overlay on every session and job step: browse the log, review the diff side by side, stage or discard, and commit with a message Claude drafts (and you edit, or regenerate). Push, squash to the branch, merge to base, or open the PR — the overlay knows whether one is already open.

Review comments on a PR render inside their real diff hunk, with lines on both sides — not GitHub's truncated `diff_hunk`. Powered by local `git` and `gh`, so commits and PRs land under your real identity.

![Diff review overlay with a drafted commit message and ship actions](docs/screenshots/diff.png)

### Sessions that read like the CLI

Live transcript with per-tool chrome — git-style diffs for `Edit`, shell-prompt blocks for `Bash`, ripgrep-shaped output for `Grep`, Read excerpts — so a session scrolls like a story, not a JSON dump. Alongside it: the task list, `AskUserQuestion` rendered as a real card, and a rail showing model, cwd, mode, tokens, and connected MCP servers.

Toggle the session between **Ask**, **Plan**, **Accept edits**, and **Bypass** from the header — same vocabulary as the CLI. Each session remembers its own mode; set the default for new sessions in Settings.

### Selective approvals — no rubber-stamping

Every `PreToolUse` is intercepted. Reads, greps, and other safe calls run automatically per your allowlist; anything else queues an inline **Approve / Reject** card right where it would have run — including inside subagent feeds, so you can stop a runaway agent before it lands. Agent-spawned work gets its own tabbed feed with the spawn context pinned at the top, so you can watch and approve each agent without losing your place in the parent transcript.

### Routines — work that fires without you

Schedules run on a `cron`, `once`, on an `event`, or **opportunistically off spare token headroom** (your 5h/7d windows have room, so something useful runs). Guards can veto a firing. A routine runs one of four things: a catalog action, a free-text prompt, a plain shell script (no Claude session at all), or an in-daemon native handler. Findings can route to the Cockpit, a Slack webhook, or a PR/issue comment.

Five ship built-in: a nightly Claude Code updater, hourly Linear intake, the PR watcher (5m), your-open-PRs watcher (10m), and the action improver — which is gated on accumulated run evidence rather than a clock, so a firing with nothing to review records a skip instead of burning tokens.

![Schedules: the token-opportunistic action improver, its trigger, and its run history](docs/screenshots/schedules.png)

### Actions get better on their own

Every action round is recorded — outcome, cost, denial count, any lesson the action journaled about why it got stuck, and every tool call the allowlist blocked. That evidence feeds a scorecard per action, and a routine that picks the single action most worth improving and proposes a `SKILL.md` revision citing the specific runs that justify it. You approve or reject the diff; every version is kept and revertible.

Blocked calls surface on the action's own page, where they're evidence — not a place to grant a permission. That only happens in one place, below.

![Skills library: the action catalog and one action's SKILL.md with its blocked-call evidence](docs/screenshots/skills.png)

### Permissions you can actually read and edit

An action declares which named **groups** it inherits, and those groups are the only thing granting it anything:

| group | what it is |
|---|---|
| `core` | implicit for every Claude-backed action — read its envelope, report results back. No network. |
| `read` | local file reads + read-only git |
| `pull` | network **reads** only — anchored whitelists for `curl`, `gh api`, MCP `get_/list_/search_`, `kubectl get` |
| `edit` | local writes, dependency manifests, and test runners — scoped to the session's own worktree |
| `push` | external writes — **and gated**: a matching call runs only if you approved a draft pinning it |

The Permissions page edits those groups inline, rule by rule. Every edit is re-linted before it applies (a rule that would span a write, escape its allowed roots, or backtrack badly is refused with the reason shown against the offending row), reloaded in memory before it's written to disk, and recorded in the group's revision history — revertible, and re-validated on revert.

The same page lists every unresolved denial across all actions with three verdicts: never allow, promote into a group the action already inherits, or queue a fix to the action itself.

![Settings › Permissions: the five groups, with `edit`'s bash patterns expanded](docs/screenshots/permissions.png)

### Usage and context at a glance

A live readout of your 5-hour and 7-day usage windows sits in the sidebar, and per-session model / context / cache detail in the session rail — so you know when you're about to hit a limit before Claude does. It's also what the opportunistic scheduler reads to decide there's room to run something.

### Themes that don't look like every other dev tool

Nine hand-tuned palettes — Halcyon, Almanac, Terminal, Nordic, Ink, Botanical, Plasma, Atlas, Library — each in light and dark, plus three row densities. Terminal is genuinely brutalist; Almanac is an editorial serif. They are not nine tints of the same blue.

## Quick start

Run Outpost on the Mac where your projects live:

```bash
git clone https://github.com/frostbyte73/outpost.git
cd outpost
npm install
npm start
```

Then open `http://localhost:8080`. That's it — the daemon binds the PWA to loopback and you're in. `npm start` runs it in the foreground for a quick look; to keep it running on login and restarting on crash, install it as a LaunchAgent (below). To reach it from another machine, see [Remote access over Tailscale](#remote-access-over-tailscale-optional) — the localhost listener stays available either way.

## Prerequisites

- **macOS** (this is a launchd LaunchAgent; nothing else is supported).
- **Node.js 22+** on `PATH`.
- **Claude Code CLI** (`claude`) installed and authenticated for the user the daemon runs as.
- **GitHub CLI** (`gh`) for anything PR-shaped — the source-control overlay's "Open PR", and every `code.*` action. `brew install gh && gh auth login`.

> **The daemon has to be running.** Outpost runs locally on your Mac, so the PWA is only reachable while the machine is awake. The installer wraps the daemon in `caffeinate -is` to block idle and AC-power system sleep, but closing the lid on a Mac without an external display still triggers sleep regardless. If you want Outpost reachable while you're away from the machine, leave it plugged in with the lid open.

## Run it in the background

`npm start` is a one-shot foreground process. For everyday use, install Outpost as a LaunchAgent.

### (Optional) Set up secrets in `~/.outpost/.env`

macOS launchd strips your shell's env when it spawns the daemon, so anything Claude subprocesses need at runtime has to reach the daemon explicitly. The simplest way is a `~/.outpost/.env` file the daemon sources at startup:

```bash
cat > ~/.outpost/.env <<'EOF'
# Lets `gh` act under a specific identity for PR creation / lookups.
# Without it, gh falls back to its own auth.
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Enables the built-in hourly Linear intake routine (one job per issue
# assigned to you). Absent, that routine stays disabled rather than
# recording an error run every hour.
LINEAR_API_TOKEN=lin_api_...

# Any other secrets your MCP servers or hooks expect.
EOF
chmod 600 ~/.outpost/.env
```

Standard `KEY=value` syntax, `#` comments allowed, `export KEY=value` tolerated. Anything already set in the plist or shell wins over the file, so the file is the safe place for secrets you don't want baked into LaunchAgent XML.

### Review the permissions before going live

Two files govern what runs without asking, and they answer different questions:

- **`config/permission-groups.json`** — what an *action* may do. Seeded from the tracked `config/permission-groups.default.json` on first start, then reconciled against it on every boot (your local additions survive, your local deletions stay deleted). Editable from Settings › Permissions.
- **`config/allowlist.json`** — what an *interactive session or skill* may do without queueing an approval card. Seeded from `config/allowlist.default.json`. Three lists: `alwaysAllow` (exact tool names), `alwaysAllowBashPatterns` (regex against a `Bash` call's `command`), `alwaysAllowMcpPatterns` (regex against `mcp__<server>__<tool>`), plus an optional `alwaysAllowPathPatterns` for path-scoped write tools.

Both runtime files are gitignored per checkout, so rules you hot-add in a worktree don't leak into your real install. The defaults auto-approve read-only tools and queue everything else — **open them and trim or extend before going live.**

### Install the LaunchAgent

```bash
install/install.sh
```

This writes `~/Library/LaunchAgents/local.outpost.$USER.plist`, loads it, and prints the pid on success. The daemon starts at every login and auto-restarts on crash. Logs land in `~/Library/Logs/outpost.{log,err.log}`. It discovers every project under `~/.claude/projects/` at startup and keeps its own registry of added repos, so there's no "pick one workspace" step.

## Configuration

The daemon reads env vars at startup, in this precedence: **plist `EnvironmentVariables` > `~/.outpost/.env` > built-in defaults.** For most users the defaults are fine and the only thing to touch is `~/.outpost/.env`.

To override a default permanently, edit `~/Library/LaunchAgents/$PLIST_LABEL.plist`, add the key under `<key>EnvironmentVariables</key>`, then `launchctl kickstart -k gui/$UID/$PLIST_LABEL`.

| Var | Default | Purpose |
|---|---|---|
| `OUTPOST_HTTP_PORT` | `8080` | Plain-HTTP loopback listener port. Set to `0` to disable it — with Tailscale also unavailable, the daemon refuses to boot rather than start with no listener. |
| `OUTPOST_HTTPS_PORT` | `8443` | Port the PWA + WebSocket listen on over the tailnet. |
| `OUTPOST_HOOK_PORT` | `8444` | Loopback-only port the `PreToolUse` hook posts to. |
| `OUTPOST_PLIST_LABEL` | `local.outpost.$USER` | LaunchAgent label. Export **before** running `install/install.sh` for an org-style prefix like `com.example.outpost`. |
| `OUTPOST_RUNTIME_DIR` | `~/.outpost` | Where certs, jobs, worktrees, the installed action tree, and `.env` live. |
| `OUTPOST_PROJECTS_ROOT` | `~/.claude/projects` | Where the daemon scans for projects/sessions. |
| `OUTPOST_HOST` | auto-detected | Tailnet hostname used to locate the TLS cert+key in `OUTPOST_RUNTIME_DIR`. Override if auto-detection picks the wrong one. |
| `OUTPOST_BIND_ADDRESS` | auto-detected | Address the HTTPS listener binds. |
| `OUTPOST_APPROVAL_TIMEOUT_MS` | `600000` (10 min) | How long a pending approval card waits before the hook auto-rejects. |
| `OUTPOST_STOP_THRESHOLD_MS` | `30000` | How long a session must be idle before a stop-hook counts it as done (drives "needs you" notifications). |
| `OUTPOST_PUSH_TTL_SECONDS` | `60` | TTL on outgoing Web Push messages. |

Anything else (`OUTPOST_CERT_PATH`, `OUTPOST_KEY_PATH`, `OUTPOST_ALLOWLIST_PATH`, `OUTPOST_VAPID_PATH`, `OUTPOST_PUSH_SUBS_PATH`) exists for power users — see `src/config.ts` for the full list.

## Remote access over Tailscale (optional)

By default Outpost only listens on `localhost`. To reach it from another machine, put both on the same [Tailscale](https://tailscale.com) tailnet and let the daemon serve HTTPS on its tailnet hostname. Nothing is exposed to the public internet.

**1. Install Tailscale on both machines.** On the Mac running the daemon:

```bash
brew install --cask tailscale-app   # or download from https://tailscale.com/download/mac
```

Open the menu-bar app and sign in, then confirm `tailscale status` shows a `100.x.y.z` IP. Install Tailscale on the other machine and sign in with the **same account** so the two show up in the same tailnet.

**2. Enable HTTPS + MagicDNS** for your tailnet in the Tailscale admin console (a one-time account setting, not on the device). This gives the Mac a stable `<host>.ts.net` name and lets you mint a real TLS cert for it — both of which the daemon needs. Follow Tailscale's [HTTPS / MagicDNS guide](https://tailscale.com/kb/1153/enabling-https).

**3. Provision a TLS cert+key** for that hostname (run on the Mac):

```bash
HOST=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')   # e.g. your-mac.tailXXXX.ts.net
mkdir -p ~/.outpost
tailscale cert \
  --cert-file ~/.outpost/$HOST.crt \
  --key-file  ~/.outpost/$HOST.key \
  $HOST
```

The daemon reads these files at startup. If they're missing or unreadable it logs the exact `tailscale cert` command to run and falls back to the loopback listener, so you can skip this step and let the daemon tell you what to type.

**4. Open the PWA** from the other machine at the tailnet hostname:

```
https://<your-tailnet-hostname>.ts.net:8443/
```

Make sure Tailscale is signed in and toggled on there first — it only routes traffic while actively connected. If the page doesn't load, that's the usual culprit.

## Uninstall

```bash
launchctl bootout gui/$UID/local.outpost.$USER
rm ~/Library/LaunchAgents/local.outpost.$USER.plist
rm -rf ~/.outpost
```

`~/.outpost` holds your jobs, worktrees, run history, and action tree — back it up first if you might want any of it.

## Development

```bash
npm run dev          # tsx watch, reloads on change
npm start            # one-shot daemon
npm test             # vitest + playwright
npm run test:unit    # vitest only
npm run test:e2e     # playwright only
npx tsc --noEmit     # NOT in the test gate — run this yourself
```

The daemon binds `:8080` (loopback PWA + WS, plain HTTP), `:8443` (tailnet PWA + WS, HTTPS), and `:8444` (loopback hook endpoint). The hook endpoint is loopback-only and authenticated with a per-launch secret written into Claude's `settings.json` at startup — see `src/permissions/hook-server.ts` for the rationale.

`CLAUDE.md` is the real orientation document for working inside this repo: the permission model rule by rule, the controller loop's guards and why each exists, where new code goes, and the gotchas that have already bitten. Read it before changing anything under `src/permissions/` or `src/work/`.

### Running side-by-side with the installed daemon

Two daemons can't share `~/.outpost/` — `index.json` files use atomic rename for persistence and a second writer will race. Stop the LaunchAgent first, then spin up an alternate-port instance from your checkout:

```bash
launchctl bootout gui/$UID/local.outpost.$USER         # stop the installed daemon
OUTPOST_HTTPS_PORT=8543 OUTPOST_HOOK_PORT=8544 \
  npx tsx src/daemon.ts                                # the test instance
```

Open `https://<host>.ts.net:8543/` to drive it. Restart the real daemon with:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/local.outpost.$USER.plist
```

After merging work into the installed checkout, `launchctl kickstart -k gui/$UID/local.outpost.$USER` is the cleanest way to pick up new code — `unload`/`load` trips on the `KeepAlive` race.

The permission files are the exception to "don't run side-by-side": each checkout has its own gitignored `config/allowlist.json` and `config/permission-groups.json`, so rules hot-added in a worktree don't leak into prod.

## Architecture

Backend is clustered by concern under `src/`; nothing new goes at the root.

| path | what lives there |
|---|---|
| `src/daemon.ts` | entrypoint — wires modules, installs route factories |
| `src/server.ts` | HTTPS + WS surface for the PWA (loopback + optional tailnet listener over one handler) |
| `src/mcp-server.ts` | MCP surface spawned Claude sessions report results through |
| `src/routes/` | HTTP route factories, one file per resource group |
| `src/session/` | session lifecycle — subprocesses, WS fanout, transcript replay |
| `src/work/` | job orchestration — the engine, envelopes, write drafts, the controller runtime |
| `src/steps/` | per-step-kind handlers, incl. the orchestrated policy that bounds a controller |
| `src/permissions/` | the `PreToolUse` gate — scopes, rules, the bash lexer, the write-shape lint |
| `src/actions/` | action registry, scorecards, improvement packs |
| `src/schedules/` | cron / event / token-opportunistic routines |
| `src/integrations/` | external polling — PR watchers, Linear, usage |
| `src/git/` | worktrees, git plumbing, diff parsing |
| `src/storage/` | persisted stores (all atomic-rename) |
| `src/pwa/` | the static client — plain ES modules, no bundler. `src/pwa/DESIGN.md` is its own orientation doc. |
| `actions/` | the shipped action catalog (`read` / `write` / `code` / `meta`) |
