---
name: write.add-project
description: Use when a job needs a GitHub repository present on this machine and registered with Outpost — the goal names a repo that isn't in the project list yet, or a multi-repo project needs a fresh checkout before any code step can run against it. Clones the repo (full clone, never shallow) to a stable path outside `~/.outpost/worktrees`, then registers that path with the daemon so later steps can create worktrees against it. Idempotent — an existing matching clone is reused, an already-registered path is a no-op. Does NOT install dependencies, create branches, commit, or push.
outpost:
  kind: action
  category: write
  side_effects: gated-write
  runner: claude
  permissions: [read, pull]
  timeout_sec: 1800
  retries: 0
---

# write.add-project

Make a GitHub repo usable by Outpost: get it on disk at a durable path, then tell
the daemon about it. Two side effects, both local and both reversible — a new
directory on disk, and one new entry in the daemon's project registry. Nothing is
pushed anywhere; no remote is mutated.

This is a **setup** step. It exists so a downstream `code.*` step has a project to
branch from. Stop at "cloned + registered" — dependency installs, branch creation,
commits, and PRs belong to the steps that come after.

## Step 1 — read inputs

```bash
cat "$OUTPOST_ENVELOPE"
```

The envelope's `inputs` field:

| Field | Required | Meaning |
|---|---|---|
| `repo` | yes | GitHub repo reference. Accepts `owner/name`, `https://github.com/owner/name(.git)`, `git@github.com:owner/name.git`, or any github.com URL you can strip down to `owner/name` (`/tree/<branch>`, `/pull/123`, `/blob/...` suffixes included). |
| `dest` | no | Absolute path to clone into. When omitted, derive it (Step 3). |
| `branch` | no | Branch to check out after cloning. Default: the repo's default branch. |
| `recurse_submodules` | no | `true` to clone with `--recurse-submodules`. Default `false`. |
| `register` | no | Default `true`. Set `false` to clone without registering (rare — a plain checkout the job only reads). |

**If `inputs` is missing or empty** (older plans), fall back to the envelope's
top-level `goal` / `title` / `description` and pull the repo reference out of the
prose. If you cannot identify a repo, do **not** guess — fail the step (Step 7)
naming what was missing.

## Step 2 — resolve the repo

Normalize the reference to `owner/name`: drop the scheme/host, drop a trailing
`.git`, drop everything from the third path segment onward. Then confirm it exists
and you can read it:

```bash
gh repo view <owner>/<name> --json nameWithOwner,defaultBranchRef,isPrivate,isArchived,url
```

- **Not found / 404** → likely a typo or a private repo the current `gh` login can't
  see. Check with `gh auth status`, then fail the step (Step 7) with the distinction
  spelled out. Do not fall back to an unauthenticated `git clone` to "try anyway".
- **A bare name with no owner** (`cloud`, not `livekit/cloud`) → `gh repo view <name>`
  resolves against the authenticated user's own account. If that resolves, use the
  returned `nameWithOwner`. If it doesn't, fail and ask for `owner/name` — never
  guess an org.
- **Archived** is not a failure; note it in the output.

Record `defaultBranchRef.name` — you need it in Step 5 and in the output.

## Step 3 — choose the destination

If `dest` is set, use it verbatim (it must be absolute). Otherwise derive it:

```bash
cat ~/.outpost/projects.json
```

Take the parent directory that hosts the most already-registered projects and use
`<that parent>/<name>`. That keeps new clones next to their siblings and matches
whatever layout convention this machine already follows. If the registry is empty,
fall back to `$HOME/<owner>/<name>`.

Hard constraints on the destination — violating any of these makes the clone
unusable or corrupts daemon state:

- **Never** clone inside `~/.outpost/worktrees/` — the daemon owns that tree and
  creates worktrees there *from* registered projects.
- **Never** clone inside `~/.outpost/` at all, and never inside another git repo
  (check with `git -C <parent> rev-parse --show-toplevel`; a hit means you picked a
  path inside an existing checkout — pick another).
