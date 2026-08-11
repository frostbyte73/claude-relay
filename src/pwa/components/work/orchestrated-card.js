// The body of an `orchestrated` timeline step — a controller action that owns the step
// and picks one move per turn. step-card.js mounts this inside the step's `.tl-content`
// (both layouts; mobile arranges the same renderer), so the title/time header, failure
// callout and inline session tail stay with the timeline and are not repeated here.
//
// Everything is stacked as its own row: phase, wait reason, dispatches, artifacts, PR block,
// gate, composer, overflow. Never one crammed eyebrow line. The order is the controller's own
// chronology — it specs and plans before it has a branch to push, so the spec and impl plan
// read above the PR they produced, not below it.

import { work } from '../../state/work.js';
import { orchestratedRows } from '../../vm/tracked.js';
import { actionCategory, actionDisplayName, actionIconHtml } from './action-icon.js';
import { hasPrBlock, renderPrBlockHtml, wirePrBlockActions } from './pr-block.js';
import { renderWriteDraft, wireWriteDraft } from './write-draft-card.js';
import { isReplyDraft } from './reply-draft.js';
import { renderMarkdown } from '../../markdown.js';
import { wireOverflowMenu } from '../../utils/overflow-menu.js';
import { openSession } from '../../app-bridge.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// pr-block.js reads the flat shape the deleted `open-pr` step had: PR facts at the top
// level and the old state vocabulary. The facts are unchanged — only where they hang —
// so adapt here rather than fork the block. Only the two phases pr-block still branches
// on are mapped; every other phase stays blank. Spec/implPlan deliberately do NOT get
// mapped: the card renders every artifact once, below, via artifactsHtml.
const PR_BLOCK_STATE = { merged: 'merged', implement: 'implementing' };
const PRE_PR_PHASES = new Set(['spec', 'plan']);

function prView(s) {
  return {
    ...s,
    ...(s.pr ?? {}),
    state: PR_BLOCK_STATE[s.phase] ?? '',
  };
}

// Exported so step-card.js can suppress its own diff/PR refs when the card already
// carries them, without reaching into the adapter above. `phase` is only written once
// the controller reports its first move, so an unset phase is still pre-PR — without
// that guard a just-created step shows a Discard CTA for work that doesn't exist yet.
export function orchestratedHasPrBlock(s) {
  if (!s.phase || PRE_PR_PHASES.has(s.phase)) return false;
  return hasPrBlock(prView(s));
}

// The controller is named here, as a category-colored action chip — the same treatment
// every other action gets. step-card.js leaves its `.tl-skill` slot empty for an
// orchestrated step so the name isn't printed twice, adjacent, in two typographies.
function chipsRowHtml(s, vm) {
  const bits = [];
  if (s.controller) {
    bits.push(`<span class="type-mono" data-cat="${escapeHtml(actionCategory(s.controller))}">${escapeHtml(actionDisplayName(s.controller))}</span>`);
  }
  if (vm.phaseChip) bits.push(`<span class="o-pill ${escapeHtml(vm.phaseChip.tone)}">${escapeHtml(vm.phaseChip.label)}</span>`);
  // The PR block carries the branch in its own stats row; only name it here when there
  // isn't one yet (spec/plan phases), so the workspace is never invisible.
  if (!orchestratedHasPrBlock(s) && s.workspace?.branch) {
    bits.push(`<span class="o-pill code">${escapeHtml(s.workspace.branch)}</span>`);
  }
  return bits.length ? `<div class="orc-chips">${bits.join('')}</div>` : '';
}

// Same callout the timeline uses for a parked meta.wait, in its neutral variant: this
// hold is on CI/review/a dispatch, not on the user, so it carries no --warn accent.
function waitRowHtml(vm) {
  if (!vm.waitingReason) return '';
  return `<div class="tl-wait tl-wait--neutral"><div class="tl-wait-reason">⏸ ${escapeHtml(vm.waitingReason)}</div></div>`;
}

