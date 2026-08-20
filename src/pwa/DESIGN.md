# Outpost — Design Language

> Codename **Signal**. This is the single source of truth for how Outpost looks and
> feels. Every UI update, rewrite, and new surface follows it. When a rule here
> conflicts with something already in the CSS, the CSS is wrong — fix the CSS.
>
> This document is prescriptive, not descriptive. It does not catalog what exists
> today (much of which was pulled in from different dev cycles and disagrees with
> itself). It defines what we're converging on.

---

## 1. The idea

Outpost is a control surface for autonomous agents working at the frontier of what
software can do. It should feel like a **precision instrument** — a glass cockpit,
a mission-control console — not a web app. Calm, machined, dense, and quietly
confident. The kind of tool where every hairline is intentional and nothing is
decorative-by-accident.

The whole system reduces to one principle:

### Structure is silent. Signal is loud.

- **Structure** — the frame, surfaces, hairlines, labels, neutral text, resting
  rows. This is ~95% of every screen and it is deliberately quiet: graphite,
  monochrome, low-contrast, no color. It recedes so the operator can scan.
- **Signal** — anything that is *live*, *actionable*, or *demands a decision*.
  This is where color, motion, and weight are allowed. It is scarce by design.

If you remember nothing else: **color is a resource you spend, not a paint you
apply.** A screen where everything is accent-cyan is a screen where nothing is.
The polish people react to ("woah") comes from restraint — a mostly-monochrome
instrument with one live signal glowing exactly where the eye should go.

---

## 2. Color

### 2.1 The token system (keep it, obey it)

Color is fully tokenized in `base.css` across 9 themes × {dark, light}. **Never
write a hex value or `rgba()` in a component.** Always reference tokens. The token
families:

| Family | Tokens | Meaning |
|---|---|---|
| Surfaces | `--bg` · `--bg-elev` · `--bg-elev-2` | deepest → most elevated plane |
| Hairlines | `--line` · `--line-soft` | dividers / borders |
| Text | `--text` · `--text-mute` · `--text-dim` | brightest → dimmest |
| Primary signal | `--accent` · `--accent-soft` | live / actionable / selected |
| Secondary accent | `--accent-2` · `--accent-2-soft` | structural, non-competing |
| State: good | `--ok` · `--ok-soft` | done / success / passing |
| State: attention | `--warn` · `--warn-soft` | needs you / caution |
| State: bad | `--danger` · `--danger-soft` | failed / error / destructive |

Dark is the default and the design's home turf. Light is a first-class port, not
an afterthought — but design for dark first, then verify light.

### 2.2 When to use each color — the rulebook

This is the part that was inconsistent. Here is the single answer.

**Neutrals (bg / line / text) — the default for everything.**
Reach for a neutral first. Most rows, cards, labels, body text, resting icons,
and secondary buttons are pure graphite. If you can't articulate why an element
is *live or actionable*, it stays neutral.

**`--accent` — the one live signal.** Use it, and only it, for:
- the **single primary action** in a view (one solid-accent button per screen);
- the **current selection** (open row, active nav item, focused input border);
- **in-progress / live** state (the pulsing dot, the streaming rail);
- **links** and interactive text;
- the **brand mark**.

Budget: aim for **at most one solid-accent element per viewport**. Everything
else that "uses accent" should use it as a *tint* (soft background) or as
*colored text/border*, not as a filled block. Two solid-accent blobs on screen
means one of them is lying about its importance.

**`--accent-2` — structural accent, never a call-to-action.** It is deliberately
desaturated and dimmed (see the luminance notes in `base.css` — we tuned it to
sit well below accent so hierarchy is unambiguous). Use for:
- parallel-group rails and other *structural* diagram lines;
- secondary machine metadata (e.g. a branch name next to a PR);
- decorative gradients (brand dot, avatar).
Never use `--accent-2` to say "click here" or "look here." That's `--accent`'s job.

**State colors are state, not decoration.** They mean something specific and
consistent everywhere:
- **`--ok`** → terminal success: done, merged, CI passing, verdict resolved.
- **`--warn`** → *needs the operator's attention* and caution: review-pending,
  a plan waiting for approval, an unread count that matters, a focus-card edge.
  Warn is "your move." It is the color of the thing you should look at next.