- The parent must be creatable under `$HOME`. `mkdir -p <parent>` if needed.

## Step 4 — is it already there?

This action is expected to re-run. Check the destination before cloning:

```bash
git -C <dest> rev-parse --show-toplevel
git -C <dest> remote get-url origin
```

- **Path doesn't exist** → clone it (Step 5).
- **Exists, is a git repo, and `origin` resolves to the same `owner/name`** (compare
  case-insensitively; treat `https://github.com/owner/name(.git)` and
  `git@github.com:owner/name.git` as equal) → **skip the clone.** Reuse it as-is. Do
  not fetch, reset, clean, or check out anything on a pre-existing checkout the user
  may have live work in — you don't know what's uncommitted there. Go to Step 6.
- **Exists but is not a git repo, or its `origin` points somewhere else** → **fail
  the step.** Do not delete it, do not clone over it, do not pick `<dest>-2`. Say
  what's there and suggest an explicit `dest`.

## Step 5 — clone

Create the parent, then clone. Prefer `gh` — it reuses the existing GitHub auth, so
private repos work without a token dance:

```bash
mkdir -p <parent>
gh repo clone <owner>/<name> <dest>
```

If `gh repo clone` is unavailable, fall back to:

```bash
git clone https://github.com/<owner>/<name>.git <dest>
```

Add `--recurse-submodules` (after `--` for `gh repo clone`) only when
`recurse_submodules` is true.

**Never** pass `--depth`, `--single-branch`, or `--bare.` The daemon creates git
worktrees off this checkout and code steps branch from `origin/<default>`; a shallow
or single-branch clone breaks both, and a bare clone has no working tree to register.

Those three are denied outright, and so is every other flag: the clone grant is a
whitelist of exactly the shape above — `owner/name` (or an `https://github.com/…` URL) plus
an absolute destination, with `--recurse-submodules` as the only option. That is not
tidiness. `git clone --upload-pack='<any command>' <path>` runs that command on this
machine, `-c protocol.ext.allow=always` with an `ext::` URL does the same, and `gh repo
clone` hands everything after `--` straight to git — so an open `git clone` grant is an
arbitrary-execution grant. If a denial lands here, the answer is the plain two-argument
clone, never a flag that "works around" it.

A clone of a large repo can take minutes. Let it run; don't wrap it in a timeout or
poll it.

If `branch` was requested and differs from the default:

```bash
git -C <dest> checkout <branch>
```

A branch that doesn't exist is a failure worth reporting, not something to create.

Verify the result before going on:

```bash
git -C <dest> rev-parse --show-toplevel
git -C <dest> log -1 --oneline
git -C <dest> branch --show-current
```

If any of these fail, the clone is incomplete — fail the step and say so rather than
registering a broken directory.

## Step 6 — register with the daemon

The project registry is daemon-owned in-memory state that gets persisted to
`~/.outpost/projects.json`. **Never hand-edit that file** — the daemon rewrites it
from memory on the next change and would clobber your edit. Register over HTTP:

```bash
curl -fsS -X POST "$OUTPOST_API_URL/api/projects" \
  -H 'content-type: application/json' \
  -d '{"cwd":"<dest>"}'
```

The daemon exports `$OUTPOST_API_URL` into every session it spawns, so the command
above works verbatim — prefer it over an interpolated literal. If the variable is
somehow empty, fall back to `http://127.0.0.1:8080` (the default loopback port), and
if that connection is refused find the real port with
`grep -h 'listening on http://127.0.0.1:' ~/Library/Logs/outpost.log | tail -1`.

Only `$OUTPOST_API_URL` and a `127.0.0.1`/`localhost` literal are allowlisted for this
POST, and only with the flags above — `-H`/`--header` and `-d`/`--data` carrying a literal
value. `-o`, `-T`, `-F`, `--next` and a `$(…)`/`$VAR` body all deny: `-o` overwrites any
local file without going near a shell redirection, and `--next` starts a second request
that the pinned URL says nothing about. Don't reach for `python`, `node -e`, or any other
HTTP client to work around a denial — a denial here means the command shape is wrong, not
that the tool is.

