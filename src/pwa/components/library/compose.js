// Compose activity — the main-view form that replaces the old window.prompt for
// both authoring a new action and revising an existing one. Rendered by
// skills-detail.js for the `new:` / `edit:<name>` selection sentinels. On submit
// it kicks off a meta.build-action session and hands off to the WIP view (which
// carries the inline feed); it never navigates into the raw session view.

import { actionsApi } from '../../net/actions.js';
import { nav } from '../../state/nav.js';
import { escapeHtml } from '../../util.js';

const CATEGORIES = [
  { id: '', label: 'Let the skill decide' },
  { id: 'read', label: 'read — investigations, no writes' },
  { id: 'write', label: 'write — external mutations' },
  { id: 'code', label: 'code — repo edits, scripts, tools' },
  { id: 'meta', label: 'meta — plans, orchestration' },
];

export function renderComposeForm(mount, opts = {}) {
  const isEdit = opts.mode === 'edit';
  const name = opts.name ?? '';
  mount.textContent = '';
  const view = document.createElement('div');
  view.className = 'lib-detail lib-compose';
  view.innerHTML = `
    <header class="lib-detail-hdr">
      <div class="lib-detail-title">
        <span class="lib-detail-name">${isEdit ? escapeHtml(name) : 'New action'}</span>
        ${isEdit ? '<span class="o-pill lib-cat-pill lib-cat-meta">editing</span>' : ''}
      </div>
    </header>
    <p class="lib-detail-desc">${isEdit
      ? 'Describe the change. meta.build-action drafts a revised SKILL.md you review here before it applies.'
      : "Describe what the action should do. meta.build-action drafts a proposal you review here — it doesn't run on its own."}</p>

    <div class="o-section lib-section lib-compose-form">
      <label class="lib-compose-field">
        <span class="lib-compose-label">${isEdit ? 'What should change?' : 'What should this action do?'}</span>
        <textarea class="lib-compose-desc" rows="5" placeholder="${isEdit
          ? 'e.g. Also post the run URL as a PR comment when the workflow finishes.'
          : 'e.g. Run a specific GitHub Actions workflow on the current branch and report the run URL.'}"></textarea>
      </label>

      ${isEdit ? '' : `
      <div class="lib-compose-row">
        <label class="lib-compose-field">
          <span class="lib-compose-label">Category</span>
          <select class="lib-compose-category">
            ${CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}
          </select>
        </label>
        <label class="lib-compose-field">
          <span class="lib-compose-label">Name <span class="lib-compose-hint">(optional)</span></span>
          <input type="text" class="lib-compose-name" placeholder="auto — skill picks a slug" spellcheck="false" autocapitalize="off">
        </label>
      </div>`}

      <div class="lib-edit-actions">
        <button type="button" class="o-btn o-btn--primary" data-compose="submit">${isEdit ? 'Draft revision' : 'Draft action'}</button>
        <button type="button" class="o-btn o-btn--default" data-compose="cancel">Cancel</button>
      </div>
      <div class="lib-edit-error" hidden></div>
    </div>
  `;
  mount.appendChild(view);

  const descEl = view.querySelector('.lib-compose-desc');
  const catEl = view.querySelector('.lib-compose-category');
  const nameEl = view.querySelector('.lib-compose-name');
  const errEl = view.querySelector('.lib-edit-error');
  const submitBtn = view.querySelector('[data-compose="submit"]');
  const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

  descEl.focus();

  view.querySelector('[data-compose="cancel"]').addEventListener('click', () => {
    // Editing returns to the action's detail; a cancelled new-action goes to empty.
    nav.select('skills', isEdit ? name : null);
  });

  submitBtn.addEventListener('click', async () => {
    const desc = descEl.value.trim();
    if (!desc) {
      fail(isEdit ? 'Describe what should change first.' : 'Describe what the action should do first.');
      descEl.focus();
      return;
    }
    errEl.hidden = true;
    submitBtn.disabled = true;
    try {
      if (isEdit) {
        await actionsApi.edit(name, desc);
        // Selection stays on the action name; the in-flight edit renders the WIP
        // view (feed + proposal card) via editFor() in skills-detail.
        nav.select('skills', name);
      } else {
        const res = await actionsApi.createNew(desc, nameEl.value.trim(), catEl.value);
        if (res?.sessionId) nav.select('skills', `new:${res.sessionId}`);
      }
    } catch (e) {
      fail(`Failed to start the builder session: ${e.message}`);
      submitBtn.disabled = false;
    }
  });

  return () => { /* nothing persistent to tear down */ };
}
