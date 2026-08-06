---
name: code.review-ui
description: Read the uncommitted/branch diff in a worktree and return structured UI/UX + design-system-conformance findings (severity, category, file, line, comment) for PWA-facing changes, checked against DESIGN.md, the .o-* primitives, and the desktop/mobile parity model. Read-only — recommends only, does not edit.
outpost:
  kind: action
  category: code
  side_effects: none
  runner: claude
  permissions: [read]
  timeout_sec: 600
  retries: 0
---

# code.review-ui

Read-only UI/UX + design-system review of PWA-facing changes. Does not modify files.

## Inputs

| Field | Required | Meaning |
|---|---|---|
| `workspace.repoCwd` | yes | Parent repo path. |
| `workspace.branch` | yes | Branch under review. |
| `context` | no | Optional `{goal, approach, risks}` from the step that produced the diff. |
| `diffRange` | no | Git diff range to review instead of the uncommitted diff — see below. |

## Ground the review in the design system first

If `diffRange` is absent, run `git status` + `git diff` to see the changes — the default, unchanged behavior: an uncommitted working-tree diff. If `diffRange` is set, run `git diff <diffRange>` instead (e.g. `git diff abc123...def456`) and skip `git status` — the range itself is the diff under review, there's no uncommitted state to check.

`diffRange` exists for reviewing a PR's worktree, which is a clean detached checkout with no uncommitted changes — `git diff` there finds nothing and this action would report "no issues" on a diff it never looked at. Pass the three-dot form, `<merge-base>...<head>`, never `<base>..<head>` (two dots): three dots is "what this branch actually changed since it forked" (`git diff A...B` *means* `git diff $(git merge-base A B) B` — semantics, not a recipe: `git merge-base` is not in this action's grant and running it is denied, so write the three dots and let git find the base), while two dots also pulls in whatever landed on the base branch after the fork, and you'd flag other people's code as the PR author's.

Then, *before flagging anything*, read (when present):

- `src/pwa/DESIGN.md` — the design language, codename **Signal**: color is fully tokenized in `base.css` across 9 themes × {dark, light} (never a raw hex/`rgba()` in a component); `.o-*` is the canonical component namespace; the left-edge colored border is the load-bearing state-rail motif; `.o-microhead` is the eyebrow/micro-label; `.o-row` is the canonical list row; design dark-first, then verify light.
- The **PWA section of the root `CLAUDE.md`** — surface/`vm` layout rules (one dir per surface under `components/`, a pure view-model per surface under `vm/`), the deps-injection / `app-bridge` patterns, and "keep modules small".
- `src/pwa/css/primitives.css` and `src/pwa/css/base.css` (the actual `.o-*` set and token names) and `src/pwa/css/overlays.css` (shared sheet/modal/popover chrome).

Understand a convention before reporting its absence, and don't flag a deliberate pattern as a bug. If `DESIGN.md` is absent (a non-PWA repo), fall back to CLAUDE.md + observed conventions and say so in the `summary`.

## What to look for

- **`design-system`** — uses the canonical `.o-*` primitives + `base.css` tokens rather than bespoke markup or one-off styles; no raw hex / `rgba()` in a component (Signal's hard rule); new overlays reuse `overlays.css` chrome; no revival of retired legacy looks (mono-uppercase buttons, `.ghost-btn`/`.step-action`/`.work-btn`, `.o-group-hdr` clones — point at `.o-microhead`); uppercase only in micro-labels / nano-tags.
- **`parity`** — rendering derives from a pure `src/pwa/vm/<surface>.js` view-model, and `mobile-shell` mounts the *same* renderers/exports `shell/surfaces.js` uses — never a second copy. Flag divergent or duplicated desktop-vs-mobile render logic, and any DOM or store-read leaking into a `vm/` file (the view-model must stay pure).
- **`layout`** — information hierarchy: header/eyebrow metadata stacked into inner rows, not crammed onto one line (a repeatedly-corrected house rule); 4px-grid spacing; correct state-rail / Signal emphasis (structure silent, signal loud).
- **`a11y`** — `:focus-visible` states, keyboard navigability, `aria`/labels on interactive controls, and sufficient contrast in *both* light and dark themes.
- **`states`** — responsive/overflow behavior (menus, truncation) and empty / loading / error states for any new list or surface.

Be sparing with `severity: "error"` — reserve it for broken/unusable UI (unreadable contrast, a control that can't be reached, a surface that duplicates instead of sharing and will drift). Conformance nits and polish are `warn`; observations are `info`. When a checklist bucket has no findings, return fewer issues rather than filler.

Each issue's `category` is one of `design-system` / `parity` / `layout` / `a11y` / `states`.

This is a *static* review — it reads the diff and the relevant PWA source; it does not run the app, drive a browser, or take screenshots. Runtime / visual-regression review is a separate future action.

## Output

```jsonc
{
  "summary": "Two components changed; one hard-coded color bypassing tokens, one mobile path re-implementing the desktop row renderer.",
  "issues": [
    { "severity": "warn",  "category": "design-system", "file": "src/pwa/components/cockpit/index.js", "line": 88, "comment": "Raw #1e88e5 instead of an --accent token; violates the token-only rule." },
    { "severity": "error", "category": "parity", "file": "src/pwa/components/mobile-shell/index.js", "line": 142, "comment": "Re-implements the cockpit row instead of mounting the shared renderer; the two will drift." }
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
  action: "code.review-ui",
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