The endpoint is loopback-only and needs no auth header. It replies
`{"added":true|false,"cwd":"..."}`:

- `added: true` — newly registered.
- `added: false` — that cwd was already registered. **This is success**, not an
  error. Report it as `alreadyRegistered`.

Non-200 responses are specific and worth quoting verbatim in a failure: `cwd must be
absolute`, `cwd does not exist`, `cwd is not a directory`.

Confirm the registration landed by re-reading the registry:

```bash
cat ~/.outpost/projects.json
```

Your `<dest>` must appear in `projects[]`. If it doesn't, the POST didn't take —
fail the step; do not report success.

Skip this entire step when `register` is `false`, and say so in the output.

## Step 7 — deliver or fail

The deliverable is: **the repo is on disk at a durable path AND that path is in the
registry.** Check what you actually hold before submitting.

- Repo cloned (or an existing matching clone reused) **and** registered (or
  `register: false` was requested) → submit the result below.
- Anything short of that — repo unresolvable, no read access, destination occupied by
  something else, clone incomplete, POST rejected, path absent from
  `projects.json` → **the step failed.** Call `mcp__outpost__submit_step_failed`.
  Do NOT call `submit_step_output` with a hopeful summary.

A downstream `code.*` step is going to try to create a worktree against this project.
If it isn't really registered, that step fails with a confusing error far from the
cause. Fail loudly here instead.

Load the outpost MCP tools — they're deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output,mcp__outpost__submit_step_failed", max_results: 2 })
```

If they don't come back, halt — the daemon marks the step failed when your turn ends.
Do NOT try to return the result as your final chat message; the daemon does not
scrape transcripts.

Success:

```
mcp__outpost__submit_step_output({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  output: "{\"ok\": true, \"repo\": \"livekit/cloud-io\", \"url\": \"https://github.com/livekit/cloud-io\", \"cwd\": \"/Users/testuser/livekit/cloud-io\", \"cloned\": true, \"alreadyCloned\": false, \"registered\": true, \"alreadyRegistered\": false, \"defaultBranch\": \"main\", \"checkedOutBranch\": \"main\", \"headCommit\": \"a1b2c3d fix egress timeout\", \"isPrivate\": true, \"summary\": \"Cloned livekit/cloud-io to /Users/testuser/livekit/cloud-io and registered it as an Outpost project; on main at a1b2c3d.\"}"
})
```

Failure — make `reason` actionable: what was requested, what blocked it, and the
concrete unblock.

```
mcp__outpost__submit_step_failed({
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  reason: "Could not clone livekit/cloud-io: gh repo view returns 404 and `gh auth status` shows the active login has no access to the livekit org. Unblock: run `gh auth refresh -s read:org` (or re-auth as an org member) and re-run this step. Destination /Users/testuser/livekit/cloud-io is untouched."
})
```

Stop after submitting. Do not install dependencies, run builds or tests, create
branches, commit, push, or open a PR — a later step owns all of that. The `cwd` you
returned is what it will work in.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "write.add-project",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "cloned" | "reused" | "blocked",
  lesson: "<= 300 chars; concrete; what would surprise next-run-me?"
})
```

**Always journal a blocker** — a denied tool call, an allowlist gap, a missing or
ambiguous envelope field, a documented command that didn't exist, anything you had to
guess at or work around. Journal it even when you recovered and the step succeeded. These
recur identically on every future run of this action until a human sees them, and this
journal is the only place `meta.improve-actions` looks.

Name the exact command or field. "`git clone` denied — this action's `allowlist.json` has
no clone rule" is actionable; "permissions were too tight" is not. Skip the journal only
when the run was genuinely unremarkable; don't pad.
