// The write-draft approval card — the exact payload of an external write (Task 1-9's
// WriteDraft/PinnedCall), editable per field before the user decides. Mounted wherever a
// step or dispatch parks one: step-card.js for an ActionStep's own draft, orchestrated-
// card.js for a controller's or a dispatch's. One draft, one card — a step or dispatch
// holding several unapproved drafts (it doesn't, in practice, but the type allows it)
// gets one renderWriteDraft/wireWriteDraft call per entry, same as any other list.

import { work } from '../../state/work.js';
import { renderMarkdown } from '../../markdown.js';
import { escapeHtml } from '../../util.js';
import { showStatusToast } from '../../app-bridge.js';

function cssId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }

// Widget inference is by the VALUE's own type, not any schema — these calls came straight
// off an MCP tool_use, which carries no schema at the boundary. `kind` doubles as the
// data-kind the DOM read-back (collectCalls) uses to parse the edited value back to its
// original type, so a change here has to stay in lockstep with collectCalls below.
function widgetKind(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return v.includes('\n') || v.length > 80 ? 'text-long' : 'text';
  return 'json'; // null, array, object, or anything else JSON.stringify can round-trip
}

// The id is load-bearing, not decorative: it's the accessible-name target for `<label
// for>`, AND (per detail.js's snapshotUi/restoreUi) the key an edited-but-unsubmitted value
// survives a store-driven repaint under. Keep it stable across renders of the same draft.
function fieldHtml(draftId, callIdx, key, value) {
  const kind = widgetKind(value);
  const id = `wd-f-${cssId(draftId)}-${callIdx}-${cssId(key)}`;
  const dataAttrs = `data-call-idx="${callIdx}" data-arg-key="${escapeHtml(key)}"`;
  if (kind === 'boolean') {
    return `
      <div class="wd-field">
        <label class="field-check">
          <input type="checkbox" id="${id}" ${dataAttrs} data-kind="boolean" ${value ? 'checked' : ''} />
          <span>${escapeHtml(key)}</span>
        </label>
      </div>`;
  }
  if (kind === 'number') {
    return `
      <div class="wd-field">
        <label class="field-label" for="${id}">${escapeHtml(key)}</label>
        <input type="number" class="field-input" id="${id}" ${dataAttrs} data-kind="number" value="${escapeHtml(String(value))}" />
      </div>`;
  }
  if (kind === 'text') {
    return `
      <div class="wd-field">
        <label class="field-label" for="${id}">${escapeHtml(key)}</label>
        <input type="text" class="field-input" id="${id}" ${dataAttrs} data-kind="string" value="${escapeHtml(value)}" />
      </div>`;
  }
  if (kind === 'text-long') {
    return `
      <div class="wd-field">
        <label class="field-label" for="${id}">${escapeHtml(key)}</label>
        <textarea class="field-textarea" id="${id}" ${dataAttrs} data-kind="string">${escapeHtml(value)}</textarea>
      </div>`;
  }
  // Opaque value (object/array/null) — round-tripped through JSON, parsed back on submit.
  // A parse failure blocks Accept (see collectCalls) rather than sending garbage.
  return `
    <div class="wd-field">
      <label class="field-label" for="${id}">${escapeHtml(key)} <span class="field-hint">JSON</span></label>
      <textarea class="field-textarea" id="${id}" ${dataAttrs} data-kind="json">${escapeHtml(JSON.stringify(value, null, 2))}</textarea>
    </div>`;
}

