// Skills library — detail pane (header + actions, pending edit/proposal review
// card, denial suggestions, rendered SKILL.md, then a stack of Permissions,
// Scorecard and the self-reported journal). Registered as the 'skills' surface's
// renderDetail in shell/surfaces.js.

import { actions, editFor, findEditBySession } from '../../state/actions.js';
import { actionsApi } from '../../net/actions.js';
import { library } from '../../state/library.js';
import { nav } from '../../state/nav.js';
import { runs } from '../../state/runs.js';
import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { renderMarkdown } from '../../markdown.js';
import { verdictTone } from '../../vm/runs.js';
import { skillByName, permissionGroupNames, allowlistRuleCount, stripFrontmatter } from '../../vm/library.js';
import { emptyState } from '../shell/placeholder.js';
import { openPalette } from '../palette/index.js';
import { startScheduleDraft } from '../schedules/draft.js';
import { renderComposeForm } from './compose.js';
import { scorecardSectionHtml, wireScorecard } from './scorecard-card.js';
import { mountInlineSession } from '../work/inline-session.js';

export function renderDetail(mount, deps) {
  const { selection } = deps ?? {};
  if (mount.__libUnsub) { try { mount.__libUnsub(); } catch { /* ignore */ } mount.__libUnsub = null; }
  if (!selection) {
    emptyState(mount, 'Select a skill to view its details.');
    return undefined;
  }

  mount.textContent = '';
  const view = document.createElement('div');
  view.className = 'lib-detail';
  mount.appendChild(view);

  // The inline meta.build-action feed is mounted once per builder session and
  // survives repaints — tearing it down on every actions_changed would churn the
  // WS and reset scroll. `feedCtl` tracks the live mount so we only re-attach
  // when the session actually changes.
  let feedCtl = { sid: null, unmount: null };
  const leaveWip = () => {
    if (feedCtl.unmount) { try { feedCtl.unmount(); } catch { /* ignore */ } }
    feedCtl = { sid: null, unmount: null };
    view.__wipSid = null;
  };

  // WIP view for a new-action builder session: header + live feed + proposal
  // card. Idempotent — the shell (and feed) are built once per session; only the
  // proposal card + header refresh on repaint so the feed DOM stays put.
  const paintWip = (edit) => {
    const sid = edit.sessionId;
    if (view.__wipSid !== sid) {
      leaveWip();
      view.__wipSid = sid;
      view.innerHTML = wipShellHtml(edit);
      const feedEl = view.querySelector('.lib-edit-feed-mount');
      // Reuse the shared inline-session preview (thinking strip + transcript tail +
      // inline approval/ask cards + "Open ↗") — same component the job step cards use.
      // No job/step context: an action-edit session is never terminal-by-step.
      const ctl = feedEl ? mountInlineSession(feedEl, sid, { jobId: null, step: null }) : null;
      feedCtl = { sid, unmount: ctl ? () => ctl.unmount() : null };
    }
    const nameEl = view.querySelector('.lib-detail-name');
    if (nameEl) nameEl.textContent = edit.actionName ?? 'draft';
    const pill = view.querySelector('.lib-wip-pill');
    if (pill) pill.textContent = edit.proposal ? 'review' : 'drafting';
    const slot = view.querySelector('.lib-wip-card-slot');
    if (slot) { slot.innerHTML = editCardHtml(edit, actions.get()); wireEditCard(view, edit); }
  };

  // Compose forms render once so in-progress typing survives repaints. Keyed by
  // sentinel so switching modes within a mount (rare) still re-renders.
  const mountComposeOnce = (key, opts) => {
    leaveWip();
    if (view.__composeMounted === key) return;
    view.__composeMounted = key;
    renderComposeForm(view, opts);
  };

  const paint = () => {
    const state = actions.get();

    // Compose activities (`new:` and `edit:<name>`).
    if (selection === 'new:') { mountComposeOnce('new', { mode: 'new' }); return; }
    if (typeof selection === 'string' && selection.startsWith('edit:')) {
      const name = selection.slice(5);
      mountComposeOnce(`edit:${name}`, { mode: 'edit', name });
      return;
    }
    view.__composeMounted = null;

    // New-action WIP (`new:<sessionId>`) — resolve the in-flight builder session.
    if (typeof selection === 'string' && selection.startsWith('new:')) {
      const edit = findEditBySession(state, selection.slice(4));
      if (edit) { paintWip(edit); return; }
      // Stale sentinel (session gone / just approved) — fall back to the compose form.
      mountComposeOnce('new', { mode: 'new' });
      return;
    }

    // Any in-flight edit for this name shows the WIP view (feed + proposal card) —
    // whether the action is already installed (revise) or not yet on disk (a new
    // action the skill has already named). Only when there's NO edit do we fall
    // back to the installed detail, or "not found".
    const item = skillByName(state, selection);
    const edit = editFor(state, selection);
    if (edit) { paintWip(edit); return; }
    leaveWip();
    if (!item) {
      view.innerHTML = `<div class="lib-empty-note">Skill not found: ${escapeHtml(selection)}</div>`;
      return;
    }
    view.innerHTML = skillHtml(item, library.get(), state, null);
    wire(view, item);
    wireDenials(view, item, state);
    wireScorecard(view);
  };

  paint();
  library.loadPermissionGroups();
  if (selection && !selection.startsWith('new:')) {
    library.loadJournal(selection);
    library.loadScorecard(selection);
  }
  if (!actions.get().loaded && !actions.get().loading) actions.load();

  const unsubActions = actions.subscribe(paint);
  const unsubLibrary = library.subscribe(paint);
  mount.__libUnsub = () => { unsubActions(); unsubLibrary(); leaveWip(); };
  return mount.__libUnsub;
}

