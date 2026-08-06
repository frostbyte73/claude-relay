import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { openDiffForStep } from '../../app-bridge.js';
import { orchestratedHasPrBlock, renderOrchestratedCard, wireOrchestratedCard } from './orchestrated-card.js';
import { renderMarkdown } from '../../markdown.js';
import { stepLaunchBadge } from '../../vm/tracked.js';
import { launchPillClass } from './ticket-row.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function shortName(cwd) { const p = String(cwd ?? '').split('/').filter(Boolean); return p.slice(-2).join('/'); }
// An orchestrated step names its controller on the card's own category-colored action
// chip (orchestrated-card.js), so this slot stays empty rather than repeating the name
// as plain accent text right next to it.
function stepLabel(s) {
  if (s.type === 'orchestrated') return '';
  return s.action ? `ACTION · ${s.action.toUpperCase()}` : 'ACTION';
}

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
  // The hard hold, either kind: a human_gate action before an external write, or an
  // orchestrated step whose controller gated its own move.
  if (s.state === 'gate_pending_approval') return 'gate';
  // meta.wait hold — a soft gate the user (or a soak timer) releases. An orchestrated
  // step's `waiting` is on CI/review/dispatches, so it stays active, not a gate.
  if (s.type === 'action' && s.state === 'waiting') return 'gate';
  return 'active';
}

function metaAction(s) {
  if (s.workspace?.kind === 'readonly') return `<span class="muted">${escapeHtml(shortName(s.workspace.repoCwd))}</span>`;
  if (s.workspace?.kind === 'writable') return `<span class="branch">${escapeHtml(s.workspace.branch)}</span>`;
  return '';
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
  // human_gate: approve the drafted write, or propose changes (redraft with feedback).
  if (s.type === 'action' && s.state === 'gate_pending_approval') {
    return `
      <button class="o-btn o-btn--primary" data-step-action="approve-gate">Approve &amp; post</button>
      <button class="o-btn o-btn--default" data-step-action="toggle-gate-feedback">Propose changes</button>
      <div class="thread-composer" data-composer="gate-feedback" hidden>
        <textarea class="thread-compose-input" data-autogrow placeholder="What should change about this draft?"></textarea>
        <div class="thread-composer-row">
          <button class="o-btn o-btn--primary" data-step-action="submit-gate-feedback">Submit</button>
        </div>
      </div>
    `;
  }
  // Resolve is a manual fallback for action steps whose session subprocess
  // exited without POSTing output. It must never appear while the session is
  // still running (it's mid-investigation) nor before its slice has loaded —
  // resolving prematurely marks unfinished work done and unblocks the next
  // step. Only 'inactive' means the subprocess actually exited; absent /
  // foreground / background all mean "not ended", so keep it hidden.
  if (s.type === 'action' && s.state !== 'resolved' && s.sessionId) {
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
  if (stateTone(s) === 'gate') return 'hot';
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

// The approval block for a human_gate action parked in gate_pending_approval: the exact
// drafted payload (s.draft) the action will post once approved, plus any feedback the user
// already sent this round. This is the daemon-enforced gate — the write is blocked until
// approval. Approve & run / Propose changes render via actionFor.
function gateBlockHtml(s) {
  if (s.type !== 'action' || s.state !== 'gate_pending_approval') return '';
  const draft = s.draft ? renderMarkdown(String(s.draft)) : '';
  const feedback = (s.gateFeedback ?? [])
    .map((f) => `<div class="tl-gate-feedback">↩ ${escapeHtml(f)}</div>`)
    .join('');
  const what = s.action ? s.action.split('.').pop() : 'action';
  return `
    <div class="tl-gate">
      <div class="tl-gate-head">⚠ Review before this ${escapeHtml(what)} posts</div>
      ${draft ? `<div class="tl-gate-body md-body">${draft}</div>` : '<div class="tl-gate-body muted">Drafting…</div>'}
      ${feedback ? `<div class="tl-gate-feedbacks">${feedback}</div>` : ''}
    </div>`;
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
  const skill = stepLabel(s).toLowerCase().replace(/\s*·\s*/, '.');
  const desc = descriptionFor(s);
  const output = (s.type === 'action' && s.output) ? renderMarkdown(s.output) : '';
  // Findings are the long tail of a step — collapse them once the step is done so
  // the timeline reads as a compact list of names/descriptions, expandable on demand.
  // Live/failed steps stay open (you're actively reading the result). Native
  // <details>; open state survives repaints via detail.js's snapshotUi.
  const findingsOpen = s.state !== 'resolved';
  const groupAttr = groupPos ? ` data-group-pos="${groupPos}"` : '';
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
          ${skill ? `<span class="tl-skill">${escapeHtml(skill)}</span>` : ''}
          <span class="tl-time">${escapeHtml(timeAgo(s.updatedAt))}${escapeHtml(durationLabel(s))}</span>
        </div>
        ${desc ? `<div class="tl-summary">${escapeHtml(desc)}</div>` : ''}
        ${s.failure ? `<div class="tl-failure">${escapeHtml(s.failure.reason ?? 'Step failed')}</div>` : ''}
        ${waitBlockHtml(s)}
        ${gateBlockHtml(s)}
        ${launchRowHtml(job, s)}
        ${s.sessionId ? `<div class="step-inline-session-mount" data-session-id="${escapeHtml(s.sessionId)}" data-step-id="${escapeHtml(s.id)}"></div>` : ''}
        ${orchestrated ? renderOrchestratedCard(s, { job }) : (metaAction(s) ? `<div class="tl-meta">${metaAction(s)}</div>` : '')}
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
      else if (kind === 'approve-gate') void work.approve(job.id, { gate: 'gate', stepId: s.id });
      else if (kind === 'toggle-gate-feedback') {
        el.querySelector('[data-composer="gate-feedback"]')?.toggleAttribute('hidden');
      } else if (kind === 'submit-gate-feedback') {
        const ta = el.querySelector('[data-composer="gate-feedback"] textarea');
        const feedback = (ta?.value ?? '').trim();
        if (!feedback) { ta?.focus(); return; }
        void work.reject(job.id, { gate: 'gate', stepId: s.id, feedback });
      }
      else if (kind === 'retry') void work.retryStep(job.id, s.id).catch((err) => alert(`Retry failed: ${err?.message ?? err}`));
    });
  });
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
