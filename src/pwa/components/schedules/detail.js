import { schedulesStore } from '../../state/schedules.js';
import { nav } from '../../state/nav.js';
import { isPaletteOpen } from '../palette/index.js';
import { scheduleDetail, draftValidity } from '../../vm/schedules.js';
import { escapeHtml } from '../../util.js';
import { emptyState } from '../shell/placeholder.js';
import { createSwitch } from './switch.js';
import { isDraftId, draftSessionId, consumeDraftSeed, startScheduleDraft } from './draft.js';
import { discardScheduleDraft } from '../../net/schedules.js';
import { renderTriggerCard } from './trigger-card.js';
import { renderWhatCard } from './what-card.js';
import { renderRoutingCard } from './routing-card.js';
import { renderRunsCard } from './runs-card.js';
import { wireOverflowMenu } from '../../utils/overflow-menu.js';

// Title-styled text input shared by the draft header and the existing-schedule
// header. `onInput` fires live (draft validity gate); `onCommit` fires on
// blur/Enter (existing-schedule rename → persist).
function nameField(initial, { onInput, onCommit } = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sched-detail-title-input';
  input.value = initial ?? '';
  input.placeholder = 'Untitled schedule';
  input.setAttribute('aria-label', 'Schedule name');
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  if (onCommit) input.addEventListener('change', () => onCommit(input.value.trim()));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  return input;
}

// Duplicate/Pause/Delete sit behind `.o-menu` (mobile brief: "Run-now as top
// CTA, Duplicate/Pause/Delete in ⋯") — desktop is unaffected since
// `.o-menu`/`.o-menu-body` render as `display: contents` there (primitives.css),
// so it still sees the same flat 4-button row it always has (D2: shared DOM,
// chrome-only divergence).
function renderHeader(schedule, mount, { onRunNow, onDuplicate, onTogglePause, onDelete }) {
  const hdr = document.createElement('div');
  hdr.className = 'sched-detail-hdr';
  hdr.innerHTML = `
    <span class="sched-detail-title-slot"></span>
    <div class="sched-detail-state ${schedule.enabled ? 'active' : 'paused'}">${schedule.enabled ? 'Active' : 'Paused'}</div>
    <div class="sched-detail-actions">
      <button type="button" class="o-btn o-btn--primary sched-run-now">Run now <span class="o-kbd">⌘↵</span></button>
      <div class="o-menu">
        <button type="button" class="o-btn o-btn--ghost o-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
        <div class="o-menu-body" hidden>
          <button type="button" class="o-btn o-btn--default sched-duplicate">Duplicate</button>
          <button type="button" class="o-btn o-btn--default sched-toggle-pause">${schedule.enabled ? 'Pause' : 'Resume'}</button>
          ${schedule.builtin ? '' : '<button type="button" class="o-btn o-btn--danger sched-delete">Delete</button>'}
        </div>
      </div>
    </div>
  `;
  hdr.querySelector('.sched-detail-title-slot').replaceWith(
    nameField(schedule.name, {
      onCommit: (v) => { if (v && v !== schedule.name) schedulesStore.update(schedule.id, { name: v }); },
    }),
  );
  hdr.querySelector('.sched-run-now').addEventListener('click', onRunNow);
  hdr.querySelector('.sched-duplicate').addEventListener('click', onDuplicate);
  hdr.querySelector('.sched-toggle-pause').addEventListener('click', onTogglePause);
  hdr.querySelector('.sched-delete')?.addEventListener('click', onDelete);
  wireOverflowMenu(hdr);
  return hdr;
}

// Throw the draft away: forget the local edit state, stop the builder session and
// drop its proposal (session-bound drafts only), and leave the pane. Nothing here
// is persisted server-side, so a failed discard call is not worth surfacing —
// the client is rid of the draft either way.
function discardDraft(mount, sessionId) {
  mount.__draft = null;
  mount.__seededProposal = null;
  mount.__schedCurrentId = null;
  if (sessionId) {
    discardScheduleDraft(sessionId).catch(() => { /* the builder session is dead to us regardless */ });
    schedulesStore.clearDraft(sessionId);
  }
  nav.select('schedules', null);
}