- **`--danger`** → failure and destruction: a failed step, an error line, a
  destructive control (delete, cancel, reject).

Never use a state color for emphasis when the state isn't true. A green label on
something that isn't "done" is a bug.

**The `-soft` variants** are the tint form of each color — a ~10–16% wash used as
a *background* behind the matching solid color (a warn pill is `--warn` text on
`--warn-soft` fill; an accent callout is `--accent` border/text on `--accent-soft`
fill). Rule: **the fill and the ink must be the same family.** Never put
`--warn`-family text on an `--accent-soft` fill.

### 2.3 Fill vs. tint vs. ink — one decision tree

Given a colored element, pick exactly one treatment:

1. **Solid fill** (`background: --accent; color: --bg`). Maximum weight. Reserved
   for: the one primary CTA, and active timeline/status dots. If you're reaching
   for a second solid fill, you probably want a tint.
2. **Tint** (`background: --x-soft; color: --x`). Medium weight. Pills, badges,
   callouts, soft edges. This is the default for "colored but not shouting."
3. **Ink only** (`color: --x`, no fill). Minimum weight. Links, state text,
   metadata, icons.

### 2.4 Text hierarchy

Three levels, used consistently:
- `--text` — primary content: titles, values, the thing being read.
- `--text-mute` — supporting content: descriptions, sub-rows, resting body.
- `--text-dim` — chrome: labels, timestamps, counts, disabled, resting icons.

Don't invent intermediate greys. If `--text-mute` feels wrong, the problem is
usually layout, not another shade.

---

## 3. Typography

### 3.1 The three typefaces and what each one *means*

- **`--font-body`** (Public Sans, or a themed serif) — everything a human reads.
  UI labels, titles, descriptions, button text, prose.
- **`--font-mono`** (JetBrains Mono) — **machine truth, and only machine truth.**
  Code, file paths, shell commands, IDs and `ABC-15`-style refs, branch names, PR
  numbers, token counts, hashes, keyboard keys, and the small uppercase machine
  tags (`∥ parallel`, `initial`). If a human wrote it as prose, it is *not* mono.
- **`--font-display`** (theme-dependent: Instrument Serif, Fraunces, or the body
  sans) — page and detail titles, section headers, and empty-state flourishes.
  Display is for the largest 2–3 pieces of text on a screen. Not for body.

The single most important typographic rule — and the one most violated today:
**buttons and actions are body font, sentence case, no letter-spacing.** The
legacy mono-uppercase button look is retired. Mono is reserved for machine truth;
a button is a human affordance.

### 3.2 Type scale

Discrete steps. Do not use in-between sizes (the stray 11.5 / 12.5 / 13.5px
values scattered through the CSS are bugs — snap them to the scale).

| Role | Size | Font | Weight | Notes |
|---|---|---|---|---|
| Display / detail title | 22px | display | 500 | tracking −0.01em |
| Section title | 18px | display | 500 | list headers |
| Row / card title | 14px | body | 500 | |
| Body | 14px | body | 400 | line-height 1.55 |
| Body small | 13px | body | 400 | dense sub-content |
| Meta / caption | 12px | body | 400 | timestamps, sub-rows |
| Micro-label | 11px | body | 600 | **uppercase, 0.08em** — see below |
| Nano tag | 10px | mono | 500 | machine tags, indices; may be uppercase 0.1–0.14em |

**The uppercase micro-label** (eyebrows, section labels, "RECENT ACTIVITY") has
**one** canonical spec: `11px / 600 / uppercase / letter-spacing 0.08em /
--text-dim`. It already exists as `.o-microhead` in `primitives.css`. Use that
class. Stop re-declaring the five properties inline — several files already do
this with a "matches .o-group-hdr" comment; point them at `.o-microhead`.

Uppercase is allowed in exactly two places: the micro-label (body, 0.08em) and
nano machine tags (mono, 0.1–0.14em, always dim or accent). Nowhere else — not
buttons, not pills, not titles.

### 3.3 Numbers

Anything columnar or comparative — times, counts, token usage, percentages,
step indices — uses `font-variant-numeric: tabular-nums`. This is already done
in places; make it universal for numeric data. Wobbling digits read as amateur.