function wipShellHtml(edit) {
  const name = edit.actionName ?? 'draft';
  return `
    <header class="lib-detail-hdr">
      <div class="lib-detail-title">
        <span class="lib-detail-name">${escapeHtml(name)}</span>
        <span class="o-pill lib-cat-pill lib-cat-meta lib-wip-pill">${edit.proposal ? 'review' : 'drafting'}</span>
      </div>
    </header>
    <div class="lib-edit-feed-mount"></div>
    <div class="lib-wip-card-slot"></div>
  `;
}

function skillHtml(item, libState, state, edit) {
  return `
    <header class="lib-detail-hdr">
      <div class="lib-detail-title">
        <span class="lib-detail-name">${escapeHtml(item.name)}</span>
        <span class="o-pill lib-cat-pill lib-cat-${escapeHtml(item.category)}">${escapeHtml(item.category)}</span>
        <span class="o-pill code">runner: ${escapeHtml(item.runner)}</span>
      </div>
      <div class="lib-detail-actions">
        ${item.kind === 'skill' ? `<button type="button" class="o-btn ${edit ? 'o-btn--default' : 'o-btn--primary'}" data-action="run-now" title="Open ⌘K prefilled with this skill">Run now</button>` : ''}
        <button type="button" class="o-btn ${item.kind === 'action' && !edit ? 'o-btn--primary' : 'o-btn--default'}" data-action="edit" ${edit ? 'hidden' : ''}>${item.kind === 'action' ? 'Edit ↗ meta.build-action' : 'Edit ↗ skill-creator'}</button>
        ${item.kind === 'skill' ? '<button type="button" class="o-btn o-btn--default" data-action="schedule">Schedule…</button>' : ''}
        ${item.kind === 'action' ? '<button type="button" class="o-btn o-btn--danger" data-action="delete">Delete</button>' : ''}
      </div>
    </header>

    ${edit ? editCardHtml(edit, state) : ''}
    ${denialsSectionHtml(item, state)}

    ${item.description ? `<p class="lib-detail-desc">${escapeHtml(item.description)}</p>` : ''}

    ${item.skillMd ? `<div class="lib-skillmd">${renderMarkdown(stripFrontmatter(item.skillMd))}</div>` : ''}

    <div class="lib-sections">
      ${permissionsSectionHtml(item, libState)}
      ${scorecardSectionHtml(item, libState)}
      ${journalSectionHtml(item, libState)}
    </div>
  `;
}

// ── Pending edit / proposal review ────────────────────────────────────────

function editCardHtml(edit, state) {
  const activity = state.activity?.get?.(edit.sessionId);
  if (!edit.proposal) {
    return `
      <div class="o-section lib-section lib-edit-card">
        <h4 class="lib-section-hdr o-microhead">Edit in progress</h4>
        <div class="lib-edit-status">meta.build-action is ${escapeHtml(activity?.verb ?? 'drafting')}… it posts a proposal here when ready.</div>
        <div class="lib-edit-actions">
          <button type="button" class="o-btn o-btn--default" data-edit-action="open-session">Open session</button>
          <button type="button" class="o-btn o-btn--danger" data-edit-action="cancel">Cancel edit</button>
        </div>
        <div class="lib-edit-error" hidden></div>
      </div>
    `;
  }
  const p = edit.proposal;
  const rules = (p.allowlistAdds ?? []).map((r) => `<span class="o-pill code">${escapeHtml(r.kind)}: ${escapeHtml(r.value)}</span>`).join(' ');
  return `
    <div class="o-section lib-section lib-edit-card">
      <h4 class="lib-section-hdr o-microhead">Proposal ready</h4>
      ${p.summary ? `<div class="lib-edit-summary">${escapeHtml(p.summary)}</div>` : ''}
      <details class="lib-edit-diff">
        <summary>Proposed SKILL.md (${p.skillMdAfter.length} bytes)</summary>
        <pre class="lib-edit-md">${escapeHtml(p.skillMdAfter)}</pre>
      </details>
      ${rules ? `<div class="lib-edit-rules">Allowlist additions: ${rules}</div>` : ''}
      <textarea class="lib-edit-feedback" rows="2" placeholder="Feedback for another draft (optional)…"></textarea>
      <div class="lib-edit-actions">
        <button type="button" class="o-btn o-btn--primary" data-edit-action="approve">Approve &amp; apply</button>
        <button type="button" class="o-btn o-btn--default" data-edit-action="feedback">Send feedback</button>
        <button type="button" class="o-btn o-btn--danger" data-edit-action="cancel">Cancel edit</button>
      </div>
      <div class="lib-edit-error" hidden></div>
    </div>
  `;
}