function discardButtonHtml() {
  return '<button type="button" class="o-btn o-btn--ghost sched-draft-discard">Discard</button>';
}

// A not-yet-persisted schedule. Reuses the same three cards as an existing
// schedule, but their onSave mutates a local draft instead of the API; the
// schedule is POSTed only once name + trigger + what are complete. Trigger and
// What start in edit mode so it reads as a form.
function renderDraft(mount, id) {
  const sessionId = draftSessionId(id);
  if (sessionId) return renderSessionDraft(mount, id, sessionId);

  // Each launch gets a fresh id (draft.js), so a new id always means a new draft.
  if (mount.__schedCurrentId !== id) {
    mount.__draft = consumeDraftSeed() ?? { name: '', trigger: null, what: null, guards: [], routing: {} };
    mount.__schedEditState = { trigger: true, what: true, routing: false };
    mount.__schedCurrentId = id;
  }
  const draft = mount.__draft;
  const editState = mount.__schedEditState;
  let persisting = false;

  // Local mutation only — no full repaint. Each card owns its own slot and
  // re-renders in place (renderCardInto), so saving one card never rebuilds a
  // sibling that's also mid-edit and discards its unsaved input.
  const onSave = (patch) => { Object.assign(draft, patch); return Promise.resolve(); };

  async function persist(enabled) {
    if (persisting || !draftValidity(draft).valid) return;
    persisting = true;
    mount.querySelector('.sched-draft-save-paused')?.setAttribute('disabled', '');
    const sw = mount.querySelector('.sched-draft-enable-slot .sched-switch');
    if (sw) sw.disabled = true;
    try {
      const res = await schedulesStore.create({
        name: draft.name.trim(),
        enabled,
        trigger: draft.trigger,
        what: draft.what,
        guards: draft.guards ?? [],
        routing: draft.routing ?? {},
      });
      if (res?.schedule?.id) nav.select('schedules', res.schedule.id);
    } catch (e) {
      const err = mount.querySelector('.sched-draft-error');
      if (err) { err.textContent = `Couldn't save: ${e.message}`; err.hidden = false; }
    } finally {
      persisting = false;
      refreshGate();
    }
  }

  // Live-update the enable/save gate on name keystrokes without a full repaint
  // (repainting would blur the name input mid-type).
  function refreshGate() {
    const { valid, missing } = draftValidity(draft);
    const sw = mount.querySelector('.sched-draft-enable-slot .sched-switch');
    if (sw) sw.disabled = !valid;
    const savePaused = mount.querySelector('.sched-draft-save-paused');
    if (savePaused) savePaused.disabled = !valid;
    const hint = mount.querySelector('.sched-draft-hint');
    if (hint) { hint.hidden = valid; hint.textContent = valid ? '' : `Add ${missing.join(', ')} to enable this schedule.`; }
  }

  function paint() {
    const { valid, missing } = draftValidity(draft);
    mount.textContent = '';

    const hdr = document.createElement('div');
    hdr.className = 'sched-detail-hdr sched-detail-hdr--draft';
    hdr.innerHTML = `
      <span class="sched-detail-title-slot"></span>
      <div class="sched-detail-state draft">Draft</div>
      <div class="sched-detail-actions">
        ${discardButtonHtml()}
        <button type="button" class="o-btn o-btn--default sched-draft-save-paused"${valid ? '' : ' disabled'}>Save paused</button>
        <label class="sched-draft-enable"><span class="sched-draft-enable-label">Enable</span><span class="sched-draft-enable-slot"></span></label>
      </div>
    `;
    hdr.querySelector('.sched-detail-title-slot').replaceWith(
      nameField(draft.name, { onInput: (v) => { draft.name = v; refreshGate(); } }),
    );
    hdr.querySelector('.sched-draft-discard').addEventListener('click', () => {
      const filled = draft.name.trim() || draft.trigger || draft.what;
      if (filled && !confirm('Discard this draft? It hasn’t been saved.')) return;
      discardDraft(mount, null);
    });
    const enableSwitch = createSwitch(false, (on) => { if (on) persist(true); }, 'Enable schedule');
    enableSwitch.disabled = !valid;
    hdr.querySelector('.sched-draft-enable-slot').appendChild(enableSwitch);
    hdr.querySelector('.sched-draft-save-paused').addEventListener('click', () => persist(false));
    mount.appendChild(hdr);

    const hint = document.createElement('p');
    hint.className = 'sched-form-hint sched-draft-hint';
    hint.hidden = valid;
    hint.textContent = valid ? '' : `Add ${missing.join(', ')} to enable this schedule.`;
    mount.appendChild(hint);

    const errLine = document.createElement('div');
    errLine.className = 'sched-form-error sched-draft-error';
    errLine.hidden = true;
    mount.appendChild(errLine);

    const body = document.createElement('div');
    body.className = 'sched-detail-body';
    const triggerSlot = document.createElement('div');
    const whatSlot = document.createElement('div');
    const routingSlot = document.createElement('div');
    body.append(triggerSlot, whatSlot, routingSlot);
    mount.appendChild(body);
    renderCardInto(triggerSlot, renderTriggerCard);
    renderCardInto(whatSlot, renderWhatCard);
    renderCardInto(routingSlot, renderRoutingCard);
  }

  // Re-render a single card in place. Its repaint callback re-renders only this
  // slot and refreshes the header gate — so a card's save/edit-toggle never
  // touches its siblings' DOM.
  function renderCardInto(slot, renderFn) {
    const detail = scheduleDetail(draft, [], Date.now());
    const repaintThis = () => { renderCardInto(slot, renderFn); refreshGate(); };
    // sessionId:null → what-card offers Test on a script, but not Redraft (no builder session).
    slot.replaceChildren(renderFn(draft, detail, editState, repaintThis, onSave, { sessionId: null }));
  }

  paint();
  const cleanup = () => {};
  mount.__schedCleanup = cleanup;
  return cleanup;
}

