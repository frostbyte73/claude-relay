---
name: code.security-review
description: Read the uncommitted/branch diff in a worktree and return structured security findings (OWASP Top 10 + STRIDE lens) with severity, category, file, line, and comment. Read-only — recommends only, does not edit.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# code.security-review

Security review of an uncommitted/branch diff through an OWASP Top 10 + STRIDE lens. Does not modify files.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `workspace.repoCwd` | yes | Parent repo path. |
| `workspace.branch` | yes | Branch under review. |
| `context` | no | Optional `{goal, approach, risks}` from the step that produced the diff. |
| `diffRange` | no | Git diff range to review instead of the uncommitted diff — see below. |

## Ground the review in the trust model first

If `diffRange` is absent, run `git status` + `git diff` to see the changes — the default, unchanged behavior: an uncommitted working-tree diff. If `diffRange` is set, run `git diff <diffRange>` instead (e.g. `git diff abc123...def456`) and skip `git status`, since the range itself is the diff under review and there's nothing uncommitted to check.

`diffRange` exists for reviewing a PR's worktree, which is a clean detached checkout with no uncommitted changes — `git diff` there finds nothing and this action would report "no findings" on a diff it never examined. Pass the three-dot form, `<merge-base>...<head>`, never `<base>..<head>` (two dots): three dots means "what this branch actually introduced since it forked" (`git diff A...B` *means* `git diff $(git merge-base A B) B` — semantics, not a recipe: `git merge-base` is not in this action's grant and running it is denied, so write the three dots and let git find the base), while two dots also drags in whatever landed on the base branch after the fork, and you'd flag someone else's commit as the PR author introducing a vulnerability they never wrote.

Then read CLAUDE.md (and any `AGENTS.md` under the touched area) *before* you flag anything, so findings reflect the repo's actual trust boundaries instead of generic ones. Understand a defense before reporting its absence, and don't flag an intentional guard as a bug. Examples of deliberate guards in this repo:

- The hook server is loopback + secret-header gated (`src/permissions/hook-server.ts`) — any new hook endpoint must validate the secret.
- The `sessionId`/branch regexes in `src/git/worktree-manager.ts` are deliberate path-traversal / argv-flag-smuggling defenses, with `--` as a second layer.
- `~/.outpost/` state uses atomic rename for persistence.

## What to look for

- Injection — SQL, OS/command, template, argument injection.
- Broken authn/authz — missing or incorrect access checks at trust boundaries; the loopback hook-server secret header on any new hook endpoint.
- Secrets / credentials committed — API keys, tokens, private keys, `.env` contents in the diff.
- SSRF and unvalidated outbound requests.
- Path traversal and git argv-flag smuggling (leading-`-` identifiers, unseparated user input in `git` argv).
- Unsafe deserialization / `eval`-class sinks.
- Missing input validation at trust boundaries (network/user input reaching the daemon or a subprocess).
- XSS / CSRF on the PWA surface (`src/pwa/`) — unescaped HTML injection, missing origin checks on state-changing requests.
- Insecure or misused crypto — weak algorithms, hardcoded keys/IVs, non-constant-time secret comparison, predictable randomness for security tokens.
- STRIDE lens — Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege — as a completeness backstop for threats the concrete list above doesn't name.

Be sparing with `severity: "error"` — reserve it for issues an attacker could actually exploit given the diff. Speculative or defense-in-depth observations are `warn`; informational notes are `info`. When a checklist item has no findings, return fewer issues rather than filler.

Each issue's `category` is a short recognizable bucket: prefer the OWASP 2021 code where one fits (e.g. `A01:2021-Broken Access Control`, `A03:2021-Injection`, `A02:2021-Cryptographic Failures`), else a `STRIDE:<category>` label (e.g. `STRIDE:Tampering`).

## Output

```jsonc
{
  "summary": "Three files changed; one command-injection sink in the git wrapper, one secret logged at debug.",
  "issues": [
    { "severity": "error", "category": "A03:2021-Injection", "file": "src/git/git-ops.ts", "line": 88, "comment": "Branch name interpolated into git argv without a -- separator; a leading-dash name is parsed as a flag." },
    { "severity": "warn",  "category": "A09:2021-Security Logging and Monitoring Failures", "file": "src/session/claude-proc.ts", "line": 40, "comment": "Auth token included in a debug log line." }
  ]
}
```

The outpost MCP tools are deferred behind ToolSearch — load the schema first:

```
ToolSearch({ query: "select:mcp__outpost__submit_step_output", max_results: 1 })
```

If the tool doesn't come back, halt. The daemon will mark the step failed when your turn ends. Do NOT try to submit the review as your final text message.

Then call `mcp__outpost__submit_step_output` with `output` set to the JSON-stringified review object. Stop.

## Before you exit — journal a blocker

`submit_journal` is deferred behind ToolSearch:

```
ToolSearch({ query: "select:mcp__outpost__submit_journal", max_results: 1 })
```

```
mcp__outpost__submit_journal({
  action: "code.security-review",
  jobId: "<$JOB_ID>",
  stepId: "<$STEP_ID>",
  outcome: "reviewed" | "blocked",
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