---

## 4. Space & rhythm

### 4.1 The 4px grid

All spacing is a multiple of 4. The scale:

```
4   8   12   16   24   32   48
```

`base.css` already ships `--gap-1..4` (4/8/12/16) and wires `--gap-2/--gap-3` to
the density control. Keep those as the **density-responsive row rhythm**, and add
fixed structural steps for layout that should *not* flex with density:

```css
:root {
  --gap-6: 24px;   /* detail padding, section gaps */
  --gap-8: 32px;   /* major section separation */
  --gap-12: 48px;  /* detail bottom breathing room */
}
```

Use density-aware `--gap-*` (2/3) inside list rows and tab strips. Use the fixed
steps for page-level structure. **Detail padding is 24px** (`--gap-6`) — retire
the ad-hoc 28px. A single consistent gutter is more of the "polish" than any
individual pixel choice.

### 4.2 Information density

Outpost is a monitoring and control tool. Operators scan many jobs, sessions, and
steps at a glance. **Favor density over whitespace luxury** — but density done
right means *tight and legible*, never *cramped*. The default row height is 32px;
the density control (compact / default / roomy) is the operator's to set, not a
reason to guess.

The test: an experienced operator should be able to take in the state of ~10–15
items without scrolling, and never feel like the layout is shouting. Dense, calm,
scannable.

---

## 5. Shape — radius

This was the single most inconsistent thing (3, 4, 6, 8, 10px all in play). It is
now a **three-step scale plus a true pill**:

```css
:root {
  --r-control:   4px;    /* buttons, inputs, chips, menu items, code/ref pills */
  --r-container: 8px;    /* cards, sections, panels, popovers, dialogs, sheets */
  --r-pill:      999px;  /* status pills, count badges, dots */
  /* radius 0 — structural dividers and full-bleed rows inside a grouped
     container (the container carries the outer radius; interior rows are square
     and share one collapsed hairline). */
}
```

The rule in one sentence: **controls and content-chips are `--r-control` (4px);
things that contain other things are `--r-container` (8px); status pills are
fully round; structural rows are square and let their group carry the corner.**

Retire 3px, 6px, and 10px entirely. Note two deliberate changes from today:
- status pills move from 10px to fully-round (`--r-pill: 999px`) — this cleanly
  separates a *pill* (round, a status) from a *card* (8px, a container), which is
  a big part of reading as "polished."
- the old `--r-pill-sm` (4px) becomes `--r-control` and covers all small controls,
  not just chips.

The aesthetic target is **crisp and machined** — tight 4px corners on controls,
calm 8px on containers. Not pill-soft everywhere (reads as consumer/toy), not
fully square everywhere (reads as brutalist/harsh). The 4/8 pairing is the
precision-instrument middle path.

---

## 6. Elevation & depth

Depth is communicated **primarily by hairlines and surface tint, not shadow.**

- Three surface planes: `--bg` (the page) → `--bg-elev` (cards, rails, rows) →
  `--bg-elev-2` (nested fills, hover, pressed).
- Hairlines: `--line` for real dividers and card borders; `--line-soft` for
  quieter internal separators.

**Shadow means one thing: this element floats above the plane.** So shadow is
allowed *only* on elements that are literally overlaid — popovers, dropdown
menus, dialogs, sheets, toasts. Cards, rows, and sections **never** cast a
shadow; they sit in the plane and are defined by their hairline and elevation
fill. There is exactly one float-shadow token:

```css
:root {
  --shadow-pop: 0 12px 32px -12px rgba(0, 0, 0, 0.5);
}
```

Retire the competing `40px` and `color-mix` shadow recipes. One float shadow,
used sparingly, on floating things only.

### The left-edge state rail — Outpost's signature motif

The 2–3px colored left border is a recurring, load-bearing pattern (focus card,
step timeline, inline session rail, failure callout). **Lean into it — it's the
product's visual fingerprint.** Standardize it:

- **3px solid** left border for standalone cards/callouts (focus card, failure
  block).
- **2px** for inline rails and the timeline spine.
- Color = the state it represents (`--warn` needs-you, `--accent` live,
  `--ok` done, `--danger` failed, `--line` inert).