function dispatchRowHtml(d) {
  const cat = actionCategory(d.action);
  return `
    <div class="orc-dispatch" data-dispatch-id="${escapeHtml(d.id)}">
      <span class="orc-dispatch-icon" data-cat="${escapeHtml(cat)}">${actionIconHtml(cat)}</span>
      <span class="type-mono" data-cat="${escapeHtml(cat)}">${escapeHtml(actionDisplayName(d.action))}</span>
      <span class="o-pill ${escapeHtml(d.tone)}">${escapeHtml(d.status)}</span>
      ${d.sessionId
        ? `<button type="button" class="o-btn o-btn--ghost sm orc-dispatch-open" data-orc-session="${escapeHtml(d.sessionId)}">Open ↗</button>`
        : ''}
      ${d.brief ? `<div class="orc-dispatch-brief">${escapeHtml(d.brief)}</div>` : ''}
      ${d.failure ? `<div class="orc-dispatch-failure">${escapeHtml(d.failure)}</div>` : ''}
      ${d.draft ? renderWriteDraft(d.draft) : ''}
    </div>`;
}

function dispatchesHtml(vm) {
  if (!vm.dispatchRows.length) return '';
  return `
    <div class="orc-dispatches">
      <div class="o-microhead">Dispatched</div>
      ${vm.dispatchRows.map(dispatchRowHtml).join('')}
    </div>`;
}

// Memo and artifacts are the controller's own paper trail — long, and only read on
// demand — so each folds into the same disclosure the step's findings use. Open state
// survives repaints via detail.js's snapshotUi, keyed on the artifact class.
function artifactsHtml(vm) {
  return vm.artifactRows.map((a) => `
    <details class="plan-findings tl-findings orc-artifact-${a.slug}">
      <summary class="tl-findings-sum">
        <span class="plan-findings-label o-microhead">${escapeHtml(a.label)}</span>
        <span class="tl-findings-caret" aria-hidden="true">▾</span>
      </summary>
      <div class="step-findings md-body">${renderMarkdown(a.body)}</div>
    </details>`).join('');
}

// The controller parked its move behind an approval: the exact payload it will run
// verbatim on approval, the question it asked, and any feedback already sent this round.
function gateHtml(vm) {
  if (!vm.gate) return '';
  const feedback = vm.gate.feedback
    .map((f) => `<div class="tl-gate-feedback">↩ ${escapeHtml(f)}</div>`)
    .join('');
  return `
    <div class="tl-gate">
      <div class="tl-gate-head">⚠ ${escapeHtml(vm.gate.question || 'Approve before this move runs')}</div>
      ${vm.gate.draft
        ? `<div class="tl-gate-body md-body">${renderMarkdown(vm.gate.draft)}</div>`
        : '<div class="tl-gate-body muted">Drafting…</div>'}
      ${feedback ? `<div class="tl-gate-feedbacks">${feedback}</div>` : ''}
    </div>`;
}

function actionsHtml(s, vm) {
  const bits = [];
  if (vm.gate) {
    // The verdict is picked at SUBMIT, never inferred from which box you typed in. The composer
    // used to have one Submit that always sent `approved: false`, so it was the only way to
    // answer a gate in words at all — a user typing "go ahead and run it" into it recorded a
    // decline, and the controller had to guess which half to believe (it guessed right, then
    // journalled the contradiction). Two submits, one textarea: an approval with a note is now
    // sayable, and a decline can't be typed by accident.
    bits.push(`
      <button class="o-btn o-btn--primary" data-orc-action="approve-gate">Approve</button>
      <button class="o-btn o-btn--default" data-orc-action="toggle-gate-feedback">Respond…</button>
      <div class="thread-composer" data-composer="orc-gate-feedback" hidden>
        <textarea class="thread-compose-input" data-autogrow placeholder="A note for the controller — then pick a verdict below."></textarea>
        <div class="thread-composer-row">
          <button class="o-btn o-btn--primary" data-orc-action="approve-gate-note" disabled>Approve with this note</button>
          <button class="o-btn o-btn--default" data-orc-action="submit-gate-feedback" disabled>Request changes</button>
        </div>
      </div>`);
  }
  if (vm.canMarkResolved) {
    const { label, hint } = vm.markResolved;
    bits.push(`
      <div class="o-menu">
        <button type="button" class="o-btn o-btn--ghost o-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
        <div class="o-menu-body" hidden>
          <button class="o-btn o-btn--ghost" data-orc-action="mark-resolved"${hint ? ` title="${escapeHtml(hint)}"` : ''}>${escapeHtml(label)}</button>
        </div>
      </div>`);
  }
  return bits.length ? `<div class="step-actions">${bits.join('')}</div>` : '';
}

