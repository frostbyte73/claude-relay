// Skills library — an action's recorded history. Every SKILL.md write (with a diff and a
// one-click revert) alongside the proposals that never landed, so an applied edit is
// reversible and a rejected one still leaves a trace.

import { escapeHtml } from '../../util.js';
import { actionsApi } from '../../net/actions.js';
import { library } from '../../state/library.js';
import { revisionRows } from '../../vm/library.js';
import { skillDiffHtml } from './skill-change-view.js';

export function revisionsSectionHtml(item, libState) {
  if (item.kind !== 'action') return '';
  const events = libState.revisionsByAction?.get?.(item.name);
  const loading = libState.revisionsLoading?.has?.(item.name);
  let body;
  if (!events) {
    body = `<div class="lib-empty-note">${loading ? 'Loading…' : 'No recorded revisions yet.'}</div>`;
  } else if (events.length === 0) {
    body = '<div class="lib-empty-note">No recorded revisions yet. The next applied edit starts the history.</div>';
  } else {
    body = revisionRows(events).map(rowHtml).join('');
  }
  return `
    <div class="o-section lib-section lib-revisions">
      <h4 class="lib-section-hdr o-microhead">History${events?.length ? ` · ${events.length}` : ''}</h4>
      ${body}
      <div class="lib-rev-error" hidden></div>
    </div>
  `;
}

function rulesHtml(rules, verb) {
  if (rules.length === 0) return '';
  const pills = rules
    .map((r) => `<span class="o-pill code">${escapeHtml(r.kind)}: ${escapeHtml(r.value)}</span>`)
    .join(' ');
  return `<div class="lib-rev-rules">${verb} ${pills}</div>`;
}

function diffHtml(row) {
  if (!row.hasBody) {
    return '<div class="lib-rev-pruned">Body no longer retained — too old to restore.</div>';
  }
  return skillDiffHtml(row.diff, {
    suffix: row.bytesText ? ` · ${escapeHtml(row.bytesText)}` : '',
  });
}

function rowHtml(row) {
  const note = row.feedback || row.rationale;
  return `
    <div class="lib-rev-row" data-rev-id="${escapeHtml(row.id)}">
      <div class="lib-rev-top">
        <span class="o-pill ${escapeHtml(row.tone === 'hot' ? 'danger' : row.tone)}">${escapeHtml(row.kindLabel)}</span>
        <span class="lib-rev-author">${escapeHtml(row.authorLabel)}</span>
        <span class="lib-rev-when">${escapeHtml(row.whenText ?? '')}</span>
        ${row.canRevert ? '<button type="button" class="o-btn o-btn--ghost lib-rev-revert" data-rev-action="revert">Revert</button>' : ''}
      </div>
      ${note ? `<div class="lib-rev-note">${escapeHtml(note)}</div>` : ''}
      ${rulesHtml(row.ruleAdds, 'Added')}
      ${rulesHtml(row.ruleRemovals, 'Removed')}
      ${diffHtml(row)}
    </div>
  `;
}

export function wireRevisions(view, item) {
  const section = view.querySelector('.lib-revisions');
  if (!section) return;
  const errEl = section.querySelector('.lib-rev-error');
  section.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rev-action="revert"]');
    if (!btn) return;
    const id = btn.closest('.lib-rev-row')?.dataset.revId;
    if (!id) return;
    if (!confirm(`Restore this version of ${item.name}? Allowlist rules it added are removed too.`)) return;
    btn.disabled = true;
    errEl.hidden = true;
    try {
      await actionsApi.revertRevision(item.name, id);
      library.invalidateRevisions(item.name);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
    }
  });
}