A colored left rail is how Outpost says "this row has a state" without a badge.
Prefer it to icons-in-circles where a single strip will do.

---

## 7. Components — canonical specs

These override the legacy lookalikes. When you touch a component, migrate it to
the spec below rather than perpetuating the old shape.

### 7.1 Buttons — one system, colored by role

Body font, sentence case, no letter-spacing, `--r-control` (4px). Two sizes:

- **sm**: padding `4px 10px`, 12px text.
- **md**: padding `6px 12px`, 13px text.

Four role variants — and only four:

| Variant | Look | When |
|---|---|---|
| **primary** | solid `--accent` fill, `--bg` text | the one main action in a view |
| **default** | `--bg`/`--bg-elev` fill, `--line` border, `--text-mute`→`--text` on hover | secondary actions |
| **ghost** | no border, `--text-mute`, `--bg-elev-2` on hover | row/menu/inline actions |
| **danger** | `--danger` text, `--danger-soft` fill/border | destructive actions |

Only **primary** uses a solid accent fill — reinforcing the one-signal-per-view
budget. The legacy `.ghost-btn` / `.step-action` / `.work-btn` mono-uppercase
squared buttons and the per-surface `.sched-btn` / `.lib-btn` / `.dr-btn`
lookalikes all collapse into this system — `.sched-btn` and `.lib-btn` are done
(no markup emits them; their selectors came out of `primitives.css`), leaving
`.dr-btn` as the last one still riding the shared base. The shape-override hacks in `tracked.css`
(making legacy buttons "speak the new rounded language") become the default, not a
patch.

Hover/press: color transitions only, `--dur-1` (120ms). No scale/lift on buttons.

### 7.2 Pills & badges

- **Status pill**: `--r-pill` (round), 11px, sentence case, tint treatment
  (`--x-soft` fill + `--x` ink) per state. `.o-pill` and its state modifiers.
- **Code / ref chip**: `--r-control` (4px), mono, `--bg-elev-2` fill,
  `--text-mute`. For refs, skill names, branch fragments.
- **Count badge**: dim by default; `--warn` fill + `--bg` text **only** when the
  count is something the operator needs to act on (the sidebar hot count).
- **Action-category chip**: mono `--r-control` chip holding the action's own name
  (`read.investigate` → `investigate`), tinted from the `[data-cat]` palette in
  `primitives.css` (`--cat-fg` / `--cat-bg`). Category is a fixed taxonomy that
  means the same thing on every surface, so the Library's dots/badge and the
  plan's step chips read from that one block — never re-map the colors locally.

### 7.3 Rows & lists

The `.o-row` grid (`icon · content · time`) is the canonical list row. Resting on
`--bg-elev` with a `--line` border; `--bg-elev-2` on hover; accent border +
accent-tinted fill when open/selected. Grouped rows collapse into one shared
hairline with the group carrying the outer `--r-container` corners. Sub-metadata
stacks in `.o-row-sub`; time right-aligns with tabular nums.

### 7.4 Cards, sections, panels

`--bg-elev` fill, `--line`/`--line-soft` border, `--r-container` (8px), no shadow.
Internal padding `--gap-3`/`--gap-4` (12–16px). A card that needs to signal state
gets a left-edge rail (§6), not a full-color border or a shadow.

### 7.5 Inputs & the command bar

`--bg` fill, `--line` border, `--r-control` (4px). Focus = `--accent` border, no
glow. The command bar (`⌘K` entry) and filter inputs share this. Placeholder is
`--text-dim`.

### 7.6 Menus, popovers, dialogs

`--bg-elev` fill, `--line` border, `--r-container` (8px), `--shadow-pop`. Menu
items: ghost-button treatment, `--r-control`, left-aligned, `--bg-elev-2` on
hover; destructive items in `--danger`.

### 7.7 The step timeline

The timeline is the heart of the job-detail surface and should be the most
refined thing we build. Spine is a 2px `--line` rail; nodes are 20px status dots
(solid-filled with the state color, `--bg` glyph); the active node pulses.
Parallel groups bracket with a second `--accent-2-soft` rail and a nano mono
`∥ parallel` tag. Failure reasons render as a `--danger` left-rail callout *above*
the retry affordance — always say why before offering the fix.