// Steering a live controller: the message lands in its inbox and wakes it on the next
// tick, so it's the lever for a step that's waiting rather than gated. A settled step
// has nothing to wake.
function composerHtml(s) {
  if (s.cancelled || s.state === 'resolved' || s.state === 'failed') return '';
  return `
    <div class="thread-composer orc-msg" data-composer="orc-message">
      <textarea class="thread-compose-input" data-autogrow placeholder="Message the controller…"></textarea>
      <div class="thread-composer-row">
        <button class="o-btn o-btn--default" data-orc-action="send-message">Send</button>
      </div>
    </div>`;
}

// A pending `code.reply-pr-comments` draft belongs in the PR block, one field per comment
// thread, not in a generic approval card stacked below it — the threads are the only place the
// replies mean anything. Only when the block is actually rendered: with no PR block there is
// nowhere for the threads to go, and the generic card is still the honest fallback.
function replyDraftFor(step, vm) {
  return orchestratedHasPrBlock(step) && isReplyDraft(vm.controllerDraft) ? vm.controllerDraft : null;
}

export function renderOrchestratedCard(step, { job } = {}) {
  const vm = orchestratedRows(step);
  const replyDraft = replyDraftFor(step, vm);
  return `
    <div class="orc-card">
      ${chipsRowHtml(step, vm)}
      ${waitRowHtml(vm)}
      ${dispatchesHtml(vm)}
      ${artifactsHtml(vm)}
      ${orchestratedHasPrBlock(step) ? renderPrBlockHtml(job, prView(step), { replyDraft }) : ''}
      ${gateHtml(vm)}
      ${vm.controllerDraft && !replyDraft ? renderWriteDraft(vm.controllerDraft) : ''}
      ${actionsHtml(step, vm)}
      ${composerHtml(step)}
    </div>`;
}

export function wireOrchestratedCard(el, step, { job } = {}) {
  const card = el.querySelector('.orc-card');
  if (!card) return;
  const vm = orchestratedRows(step);
  if (orchestratedHasPrBlock(step)) {
    wirePrBlockActions(card, job, prView(step), { replyDraft: replyDraftFor(step, vm) });
  }
  wireOverflowMenu(card);

  // The controller's own draft and each dispatch's are self-contained cards (their own
  // Accept/Propose changes/Deny) — wireWriteDraft finds its own markup by draft id inside
  // this card, same as any other draft mount point. That holds for a reply draft too: it
  // renders inside the PR block rather than below it, but it's the same `.wd-card` contract,
  // so nothing here needs to know where the markup ended up.
  if (vm.controllerDraft) wireWriteDraft(card, { jobId: job.id, stepId: step.id, draft: vm.controllerDraft });
  vm.dispatchRows.forEach((d) => {
    if (d.draft) wireWriteDraft(card, { jobId: job.id, stepId: step.id, draft: d.draft });
  });

  card.querySelectorAll('[data-orc-session]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSession({ id: btn.getAttribute('data-orc-session'), fromTicketId: job.id });
    });
  });

  card.querySelectorAll('[data-orc-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.getAttribute('data-orc-action');
      if (kind === 'approve-gate') {
        void work.resolveStepGate(job.id, step.id, true);
      } else if (kind === 'toggle-gate-feedback') {
        card.querySelector('[data-composer="orc-gate-feedback"]')?.toggleAttribute('hidden');
      } else if (kind === 'approve-gate-note' || kind === 'submit-gate-feedback') {
        const ta = card.querySelector('[data-composer="orc-gate-feedback"] textarea');
        const feedback = (ta?.value ?? '').trim();
        if (!feedback) { ta?.focus(); return; }
        void work.resolveStepGate(job.id, step.id, kind === 'approve-gate-note', feedback);
      } else if (kind === 'send-message') {
        const ta = card.querySelector('[data-composer="orc-message"] textarea');
        const body = (ta?.value ?? '').trim();
        if (!body) { ta?.focus(); return; }
        ta.value = '';
        void work.messageStep(job.id, step.id, body);
      } else if (kind === 'mark-resolved') {
        void work.markStepResolved(job.id, step.id);
      }
    });
  });

  // Both gate verdicts need a note, so neither is clickable until there is one — same rule the
  // write-draft card's revise/deny composers use.
  const gateNote = card.querySelector('[data-composer="orc-gate-feedback"] textarea');
  if (gateNote) {
    const verdicts = card.querySelectorAll(
      '[data-orc-action="approve-gate-note"], [data-orc-action="submit-gate-feedback"]');
    const sync = () => verdicts.forEach((b) => { b.disabled = !gateNote.value.trim(); });
    gateNote.addEventListener('input', sync);
    sync();
  }
}
