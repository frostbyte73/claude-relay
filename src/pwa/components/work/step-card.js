import { work } from '../../state/work.js';
import { sessions } from '../../state/sessions.js';
import { openDiffForStep } from '../../app-bridge.js';
import { hasPrBlock, renderPrBlockHtml, wirePrBlockActions } from './pr-block.js';
import { renderMarkdown } from '../../markdown.js';
import { stepLaunchBadge } from '../../vm/tracked.js';
import { launchPillClass } from './ticket-row.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function shortName(cwd) { const p = String(cwd ?? '').split('/').filter(Boolean); return p.slice(-2).join('/'); }
function stepLabel(s) {
  if (s.type === 'open-pr') return 'OPEN PR';
  return s.action ? `ACTION · ${s.action.toUpperCase()}` : 'ACTION';
}

function stateLabel(s) {
  if (s.failure) return 'failed';
  if (s.cancelled) return 'cancelled';
  // A step in its initial state with no session attached hasn't been started yet —
  // it's queued behind earlier steps. Label as "todo" to match the job-level vocabulary.
  // Mirrors OpenPrStep's initialState ('speccing').
  const initial = s.type === 'open-pr' ? 'speccing' : 'running';
  if (!s.sessionId && s.state === initial) return 'todo';
  if (s.type === 'open-pr') {
    if (s.state === 'reply_pending_review') return 'pending';
    return s.state.replace(/_/g, ' ');
  }
  return s.state;
}
function stateTone(s) {
  if (s.failure) return 'danger';
  if (s.cancelled) return 'mute';
  // Mirrors OpenPrStep's initialState ('speccing').
  const initial = s.type === 'open-pr' ? 'speccing' : 'running';
  // todo: queued, no session yet.
  if (!s.sessionId && s.state === initial) return 'mute';
  // done.
  if (s.state === 'resolved' || s.state === 'merged') return 'ok';
  // meta.wait hold — a soft gate the user (or a soak timer) releases.
  if (s.type === 'action' && s.state === 'waiting') return 'gate';
  if (s.type === 'open-pr') {
    // Gates: spec review, pending review, ready-to-merge.
    if (s.state === 'spec_pending_review') return 'gate';
    if (s.state === 'reply_pending_review') return 'gate';
    if (s.state === 'pr_open' && s.reviewState === 'approved' && s.ciState === 'success' && s.prState !== 'merged') return 'gate';
    // Otherwise active (implementing with session, pr_open without gate).
    return 'active';
  }
  // Active running session for non-open-pr steps.
  return 'active';
}

function unresolvedCount(s) {
  const comments = s.comments ?? [];
  return comments.filter((c) => !c.respondedAt).length;
}

