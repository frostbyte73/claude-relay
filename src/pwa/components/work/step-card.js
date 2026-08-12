import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { openDiffForStep } from '../../app-bridge.js';
import { orchestratedHasPrBlock, renderOrchestratedCard, wireOrchestratedCard } from './orchestrated-card.js';
import { actionCategory, actionDisplayName } from './action-icon.js';
import { renderWriteDraft, wireWriteDraft } from './write-draft-card.js';
import { renderMarkdown } from '../../markdown.js';
import { stepLaunchBadge } from '../../vm/tracked.js';
import { launchPillClass } from './ticket-row.js';
import { isTerminalStep, hasUnapprovedDraft } from '../../vm/work-predicates.js';
import { shortName } from '../../utils/formatting.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function stateLabel(s) {
  if (s.failure) return 'failed';
  if (s.cancelled) return 'cancelled';
  // A step in its initial state with no session attached hasn't been started yet —
  // it's queued behind earlier steps. Label as "todo" to match the job-level vocabulary.
  if (!s.sessionId && s.state === 'running') return 'todo';
  if (s.state === 'gate_pending_approval') return 'needs approval';
  return s.state;
}
function stateTone(s) {
  if (s.failure) return 'danger';
  if (s.cancelled) return 'mute';
  // todo: queued, no session yet.
  if (!s.sessionId && s.state === 'running') return 'mute';
  // done.
  if (s.state === 'resolved') return 'ok';
  // Terminal but not a failure: the user vetoed this step's write draft. Neutral, same
  // family as cancelled/todo — not "active" (it isn't running) and not "danger" (it isn't
  // broken).
  if (s.type === 'action' && s.state === 'declined') return 'mute';
  // The hard hold, either kind: a human_gate action before an external write, or an
  // orchestrated step whose controller gated its own move.
  if (s.state === 'gate_pending_approval') return 'gate';
  // meta.wait hold — a soft gate the user (or a soak timer) releases. An orchestrated
  // step's `waiting` is on CI/review/dispatches, so it stays active, not a gate.
  if (s.type === 'action' && s.state === 'waiting') return 'gate';
  return 'active';
}

// Identity row for an `action` step: which action it is, and the workspace it runs in.
// Sits directly under the description, mirroring `.tl-ident` in the orchestrated card
// (orchestrated-card.js) — the two step types used to disagree about where a step says what
// it is. An action step crammed its name onto the header line as an `--accent` chip reading
// `action.write.run-github-workflow` (uppercased and then lowercased straight back, with the
// `·` separator swapped for a dot that fabricated a namespace segment, on a prefix every
// action step carries) while its workspace sat on its own row near the bottom, below the
// session tail. The chip is now the same `type-mono[data-cat]` the plan index and the
// orchestrated card already use, so all three sites read from the one category taxonomy
// instead of the timeline re-mapping the color to accent locally (DESIGN §7.2).
function identRowHtml(s) {
  const bits = [];
  if (s.action) {
    bits.push(`<span class="type-mono" data-cat="${escapeHtml(actionCategory(s.action))}">${escapeHtml(actionDisplayName(s.action))}</span>`);
  }
  if (s.workspace?.kind === 'writable' && s.workspace.branch) {
    bits.push(`<span class="o-pill code">${escapeHtml(s.workspace.branch)}</span>`);
  } else if (s.workspace?.kind === 'readonly') {
    // A read-only checkout is context, not something the step owns — it stays quiet text
    // rather than taking the ref chip the branch gets.
    bits.push(`<span class="tl-ident-repo">${escapeHtml(shortName(s.workspace.repoCwd))}</span>`);
  }
  return bits.length ? `<div class="tl-ident">${bits.join('')}</div>` : '';
}

function descriptionFor(s) {
  const text = s.description?.trim() || s.goal?.trim() || '';
  return text;
}