// One `files` entry (path -> content), rendered as its own editable textarea — a drafted
// body wants the multiline treatment (it's markdown or JSON), not the one-line `fieldHtml`
// text input. `data-arg-key="${path}"` (not a `data-file-path`-only attribute) is deliberate:
// detail.js's snapshotUi/restoreUi already keys every `.wd-card [id^="wd-f-"]` element on
// `data-call-idx` + `data-arg-key` (falling back to a `' bash'` sentinel only when neither is
// present) — reusing that exact attribute, with the path as its value, gives this field the
// same repaint-survival guarantee `fieldHtml`'s tool-arg fields get, in its own namespace
// (a `bash` call never otherwise sets `data-arg-key`, so there's nothing to collide with).
function fileFieldHtml(draftId, callIdx, path, content) {
  const id = `wd-f-${cssId(draftId)}-${callIdx}-file-${cssId(path)}`;
  return `
    <div class="wd-field">
      <label class="field-label" for="${id}">${escapeHtml(path)}</label>
      <textarea class="field-textarea wd-file-body" id="${id}" data-call-idx="${callIdx}" data-arg-key="${escapeHtml(path)}" data-kind="file">${escapeHtml(content)}</textarea>
    </div>`;
}

function callHtml(draftId, call, idx) {
  const label = call.label || (call.bash ? 'Command' : call.tool?.name) || `Call ${idx + 1}`;
  const bashId = `wd-f-${cssId(draftId)}-${idx}-bash`;
  // A call the hook released after its write failed may already have taken effect (the
  // failure is the TOOL's report, not proof the write never landed) — DESIGN §7.7: say why
  // before offering the fix, so this renders ABOVE the payload it qualifies, not buried
  // below it.
  //
  // NOTE — currently unreachable: `releasedAfterFailure` is only ever stamped by
  // `releasePin` (engine.ts), which only touches a call belonging to `draftForSession()`'s
  // draft — i.e. one with `approvedAt` already set (`draftForSession` returns undefined
  // otherwise). But both places that call `renderWriteDraft` (this file's own callers,
  // step-card.js's `draftsHtml` and tracked.js's `draftFor`) filter to `!d.approvedAt`
  // only, and nothing anywhere ever clears an existing `approvedAt` back to unset — so a
  // call can never carry `releasedAfterFailure: true` at the moment its draft would be
  // rendered. Left in place (harmless, and exactly what the spec asked for) rather than
  // removed, since the gap is in which drafts get rendered at all — an approved draft's
  // calls have no read-only progress view anywhere yet — not in this widget's own logic.
  const releasedNote = call.releasedAfterFailure
    ? `<div class="wd-call-released">⚠ A previous attempt at this call failed and was re-armed — it may already have taken effect. Verify before accepting again.</div>`
    : '';
  // `.wd-call-label` is the VISIBLE caption; `<legend>` gives the <fieldset> the same text
  // as its accessible name without printing it twice — visually hidden, not removed.
  if (call.bash !== undefined) {
    const fileFields = Object.entries(call.files ?? {})
      .map(([path, content]) => fileFieldHtml(draftId, idx, path, content))
      .join('');
    return `
      <fieldset class="wd-call" data-call-idx="${idx}" data-call-kind="bash">
        <legend class="o-sr-only">${escapeHtml(label)}</legend>
        <div class="wd-call-label o-microhead" aria-hidden="true">${escapeHtml(label)}</div>
        ${releasedNote}
        <label class="field-label" for="${bashId}">Command</label>
        <textarea class="field-textarea wd-bash" id="${bashId}" data-call-idx="${idx}" data-kind="bash">${escapeHtml(call.bash)}</textarea>
        ${fileFields}
      </fieldset>`;
  }
  const args = call.tool?.args ?? {};
  const fields = Object.entries(args).map(([k, v]) => fieldHtml(draftId, idx, k, v)).join('');
  return `
    <fieldset class="wd-call" data-call-idx="${idx}" data-call-kind="tool">
      <legend class="o-sr-only">${escapeHtml(label)}${call.tool?.name ? ` (${escapeHtml(call.tool.name)})` : ''}</legend>
      <div class="wd-call-label o-microhead" aria-hidden="true">${escapeHtml(label)} <span class="field-hint">${escapeHtml(call.tool?.name ?? '')}</span></div>
      ${releasedNote}
      ${fields || '<div class="field-hint">No arguments.</div>'}
    </fieldset>`;
}

