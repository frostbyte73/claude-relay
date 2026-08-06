import { work } from '../../state/work.js';
import { actions } from '../../state/actions.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

const TYPE_LABELS = {
  'orchestrated': 'orchestrated  (a controller action drives the step turn by turn)',
  'action':       'action  (run a named action for one-shot work)',
};

function optionsHtml(names, selected, fallback) {
  const withSelected = selected && !names.includes(selected) ? [selected, ...names] : names;
  if (!withSelected.length) return `<option value="${escapeHtml(selected ?? fallback)}">${escapeHtml(selected ?? fallback)}</option>`;
  return withSelected.map((n) => `<option value="${escapeHtml(n)}"${n === selected ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
}

function actionOptions(selected) {
  const list = actions.get()?.actions ?? [];
  return optionsHtml(list.map((a) => a.name).filter(Boolean).sort(), selected, 'claude');
}

// Only a `kind: step-orchestrator` action can own an orchestrated step — a plain action
// has no next-move contract, so offering one here would hand the engine a step whose
// controller can never report a move.
function controllerOptions(selected) {
  const catalog = actions.get()?.catalog ?? [];
  const names = catalog.filter((a) => a.kind === 'step-orchestrator').map((a) => a.name).filter(Boolean).sort();
  return optionsHtml(names, selected, 'code.orchestrate-pr');
}

// `editStep` is the current step when editing. Workspace fields stay editable: the dialog only
// opens for steps that haven't started, so nothing has provisioned against the old ref — and a
// planner-authored workspace that's wrong (missing repo, wrong path) is otherwise unfixable.
function renderFields(type, editStep) {
  const s = editStep && editStep.type === type ? editStep : null;
  switch (type) {
    case 'orchestrated':
      return `
        <div>
          <div class="field-label">Controller</div>
          <select id="as-controller" class="field-input">
            ${controllerOptions(s?.controller)}
          </select>
        </div>
        <div>
          <div class="field-label">Repo cwd</div>
          <input id="as-repo" class="field-input" type="text" placeholder="~/code/your-project" value="${escapeHtml(s?.workspace?.repoCwd ?? '')}" />
        </div>
        <div>
          <div class="field-label">Branch <span class="field-hint">optional — blank means read-only</span></div>
          <input id="as-branch" class="field-input" type="text" placeholder="fix/dropping-rpc" value="${escapeHtml(s?.workspace?.branch ?? '')}" />
        </div>
        <div>
          <div class="field-label">Goal</div>
          <textarea id="as-goal" class="field-textarea" placeholder="What outcome does this step deliver?">${escapeHtml(s?.goal ?? '')}</textarea>
        </div>
        <div>
          <div class="field-label">Approach</div>
          <textarea id="as-approach" class="field-textarea" placeholder="Files / modules / functions to touch">${escapeHtml(s?.inputs?.approach ?? '')}</textarea>
        </div>
        <div>
          <div class="field-label">Risks <span class="field-hint">optional</span></div>
          <textarea id="as-risks" class="field-textarea" placeholder="What could go wrong?">${escapeHtml(s?.inputs?.risks ?? '')}</textarea>
        </div>
      `;
    case 'action':
    default:
      return `
        <div>
          <div class="field-label">Action</div>
          <select id="as-action" class="field-input">
            ${actionOptions(s?.action)}
          </select>
        </div>
        <div>
          <div class="field-label">Goal</div>
          <textarea id="as-goal" class="field-textarea" placeholder="What should this action do? Findings / outcome expected.">${escapeHtml(s?.goal ?? '')}</textarea>
        </div>
        ${s ? `
        <div>
          <div class="field-label">Inputs <span class="field-hint">JSON, optional</span></div>
          <textarea id="as-inputs" class="field-textarea" placeholder="{}">${escapeHtml(JSON.stringify(s.inputs ?? {}, null, 2))}</textarea>
        </div>
        ` : ''}
        <div>
          <div class="field-label">Repo cwd <span class="field-hint">optional — blank means no checkout</span></div>
          <input id="as-repo" class="field-input" type="text" placeholder="~/code/your-project" value="${escapeHtml(s?.workspace?.repoCwd ?? '')}" />
        </div>
        ${s ? '' : `
        <div>
          <label class="field-check">
            <input id="as-forward" type="checkbox" checked />
            <span>Forward output to later steps</span>
          </label>
        </div>
        `}
      `;
  }
}

// `opts.editStep` switches the dialog into edit mode for that step: prefilled fields,
// type locked to the step's own type, and submit calls work.editStep instead of
// work.addStep. Same dialog either way — the plan editor's edit tool (✎) opens this
// with editStep set; "+ Add step" / insert flows open it without.
export function openAddStepDialog(jobId, opts = {}) {
  if (document.getElementById('add-step-dialog')) return;
  void actions.load();
  const editStep = opts.editStep ?? null;
  const isEdit = !!editStep;

  const wrap = document.createElement('div');
  wrap.id = 'add-step-dialog';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-label="${isEdit ? 'Edit step' : 'Add step'}">
      <div class="modal-head">
        <span class="glyph">${isEdit ? '✎' : '+'}</span>
        <span class="label">${isEdit ? 'Edit step' : 'Add step'}</span>
        <span class="spacer"></span>
        <button class="close" type="button" aria-label="Close">esc</button>
      </div>
      <div class="modal-body">
        <div>
          <div class="field-label">Step type</div>
          <select id="as-type" class="field-input" ${isEdit ? 'disabled' : ''}>
            ${Object.entries(TYPE_LABELS).map(([v, label]) => `<option value="${v}"${isEdit && editStep.type === v ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="field-label">Title</div>
          <input id="as-title" class="field-input" type="text" placeholder="Short, scannable title" value="${escapeHtml(editStep?.title ?? '')}" />
        </div>
        <div>
          <div class="field-label">Description <span class="field-hint">optional</span></div>
          <textarea id="as-desc" class="field-textarea" placeholder="1-2 sentences for the UI">${escapeHtml(editStep?.description ?? '')}</textarea>
        </div>
        <div id="as-fields"></div>
        <div id="as-error" class="work-error" style="display:none"></div>
      </div>
      <div class="modal-foot">
        <button class="secondary" type="button" data-action="cancel">Cancel</button>
        <button class="primary" type="button" data-action="add">${isEdit ? 'Save' : 'Add step'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => { unsub?.(); wrap.remove(); };
  const typeEl = wrap.querySelector('#as-type');
  const fieldsHost = wrap.querySelector('#as-fields');
  const refreshFields = () => { fieldsHost.innerHTML = renderFields(typeEl.value, editStep); };
  typeEl.addEventListener('change', refreshFields);
  refreshFields();
  // Re-render the action / controller dropdowns once the catalog finishes loading.
  const unsub = actions.subscribe(refreshFields);

  const showError = (msg) => {
    const err = wrap.querySelector('#as-error');
    err.style.display = 'block';
    err.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  };

  const submit = async () => {
    const type = typeEl.value;
    const title = wrap.querySelector('#as-title').value.trim();
    if (!title) return showError('Title required');
    const description = wrap.querySelector('#as-desc').value;

    const step = { type, title, description };
    if (type === 'orchestrated') {
      const controller = wrap.querySelector('#as-controller')?.value.trim();
      if (!controller) return showError('Controller required');
      const goal = wrap.querySelector('#as-goal')?.value.trim();
      if (!goal) return showError('Goal required');
      const approach = wrap.querySelector('#as-approach')?.value.trim();
      const risks    = wrap.querySelector('#as-risks')?.value.trim();
      step.controller = controller;
      step.goal = goal;
      step.inputs = { ...(approach ? { approach } : {}), ...(risks ? { risks } : {}) };
      const repoCwd = wrap.querySelector('#as-repo')?.value.trim();
      const branch  = wrap.querySelector('#as-branch')?.value.trim();
      if (!repoCwd) return showError('Repo cwd required');
      step.workspace = branch ? { kind: 'writable', repoCwd, branch } : { kind: 'readonly', repoCwd };
    } else {
      const action = wrap.querySelector('#as-action')?.value.trim();
      if (!action) return showError('Action required');
      const goal = wrap.querySelector('#as-goal')?.value.trim();
      if (!goal) return showError('Goal required');
      step.action = action;
      step.goal = goal;
      const repoCwd = wrap.querySelector('#as-repo')?.value.trim();
      // Keep the existing ref when it already matches the field and is well-formed, so saving
      // unrelated fields can't downgrade a writable action step or drop its pinned `ref`.
      // Anything else — including a malformed ref like {kind:'readonly'} with no repoCwd — is
      // rebuilt from the field, which is how such a step gets repaired.
      const cur = editStep?.workspace ?? {};
      const keepable = repoCwd
        ? (cur.kind === 'readonly' || cur.kind === 'writable') && cur.repoCwd === repoCwd
        : cur.kind === 'none';
      if (!isEdit || !keepable) {
        step.workspace = repoCwd ? { kind: 'readonly', repoCwd } : { kind: 'none' };
      }
      if (isEdit) {
        const rawInputs = wrap.querySelector('#as-inputs')?.value.trim();
        if (rawInputs) {
          try { step.inputs = JSON.parse(rawInputs); }
          catch (e) { return showError(`Inputs isn't valid JSON: ${e.message}`); }
        } else {
          step.inputs = {};
        }
      } else {
        step.forwardOutput = !!wrap.querySelector('#as-forward')?.checked;
      }
    }

    try {
      if (isEdit) await work.editStep(jobId, editStep.id, step);
      else await work.addStep(jobId, step);
      close();
    } catch (e) {
      showError(e.message);
    }
  };

  wrap.querySelector('.close').addEventListener('click', close);
  wrap.querySelector('[data-action="cancel"]').addEventListener('click', close);
  wrap.querySelector('[data-action="add"]').addEventListener('click', submit);
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); submit(); }
  });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('#as-title').focus();
}