function actionFor(s) {
  if (s.failure) return `<button class="o-btn o-btn--danger" data-step-action="retry">Retry</button>`;
  if (s.cancelled) return '';
  // An orchestrated step's affordances (gate, message, mark-resolved) all live in its
  // own card, which owns the wiring too.
  if (s.type === 'orchestrated') return '';
  // meta.wait hold: let the user release it early (timed) or at all (indefinite).
  if (s.type === 'action' && s.state === 'waiting') {
    return `<button class="o-btn o-btn--primary" data-step-action="resume">Resume now</button>`;
  }
  // human_gate: the drafted write itself renders via renderWriteDraft (draftsHtml below),
  // which carries its own Accept/Propose changes/Deny buttons — nothing to add here.
  // Resolve is a manual fallback for action steps whose session subprocess
  // exited without POSTing output. It must never appear while the session is
  // still running (it's mid-investigation) nor before its slice has loaded —
  // resolving prematurely marks unfinished work done and unblocks the next
  // step. Only 'inactive' means the subprocess actually exited; absent /
  // foreground / background all mean "not ended", so keep it hidden. `declined` is
  // already terminal (isResolved() in steps/action.ts treats it the same as `resolved`) —
  // offering Resolve on top of it would read as a stray, meaningless affordance.
  if (s.type === 'action' && !isTerminalStep(s) && s.sessionId) {
    const slice = sessions.get().sessionsById.get(s.sessionId);
    if (slice?.runState !== 'inactive') return '';
    return `<button class="o-btn o-btn--primary" data-step-action="resolve">Resolve</button>`;
  }
  return '';
}

// ── Timeline rendering (Tracked drill-in) ───────────────────────────────
// The Tracked surface's per-step renderer (both layouts, since D1 retired the
// desktop-only pane/tab system) — maps stateTone()/stateLabel() onto a
// connected-rule-and-dot shape.

function dotTone(s) {
  if (s.cancelled) return 'mute';
  if (s.failure) return 'danger';
  if (s.state === 'resolved') return 'done';
  // Terminal but not a failure — its own neutral tone, distinct from both "done" (✓) and
  // "failed" (✗).
  if (s.type === 'action' && s.state === 'declined') return 'declined';
  // stateTone's 'gate' only sees the step's own `state`, which a dispatch-raised draft
  // never flips (only the dispatch's own status does) — the same gap Critical 2 named in
  // focusAction/stepWaitPill, here in the timeline's own dot. Without hasUnapprovedDraft, an
  // orchestrated step parked on a dispatch's draft would draw the neutral hollow "pending"
  // ring below instead of the hot "your move" fill, on DESIGN's own "most refined thing we
  // build" (§7.7).
  if (stateTone(s) === 'gate' || hasUnapprovedDraft(s)) return 'hot';
  if (!s.sessionId && s.state === 'running') return 'pending';
  // An orchestrated step parked on CI or a dispatch can sit for hours; the busy dot
  // pulses, and DESIGN §10 says don't pulse anything that isn't live.
  if (s.type === 'orchestrated' && s.state === 'waiting') return 'pending';
  return 'busy';
}

function dotGlyph(tone) {
  if (tone === 'done') return '✓';
  if (tone === 'hot') return '!';
  if (tone === 'danger') return '✗';
  if (tone === 'declined') return '⊘';
  if (tone === 'pending') return '◯';
  return ''; // busy — pulsing fill carries the state
}