// A prompt-first draft: the meta.build-schedule builder proposes name + trigger +
// what over WS (schedulesStore.draftBySession), and the user reviews/tests/saves
// it here. Same three cards + persist path as a blank draft, but seeded from the
// proposal and re-seeded when a redraft arrives, with Save always available.
function renderSessionDraft(mount, id, sessionId) {
  if (mount.__schedCurrentId !== id) {
    mount.__schedEditState = { trigger: false, what: false, routing: false };
    mount.__schedCurrentId = id;
    mount.__seededProposal = null;
    mount.__draft = null;
  }
  let persisting = false;
  let discarding = false;

  const onSave = (patch) => { Object.assign(mount.__draft, patch); return Promise.resolve(); };

  // clearDraft notifies before we've navigated away — without the flag the pane
  // repaints itself back to the "Drafting…" spinner on the way out.
  function discard() {
    discarding = true;
    discardDraft(mount, sessionId);
  }

  async function persist(enabled) {
    if (persisting || !mount.__draft) return;
    persisting = true;
    mount.querySelector('.sched-draft-save-paused')?.setAttribute('disabled', '');
    const sw = mount.querySelector('.sched-draft-enable-slot .sched-switch');
    if (sw) sw.disabled = true;
    try {
      const d = mount.__draft;
      const res = await schedulesStore.create({
        name: (d.name ?? '').trim(),
        enabled,
        trigger: d.trigger,
        what: d.what,
        guards: d.guards ?? [],
        routing: d.routing ?? {},
      });
      schedulesStore.clearDraft(sessionId);
      if (res?.schedule?.id) nav.select('schedules', res.schedule.id);
    } catch (e) {
      persisting = false;
      const err = mount.querySelector('.sched-draft-error');
      if (err) { err.textContent = `Couldn't save: ${e.message}`; err.hidden = false; }
      mount.querySelector('.sched-draft-save-paused')?.removeAttribute('disabled');
      if (sw) sw.disabled = false;
    }
  }

  function renderCardInto(slot, renderFn) {
    const detail = scheduleDetail(mount.__draft, [], Date.now());
    const repaintThis = () => renderCardInto(slot, renderFn);
    slot.replaceChildren(renderFn(mount.__draft, detail, mount.__schedEditState, repaintThis, onSave, { sessionId }));
  }

  function paint() {
    const proposal = schedulesStore.get().draftBySession.get(sessionId) ?? null;
    mount.textContent = '';

    const hdr = document.createElement('div');
    hdr.className = 'sched-detail-hdr sched-detail-hdr--draft';

    if (!proposal) {
      const failure = schedulesStore.get().draftFailedBySession.get(sessionId) ?? null;
      hdr.innerHTML = `
        <span class="sched-detail-title-slot"></span>
        <div class="sched-detail-state draft">Draft</div>
        <div class="sched-detail-actions">${discardButtonHtml()}</div>
      `;
      hdr.querySelector('.sched-detail-title-slot').replaceWith(nameField('', {}));
      // Nothing to lose once the builder has already failed — only confirm while it's
      // still working, where Discard is what kills the running session.
      hdr.querySelector('.sched-draft-discard').addEventListener('click', () => {
        if (!failure && !confirm('Discard this draft? The schedule builder will stop.')) return;
        discard();
      });
      mount.appendChild(hdr);
      // A failed builder never delivers a proposal — surface the failure with a way out
      // instead of spinning on "Drafting…" forever.
      if (failure) {
        const err = document.createElement('div');
        err.className = 'sched-drafting sched-drafting--failed';
        err.textContent = failure.reason || 'The schedule builder stopped before proposing a draft.';
        mount.appendChild(err);
        const startBlank = document.createElement('button');
        startBlank.type = 'button';
        startBlank.className = 'o-btn o-btn--default sched-draft-start-blank';
        startBlank.textContent = 'Start blank';
        startBlank.addEventListener('click', () => startScheduleDraft());
        mount.appendChild(startBlank);
        return;
      }
      const drafting = document.createElement('div');
      drafting.className = 'sched-drafting';
      drafting.innerHTML = '<span class="sched-drafting-dot"></span>Drafting your schedule…';
      mount.appendChild(drafting);
      return;
    }

    // Re-seed only when a *new* proposal object arrives (initial or redraft), so
    // an unrelated repaint never discards in-progress card edits.
    if (mount.__seededProposal !== proposal) {
      mount.__seededProposal = proposal;
      mount.__draft = {
        name: proposal.name ?? '',
        trigger: proposal.trigger ?? null,
        what: proposal.what ?? null,
        guards: [],
        routing: {},
      };
      mount.__schedEditState = { trigger: false, what: false, routing: false };
    }
    const draft = mount.__draft;

    hdr.innerHTML = `
      <span class="sched-detail-title-slot"></span>
      <div class="sched-detail-state draft">Draft</div>
      <div class="sched-detail-actions">
        ${discardButtonHtml()}
        <button type="button" class="o-btn o-btn--default sched-draft-save-paused">Save paused</button>
        <label class="sched-draft-enable"><span class="sched-draft-enable-label">Enable</span><span class="sched-draft-enable-slot"></span></label>
      </div>
    `;
    hdr.querySelector('.sched-detail-title-slot').replaceWith(
      nameField(draft.name, { onInput: (v) => { draft.name = v; } }),
    );
    hdr.querySelector('.sched-draft-discard').addEventListener('click', () => {
      if (!confirm('Discard this draft? It hasn’t been saved.')) return;
      discard();
    });
    const enableSwitch = createSwitch(false, (on) => { if (on) persist(true); }, 'Enable schedule');
    hdr.querySelector('.sched-draft-enable-slot').appendChild(enableSwitch);
    hdr.querySelector('.sched-draft-save-paused').addEventListener('click', () => persist(false));
    mount.appendChild(hdr);

    if (proposal.summary) {
      const cap = document.createElement('p');
      cap.className = 'sched-form-hint sched-draft-caption';
      cap.textContent = proposal.summary;
      mount.appendChild(cap);
    }

    const errLine = document.createElement('div');
    errLine.className = 'sched-form-error sched-draft-error';
    errLine.hidden = true;
    mount.appendChild(errLine);

    const body = document.createElement('div');
    body.className = 'sched-detail-body';
    const triggerSlot = document.createElement('div');
    const whatSlot = document.createElement('div');
    const routingSlot = document.createElement('div');
    body.append(triggerSlot, whatSlot, routingSlot);
    mount.appendChild(body);
    renderCardInto(triggerSlot, renderTriggerCard);
    renderCardInto(whatSlot, renderWhatCard);
    renderCardInto(routingSlot, renderRoutingCard);
  }

  paint();
  const unsub = schedulesStore.subscribe(() => {
    if (persisting || discarding) return; // save/discard in flight: the clearDraft it fires isn't ours to paint
    const proposal = schedulesStore.get().draftBySession.get(sessionId) ?? null;
    // Test-result writes leave the proposal identity unchanged — skip those once cards are up.
    if (proposal && proposal === mount.__seededProposal) return;
    const active = document.activeElement;
    if (active && active.classList?.contains('sched-detail-title-input') && mount.contains(active)) return;
    paint();
  });
  mount.__schedCleanup = unsub;
  return unsub;
}

