// The body of an `orchestrated` timeline step — a controller action that owns the step
// and picks one move per turn. step-card.js mounts this inside the step's `.tl-content`
// (both layouts; mobile arranges the same renderer), so the title/description/time header
// and the failure callout stay with the timeline and are not repeated here.
//
// Three bands, in the order a reader walks them: what this step IS → where the work STANDS →
// what is happening and what you'd say about it. The last band ends at the bottom edge of the
// card, and that is the whole point of the arrangement.
//
// 1. IDENTITY — which controller, which repo. One row.
// 2. RECORD (`.orc-record`) — the PR block, settled dispatches, the trail strip. State that
//    accumulates: you scan it, you rarely act in it.
// 3. LIVE — anything holding for your approval → the controller's own feed, which streams
//    while it's working and states its status once it parks → the box you answer it in.
//
// The live band used to sit ABOVE the record, which put a growing feed and its composer on
// the far side of a PR block that is itself hundreds of pixels of threads and checks. Every
// glance at "what is it saying now" and every reply meant scrolling back up past all of it,
// then back down to check CI. Bottom-anchoring the live band means the newest thing to read
// and the only thing to type in are both where the scroll already ends — one destination,
// not two. The card owns the session mount itself (step-card.js renders it only for
// non-orchestrated steps) precisely so the composer can sit directly under the feed.
//
// The trail is the last thing in the record band, so the transition into the live band is one
// quiet strip of chips rather than the tail of a comment thread. Six artifacts used to stack
// as six sibling disclosures, each with its own label row and caret, at ~190px before a
// single one was opened; they're now one strip that opens one body at a time.
//
// Everything is still its own stacked row. Never one crammed eyebrow line.

import { work } from '../../state/work.js';
import { orchestratedRows } from '../../vm/tracked.js';
import { actionCategory, actionDisplayName, actionIconHtml } from './action-icon.js';
import { hasPrBlock, renderPrBlockHtml, wirePrBlockActions } from './pr-block.js';
import { renderWriteDraft, wireWriteDraft } from './write-draft-card.js';
import { isReplyDraft } from './reply-draft.js';
import { renderMarkdown } from '../../markdown.js';
import { wireOverflowMenu } from '../../utils/overflow-menu.js';
import { openSession } from '../../app-bridge.js';
import { shortName } from '../../utils/formatting.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
// The trail's chips carry DOM ids so they can point `aria-controls` at their bodies, and a
// step id is only guaranteed to be a string. Same defence as vm/tracked.js's slugOf.
function domId(s) { return String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '_'); }

// pr-block.js reads the flat shape the deleted `open-pr` step had: PR facts at the top
// level and the old state vocabulary. The facts are unchanged — only where they hang —
// so adapt here rather than fork the block. Only the one phase pr-block still branches
// on is mapped; every other phase stays blank (`implement` used to map too, purely to
// retitle the removed review banner). Spec/implPlan deliberately do NOT get mapped: the
// card renders every artifact once, in the trail strip.
const PR_BLOCK_STATE = { merged: 'merged' };
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

// Row 1 of the live tier: identity — which controller, which repo — on the `.tl-ident` row
// an `action` step also renders (step-card.js), same position and same category-colored
// chip, so the two step types agree about where a step says what it is. Identity only: state
// belongs to the status line below it and to the PR block. This used to render BELOW the
// transcript tail, so you read what the controller was saying before you knew which
// controller was saying it.
//
// The step's own overflow (Mark resolved) rides on the right of this row rather than as a
// full-width button under the whole card: `.tl-hdr` can't take it — it already reserves
// 110px for the plan editor's ▲▼✎× toolbar. On desktop `.o-menu` is `display: contents`
// (primitives.css), so this is a flat right-aligned ghost button there and a real ⋯
// dropdown on mobile.
function metaRowHtml(s, vm) {
  const bits = [];
  if (s.controller) {
    bits.push(`<span class="type-mono" data-cat="${escapeHtml(actionCategory(s.controller))}">${escapeHtml(actionDisplayName(s.controller))}</span>`);
  }
  // The repo, same as an action step names it. This slot used to hold the phase pill, which
  // restated the PR block one row below — see statusLineOf in vm/tracked.js for where the
  // phase went and why it's still reachable.
  if (s.workspace?.repoCwd) {
    bits.push(`<span class="tl-ident-repo">${escapeHtml(shortName(s.workspace.repoCwd))}</span>`);
  }
  // The PR block carries the branch in its own stats row; only name it here when there
  // isn't one yet (spec/plan phases), so the workspace is never invisible.
  if (!orchestratedHasPrBlock(s) && s.workspace?.branch) {
    bits.push(`<span class="o-pill code">${escapeHtml(s.workspace.branch)}</span>`);
  }
  const menu = overflowHtml(vm);
  if (!bits.length && !menu) return '';
  return `<div class="tl-ident">${bits.join('')}<span class="tl-ident-spacer"></span>${menu}</div>`;
}

