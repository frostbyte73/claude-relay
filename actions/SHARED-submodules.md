# Moving a git submodule pin

Some repos vendor a dependency as a git submodule rather than through a package manager —
`server-sdk-ruby`, `server-sdk-kotlin` and `rust-sdks` all vendor `livekit/protocol` this way.
Bumping one is **the payload of the step, not a chore to hand back to the user.** This file is
the mechanics; your own `SKILL.md` says when the bump is yours.

**Where this file lives.** `~/.outpost/actions/SHARED-submodules.md` — two levels above your
own action's directory, and outside what your `Read`/`Grep` grant (if you have one) reaches.
Use `cat` with the tilde spelling, exactly as written:

```bash
cat ~/.outpost/actions/SHARED-submodules.md
```

## The sequence

Your worktree arrives with submodules already populated at the current pin, so normally you
only need the three lines that move it:

```bash
git -C <path> fetch origin                                  # get the target commit locally
git update-index --add --cacheinfo 160000,<full-sha>,<path> # move the gitlink in the index
git submodule update <path>                                 # sync the working tree to the new pin
```

Then confirm, and only then report the bump as done:

```bash
git submodule status         # the path must show the new sha with NO leading + or -
git diff --cached <path>     # one line: Subproject commit <old> -> <new>
```

Notes that matter:

- **Use the full 40-character sha.** A short one is accepted by some git versions and not
  others, and a wrong-length operand denies rather than failing loudly.
- **If the submodule path is empty** — a worktree provisioned before population became
  automatic — run `git submodule update --init <path>` first.
- **`git submodule update <path>` does not undo the previous line.** It moves the *working
  tree* to match the index, not the reverse. Running it is what stops a later `git add <path>`
  from quietly reverting the gitlink to whatever is checked out.
- **Order matters if you also edit files that depend on the new schema.** Those files will not
  compile until the gitlink moves, so move it in the same round.

## What is denied, and why not to go looking

These all fail, and none of them has a spelling that works:

| Denied | Why |
|---|---|
| `git -C <path> checkout <sha>` | no destructive git verb is reachable against a repo other than the one you were given, and a submodule counts |
| `git -C <path> reset --hard <sha>`, `git -C <path> switch --detach <sha>` | same bar |
| `cd <path> && git checkout <sha>` | `cd` is denied outright; your cwd is already the worktree |
| `git submodule add`, `deinit`, `set-url`, `foreach` | `foreach` is an interpreter wearing a git verb; the rest are not bump operations |
| `git submodule update --reference <path>` | takes a path outside the worktree and links its objects in as alternates |
| `git clone`, `cp -R` | a submodule is not populated by copying one in |
| `git update-index` with any mode but `160000` | `160000` is the gitlink mode. Other modes stage arbitrary file content, bypassing `Edit`/`Write` path scoping — that is the bar, not an oversight |

The `--cacheinfo` route above exists precisely so none of these is needed. If it is failing,
read the error rather than reaching for the next spelling: past rounds burned five and six
attempts cycling through `checkout` → `switch` → `reset` and ended up handing the step back
with the work undone.

## Regeneration

A bump is usually followed by regenerating from the new schema — `./generate_proto.sh`,
`rake proto`, a gradle task. Run it if the repo's tooling is actually available to you. If it
is not (no `cargo` on `PATH`, no JDK, a generator binary that isn't installed), say so plainly
and name what you could not verify. Some repos regenerate in CI and auto-commit onto your
branch, in which case skipping it locally is correct — but the *gitlink* still has to land, or
CI regenerates at the old pin and the branch is permanently red rather than transiently.