function timeAgo(epochMs) {
  if (!epochMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function durationLabel(s) {
  if (!s.createdAt || !s.updatedAt || s.updatedAt <= s.createdAt) return '';
  const mins = Math.round((s.updatedAt - s.createdAt) / 60000);
  if (mins < 1) return '';
  if (mins < 60) return ` · ${mins}m`;
  return ` · ${Math.round(mins / 60)}h`;
}

function humanizeMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// The hold block for a parked meta.wait step: the soak/manual timer, the reason it's
// paused, and any preview the planner attached (verdict, diff link, drafted body).
// The countdown is a per-render snapshot — it refreshes whenever the timeline repaints.
function waitBlockHtml(s) {
  if (s.type !== 'action' || s.state !== 'waiting') return '';
  let timer;
  if (typeof s.resumeAt === 'number') {
    const ms = s.resumeAt - Date.now();
    timer = ms > 0 ? `Auto-resumes in ~${humanizeMs(ms)}` : 'Auto-resuming…';
  } else {
    timer = 'Waiting for you to resume';
  }
  const reason = s.inputs?.reason ? escapeHtml(String(s.inputs.reason)) : '';
  const preview = s.inputs?.preview != null
    ? `<pre class="tl-wait-preview">${escapeHtml(typeof s.inputs.preview === 'string' ? s.inputs.preview : JSON.stringify(s.inputs.preview, null, 2))}</pre>`
    : '';
  return `
    <div class="tl-wait">
      <div class="tl-wait-timer">⏸ ${escapeHtml(timer)}</div>
      ${reason ? `<div class="tl-wait-reason">${reason}</div>` : ''}
      ${preview}
    </div>`;
}

// An ActionStep's own write drafts awaiting a decision — the exact calls it will run
// verbatim once accepted (see write-draft-card.js), editable per field. Approved drafts
// (kept in `s.drafts` forever, for inspection) are never rendered here — only what's still
// pending. In practice an ActionStep carries at most one unapproved draft at a time
// (raisedBy is always `{kind:'step'}` for this step type), but this renders every entry
// that qualifies rather than assuming that invariant holds forever.
// `isTerminalStep` guard: an ActionStep's `.failure` doesn't reset `state` (see that
// function's own doc comment), so a draft raised before a later provisioning failure can
// stay pending forever on a step that's actually dead — rendering a live Accept/Propose/
// Deny card whose every button would 409 against the server's own terminal-step guard.
function draftsHtml(s) {
  if (s.type !== 'action' || isTerminalStep(s)) return '';
  return (s.drafts ?? [])
    .filter((d) => !d.approvedAt)
    .map((d) => renderWriteDraft(d))
    .join('');
}

// Token-launch-queue status for this step, in its own row (never crammed onto
// tl-hdr alongside the name/skill/time).
function launchRowHtml(job, s) {
  const badge = stepLaunchBadge(job, s.id);
  if (!badge) return '';
  return `
    <div class="tl-launch">
      <span class="o-pill ${launchPillClass(badge.kind)}">${escapeHtml(badge.label)}</span>
      ${badge.kind === 'queued' ? `<button type="button" class="o-btn o-btn--primary" data-step-action="launch-now">Launch</button>` : ''}
    </div>
  `;
}

// Structured outbound links per step: whatever real data supports (no
// fabricated "N log excerpts" counts — the mockup invents structure our data
// model doesn't have; only render refs we can actually resolve).
function stepRefs(job, s) {
  const refs = [];
  if (s.type !== 'orchestrated') return refs;
  if (s.sessionId && s.phase !== 'merged') refs.push({ kind: 'diff', label: 'Review changes' });
  if (s.pr?.prUrl) refs.push({ kind: 'pr', label: 'Open PR', href: s.pr.prUrl });
  return refs;
}

function refsHtml(refs) {
  if (!refs.length) return '';
  return `<div class="tl-refs">${refs.map((r) => r.href
    ? `<a class="tl-ref" href="${escapeHtml(r.href)}" target="_blank" rel="noopener" data-ref="${r.kind}">${escapeHtml(r.label)} ↗</a>`
    : `<button type="button" class="tl-ref" data-ref="${r.kind}">${escapeHtml(r.label)} →</button>`,
  ).join('')}</div>`;
}

export function renderTimelineStep(job, s, index, groupPos, opts = {}) {
  const tone = dotTone(s);
  const title = s.title || s.type;
  const desc = descriptionFor(s);
  const output = (s.type === 'action' && s.output) ? renderMarkdown(s.output) : '';
  // Findings are the long tail of a step — collapse them once the step is done so
  // the timeline reads as a compact list of names/descriptions, expandable on demand.
  // Live/failed steps stay open (you're actively reading the result). Native
  // <details>; open state survives repaints via detail.js's snapshotUi.
  const findingsOpen = s.state !== 'resolved';
  const groupAttr = groupPos ? ` data-group-pos="${groupPos}"` : '';
  // An orchestrated step's session mount is rendered by the card itself, so its composer can
  // sit directly under the transcript tail — see orchestrated-card.js's own header comment.
  const orchestrated = s.type === 'orchestrated';
  // The PR block (mounted inside the orchestrated card) carries its own diff-review
  // button and PR link, so suppress the standalone refs alongside it. The transcript is
  // never a link — its inline feed carries an "Open ↗" affordance.
  const refs = orchestrated && orchestratedHasPrBlock(s) ? [] : stepRefs(job, s);
  const action = actionFor(s);
  return `
    <div class="tl-step" data-step-id="${escapeHtml(s.id)}" data-cancelled="${!!s.cancelled}"${groupAttr}>
      <div class="tl-dot" data-tone="${tone}">${dotGlyph(tone)}</div>
      <div class="tl-content">
        <div class="tl-hdr">
          <span class="tl-name">${escapeHtml(title)}</span>
          <span class="tl-time">${escapeHtml(timeAgo(s.updatedAt))}${escapeHtml(durationLabel(s))}</span>
        </div>
        ${desc ? `<div class="tl-summary">${escapeHtml(desc)}</div>` : ''}
        ${orchestrated ? '' : identRowHtml(s)}
        ${s.failure ? `<div class="tl-failure">${escapeHtml(s.failure.reason ?? 'Step failed')}</div>` : ''}
        ${waitBlockHtml(s)}
        ${draftsHtml(s)}
        ${launchRowHtml(job, s)}
        ${!orchestrated && s.sessionId ? `<div class="step-inline-session-mount" data-session-id="${escapeHtml(s.sessionId)}" data-step-id="${escapeHtml(s.id)}"></div>` : ''}
        ${orchestrated ? renderOrchestratedCard(s, { job }) : ''}
        ${refsHtml(refs)}
        ${output ? `<details class="plan-findings tl-findings"${findingsOpen ? ' open' : ''}><summary class="tl-findings-sum"><span class="plan-findings-label o-microhead">Findings</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary><div class="step-findings md-body">${output}</div></details>` : ''}
        ${action ? `<div class="step-actions">${action}</div>` : ''}
      </div>
      ${opts.editTools ?? ''}
    </div>
  `;
}

export function wireTimelineStep(el, job, s) {
  el.querySelectorAll('[data-ref]').forEach((btn) => {
    if (btn.tagName === 'A') return; // external link — no JS needed
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-ref');
      if (kind === 'diff') void openDiffForStep({ jobId: job.id, stepId: s.id, sessionId: s.sessionId });
    });
  });
  el.querySelectorAll('[data-step-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.getAttribute('data-step-action');
      if (kind === 'resolve') void work.resolveStep(job.id, s.id);
      else if (kind === 'launch-now') void work.launchStep(job.id, s.id).catch((err) => alert(`Launch failed: ${err?.message ?? err}`));
      else if (kind === 'resume') void work.approve(job.id, { gate: 'wait', stepId: s.id });
      else if (kind === 'retry') void work.retryStep(job.id, s.id).catch((err) => alert(`Retry failed: ${err?.message ?? err}`));
    });
  });
  if (s.type === 'action' && !isTerminalStep(s)) {
    (s.drafts ?? []).filter((d) => !d.approvedAt)
      .forEach((d) => wireWriteDraft(el, { jobId: job.id, stepId: s.id, draft: d }));
  }
  if (s.type === 'orchestrated') wireOrchestratedCard(el, s, { job });
}

export function computeGroupPositions(steps) {
  const positions = [];
  let i = 0;
  while (i < steps.length) {
    const key = steps[i].parallelGroup ?? `__solo_${i}`;
    let j = i;
    while (j < steps.length && (steps[j].parallelGroup ?? `__solo_${j}`) === key) j++;
    const count = j - i;
    for (let k = i; k < j; k++) {
      if (count === 1) positions[k] = undefined;
      else if (k === i) positions[k] = 'open';
      else if (k === j - 1) positions[k] = 'close';
      else positions[k] = 'mid';
    }
    i = j;
  }
  return positions;
}