function wireEditCard(view, edit) {
  const card = view.querySelector('.lib-edit-card');
  if (!card) return;
  const errEl = card.querySelector('.lib-edit-error');
  const fail = (e) => { errEl.textContent = e.message; errEl.hidden = false; };
  card.querySelector('[data-edit-action="open-session"]')?.addEventListener('click', () => {
    nav.select('sessions', edit.sessionId);
  });
  card.querySelector('[data-edit-action="approve"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const res = await actionsApi.approveProposal(edit.sessionId);
      // Move the selection off the `new:<sessionId>` sentinel onto the freshly
      // installed action so the detail shows the real thing, not "Skill not found".
      if (res?.actionName) nav.select('skills', res.actionName);
    } catch (err) { fail(err); e.target.disabled = false; }
  });
  card.querySelector('[data-edit-action="feedback"]')?.addEventListener('click', async (e) => {
    const text = card.querySelector('.lib-edit-feedback')?.value.trim();
    if (!text) { fail(new Error('Write the feedback first.')); return; }
    e.target.disabled = true;
    try { await actionsApi.feedbackProposal(edit.sessionId, text); }
    catch (err) { fail(err); }
    finally { e.target.disabled = false; }
  });
  card.querySelector('[data-edit-action="cancel"]')?.addEventListener('click', async (e) => {
    if (!confirm('Cancel this edit and discard the draft?')) return;
    e.target.disabled = true;
    try {
      await actionsApi.cancelEdit(edit.sessionId);
      // Return to the action's full detail if it's installed (an edit of an
      // existing action); a cancelled brand-new action has nowhere to land.
      const installed = edit.actionName && skillByName(actions.get(), edit.actionName);
      nav.select('skills', installed ? edit.actionName : null);
    }
    catch (err) { fail(err); e.target.disabled = false; }
  });
}

// ── Denials ("the action tried this and was blocked") ────────────────────

function denialsSectionHtml(item, state) {
  const list = state.denials?.[item.name] ?? [];
  if (list.length === 0) return '';
  const rows = list.map((d) => `
    <div class="lib-denial-row" data-denial-id="${escapeHtml(d.id)}">
      <div class="lib-denial-desc">
        <span class="lib-denial-tool">${escapeHtml(d.toolName)}</span>
        <span class="o-pill code">${escapeHtml(d.suggested.kind)}: ${escapeHtml(d.suggested.value)}</span>
        ${d.count > 1 ? `<span class="lib-denial-count">×${d.count}</span>` : ''}
      </div>
      <button type="button" class="o-btn o-btn--ghost" data-denial="allow">Allow</button>
      <button type="button" class="o-btn o-btn--ghost" data-denial="dismiss">Dismiss</button>
    </div>
  `).join('');
  return `
    <div class="o-section lib-section lib-denials">
      <h4 class="lib-section-hdr o-microhead">Blocked calls · ${list.length}</h4>
      <div class="lib-denials-note">Tool calls this action attempted that the allowlist blocked — allow to add the suggested rule, dismiss to ignore.</div>
      ${rows}
    </div>
  `;
}

function wireDenials(view, item, state) {
  const section = view.querySelector('.lib-denials');
  if (!section) return;
  section.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-denial]');
    if (!btn) return;
    const row = btn.closest('.lib-denial-row');
    const denial = (state.denials?.[item.name] ?? []).find((d) => d.id === row?.dataset.denialId);
    if (!denial) return;
    btn.disabled = true;
    try {
      if (btn.dataset.denial === 'allow') {
        await actionsApi.addAllowlistRule(item.name, denial.suggested.kind, denial.suggested.value);
      }
      await actionsApi.dismissDenial(item.name, denial.id);
    } catch (err) {
      window.alert(`Failed: ${err.message}`);
      btn.disabled = false;
    }
  });
}

