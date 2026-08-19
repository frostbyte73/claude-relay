// The unified "Plan" section for tracked/detail.js, which mobile-shell mounts
// unchanged (there is no separate mobile renderer). One heading over everything:
// plan-level chrome (orchestrator session mount, reconciliation diff, approve/replan/
// add-step actions) plus the steps themselves — the compact index during
// planning/review, or the caller's live timeline once executing. See
// renderPlanSection for the two-body split. Interactive wiring (approve/replan/
// etc.) stays with the caller — this module renders markup plus the two composer
// toggle/submit helpers.

import { work } from '../../state/work.js';
import { planIsLive } from '../../vm/work-predicates.js';
import { renderFinding } from './finding.js';
import { actionCategory, actionDisplayName } from './action-icon.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// The type chip carries the action's own name (the category prefix is dropped —
// the tint says which category it is, keyed on the same palette as the Library's
// skills list so both surfaces read as one taxonomy).
function typeChip(s) {
  if (s?.type === 'action' && s.action) {
    return `<span class="type-mono" data-cat="${escapeHtml(actionCategory(s.action))}">${escapeHtml(actionDisplayName(s.action))}</span>`;
  }
  if (s?.type === 'orchestrated' && s.controller) {
    return `<span class="type-mono" data-cat="${escapeHtml(actionCategory(s.controller))}">${escapeHtml(actionDisplayName(s.controller))}</span>`;
  }
  return `<span class="type-mono">${escapeHtml(s?.type ?? '··')}</span>`;
}

function diffKindFor(p, current) {
  if (!p.keepId) return 'add';
  const prior = current.find((s) => s.id === p.keepId);
  if (!prior) return 'add';
  // A completed step can't be patched or dropped (validateDispositions refuses both), so it
  // reads as history rather than as one more reviewable row.
  if (prior.state === 'resolved') return 'done';
  const fields = ['title', 'description', 'goal', 'parallelGroup', 'action', 'controller', 'forwardOutput'];
  for (const f of fields) {
    const next = p[f];
    if (next !== undefined && next !== prior[f]) return 'patch';
  }
  return 'keep';
}

export function renderReconciliation(j) {
  const recon = j.pendingReconciliation;
  if (!recon) return '';
  const current = j.steps ?? [];
  const dropSet = new Set(recon.drops ?? []);
  const cancelled = current.filter((s) => dropSet.has(s.id));

  const proposedRows = recon.proposed.map((p) => {
    const kind = diffKindFor(p, current);
    const glyph = kind === 'done' ? '✓ done' : kind === 'keep' ? '✓ keep' : kind === 'patch' ? '~ patch' : '+ add';
    const prior = p.keepId ? current.find((s) => s.id === p.keepId) : null;
    const delta = kind === 'done'
      ? 'already ran — kept as-is'
      : kind === 'keep'
        ? 'no change'
        : kind === 'patch'
          ? `${prior ? 'patched from existing step' : 'patched'} — title / goal / approach updated`
          : 'new step, inserted at this position';
    const key = p.keepId
      ? String(current.findIndex((s) => s.id === p.keepId) + 1).padStart(2, '0')
      : 'new';
    return `
      <div class="diff-row">
        <div class="diff-glyph" data-kind="${kind}">${escapeHtml(glyph)}</div>
        ${typeChip(p)}
        <div>
          <div class="step-title">${escapeHtml(p.title ?? p.goal ?? '')}</div>
          <div class="delta"><span class="key">${escapeHtml(key)}</span> · ${escapeHtml(delta)}</div>
        </div>
      </div>
    `;
  }).join('');

  const cancelledRows = cancelled.map((s) => {
    const idx = String(current.indexOf(s) + 1).padStart(2, '0');
    const running = !!s.sessionId;
    return `
      <div class="diff-row">
        <div class="diff-glyph" data-kind="cancel">✗ cancel</div>
        ${typeChip(s)}
        <div>
          <div class="step-title"><span class="strike">${escapeHtml(s.title)}</span></div>
          <div class="delta"><span class="key">${escapeHtml(idx)}</span> · removed${running ? ' · running session will be retained (kill manually if desired)' : ''}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="plan-card is-reconciling">
      <div class="recon-banner">
        <span class="label o-microhead">Plan amendment</span>
        ${recon.feedback ? `<span class="feedback">"${escapeHtml(recon.feedback)}"</span>` : ''}
      </div>
      ${renderFinding(j.plan?.findings)}
      <div class="step-list">
        ${proposedRows}
        ${cancelledRows}
      </div>
      <div class="plan-card-foot">
        <button class="o-btn o-btn--default" type="button" data-job-action="recon-discard" aria-expanded="false">Discard</button>
        <button class="o-btn o-btn--primary" type="button" data-job-action="recon-apply">Apply changes</button>
      </div>
      ${renderDiscardComposer()}
    </div>
  `;
}

// Discard opens this rather than firing immediately: an amendment the user refuses silently
// teaches the orchestrator nothing, and it will happily repropose the same plan. Submitting
// empty is still a plain discard — the reason is encouraged, not required.
function renderDiscardComposer() {
  return `
    <div class="recon-discard-composer" data-open="false" aria-hidden="true">
      <div class="field-label">Why doesn't this amendment work? (optional)</div>
      <textarea class="field-textarea recon-discard-textarea" placeholder="The orchestrator reads this and proposes a different amendment. Leave empty to just drop it."></textarea>
      <div class="recon-discard-actions">
        <button class="o-btn o-btn--default" type="button" data-job-action="recon-discard-cancel">Cancel</button>
        <button class="o-btn o-btn--danger" type="button" data-job-action="recon-discard-submit">Discard plan</button>
      </div>
    </div>`;
}

export function toggleDiscardComposer(root, open) {
  const composer = root.querySelector('.recon-discard-composer');
  const trigger = root.querySelector('[data-job-action="recon-discard"]');
  if (!composer) return;
  composer.setAttribute('data-open', open ? 'true' : 'false');
  composer.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) setTimeout(() => composer.querySelector('.recon-discard-textarea')?.focus(), 60);
}

// Empty box → today's silent discard. Non-empty → the orchestrator gets it back as a rejected
// iteration and re-amends, so the button says what will happen either way.
export async function submitDiscard(root, jobId) {
  const composer = root.querySelector('.recon-discard-composer');
  const ta = composer?.querySelector('.recon-discard-textarea');
  const submit = composer?.querySelector('[data-job-action="recon-discard-submit"]');
  if (!composer || !ta || !submit) return;
  const feedback = ta.value.trim();
  submit.disabled = true;
  submit.textContent = feedback ? 'Sending…' : 'Discarding…';
  try {
    await work.discardReconciliation(jobId, feedback || undefined);
    ta.value = '';
    toggleDiscardComposer(root, false);
  } catch (e) {
    alert(`Discard failed: ${e?.message ?? e}`);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Discard plan';
  }
}

function planApproveButton(j) {
  if (j.state !== 'plan_pending_review' || j.pendingReconciliation) return '';
  return `<button class="o-btn o-btn--primary" type="button" data-job-action="approve-plan">Approve plan</button>`;
}

// One compact index row per step: two-digit index, type-mono chip, title.
// Deliberately no session mounts / PR blocks / outputs — those belong to the
// timeline, the single full-step renderer.
function planIndexRow(s, i) {
  return `
    <div class="plan-row">
      <span class="plan-row-idx">${String(i + 1).padStart(2, '0')}</span>
      ${typeChip(s)}
      <span class="plan-row-title">${escapeHtml(s.title ?? s.goal ?? '')}</span>
    </div>
  `;
}

// The Plan and Steps used to be two labelled sections stacked in the drill-in:
// a collapsible "Plan" card holding a compact step index, then a "Steps" timeline
// re-listing the same steps in full. They're now ONE section under a single
// "Plan" heading. Two bodies, never simultaneous:
//   • planning / review  → the reviewable boxed card with the compact index
//     (no timeline exists yet — steps have no sessions to render)
//   • executing / done   → the header sits directly atop the live timeline
//     (caller passes it in as `timelineHtml`); the compact index is gone, since
//     the same steps now render as full cards below.
// The whole-section collapse is retired — collapsing moved down to each step's
// findings (see step-card.js). `editing` drives the "Edit plan" toggle's
// pressed state; the toggle used to live on the Steps header.
export function renderPlanSection(j, { timelineHtml = '', editing = false } = {}) {
  // Not timelineHtml truthiness — an executing job momentarily between steps still belongs in
  // the live layout, not the review card. Not job state alone either: see planIsLive.
  const live = planIsLive(j);
  // A plan amendment (replan) during execution keeps the running timeline in
  // view below the reconciliation banner — the pre-merge Steps block did too.
  if (j.pendingReconciliation) {
    const recon = renderReconciliation(j);
    return live && timelineHtml
      ? `<section class="plan-section plan-section--live">${recon}${timelineHtml}</section>`
      : recon;
  }
  const steps = (j.steps ?? []).filter((s) => !s.cancelled);
  const noPlanYet = j.state === 'planning' && steps.length === 0;
  const orchestratorLive = !!j.orchestratorSessionId;
  const awaitingLaunch = noPlanYet && !orchestratorLive;
  const approved = j.plan?.postedAt && live;

  const header = `
    <div class="plan-heading">
      <span class="plan-heading-label">Plan</span>
      <span class="plan-heading-count">${String(steps.length).padStart(2, '0')}</span>
      <span class="plan-heading-spacer"></span>
      ${approved ? `<span class="plan-heading-approved">approved</span>` : ''}
      ${j.state === 'executing'
        ? `<button class="o-btn ${editing ? 'o-btn--primary' : 'o-btn--default'}" type="button" data-job-action="toggle-edit-plan" aria-pressed="${editing}">${editing ? 'Done editing' : 'Edit plan'}</button>`
        : ''}
      ${awaitingLaunch
        ? `<button class="o-btn o-btn--primary plan-heading-launch" type="button" data-job-action="launch-orchestrator">Launch orchestrator</button>`
        : ''}
    </div>
  `;

  // Collapsible, and rendered *below* the live orchestrator feed — it's the completed
  // rationale, supporting context to the feed's live activity. Once the job is
  // executing/done it collapses by default; during planning/review it stays open
  // so the investigation is front-and-center while the plan is being reviewed.
  const findings = renderFinding(j.plan?.findings, 'Investigation', { collapsible: true, open: !live });
  // A step-review runs the orchestrator on top of an executing plan, so its feed
  // appears above a timeline that stays put. Say which step it's reviewing —
  // otherwise a live planner feed mid-execution reads as an unexplained replan.
  const reviewIdx = j.reviewingStepId ? steps.findIndex((s) => s.id === j.reviewingStepId) : -1;
  const reviewNote = reviewIdx >= 0
    ? `<div class="plan-review-note o-microhead">Reviewing step ${String(reviewIdx + 1).padStart(2, '0')} before continuing</div>`
    : '';
  const replanMount = orchestratorLive && steps.length > 0
    ? `${reviewNote}<div class="orchestrator-inline-session-mount orchestrator-inline-session-mount--replan" data-session-id="${escapeHtml(j.orchestratorSessionId)}" data-job-id="${escapeHtml(j.id)}"></div>`
    : '';
  const foot = (awaitingLaunch || noPlanYet) ? '' : `
    <div class="plan-card-foot">
      <button class="o-btn o-btn--default" type="button" data-job-action="add-step-end">+ Add step</button>
      <button class="o-btn o-btn--default" type="button" data-job-action="reopen-orchestrator" aria-expanded="false">Reopen orchestrator</button>
      ${planApproveButton(j)}
    </div>`;
  const replanComposer = `
      <div class="replan-composer" data-open="false" aria-hidden="true">
        <div class="field-label">What changed?</div>
        <textarea class="field-textarea replan-textarea" placeholder="The orchestrator reads this and posts an amended plan."></textarea>
        <div class="replan-composer-actions">
          <button class="o-btn o-btn--default" type="button" data-job-action="replan-cancel">Cancel</button>
          <button class="o-btn o-btn--primary" type="button" data-job-action="replan-submit">Send to orchestrator</button>
        </div>
      </div>`;

  if (live) {
    return `
    <section class="plan-section plan-section--live">
      ${header}
      ${replanMount}
      ${findings}
      ${timelineHtml}
      ${foot}
      ${replanComposer}
    </section>
  `;
  }

  return `
    <section class="plan-section plan-section--review">
      ${header}
      <div class="plan-card">
        ${replanMount}
        ${findings}
        <div class="plan-index">
          ${steps.length === 0
            ? (orchestratorLive
                ? `<div class="orchestrator-inline-session-mount" data-session-id="${escapeHtml(j.orchestratorSessionId)}" data-job-id="${escapeHtml(j.id)}"></div>`
                : `<div class="launch-context">
                     <label class="field-label" for="launch-context-input">Anything the planner should know? (optional)</label>
                     <textarea id="launch-context-input" class="field-textarea launch-context-textarea" placeholder="Priorities, constraints, where to look — passed to the planner when you launch."></textarea>
                     <div class="work-empty">No plan yet. Click "Launch orchestrator" to start.</div>
                   </div>`)
            : steps.map(planIndexRow).join('')}
        </div>
        ${foot}
        ${replanComposer}
      </div>
    </section>
  `;
}

export function toggleReplanComposer(root, open) {
  const composer = root.querySelector('.replan-composer');
  const trigger = root.querySelector('[data-job-action="reopen-orchestrator"]');
  if (!composer) return;
  composer.setAttribute('data-open', open ? 'true' : 'false');
  composer.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const ta = composer.querySelector('.replan-textarea');
    setTimeout(() => ta?.focus(), 60);
  }
}

export async function submitReplan(root, jobId) {
  const composer = root.querySelector('.replan-composer');
  const ta = composer?.querySelector('.replan-textarea');
  const submit = composer?.querySelector('[data-job-action="replan-submit"]');
  if (!composer || !ta || !submit) return;
  const fb = ta.value.trim();
  if (!fb) { ta.focus(); return; }
  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    await work.replan(jobId, fb);
    ta.value = '';
    toggleReplanComposer(root, false);
  } catch (e) {
    submit.disabled = false;
    submit.textContent = 'Send to orchestrator';
    alert(`Replan failed: ${e?.message ?? e}`);
  }
}