function metaOpenPr(s) {
  const n = unresolvedCount(s);
  const bits = [
    s.workspace?.branch ? `<span class="branch">${escapeHtml(s.workspace.branch)}</span>` : '',
    s.ciState === 'success' ? '<span class="ci-ok">CI ok</span>'
      : s.ciState === 'failure' ? '<span class="ci-fail">CI fail</span>'
      : s.ciState ? '<span class="muted">CI pending</span>' : '',
    s.reviewState === 'approved' ? '<span class="review-ok">Approved</span>'
      : s.reviewState === 'changes_requested' ? '<span class="muted">Changes requested</span>'
      : s.reviewState ? '<span class="muted">Review required</span>' : '',
    n > 0 ? `<span class="unresolved">${n} unresolved</span>` : '',
  ].filter(Boolean);
  return bits.join('');
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

function metaFor(s) {
  if (s.type === 'open-pr') return metaOpenPr(s);
  if (s.type === 'action') return metaAction(s);
  return '';
}

function actionFor(s) {
  if (s.failure) return `<button class="o-btn o-btn--danger" data-step-action="retry">Retry</button>`;
  if (s.cancelled) return '';
  if (s.type === 'open-pr') {
    if (s.state === 'spec_pending_review') {
      return `
        <button class="o-btn o-btn--primary" data-step-action="accept-spec">Accept spec</button>
        <button class="o-btn o-btn--default" data-step-action="toggle-spec-feedback">Propose changes</button>
        <div class="thread-composer" data-composer="spec-feedback" hidden>
          <textarea class="thread-compose-input" data-autogrow placeholder="What should change?"></textarea>
          <div class="thread-composer-row">
            <button class="o-btn o-btn--primary" data-step-action="submit-spec-feedback">Submit</button>
          </div>
        </div>
      `;
    }
    if (s.state === 'pr_open' && s.reviewState === 'approved' && s.ciState === 'success' && s.prState !== 'merged') {
      return `<button class="o-btn o-btn--primary" data-step-action="merge">Approve merge</button>`;
    }
    return '';
  }
  // meta.wait hold: let the user release it early (timed) or at all (indefinite).
  if (s.type === 'action' && s.state === 'waiting') {
    return `<button class="o-btn o-btn--primary" data-step-action="resume">Resume now</button>`;
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
  if (s.state === 'resolved' || s.state === 'merged') return 'done';
  // Mirrors OpenPrStep's initialState ('speccing').
  const initial = s.type === 'open-pr' ? 'speccing' : 'running';
  if (stateTone(s) === 'gate') return 'hot';
  if (!s.sessionId && s.state === initial) return 'pending';
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

// Token-launch-queue status for this step, in its own row (never crammed onto
// tl-hdr alongside the name/skill/time).
function launchRowHtml(job, s) {
  const badge = stepLaunchBadge(job, s.id);
  if (!badge) return '';
  return `
    <div class="tl-launch">
      <span class="o-pill ${launchPillClass(badge.kind)}">${escapeHtml(badge.label)}</span>
      ${badge.kind === 'queued' ? `<button type="button" class="o-btn o-btn--ghost" data-step-action="launch-now">Launch now</button>` : ''}
    </div>
  `;
}

// Structured outbound links per step: whatever real data supports (no
// fabricated "N log excerpts" counts — the mockup invents structure our data
// model doesn't have; only render refs we can actually resolve).
function stepRefs(job, s) {
  const refs = [];
  if (s.type === 'open-pr' && s.sessionId && s.state !== 'merged') refs.push({ kind: 'diff', label: 'Review changes' });
  if (s.type === 'open-pr' && s.prUrl) refs.push({ kind: 'pr', label: 'Open PR', href: s.prUrl });
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
  const spec = s.type === 'open-pr' && s.spec ? renderMarkdown(s.spec) : '';
  const implPlan = s.type === 'open-pr' && s.implPlan ? renderMarkdown(s.implPlan) : '';
  // Findings are the long tail of a step — collapse them once the step is done so
  // the timeline reads as a compact list of names/descriptions, expandable on demand.
  // Live/failed steps stay open (you're actively reading the result). Native
  // <details>; open state survives repaints via detail.js's snapshotUi.
  const findingsOpen = !(s.state === 'resolved' || s.state === 'merged');
  const groupAttr = groupPos ? ` data-group-pos="${groupPos}"` : '';
  const showPrBlock = s.type === 'open-pr' && hasPrBlock(s);
  // The PR block carries its own diff-review button and PR link, so suppress the
  // standalone refs alongside it. The transcript is never a link — its inline
  // feed (mounted below, same as the orchestrator) carries an "Open ↗" affordance.
  const refs = showPrBlock ? [] : stepRefs(job, s);
  const action = actionFor(s);
  return `
    <div class="tl-step" data-step-id="${escapeHtml(s.id)}" data-cancelled="${!!s.cancelled}"${groupAttr}>
      <div class="tl-dot" data-tone="${tone}">${dotGlyph(tone)}</div>
      <div class="tl-content">
        <div class="tl-hdr">
          <span class="tl-name">${escapeHtml(title)}</span>
          <span class="tl-skill">${escapeHtml(stepLabel(s).toLowerCase().replace(/\s*·\s*/, '.'))}</span>
          <span class="tl-time">${escapeHtml(timeAgo(s.updatedAt))}${escapeHtml(durationLabel(s))}</span>
        </div>
        ${desc ? `<div class="tl-summary">${escapeHtml(desc)}</div>` : ''}
        ${s.failure ? `<div class="tl-failure">${escapeHtml(s.failure.reason ?? 'Step failed')}</div>` : ''}
        ${waitBlockHtml(s)}
        ${launchRowHtml(job, s)}
        ${s.sessionId ? `<div class="step-inline-session-mount" data-session-id="${escapeHtml(s.sessionId)}" data-step-id="${escapeHtml(s.id)}"></div>` : ''}
        ${showPrBlock ? renderPrBlockHtml(job, s) : (metaFor(s) ? `<div class="tl-meta">${metaFor(s)}</div>` : '')}
        ${refsHtml(refs)}
        ${output ? `<details class="plan-findings tl-findings"${findingsOpen ? ' open' : ''}><summary class="tl-findings-sum"><span class="plan-findings-label o-microhead">Findings</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary><div class="step-findings md-body">${output}</div></details>` : ''}
        ${spec && !showPrBlock ? `<details class="plan-findings tl-findings"${s.state === 'spec_pending_review' ? ' open' : ''}><summary class="tl-findings-sum"><span class="plan-findings-label o-microhead">Spec</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary><div class="step-findings md-body">${spec}</div></details>` : ''}
        ${implPlan && !showPrBlock ? `<details class="plan-findings tl-findings"><summary class="tl-findings-sum"><span class="plan-findings-label o-microhead">Implementation plan</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary><div class="step-findings md-body">${implPlan}</div></details>` : ''}
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
      if (kind === 'diff') void openDiffForStep({ jobId: job.id, stepId: s.id, sessionId: s.sessionId, mode: 'review' });
    });
  });
  el.querySelectorAll('[data-step-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.getAttribute('data-step-action');
      if (kind === 'resolve') void work.resolveStep(job.id, s.id);
      else if (kind === 'launch-now') void work.launchStep(job.id, s.id).catch((err) => alert(`Launch failed: ${err?.message ?? err}`));
      else if (kind === 'resume') void work.approve(job.id, { gate: 'wait', stepId: s.id });
      else if (kind === 'retry') void work.retryStep(job.id, s.id);
      else if (kind === 'merge') void work.approve(job.id, { gate: 'merge', stepId: s.id });
      else if (kind === 'accept-spec') void work.approve(job.id, { gate: 'spec', stepId: s.id });
      else if (kind === 'toggle-spec-feedback') {
        el.querySelector('[data-composer="spec-feedback"]')?.toggleAttribute('hidden');
      } else if (kind === 'submit-spec-feedback') {
        const ta = el.querySelector('[data-composer="spec-feedback"] textarea');
        const feedback = (ta?.value ?? '').trim();
        if (!feedback) { ta?.focus(); return; }
        void work.reject(job.id, { gate: 'spec', stepId: s.id, feedback });
      }
    });
  });
  if (s.type === 'open-pr' && hasPrBlock(s)) wirePrBlockActions(el, job, s);
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
