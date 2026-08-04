import { escapeHtml } from '../../util.js';
import { actions } from '../../state/actions.js';
import { sessions } from '../../state/sessions.js';
import { schedulesStore } from '../../state/schedules.js';
import { testScript, redraftSchedule } from '../../net/schedules.js';

// Known project paths, offered as a datalist for the working-directory input so
// prompt/script schedules land in a registered cwd (the backend rejects unknown ones).
function cwdDatalistOptions() {
  return (sessions.get().projects ?? []).map((p) => `<option value="${escapeHtml(p.cwd)}"></option>`).join('');
}

function viewRows(w) {
  const runnerRow = `
    <span class="k">Runner</span>
    <span class="v">${w.model ? `<span class="o-pill">${escapeHtml(w.model)}</span>` : '<span class="sched-tz">default model</span>'}</span>`;
  const cwdRow = `
    <span class="k">Working dir</span>
    <span class="v">${w.cwd ? `<span class="o-pill code">${escapeHtml(w.cwd)}</span>` : '<span class="sched-tz">not set</span>'}</span>`;
  const argsRow = `
    <span class="k">Args</span>
    <span class="v"><code class="sched-args-code">${escapeHtml(JSON.stringify(w.args ?? {}))}</code></span>`;

  if (w.kind === 'prompt') {
    return `
      <span class="k">Prompt</span>
      <span class="v">${w.prompt ? escapeHtml(w.prompt) : '<span class="sched-tz">not set</span>'}</span>
      ${cwdRow}${runnerRow}`;
  }
  if (w.kind === 'script') {
    return `
      <span class="k">Script</span>
      <span class="v"><pre class="sched-args-code sched-script-view">${escapeHtml(w.script ?? '')}</pre></span>
      ${cwdRow}${runnerRow}${argsRow}`;
  }
  if (w.kind === 'native') {
    return `
      <span class="k">Handler</span>
      <span class="v">${w.handler ? `<span class="o-pill code sched-accent-pill">${escapeHtml(w.handler)}</span>` : '<span class="sched-tz">not set</span>'}</span>`;
  }
  return `
    <span class="k">Skill</span>
    <span class="v">${w.skill ? `<span class="o-pill code sched-accent-pill">${escapeHtml(w.skill)}</span>` : '<span class="sched-tz">not set</span>'}</span>
    <span class="k">Repos</span>
    <span class="v">${w.repos.length ? w.repos.map((r) => `<span class="o-pill code">${escapeHtml(r)}</span>`).join(' ') : '<span class="sched-tz">none</span>'}</span>
    <span class="k">Scope</span>
    <span class="v">${w.scope ? escapeHtml(w.scope) : '<span class="sched-tz">not set</span>'}</span>
    ${runnerRow}${argsRow}`;
}

// Test / Redraft controls for a script-kind draft. Test runs the script for real
// (POST /api/schedules/test); on failure a Redraft button feeds the error back to
// the builder session (sessionId in scope) for a fresh proposal. Redraft is
// hidden when there's no builder session (manual blank draft).
function appendTestSection(card, schedule, sessionId) {
  const wrap = document.createElement('div');
  wrap.className = 'sched-test';
  wrap.innerHTML = `
    <div class="sched-test-controls">
      <button type="button" class="o-btn o-btn--default sched-test-btn">Test</button>
    </div>
    <div class="sched-test-panel" hidden></div>
  `;
  card.appendChild(wrap);
  const controls = wrap.querySelector('.sched-test-controls');
  const testBtn = wrap.querySelector('.sched-test-btn');
  const panel = wrap.querySelector('.sched-test-panel');

  function showResult(result) {
    panel.hidden = false;
    panel.className = `sched-test-panel ${result.outcome === 'ok' ? 'ok' : 'error'}`;
    panel.innerHTML = `
      <div class="sched-test-hd">${result.outcome === 'ok' ? '✓ Ran clean' : '✕ Failed'}</div>
      <pre class="sched-test-out">${escapeHtml(result.output ?? '')}</pre>
    `;
    controls.querySelector('.sched-redraft-btn')?.remove();
    if (result.outcome === 'error' && sessionId) {
      const redraft = document.createElement('button');
      redraft.type = 'button';
      redraft.className = 'o-btn o-btn--primary sched-redraft-btn';
      redraft.textContent = 'Redraft';
      redraft.addEventListener('click', async () => {
        redraft.disabled = true; testBtn.disabled = true;
        redraft.textContent = 'Redrafting…';
        try {
          // The fresh schedule_draft_ready this triggers rebuilds the whole draft
          // pane, so there's no local success state to restore here.
          await redraftSchedule(sessionId, result.output, {
            name: schedule.name, trigger: schedule.trigger, what: schedule.what,
          });
        } catch (e) {
          redraft.disabled = false; testBtn.disabled = false;
          redraft.textContent = 'Redraft';
          panel.querySelector('.sched-test-out').textContent = `${result.output}\n\nRedraft failed: ${e.message}`;
        }
      });
      controls.appendChild(redraft);
    }
  }

  if (sessionId) {
    const stored = schedulesStore.get().testResultBySession.get(sessionId);
    if (stored) showResult(stored);
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    try {
      const result = await testScript(schedule.what);
      if (sessionId) schedulesStore.setTestResult(sessionId, result);
      showResult(result);
    } catch (e) {
      showResult({ outcome: 'error', output: e.message });
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test';
    }
  });
}