function overflowHtml(vm) {
  if (!vm.canMarkResolved) return '';
  const { label, hint } = vm.markResolved;
  return `
    <div class="o-menu">
      <button type="button" class="o-btn o-btn--ghost sm o-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
      <div class="o-menu-body" hidden>
        <button class="o-btn o-btn--ghost sm" data-orc-action="mark-resolved"${hint ? ` title="${escapeHtml(hint)}"` : ''}>${escapeHtml(label)}</button>
      </div>
    </div>`;
}

// The controller's own transcript tail — and, once its session goes quiet, its status
// instead, as a chip in the same slot a finished action step uses for "✓ Finished in 10m37s"
// (session-terminal-chip.js). The status used to be a row of its own right here, above the
// feed, which meant a parked controller said it twice: once as prose, and once as the two
// lines of transcript it happened to end on.
//
// Rendered here rather than by step-card.js (which
// still owns it for every other step type) so the composer can follow immediately after it.
// syncInlineMounts keys purely on sessionId across the whole rendered tree, so the mount
// works identically wherever in the step it lands — it just has to appear exactly once.
function feedMountHtml(s) {
  if (!s.sessionId) return '';
  return `<div class="step-inline-session-mount" data-session-id="${escapeHtml(s.sessionId)}" data-step-id="${escapeHtml(s.id)}"></div>`;
}