// Pure render — no DOM reads, only the draft. `ctx` is currently unused by the body (the
// header's attribution comes straight off `draft.action`, which the daemon already
// resolves to the DISPATCHED action's own name for a dispatch-raised draft — see
// submit_write_draft's handler in daemon.ts) but kept for symmetry with wireWriteDraft and
// so a future caller can pass render-time context without changing the signature.
export function renderWriteDraft(draft, ctx = {}) {
  const feedback = (draft.feedback ?? [])
    .map((f) => `<div class="wd-feedback">↩ ${escapeHtml(f)}</div>`)
    .join('');
  // detail.js's `detailsKey` is `className|stepId` — a bare "plan-findings tl-findings"
  // would collide with the step's own findings block (identical className, same step), and
  // with a SECOND draft's own evidence block on the same step (two dispatches under one
  // controller), toggling one open/closed state across all of them. The per-draft class
  // (same trick tracked.js's `slugOf` uses for artifact keys) makes it unique.
  const evidence = draft.evidence
    ? `<details class="plan-findings tl-findings wd-evidence-${cssId(draft.id)}">
        <summary class="tl-findings-sum"><span class="plan-findings-label o-microhead">Evidence</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary>
        <div class="step-findings md-body">${renderMarkdown(draft.evidence)}</div>
      </details>`
    : '';
  return `
    <div class="wd-card" data-draft-id="${escapeHtml(draft.id)}">
      <div class="wd-head">⚠ ${escapeHtml(draft.action)} wants to ${escapeHtml(draft.summary)}</div>
      ${feedback ? `<div class="wd-feedbacks">${feedback}</div>` : ''}
      <div class="wd-calls">${draft.calls.map((c, i) => callHtml(draft.id, c, i)).join('')}</div>
      ${evidence}
      <div class="wd-error work-error" data-wd-error role="alert" hidden></div>
      <div class="step-actions">
        <button type="button" class="o-btn o-btn--primary" data-wd-action="accept">Accept</button>
        <button type="button" class="o-btn o-btn--default" data-wd-action="toggle-revise">Propose changes</button>
        <button type="button" class="o-btn o-btn--danger" data-wd-action="toggle-deny">Deny</button>
        <div class="thread-composer" data-composer="wd-revise-${escapeHtml(draft.id)}" hidden>
          <textarea class="thread-compose-input" data-autogrow placeholder="What should change about this draft?"></textarea>
          <div class="thread-composer-row">
            <button type="button" class="o-btn o-btn--primary" data-wd-action="submit-revise" disabled>Submit</button>
          </div>
        </div>
        <div class="thread-composer" data-composer="wd-deny-${escapeHtml(draft.id)}" hidden>
          <textarea class="thread-compose-input" data-autogrow placeholder="Why are you denying this?"></textarea>
          <div class="thread-composer-row">
            <button type="button" class="o-btn o-btn--danger" data-wd-action="submit-deny" disabled>Deny</button>
          </div>
        </div>
      </div>
    </div>`;
}

// Reads the (possibly edited) fields back into a fresh calls array shaped for
// acceptDraft/parseDraftCalls — original `id`/`consumedAt`/etc are never carried forward
// (the server rebuilds them; see write-draft.ts's parseDraftCalls). Returns per-field parse
// errors instead of throwing so the caller can show all of them at once rather than
// stopping at the first.
function collectCalls(card, draft) {
  const errors = [];
  const calls = draft.calls.map((call, idx) => {
    const fieldset = card.querySelector(`.wd-call[data-call-idx="${idx}"]`);
    const withLabel = (rest) => (call.label ? { label: call.label, ...rest } : rest);
    if (call.bash !== undefined) {
      const ta = fieldset?.querySelector('[data-kind="bash"]');
      const bash = ta ? ta.value : call.bash;
      const files = {};
      fieldset?.querySelectorAll('[data-kind="file"]').forEach((el) => { files[el.dataset.argKey] = el.value; });
      return withLabel({ bash, ...(Object.keys(files).length ? { files } : {}) });
    }
    const args = {};
    fieldset?.querySelectorAll('[data-arg-key]').forEach((el) => {
      const key = el.dataset.argKey;
      const kind = el.dataset.kind;
      if (kind === 'boolean') { args[key] = el.checked; return; }
      if (kind === 'number') {
        const n = Number(el.value);
        if (el.value.trim() === '' || Number.isNaN(n)) { errors.push(`"${key}" is not a valid number`); return; }
        args[key] = n;
        return;
      }
      if (kind === 'json') {
        try { args[key] = JSON.parse(el.value); }
        catch (e) { errors.push(`"${key}" isn't valid JSON: ${e.message}`); }
        return;
      }
      args[key] = el.value;
    });
    return withLabel({ tool: { name: call.tool?.name, args } });
  });
  return { calls, errors };
}