export function renderWhatCard(schedule, detail, editState, repaint, onSave, draftCtx = null) {
  const card = document.createElement('div');
  card.className = 'o-section sched-card-detail';

  // A native handler is an in-daemon function wired at daemon.ts startup, not
  // something a form can redirect — no Edit affordance, no kind switcher.
  const isNative = detail.whatToRun.kind === 'native';

  if (isNative || !editState.what) {
    card.innerHTML = `
      <div class="sched-card-hdr">
        <h3 class="o-microhead">✱ What to run</h3>
        ${isNative ? '' : '<button type="button" class="sched-edit-link">Edit</button>'}
      </div>
      <div class="sched-kv">${viewRows(detail.whatToRun)}</div>
    `;
    if (!isNative) card.querySelector('.sched-edit-link').addEventListener('click', () => { editState.what = true; repaint(); });
    if (draftCtx && detail.whatToRun.kind === 'script') appendTestSection(card, schedule, draftCtx.sessionId ?? null);
    return card;
  }

  // ── Edit mode ──
  if (!actions.get().loaded && !actions.get().loading) actions.load();
  const what = schedule.what ?? { kind: 'skill' };
  const kind = what.kind ?? 'skill';

  card.innerHTML = `
    <div class="sched-card-hdr"><h3 class="o-microhead">✱ What to run</h3></div>
    <div class="sched-form">
      <label class="sched-form-row"><span class="k">Type</span>
        <select class="w-kind">
          <option value="skill">Skill</option>
          <option value="prompt">Prompt</option>
          <option value="script">Script</option>
        </select>
      </label>
      <div class="w-fields"></div>
      <label class="sched-form-row"><span class="k">Runner (model)</span><input class="w-model" type="text" placeholder="e.g. claude-sonnet-5" value="${escapeHtml(what.model ?? '')}" /></label>
      <datalist id="w-cwd-list">${cwdDatalistOptions()}</datalist>
      <div class="sched-form-error" hidden></div>
      <div class="sched-form-actions">
        <button type="button" class="o-btn o-btn--default sched-cancel">Cancel</button>
        <button type="button" class="o-btn o-btn--primary sched-save">Save</button>
      </div>
    </div>
  `;

  const kindSelect = card.querySelector('.w-kind');
  const fieldsEl = card.querySelector('.w-fields');
  kindSelect.value = kind;

  function fieldsHtml(k) {
    if (k === 'prompt') {
      return `
        <label class="sched-form-row sched-form-row-stacked"><span class="k">Prompt</span><textarea class="w-prompt" rows="4" placeholder="Review yesterday's merged PRs and summarize risks">${escapeHtml(what.prompt ?? '')}</textarea></label>
        <label class="sched-form-row"><span class="k">Working dir</span><input class="w-cwd" type="text" list="w-cwd-list" placeholder="/Users/you/project" value="${escapeHtml(what.cwd ?? '')}" /></label>`;
    }
    if (k === 'script') {
      return `
        <label class="sched-form-row sched-form-row-stacked"><span class="k">Script</span><textarea class="w-script" rows="5" spellcheck="false" placeholder="npm test">${escapeHtml(what.script ?? '')}</textarea></label>
        <label class="sched-form-row"><span class="k">Working dir</span><input class="w-cwd" type="text" list="w-cwd-list" placeholder="/Users/you/project" value="${escapeHtml(what.cwd ?? '')}" /></label>
        <label class="sched-form-row sched-form-row-stacked"><span class="k">Args (JSON)</span><textarea class="w-args" rows="3" spellcheck="false">${escapeHtml(JSON.stringify(what.args ?? {}, null, 2))}</textarea></label>`;
    }
    return `
      <label class="sched-form-row"><span class="k">Skill</span><select class="w-skill"></select></label>
      <label class="sched-form-row"><span class="k">Repos</span><input class="w-repos" type="text" placeholder="owner/repo, owner/other" value="${escapeHtml((what.repos ?? []).join(', '))}" /></label>
      <label class="sched-form-row"><span class="k">Scope</span><input class="w-scope" type="text" placeholder="PRs merged in the last 7 days" value="${escapeHtml(what.scope ?? '')}" /></label>
      <label class="sched-form-row sched-form-row-stacked"><span class="k">Args (JSON)</span><textarea class="w-args" rows="3" spellcheck="false">${escapeHtml(JSON.stringify(what.args ?? {}, null, 2))}</textarea></label>`;
  }

  // Catalog may still be loading on a fresh page — refill the Skill <select> as
  // the store settles, preserving the user's in-flight pick.
  function fillSkillOptions() {
    const sel = card.querySelector('.w-skill');
    if (!sel) return;
    const { catalog, loaded } = actions.get();
    const current = sel.value || what.skill || '';
    sel.innerHTML = `<option value="">${loaded ? '— choose —' : 'Loading skills…'}</option>`
      + (catalog ?? []).map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
    if (current) sel.value = current;
  }
  function renderFields() {
    fieldsEl.innerHTML = fieldsHtml(kindSelect.value);
    fillSkillOptions();
  }
  kindSelect.addEventListener('change', renderFields);
  renderFields();
  const unsubActions = actions.subscribe(() => {
    if (!card.isConnected) { unsubActions(); return; }
    fillSkillOptions();
  });

  const err = card.querySelector('.sched-form-error');
  function fail(msg) { err.textContent = msg; err.hidden = false; }

  card.querySelector('.sched-cancel').addEventListener('click', () => { unsubActions(); editState.what = false; repaint(); });
  card.querySelector('.sched-save').addEventListener('click', async () => {
    err.hidden = true;
    const model = card.querySelector('.w-model').value.trim();
    const k = kindSelect.value;
    let nextWhat;

    if (k === 'prompt') {
      const prompt = card.querySelector('.w-prompt').value.trim();
      const cwd = card.querySelector('.w-cwd').value.trim();
      if (!prompt) return fail('Prompt is required.');
      if (!cwd) return fail('Working directory is required.');
      nextWhat = { kind: 'prompt', prompt, cwd, ...(model ? { model } : {}) };
    } else if (k === 'script') {
      const script = card.querySelector('.w-script').value.trim();
      const cwd = card.querySelector('.w-cwd').value.trim();
      if (!script) return fail('Script is required.');
      if (!cwd) return fail('Working directory is required.');
      let args;
      try { const raw = card.querySelector('.w-args').value.trim(); args = raw ? JSON.parse(raw) : {}; }
      catch { return fail('Args must be valid JSON.'); }
      nextWhat = { kind: 'script', script, cwd, args, ...(model ? { model } : {}) };
    } else {
      const skill = card.querySelector('.w-skill').value.trim();
      if (!skill) return fail('Skill is required.');
      let args;
      try { const raw = card.querySelector('.w-args').value.trim(); args = raw ? JSON.parse(raw) : {}; }
      catch { return fail('Args must be valid JSON.'); }
      const repos = card.querySelector('.w-repos').value.split(',').map((r) => r.trim()).filter(Boolean);
      const scope = card.querySelector('.w-scope').value.trim();
      nextWhat = {
        kind: 'skill',
        skill,
        ...(repos.length ? { repos } : {}),
        ...(scope ? { scope } : {}),
        ...(model ? { model } : {}),
        args,
      };
    }

    try {
      await onSave({ what: nextWhat });
      unsubActions();
      editState.what = false;
      repaint();
    } catch (e) {
      fail(`Failed to save: ${e.message}`);
    }
  });

  return card;
}