// A running dispatch IS the implementor session, and its row used to offer exactly one way to
// find out what it was doing: "Open ↗". So a controller that had fanned the work out showed a
// static brief written at dispatch time, for however long the child took. The child gets its
// own feed here for the same reason the controller has one — syncInlineMounts keys purely on
// sessionId across the whole rendered tree at any depth, so this needs no new plumbing, only
// the mount. Only while it is running: a settled dispatch's row is record, and mounting a
// finished child would make the daemon respawn its long-reaped subprocess (see the terminal
// guard in mountInlineSession).
function dispatchFeedHtml(d) {
  if (d.status !== 'running' || !d.sessionId) return '';
  return `<div class="orc-dispatch-feed step-inline-session-mount" data-session-id="${escapeHtml(d.sessionId)}"></div>`;
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
      ${dispatchFeedHtml(d)}
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

// A dispatch that raised its own write draft is parked on YOU, but the draft renders inside
// the dispatch's row (never hoisted to the controller's gate — see vm/tracked.js). So when
// one is pending, the whole dispatch list moves up into the hold band with the gate; the
// rest of the time it reads as process record and sits below the feed.
function dispatchesAreHolding(vm) {
  return vm.dispatchRows.some((d) => !!d.draft);
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

function gateActionsHtml(vm) {
  if (!vm.gate) return '';
  // The verdict is picked at SUBMIT, never inferred from which box you typed in. The composer
  // used to have one Submit that always sent `approved: false`, so it was the only way to
  // answer a gate in words at all — a user typing "go ahead and run it" into it recorded a
  // decline, and the controller had to guess which half to believe (it guessed right, then
  // journalled the contradiction). Two submits, one textarea: an approval with a note is now
  // sayable, and a decline can't be typed by accident.
  return `
    <div class="step-actions">
      <button class="o-btn o-btn--primary" data-orc-action="approve-gate">Approve</button>
      <button class="o-btn o-btn--default" data-orc-action="toggle-gate-feedback">Respond…</button>
      <div class="thread-composer" data-composer="orc-gate-feedback" hidden>
        <textarea class="thread-compose-input" data-autogrow placeholder="A note for the controller — then pick a verdict below."></textarea>
        <div class="thread-composer-row">
          <button class="o-btn o-btn--primary" data-orc-action="approve-gate-note" disabled>Approve with this note</button>
          <button class="o-btn o-btn--default" data-orc-action="submit-gate-feedback" disabled>Request changes</button>
        </div>
      </div>
    </div>`;
}

// Steering a live controller: the message lands in its inbox and wakes it on the next
// tick, so it's the lever for a step that's waiting rather than gated. A settled step
// has nothing to wake.
//
// One line tall at rest, growing with what's typed (utils/autogrow.js), and the Send row
// only appears once there's something to send. The box was previously a permanently-open
// 76px textarea plus a button row on every live orchestrated step in the timeline.
function composerHtml(s) {
  if (s.cancelled || s.state === 'resolved' || s.state === 'failed') return '';
  return `
    <div class="thread-composer orc-msg" data-composer="orc-message">
      <textarea class="thread-compose-input" rows="1" data-autogrow placeholder="Message the controller…"></textarea>
      <div class="thread-composer-row">
        <button class="o-btn o-btn--default" data-orc-action="send-message">Send</button>
      </div>
    </div>`;
}

// The record tier's signature: the controller's memo and every artifact it has reported, as
// one strip of chips in the order they were produced, with one body open at a time. Reading
// two artifacts side by side was never possible anyway (they're full-width prose), so
// exclusivity costs nothing and buys back the five stacked label rows.
//
// Plain buttons rather than <details>: an exclusive native accordion needs `<details name>`,
// and detail.js's repaint-survival snapshot only knows about `<details>` and `[data-composer]`
// — the open chip is carried across repaints explicitly instead (snapshotUi/restoreUi).
function trailHtml(step, vm) {
  if (!vm.artifactRows.length) return '';
  const base = `orc-trail-${domId(step.id)}`;
  const chips = vm.artifactRows.map((a) => `
    <button type="button" class="orc-trail-chip" data-trail-chip="${escapeHtml(a.slug)}"
            aria-expanded="false" aria-controls="${base}-${escapeHtml(a.slug)}">
      ${escapeHtml(a.label)}${a.latest ? '<span class="orc-trail-dot" aria-hidden="true"></span>' : ''}
    </button>`).join('');
  const bodies = vm.artifactRows.map((a) => `
    <div class="orc-trail-body" id="${base}-${escapeHtml(a.slug)}" data-trail-body="${escapeHtml(a.slug)}" hidden>
      <div class="step-findings md-body">${renderMarkdown(a.body)}</div>
    </div>`).join('');
  return `
    <div class="orc-trail" data-trail>
      <span class="orc-trail-caret" aria-hidden="true">▸</span>
      ${chips}
      ${bodies}
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
  const dispatches = dispatchesHtml(vm);
  const holding = dispatchesAreHolding(vm);
  const record = `
    ${orchestratedHasPrBlock(step) ? renderPrBlockHtml(job, prView(step), { replyDraft }) : ''}
    ${holding ? '' : dispatches}
    ${trailHtml(step, vm)}`;
  return `
    <div class="orc-card">
      ${metaRowHtml(step, vm)}
      ${record.trim() ? `<div class="orc-record">${record}</div>` : ''}
      ${gateHtml(vm)}
      ${gateActionsHtml(vm)}
      ${vm.controllerDraft && !replyDraft ? renderWriteDraft(vm.controllerDraft) : ''}
      ${holding ? dispatches : ''}
      ${feedMountHtml(step)}
      ${composerHtml(step)}
    </div>`;
}

// One artifact body open at a time. `slug` of null closes everything (re-clicking the open
// chip), which is also the state every repaint starts in — restoreUi re-clicks the chip the
// user had open.
function openTrail(trail, slug) {
  trail.querySelectorAll('[data-trail-chip]').forEach((c) => {
    const on = c.getAttribute('data-trail-chip') === slug;
    c.classList.toggle('is-open', on);
    c.setAttribute('aria-expanded', String(on));
  });
  trail.querySelectorAll('[data-trail-body]').forEach((b) => {
    b.toggleAttribute('hidden', b.getAttribute('data-trail-body') !== slug);
  });
  trail.classList.toggle('is-open', slug != null);
}

function wireTrail(card) {
  const trail = card.querySelector('[data-trail]');
  if (!trail) return;
  trail.querySelectorAll('[data-trail-chip]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrail(trail, chip.classList.contains('is-open') ? null : chip.getAttribute('data-trail-chip'));
    });
  });
}

export function wireOrchestratedCard(el, step, { job } = {}) {
  const card = el.querySelector('.orc-card');
  if (!card) return;
  const vm = orchestratedRows(step);
  if (orchestratedHasPrBlock(step)) {
    wirePrBlockActions(card, job, prView(step), { replyDraft: replyDraftFor(step, vm) });
  }
  wireOverflowMenu(card);
  wireTrail(card);

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
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        void work.messageStep(job.id, step.id, body);
      } else if (kind === 'mark-resolved') {
        void work.markStepResolved(job.id, step.id);
      }
    });
  });

  // The message composer's Send row is revealed by `:focus-within` while you're in the box;
  // `is-open` is what keeps it reachable once focus leaves with text still in there.
  const msg = card.querySelector('[data-composer="orc-message"]');
  const msgInput = msg?.querySelector('textarea');
  if (msg && msgInput) {
    const sync = () => msg.classList.toggle('is-open', !!msgInput.value.trim());
    msgInput.addEventListener('input', sync);
    sync();
  }

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