export function renderDetail(mount, deps) {
  const id = deps?.selection ?? null;

  if (mount.__schedCleanup) { try { mount.__schedCleanup(); } catch { /* ignore */ } mount.__schedCleanup = null; }

  if (isDraftId(id)) return renderDraft(mount, id);

  if (!id) {
    emptyState(mount, 'Select a schedule to view its trigger, what-to-run, routing, and recent runs.');
    return undefined;
  }

  // Edit-mode flags survive repaints triggered by the same schedule's own
  // updates (e.g. a run finishing) but reset when the selection changes.
  if (mount.__schedCurrentId !== id) {
    mount.__schedEditState = { trigger: false, what: false, routing: false };
    mount.__schedCurrentId = id;
    schedulesStore.loadRuns(id);
  }
  const editState = mount.__schedEditState;

  async function onSave(patch) {
    await schedulesStore.update(id, patch);
  }

  function onKeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    // The ⌘K palette claims ⌘↵ for "send as session" while it's open — never
    // double-fire Run now underneath it (matches shell/keyboard.js's guard).
    if (isPaletteOpen()) return;
    // Don't hijack ⌘↵ while an edit form field is focused (e.g. the args
    // textarea) — only fires "Run now" when the detail pane itself has focus.
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    e.preventDefault();
    schedulesStore.runNow(id);
  }

  function paint() {
    // Don't blow away an in-progress rename: the header's name field is always
    // editable, and this repaint fires on any schedule's WS run/list event, not
    // just this one. Skip while it's focused — the pending edit commits on blur.
    const active = document.activeElement;
    if (active && active.classList?.contains('sched-detail-title-input') && mount.contains(active)) return;
    const { schedules, runsBySchedule } = schedulesStore.get();
    const schedule = schedules.find((s) => s.id === id);
    mount.textContent = '';
    if (!schedule) {
      emptyState(mount, 'This schedule was deleted.');
      return;
    }
    const detail = scheduleDetail(schedule, runsBySchedule.get(id) ?? [], Date.now());

    mount.appendChild(renderHeader(schedule, mount, {
      onRunNow: () => schedulesStore.runNow(id),
      onDuplicate: async () => {
        const res = await schedulesStore.duplicate(id);
        if (res?.schedule?.id) nav.select('schedules', res.schedule.id);
      },
      onTogglePause: () => (schedule.enabled ? schedulesStore.pause(id) : schedulesStore.resume(id)),
      onDelete: async () => {
        if (!confirm(`Delete "${schedule.name}"? This can't be undone.`)) return;
        await schedulesStore.remove(id);
        nav.select('schedules', null);
      },
    }));

    const body = document.createElement('div');
    body.className = 'sched-detail-body';
    body.appendChild(renderTriggerCard(schedule, detail, editState, paint, onSave));
    body.appendChild(renderWhatCard(schedule, detail, editState, paint, onSave));
    body.appendChild(renderRoutingCard(schedule, detail, editState, paint, onSave));
    body.appendChild(renderRunsCard(schedule, detail));
    mount.appendChild(body);
  }

  paint();
  const unsub = schedulesStore.subscribe(paint);
  document.addEventListener('keydown', onKeydown);
  const cleanup = () => { unsub(); document.removeEventListener('keydown', onKeydown); };
  mount.__schedCleanup = cleanup;
  return cleanup;
}