// ── Permissions / recent runs ─────────────────────────────────────────────

function permissionsSectionHtml(item, libState) {
  const names = permissionGroupNames(item);
  const groups = libState.permissionGroups ?? [];
  const rows = names.map((n) => {
    const g = groups.find((x) => x.name === n);
    return `
      <div class="lib-perm-row">
        <span class="o-pill code lib-perm-pill">${escapeHtml(n)}</span>
        <span class="lib-perm-desc">${escapeHtml(g?.description ?? '')}</span>
      </div>
    `;
  }).join('');
  const extras = allowlistRuleCount(item.allowlist);
  return `
    <div class="o-section lib-section">
      <h4 class="lib-section-hdr o-microhead">Permissions</h4>
      ${rows || '<div class="lib-empty-note">No permission groups (builtin runner).</div>'}
      ${extras > 0 ? `<div class="lib-perm-extra">Plus ${extras} action-specific rule${extras === 1 ? '' : 's'} narrower than these groups.</div>` : ''}
    </div>
  `;
}

function journalSectionHtml(item, libState) {
  const loading = libState.journalLoading?.has?.(item.name);
  const entries = libState.journalByAction?.get?.(item.name);
  let body;
  if (loading && !entries) {
    body = '<div class="lib-empty-note">Loading…</div>';
  } else if (!entries || entries.length === 0) {
    body = '<div class="lib-empty-note">No lessons logged yet.</div>';
  } else {
    body = entries.slice().reverse().map(journalRowHtml).join('')
      + `<button type="button" class="lib-view-all" data-action="view-all-runs">View all runs →</button>`;
  }
  return `
    <div class="o-section lib-section">
      <h4 class="lib-section-hdr o-microhead">Self-reported lessons${entries?.length ? ` · ${entries.length}` : ''}</h4>
      <div class="lib-runs-note">What the action wrote about its own runs — its claims, not measured outcomes.</div>
      <div class="lib-runs-list">${body}</div>
    </div>
  `;
}

function journalRowHtml(e) {
  const tone = verdictTone(e.outcome);
  const icon = tone === 'ok' ? '✓' : tone === 'hot' ? '✕' : '◆';
  const inner = `
    <span class="o-row-icon ${tone}">${icon}</span>
    <span class="lib-run-lbl">
      <span class="lib-run-outcome">${escapeHtml(e.outcome)}</span>
      <span class="lib-run-lesson">${escapeHtml(e.lesson ?? '')}</span>
    </span>
    <span class="lib-run-when">${relPast(e.at)}</span>
  `;
  // Entries without a jobId have nowhere to link — render them inert instead
  // of as a button that looks clickable but no-ops.
  return e.jobId
    ? `<button type="button" class="lib-run-item" data-job-id="${escapeHtml(e.jobId)}">${inner}</button>`
    : `<div class="lib-run-item lib-run-item-static">${inner}</div>`;
}

function wire(view, item) {
  view.querySelector('[data-action="run-now"]')?.addEventListener('click', () => {
    openPalette({ prompt: `/${item.name.replace(/^\//, '')} ` });
  });

  view.querySelector('[data-action="edit"]')?.addEventListener('click', async () => {
    // Actions revise inline via the edit compose activity (stays on the Skills
    // surface, shows the live feed). Skills stay a session flow — skill-creator
    // is genuinely interactive.
    if (item.kind === 'action') { nav.select('skills', `edit:${item.name}`); return; }
    const feedback = window.prompt(`What should change about ${item.name}? (optional)`) ?? '';
    try {
      const res = await actionsApi.editSkill(item.name, feedback);
      if (res?.sessionId) nav.select('sessions', res.sessionId);
    } catch (e) {
      window.alert(`Edit failed: ${e.message}`);
    }
  });

  view.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${item.name}? Its SKILL.md, schemas, and allowlist are removed from disk.`)) return;
    try {
      await actionsApi.remove(item.name);
      nav.select('skills', null);
    } catch (e) {
      window.alert(`Delete failed: ${e.message}`);
    }
  });

  view.querySelector('[data-action="schedule"]')?.addEventListener('click', () => {
    nav.setSurface('schedules');
    startScheduleDraft({ skill: item.name.replace(/^\//, '') });
  });

  view.querySelectorAll('[data-action="view-all-runs"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      runs.setPendingFilter({ skill: item.name.replace(/^\//, '') });
      nav.setSurface('runs');
    });
  });

  view.querySelectorAll('.lib-run-item[data-job-id]').forEach((btn) => {
    btn.addEventListener('click', () => nav.select('tracked', btn.dataset.jobId));
  });
}
