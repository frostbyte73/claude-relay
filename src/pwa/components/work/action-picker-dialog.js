import { work } from '../../state/work.js';
import { actions } from '../../state/actions.js';
import { actionIconHtml, actionDisplayName } from './action-icon.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// Opens the typed-action picker; on submit, posts the picked action as a new
// step. opts.afterStepId inserts after that step; opts.beforeStepId inserts
// before it (the backend only speaks afterStepId, so before-first is an
// append followed by a reorder).
export function openActionPickerDialog(jobId, opts = {}) {
  if (document.getElementById('action-picker-dialog')) return;
  void actions.load();

  const wrap = document.createElement('div');
  wrap.id = 'action-picker-dialog';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-label="Pick an action">
      <div class="modal-head">
        <span class="glyph">/</span>
        <span class="label">${opts.afterStepId || opts.beforeStepId ? 'Insert step' : 'Add step'}</span>
        <span class="spacer"></span>
        <button class="close" type="button" aria-label="Close">esc</button>
      </div>
      <div class="modal-body action-picker-body">
        <div class="action-picker-search">
          <input id="ap-search" class="field-input" type="search" placeholder="Filter by name, category, description…" autocomplete="off" />
        </div>
        <div class="action-picker-layout">
          <div class="action-picker-list" id="ap-list">
            <div class="empty">Loading actions…</div>
          </div>
          <div class="action-picker-detail" id="ap-detail">
            <div class="empty">Pick an action to see its inputs.</div>
          </div>
        </div>
        <div id="ap-error" class="work-error" style="display:none"></div>
      </div>
      <div class="modal-foot">
        <button class="secondary" type="button" data-action="cancel">Cancel</button>
        <button class="primary" type="button" data-action="add" disabled>Add step</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const listEl = wrap.querySelector('#ap-list');
  const detailEl = wrap.querySelector('#ap-detail');
  const searchEl = wrap.querySelector('#ap-search');
  const addBtn = wrap.querySelector('[data-action="add"]');
  const errEl = wrap.querySelector('#ap-error');

  let picked = null;       // the ActionDef chosen
  let filter = '';

  const close = () => { unsub?.(); wrap.remove(); };
  const showError = (msg) => {
    errEl.style.display = 'block';
    errEl.textContent = msg;
  };

  // The ActionRegistry catalog — NOT the on-disk `actions` list. Only the catalog
  // carries the frontmatter this dialog reads: `kind` (which decides orchestrated vs
  // action step), runner/side_effects/human_gate for the chips, and the input/output
  // schemas the detail pane renders.
  function catalogOf(s) { return s.catalog ?? []; }

  function renderList() {
    const s = actions.get();
    if (s.err) { listEl.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(s.err)}</div>`; return; }
    if (!s.loaded) { listEl.innerHTML = `<div class="empty">Loading…</div>`; return; }
    const q = filter.toLowerCase();
    const matched = catalogOf(s).filter((a) => !q
      || a.name.toLowerCase().includes(q)
      || a.category.toLowerCase().includes(q)
      || (a.description ?? '').toLowerCase().includes(q));
    if (matched.length === 0) {
      listEl.innerHTML = `<div class="empty">No actions match.</div>`;
      return;
    }
    const byCat = new Map();
    for (const a of matched) {
      if (!byCat.has(a.category)) byCat.set(a.category, []);
      byCat.get(a.category).push(a);
    }
    const cats = [...byCat.keys()].sort();
    listEl.innerHTML = cats.map((cat) => `
      <div class="ap-cat">
        <div class="ap-cat-head">${escapeHtml(cat)}</div>
        ${byCat.get(cat).map((a) => `
          <button type="button" class="ap-row${picked?.name === a.name ? ' is-selected' : ''}" data-name="${escapeHtml(a.name)}" title="${escapeHtml(a.name)}">
            <span class="ap-row-icon" data-cat="${escapeHtml(a.category)}">${actionIconHtml(a.category)}</span>
            <span class="ap-row-name">${escapeHtml(actionDisplayName(a.name))}</span>
            <span class="ap-row-meta">
              <span class="ap-chip ap-chip-runner">${escapeHtml(a.runner)}</span>
              <span class="ap-chip ap-chip-sideeff ap-chip-sideeff-${escapeHtml(a.side_effects)}">${escapeHtml(a.side_effects)}</span>
              ${a.human_gate ? `<span class="ap-chip ap-chip-gate">gate</span>` : ''}
            </span>
            <span class="ap-row-desc">${escapeHtml(a.description ?? '')}</span>
          </button>
        `).join('')}
      </div>
    `).join('');
    listEl.querySelectorAll('.ap-row').forEach((el) => {
      el.addEventListener('click', () => pick(el.getAttribute('data-name')));
    });
  }

  function renderDetail() {
    if (!picked) {
      detailEl.innerHTML = `<div class="empty">Pick an action to see its inputs.</div>`;
      addBtn.disabled = true;
      return;
    }
    const fields = schemaFields(picked.input_schema);
    detailEl.innerHTML = `
      <div class="ap-detail-head">
        <span class="ap-detail-icon" data-cat="${escapeHtml(picked.category)}">${actionIconHtml(picked.category)}</span>
        <div class="ap-detail-names">
          <div class="ap-detail-name">${escapeHtml(actionDisplayName(picked.name))}</div>
          <div class="ap-detail-fullname">${escapeHtml(picked.name)}</div>
        </div>
        <div class="ap-detail-meta">
          <span class="ap-chip ap-chip-runner">${escapeHtml(picked.runner)}</span>
          <span class="ap-chip ap-chip-sideeff ap-chip-sideeff-${escapeHtml(picked.side_effects)}">${escapeHtml(picked.side_effects)}</span>
          ${picked.human_gate ? `<span class="ap-chip ap-chip-gate">human-gate</span>` : ''}
        </div>
      </div>
      <div class="ap-detail-desc">${escapeHtml(picked.description ?? '')}</div>

      <div class="ap-field">
        <div class="field-label">Title</div>
        <input id="ap-title" class="field-input" type="text" placeholder="Short, scannable title for the plan" />
      </div>

      ${workspaceFieldsHtml(picked)}

      ${fields.length === 0 ? '' : `
        <div class="ap-section-label o-microhead">Inputs <span class="field-hint">${fields.filter((f) => f.required).length} required</span></div>
        <div class="ap-fields">
          ${fields.map(renderField).join('')}
        </div>
      `}

      <details class="ap-schema">
        <summary class="o-microhead">Output schema</summary>
        <pre class="ap-schema-body">${escapeHtml(JSON.stringify(picked.output_schema, null, 2))}</pre>
      </details>
    `;
    addBtn.disabled = false;
    detailEl.querySelector('#ap-title')?.focus();
  }

  // A controller owns a step for its whole life, so it needs a workspace the way a
  // one-shot action doesn't — and no step-orchestrator declares `workspace` in its input
  // schema (the controller's own inputs are the goal/approach, not where to run). Ask for
  // it explicitly, the same two fields add-step-dialog.js uses.
  function workspaceFieldsHtml(action) {
    if (action.kind !== 'step-orchestrator') return '';
    return `
      <div class="ap-section-label o-microhead">Workspace</div>
      <div class="ap-field">
        <div class="field-label">Repo cwd</div>
        <input id="ap-repo" class="field-input" type="text" placeholder="~/code/your-project" />
      </div>
      <div class="ap-field">
        <div class="field-label">Branch <span class="field-hint">optional — blank means read-only</span></div>
        <input id="ap-branch" class="field-input" type="text" placeholder="fix/dropping-rpc" />
      </div>
    `;
  }

  function renderField(f) {
    const id = `ap-in-${cssId(f.name)}`;
    const hint = f.description ? `<span class="field-hint">${escapeHtml(f.description)}</span>` : '';
    if (f.type === 'boolean') {
      return `
        <div class="ap-field">
          <label class="field-check">
            <input id="${id}" type="checkbox" ${f.default ? 'checked' : ''} data-input="${escapeHtml(f.name)}" data-kind="boolean" />
            <span>${escapeHtml(f.name)}${f.required ? ' *' : ''} ${hint}</span>
          </label>
        </div>
      `;
    }
    if (f.type === 'integer' || f.type === 'number') {
      return `
        <div class="ap-field">
          <div class="field-label">${escapeHtml(f.name)}${f.required ? ' *' : ''} ${hint}</div>
          <input id="${id}" class="field-input" type="number" data-input="${escapeHtml(f.name)}" data-kind="${escapeHtml(f.type)}" />
        </div>
      `;
    }
    if (f.type === 'object' || f.type === 'array') {
      return `
        <div class="ap-field">
          <div class="field-label">${escapeHtml(f.name)}${f.required ? ' *' : ''} <span class="field-hint">JSON · ${escapeHtml(f.type)}${f.description ? ' — ' + escapeHtml(f.description) : ''}</span></div>
          <textarea id="${id}" class="field-textarea" placeholder="${f.type === 'array' ? '[]' : '{}'}" data-input="${escapeHtml(f.name)}" data-kind="json"></textarea>
        </div>
      `;
    }
    // string + enum + default
    if (f.enum) {
      return `
        <div class="ap-field">
          <div class="field-label">${escapeHtml(f.name)}${f.required ? ' *' : ''} ${hint}</div>
          <select id="${id}" class="field-input" data-input="${escapeHtml(f.name)}" data-kind="string">
            ${f.required ? '' : '<option value=""></option>'}
            ${f.enum.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}
          </select>
        </div>
      `;
    }
    return `
      <div class="ap-field">
        <div class="field-label">${escapeHtml(f.name)}${f.required ? ' *' : ''} ${hint}</div>
        <input id="${id}" class="field-input" type="text" data-input="${escapeHtml(f.name)}" data-kind="string" placeholder="${escapeHtml(f.example ?? '')}" />
      </div>
    `;
  }

  function pick(name) {
    const s = actions.get();
    picked = catalogOf(s).find((a) => a.name === name) ?? null;
    renderList();
    renderDetail();
  }

  function collectInputs() {
    const inputs = {};
    detailEl.querySelectorAll('[data-input]').forEach((el) => {
      const name = el.getAttribute('data-input');
      const kind = el.getAttribute('data-kind');
      if (kind === 'boolean') inputs[name] = el.checked;
      else if (kind === 'integer' || kind === 'number') {
        const raw = el.value.trim();
        if (raw === '') return;
        const n = Number(raw);
        if (!Number.isNaN(n)) inputs[name] = kind === 'integer' ? Math.trunc(n) : n;
      } else if (kind === 'json') {
        const raw = el.value.trim();
        if (raw === '') return;
        try { inputs[name] = JSON.parse(raw); }
        catch (e) { throw new Error(`Input '${name}' isn't valid JSON: ${e.message}`); }
      } else {
        const v = el.value.trim();
        if (v !== '') inputs[name] = v;
      }
    });
    return inputs;
  }

  function workspaceFromFields() {
    const repoCwd = (detailEl.querySelector('#ap-repo')?.value ?? '').trim();
    const branch = (detailEl.querySelector('#ap-branch')?.value ?? '').trim();
    if (!repoCwd) return { kind: 'none' };
    return branch ? { kind: 'writable', repoCwd, branch } : { kind: 'readonly', repoCwd };
  }

  // Map (action, inputs) → ProposedStep that the existing orchestrator accepts.
  // Keep this shim small; it goes away when the orchestrator routes by action name.
  function buildStep(action, title, inputs) {
    // A step-orchestrator isn't run as a one-shot action — it owns a step and picks its
    // own move each turn, so it becomes the step's controller rather than its action.
    if (action.kind === 'step-orchestrator') {
      const { goal: _goal, ...rest } = inputs;
      return {
        type: 'orchestrated',
        controller: action.name,
        title,
        description: action.description ?? '',
        goal: typeof inputs.goal === 'string' ? inputs.goal : title,
        inputs: rest,
        workspace: workspaceFromFields(),
      };
    }
    // Generic action shim: goal carries a serialized rendering of the inputs so
    // the session can re-parse them.
    const goalLines = Object.entries(inputs).map(([k, v]) =>
      `**${k}**: ${typeof v === 'string' ? v : '```json\n' + JSON.stringify(v, null, 2) + '\n```'}`,
    );
    const ws = inputs.workspace;
    const workspace = ws && typeof ws === 'object' && ws.repoCwd
      ? (ws.branch ? { kind: 'writable', repoCwd: ws.repoCwd, branch: ws.branch } : { kind: 'readonly', repoCwd: ws.repoCwd })
      : { kind: 'none' };
    return {
      type: 'action',
      action: action.name,
      title,
      description: action.description ?? '',
      goal: goalLines.join('\n\n') || title,
      workspace,
      forwardOutput: true,
    };
  }

  const submit = async () => {
    if (!picked) return;
    errEl.style.display = 'none';
    const title = (detailEl.querySelector('#ap-title')?.value ?? '').trim() || picked.name;
    let step;
    try {
      const inputs = collectInputs();
      validateRequired(picked.input_schema, inputs);
      step = buildStep(picked, title, inputs);
    } catch (e) {
      showError(e.message);
      return;
    }
    if (opts.afterStepId) step.afterStepId = opts.afterStepId;
    try {
      const res = await work.addStep(jobId, step);
      if (opts.beforeStepId && res?.step?.id) {
        await work.loadOne(jobId);
        const job = work.get().byId.get(jobId);
        const ids = (job?.steps ?? []).map((x) => x.id).filter((x) => x !== res.step.id);
        const at = ids.indexOf(opts.beforeStepId);
        if (at >= 0) {
          ids.splice(at, 0, res.step.id);
          await work.reorderSteps(jobId, ids);
        }
      }
      close();
    } catch (e) {
      showError(e.message);
    }
  };

  // wiring
  wrap.querySelector('.close').addEventListener('click', close);
  wrap.querySelector('[data-action="cancel"]').addEventListener('click', close);
  wrap.querySelector('[data-action="add"]').addEventListener('click', submit);
  searchEl.addEventListener('input', () => { filter = searchEl.value; renderList(); });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); submit(); }
  });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  const unsub = actions.subscribe(renderList);
  renderList();
  renderDetail();
  searchEl.focus();
}

// Extract a flat list of top-level inputs from a JSON Schema object. Returns
// {name, type, required, description?, enum?, default?} per top-level property.
function schemaFields(schema) {
  if (!schema || typeof schema !== 'object' || !schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, def]) => ({
    name,
    type: Array.isArray(def.type) ? def.type[0] : (def.type ?? 'string'),
    required: required.has(name),
    description: def.description,
    enum: def.enum,
    default: def.default,
  }));
}

function validateRequired(schema, inputs) {
  if (!schema || !Array.isArray(schema.required)) return;
  for (const req of schema.required) {
    if (inputs[req] === undefined || inputs[req] === '' || inputs[req] === null) {
      throw new Error(`Input '${req}' is required`);
    }
  }
}

function cssId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