---

## 8. Motion

Restrained and purposeful. Motion earns attention; we don't spend it on
decoration.

```css
:root {
  --ease:  cubic-bezier(0.2, 0, 0, 1);  /* standard */
  --dur-1: 120ms;   /* color / hover / focus */
  --dur-2: 180ms;   /* reveal / layout / expand */
  --pulse: 1.6s;    /* the live signal */
}
```

- **Micro-interactions** (hover, focus, press): color/border transitions at
  `--dur-1`. No lifts, no bounces, no scale on click.
- **Reveals** (surface mount, expand, sheet in): one composed motion at `--dur-2`.
  A single staggered fade-in on a surface's first paint is welcome; scattered
  per-element animations are not.
- **The pulse** (`o-pulse` / `tl-pulse`, ~1.6s ease-in-out opacity) is the
  signature "this is live" animation. **Reserve it exclusively for genuinely
  live/in-progress signals** — the running dot, the streaming rail, the active
  timeline node. A pulsing thing that isn't live is a lie.
- Always honor `prefers-reduced-motion`: pulses hold steady, reveals cut.

The feeling: a calm instrument that responds instantly and precisely, with one
slow heartbeat where work is happening.

---

## 9. Iconography & glyphs

Keep the icon language spare and geometric. A single line weight, sized to the
text it sits with (14–16px in rows, 16px in the sidebar). Icons are chrome —
resting `--text-dim`, taking a state color (`.hot`/`.warn`/`.ok`/`.busy`) only
when they carry that state. Prefer a colored left-rail or a text label over an
icon when either communicates as clearly; we are not an icon-forward UI.

Terminal glyphs (`✓ ✗ ⊘ → » ∥`) are part of the machine-truth vocabulary and pair
with mono. They're allowed and encouraged in transcript/timeline contexts where
they read as instrument output.

---

## 10. Do / Don't

**Do**
- Start every element neutral; add color only to mark live/actionable/state.
- Keep one solid-accent element per viewport.
- Use mono only for machine truth; body font for everything humans read.
- Snap every size to the type scale and every gap to the 4px grid.
- Use `--r-control` (4) for controls, `--r-container` (8) for containers, round for pills.
- Communicate depth with hairlines; use `--shadow-pop` only on floating overlays.
- Use the left-edge rail to mark a row/card's state.
- Reference tokens, always. Never a raw hex or rgba in a component.

**Don't**
- Don't paint the screen with accent because it's the brand color.
- Don't use a state color when the state isn't true.
- Don't ship mono-uppercase buttons, or uppercase anything outside micro-labels/nano tags.
- Don't invent intermediate greys, radii, shadows, or font sizes.
- Don't put a shadow on an in-plane card or row.
- Don't animate for decoration; don't pulse anything that isn't live.
- Don't copy a legacy component's shape forward — migrate it to §7.

---

## 11. Migration

**Done (2026-07-18).** The pre-redesign `legacy-components.css` sheet has been
fully dissolved — every section relocated into its owning per-surface sheet (or
deleted where dead), the file removed, and all nine surfaces conformed to §2–§9
in one pass. The structural tokens (`--r-control`, `--r-container`,
`--r-pill: 999px`, `--gap-6/8/12`, `--shadow-pop`, `--scrim`, `--ease`,
`--dur-*`, `--pulse`) now live in `base.css`, and the canonical `.o-*` components
(including the four-variant `.o-btn` system) in `primitives.css`. Shared overlay
chrome lives in `overlays.css`; the pre-JS bootstrap shell in `app-shell.css`.

The `o-` prefixed primitives are the canonical namespace. The discipline that
keeps it that way:

1. Every **new** component is built to this document from the start.
2. Every component you **touch** for other reasons gets migrated to the specs in
   §5–§7 in the same change — radius snapped, button variant adopted, shadow
   removed if in-plane, uppercase/mono corrected, tokens referenced (never a raw
   hex/rgba/radius/duration).

The north star: a stranger should be able to open any surface — cockpit, tracked,
sessions, schedules, library, settings — and not be able to tell they were built
in different months. One instrument, one hand.