// Mounts behavior onto the markup renderWriteDraft produced somewhere inside `root` (the
// step's whole content root, not necessarily this card alone — step-card.js/orchestrated-
// card.js wire a step's full body in one pass, and a step can carry more than one draft).
export function wireWriteDraft(root, { jobId, stepId, draft }) {
  const card = root.querySelector(`.wd-card[data-draft-id="${CSS.escape(draft.id)}"]`);
  if (!card) return;

  const errEl = card.querySelector('[data-wd-error]');
  const showError = (msg) => { errEl.hidden = false; errEl.textContent = msg; };
  const clearError = () => { errEl.hidden = true; errEl.textContent = ''; };
  const setBusy = (busy) => card.querySelectorAll('[data-wd-action]').forEach((b) => { b.disabled = busy; });

  // net/work.js's `request()` throws `work api <status>: <reason>` — Task 9 wrote the
  // <reason> half to be a real, human-readable sentence (a 409 already-decided race, a 400
  // validation message); the `work api NNN:` half is transport plumbing the user has no use
  // for. Strip it for display only — the raw message is still what gets logged if this ever
  // needs debugging, since only the shown copy is stripped.
  const displayMessage = (msg) => msg.replace(/^work api \d+:\s*/, '');

  async function decide(run) {
    clearError();
    setBusy(true);
    try {
      await run();
    } catch (e) {
      const msg = displayMessage(e?.message || String(e));
      showError(msg);
      showStatusToast(`${draft.action}: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  card.querySelector('[data-wd-action="accept"]')?.addEventListener('click', () => {
    const { calls, errors } = collectCalls(card, draft);
    if (errors.length) { showError(errors.join('; ')); return; }
    void decide(() => work.acceptDraft(jobId, stepId, draft.id, calls));
  });

  function wireComposer(kind, submitFn) {
    // `data-composer` (not a `data-wd-*` name) so detail.js's repaint-preservation
    // (`snapshotUi`/`restoreUi`, scoped by `[data-composer]`) carries a half-typed revise/
    // deny reason and its open/closed state across a store-driven repaint, same as every
    // other composer in the timeline. The draft-id suffix is required, not cosmetic —
    // `composerKey` is `attr|stepId`, and two drafts can share one step (a dispatch's and
    // the controller's own), so a bare `wd-revise` would collide between them.
    const composer = card.querySelector(`[data-composer="wd-${kind}-${CSS.escape(draft.id)}"]`);
    if (!composer) return;
    const toggle = card.querySelector(`[data-wd-action="toggle-${kind}"]`);
    const ta = composer.querySelector('textarea');
    const submitBtn = composer.querySelector(`[data-wd-action="submit-${kind}"]`);
    toggle?.addEventListener('click', () => composer.toggleAttribute('hidden'));
    ta?.addEventListener('input', () => { submitBtn.disabled = !ta.value.trim(); });
    submitBtn?.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      void decide(() => submitFn(text));
    });
  }
  wireComposer('revise', (text) => work.reviseDraft(jobId, stepId, draft.id, text));
  wireComposer('deny', (text) => work.denyDraft(jobId, stepId, draft.id, text));
}
