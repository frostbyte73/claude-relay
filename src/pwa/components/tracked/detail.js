// Tracked drill-in — the redesign's "one scrollable story": sticky header,
// plan card (work/plan-section.js: plan-level chrome + compact step index),
// a steps timeline (work/step-card.js's renderTimelineStep/wireTimelineStep —
// the ONE full-step renderer), and the bottom "+ Add step". Mobile mounts this
// same renderer via mobile-shell's mountListDetailScreens (with a focus card
// wrapped above it) — there is no separate mobile job-detail view.

import { work } from '../../state/work.js';
import { renderPlanSection, toggleReplanComposer, submitReplan } from '../work/plan-section.js';
import { renderTimelineStep, wireTimelineStep, computeGroupPositions } from '../work/step-card.js';
import { openAddStepDialog } from '../work/add-step-dialog.js';
import { openActionPickerDialog } from '../work/action-picker-dialog.js';
import { jobTone, ago, STATE_LABEL, launchPillClass } from '../work/ticket-row.js';
import { jobLaunchBadge } from '../../vm/tracked.js';
import { syncInlineMounts, teardownAllExcept } from './session-mounts.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function shortName(cwd) { const p = String(cwd ?? '').split('/').filter(Boolean); return p.slice(-2).join('/'); }

// Per-job "edit plan" toggle, module-local: it's UI mode, not job state, so it
// must survive store-driven repaints without a round-trip.
const editingPlanByJob = new Map();
function isEditingPlan(jobId) { return editingPlanByJob.get(jobId) === true; }
function stepIsEditable(s) {
  if (s.cancelled) return false;
  if (s.sessionId) return false;
  if (s.state === 'resolved' || s.state === 'merged') return false;
  return true;
}

function primaryRepo(job) {
  for (const s of job.steps ?? []) {
    if (s.workspace?.repoCwd) return s.workspace.repoCwd;
  }
  return null;
}

function renderHeader(job) {
  const extId = job.externalRef?.issueIdentifier ?? '';
  const url = job.externalRef?.url ?? '';
  const sourceLabel = job.source === 'manual' ? 'Manual' : 'Linear';
  const tone = jobTone(job);
  const label = (job.state === 'planning' && !job.orchestratorSessionId) ? 'Todo' : (STATE_LABEL[job.state] ?? job.state);
  const repo = primaryRepo(job);
  const syncingThis = work.get().syncingJobId === job.id;

  return `
    <header class="tk-hdr">
      <div class="tk-breadcrumb">Tracked / ${escapeHtml(extId || job.title || '')}</div>
      <div class="tk-title-row">
        ${extId ? `<span class="o-ref">${escapeHtml(extId)}</span>` : ''}
        <h1 class="tk-title">${escapeHtml(job.title ?? '')}</h1>
        <span class="job-state-pill" data-tone="${tone}">${escapeHtml(label)}</span>
        <div class="tk-actions">
          <button class="work-sync-btn" type="button" data-action="sync-job" ${syncingThis ? 'disabled' : ''} title="Refresh PR status">${syncingThis ? '…' : '↻'}</button>
          <div class="tk-menu">
            <button type="button" class="o-btn o-btn--ghost" data-action="toggle-menu" aria-haspopup="true" aria-expanded="false">⋯</button>
            <div class="tk-menu-body" hidden>
              <button type="button" class="tk-menu-item" data-job-action="rerun-latest">${job.steps?.some((s) => !s.cancelled && s.failure) ? 'Rerun failed step' : 'Rerun latest step'}</button>
              <button type="button" class="tk-menu-item danger" data-job-action="reset-job">Reset job</button>
              ${job.state !== 'abandoned' && job.state !== 'done' ? `<button type="button" class="tk-menu-item danger" data-job-action="abandon-job">Abandon</button>` : ''}
              ${job.source === 'manual' ? `<button type="button" class="tk-menu-item danger" data-job-action="delete-job">Delete</button>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="tk-meta">
        <span class="tk-meta-item">${escapeHtml(sourceLabel)}${url ? ` · <a href="${escapeHtml(url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</span>
        ${repo ? `<span class="tk-meta-item">${escapeHtml(shortName(repo))}</span>` : ''}
        <span class="tk-meta-item">Started ${ago(job.createdAt)} ago</span>
      </div>
      ${renderLaunchRow(job)}
    </header>
  `;
}

// Token-launch-queue status + controls — its own inner row so it never crowds
// onto the title/state or source/repo/started lines above (header-spacing rule).
function renderLaunchRow(job) {
  const badge = jobLaunchBadge(job);
  const showPriorityToggle = job.state !== 'done' && job.state !== 'abandoned';
  if (!badge && !showPriorityToggle) return '';
  return `
    <div class="tk-launch-row">
      ${badge ? `<span class="o-pill ${launchPillClass(badge.kind)}">${escapeHtml(badge.label)}</span>` : ''}
      ${showPriorityToggle ? `
        <label class="tk-priority-toggle" title="Run immediately, ignore the token queue">
          <input type="checkbox" class="tk-priority-checkbox" ${job.highPriority ? 'checked' : ''}>
          High priority — run immediately, ignore the token queue
        </label>
      ` : ''}
    </div>
  `;
}

function editTools(s, editable, canMoveUp, canMoveDown) {
  return `
    <div class="step-edit-tools" data-step-id="${escapeHtml(s.id)}">
      <button class="step-edit-tool" type="button" data-step-action="move-up"   aria-label="Move up"   ${canMoveUp ? '' : 'disabled'} title="Move up">▲</button>
      <button class="step-edit-tool" type="button" data-step-action="move-down" aria-label="Move down" ${canMoveDown ? '' : 'disabled'} title="Move down">▼</button>
      <button class="step-edit-tool" type="button" data-step-action="edit-step" aria-label="Edit" ${editable ? '' : 'disabled'} title="${editable ? 'Edit step' : 'Step already running or done'}">✎</button>
      <button class="step-edit-tool danger" type="button" data-step-action="cancel-step" aria-label="Cancel" ${editable ? '' : 'disabled'} title="${editable ? 'Cancel step' : 'Step already running or done'}">×</button>
    </div>
  `;
}

function insertButton(attrs) {
  return `
    <button class="plan-insert" type="button" ${attrs}>
      <span class="plan-insert-line"></span><span class="plan-insert-label">+ insert</span><span class="plan-insert-line"></span>
    </button>
  `;
}

function renderStepsTimeline(job) {
  const liveSteps = (job.steps ?? []).filter((s) => !s.cancelled);
  if (!liveSteps.length) return '';
  const positions = computeGroupPositions(liveSteps);
  const editing = isEditingPlan(job.id) && job.state === 'executing';

  const rows = liveSteps.map((s, i) => {
    let insert = '';
    if (editing && i === 0 && stepIsEditable(s)) {
      insert = insertButton(`data-job-action="insert-step-before" data-before-id="${escapeHtml(s.id)}"`);
    } else if (editing && i > 0) {
      insert = insertButton(`data-job-action="insert-step-after" data-after-id="${escapeHtml(liveSteps[i - 1].id)}"`);
    }
    let tools = '';
    if (editing) {
      const editable = stepIsEditable(s);
      const prev = i > 0 ? liveSteps[i - 1] : null;
      const next = i < liveSteps.length - 1 ? liveSteps[i + 1] : null;
      tools = editTools(s, editable, editable && prev && stepIsEditable(prev), editable && next && stepIsEditable(next));
    }
    return insert + renderTimelineStep(job, s, i, positions[i], { editTools: tools });
  }).join('');

  // Just the rail — the "Steps" heading + Edit-plan toggle moved up into the
  // single Plan header (plan-section.js). This renders inside that section now.
  return `<div class="tl-rail">${rows}</div>`;
}

// ── Repaint state preservation ──────────────────────────────────────────
// The detail rebuilds via innerHTML on work-store events; without this, any
// half-typed composer text, manually toggled <details>, or open menu would be
// wiped mid-interaction by an unrelated activity event.

function detailsKey(d) {
  const step = d.closest('[data-step-id]');
  return `${d.className}|${step ? step.getAttribute('data-step-id') : ''}`;
}

function snapshotUi(root) {
  const snap = { details: new Map(), threads: new Map(), replan: null, launchContext: null, menuOpen: false, focus: null };
  root.querySelectorAll('details').forEach((d) => snap.details.set(detailsKey(d), d.open));
  root.querySelectorAll('.thread[data-comment-id]').forEach((t) => {
    const openEl = [...t.querySelectorAll('[data-composer]')].find((c) =>
      !c.hasAttribute('hidden') && !c.classList.contains('thread-composer-status'));
    const values = {};
    t.querySelectorAll('[data-composer] textarea').forEach((ta) => {
      // defaultValue is the rendered prefill — only carry over what the user
      // actually typed, so a fresh draft from the server isn't clobbered.
      if (ta.value !== ta.defaultValue) values[ta.closest('[data-composer]').getAttribute('data-composer')] = ta.value;
    });
    const open = openEl?.getAttribute('data-composer') ?? null;
    if (open || Object.keys(values).length) {
      snap.threads.set(t.getAttribute('data-comment-id'), { open, values });
    }
  });
  const replan = root.querySelector('.replan-composer');
  if (replan) {
    snap.replan = {
      open: replan.getAttribute('data-open') === 'true',
      value: replan.querySelector('.replan-textarea')?.value ?? '',
    };
  }
  const launchTa = root.querySelector('.launch-context-textarea');
  if (launchTa && launchTa.value) snap.launchContext = launchTa.value;
  snap.menuOpen = !!root.querySelector('.tk-menu-body:not([hidden])');
  const ae = document.activeElement;
  if (ae && root.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
    snap.focus = {
      commentId: ae.closest('.thread[data-comment-id]')?.getAttribute('data-comment-id') ?? null,
      composer: ae.closest('[data-composer]')?.getAttribute('data-composer') ?? null,
      replan: !!ae.closest('.replan-composer'),
      launchContext: !!ae.closest('.launch-context'),
      start: ae.selectionStart,
      end: ae.selectionEnd,
    };
  }
  return snap;
}

function restoreUi(root, snap) {
  // Carries per-step findings collapse (step-card.js's <details.tl-findings>),
  // PR resolved-threads disclosure, etc. across store-driven repaints.
  root.querySelectorAll('details').forEach((d) => {
    const k = detailsKey(d);
    if (snap.details.has(k)) d.open = snap.details.get(k);
  });
  for (const [commentId, t] of snap.threads) {
    const el = root.querySelector(`.thread[data-comment-id="${CSS.escape(commentId)}"]`);
    if (!el) continue;
    for (const [kind, value] of Object.entries(t.values)) {
      const ta = el.querySelector(`[data-composer="${CSS.escape(kind)}"] textarea`);
      if (ta) ta.value = value;
    }
    if (t.open) {
      el.querySelectorAll('[data-composer]').forEach((c) => {
        if (c.classList.contains('thread-composer-status')) return;
        c.toggleAttribute('hidden', c.getAttribute('data-composer') !== t.open);
      });
    }
  }
  if (snap.replan && (snap.replan.open || snap.replan.value)) {
    const composer = root.querySelector('.replan-composer');
    const ta = composer?.querySelector('.replan-textarea');
    if (ta) ta.value = snap.replan.value;
    if (composer && snap.replan.open) {
      composer.setAttribute('data-open', 'true');
      composer.setAttribute('aria-hidden', 'false');
      root.querySelector('[data-job-action="reopen-orchestrator"]')?.setAttribute('aria-expanded', 'true');
    }
  }
  if (snap.launchContext) {
    const ta = root.querySelector('.launch-context-textarea');
    if (ta) ta.value = snap.launchContext;
  }
  if (snap.focus) {
    let ta = null;
    if (snap.focus.replan) {
      ta = root.querySelector('.replan-textarea');
    } else if (snap.focus.launchContext) {
      ta = root.querySelector('.launch-context-textarea');
    } else if (snap.focus.commentId && snap.focus.composer) {
      ta = root.querySelector(
        `.thread[data-comment-id="${CSS.escape(snap.focus.commentId)}"] [data-composer="${CSS.escape(snap.focus.composer)}"] textarea`);
    }
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(snap.focus.start, snap.focus.end); } catch { /* non-text input */ }
    }
  }
}

export function renderTrackedDetail(root, jobId) {
  const job = jobId ? work.get().byId.get(jobId) : null;
  teardownAllExcept(jobId);

  if (!job) {
    root.__tkPaintKey = null;
    root.innerHTML = `<div class="o-frame-empty">Loading job ${escapeHtml(jobId ?? '')}…</div>`;
    return;
  }

  // Skip no-op repaints: work-store events for *other* jobs fire subscribers
  // too, and rebuilding would churn inline session mounts for nothing. launchStatus
  // and highPriority are folded in explicitly — they change on a work_launch_changed
  // refetch without bumping the job's own `updatedAt`.
  const editing = isEditingPlan(job.id);
  const paintKey = `${job.id}:${job.updatedAt}:${work.get().syncingJobId === job.id}:${editing}:${job.highPriority}:${JSON.stringify(job.launchStatus ?? null)}`;
  if (root.__tkPaintKey === paintKey && root.querySelector('.tk-shell')) return;
  root.__tkPaintKey = paintKey;

  const snap = root.querySelector('.tk-shell') ? snapshotUi(root) : null;
  if (root.__tkMenuClose) { document.removeEventListener('click', root.__tkMenuClose); root.__tkMenuClose = null; }

  // During planning/plan review the plan card's compact index is the story;
  // the timeline takes over once the plan is approved and steps execute. Both
  // live under the single Plan section now — the timeline is handed to
  // renderPlanSection rather than rendered as a separate "Steps" block.
  const showTimeline = job.state !== 'planning' && job.state !== 'plan_pending_review';
  const editingTimeline = editing && job.state === 'executing';
  const timelineHtml = showTimeline ? renderStepsTimeline(job) : '';

  root.innerHTML = `
    <div class="tk-shell">
      ${renderHeader(job)}
      <div class="tk-body">
        <div id="tk-plan">${renderPlanSection(job, { timelineHtml, editing: editingTimeline })}</div>
      </div>
    </div>
  `;

  syncInlineMounts(root, job);

  root.querySelectorAll('.tl-step').forEach((el) => {
    const stepId = el.getAttribute('data-step-id');
    const step = (job.steps ?? []).find((s) => s.id === stepId);
    if (step) wireTimelineStep(el, job, step);
  });

  const menuBtn = root.querySelector('[data-action="toggle-menu"]');
  const menuBody = root.querySelector('.tk-menu-body');
  if (menuBtn && menuBody) {
    const closeMenu = () => {
      menuBody.setAttribute('hidden', '');
      menuBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', closeMenu);
      root.__tkMenuClose = null;
    };
    const openMenu = () => {
      menuBody.removeAttribute('hidden');
      menuBtn.setAttribute('aria-expanded', 'true');
      root.__tkMenuClose = closeMenu;
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    };
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuBody.hasAttribute('hidden')) openMenu(); else closeMenu();
    });
    if (snap?.menuOpen) openMenu();
  }

  const syncBtn = root.querySelector('[data-action="sync-job"]');
  if (syncBtn) syncBtn.addEventListener('click', () => void work.syncJob(job.id));

  root.querySelectorAll('[data-job-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const action = el.getAttribute('data-job-action');
      if (el.closest('summary')) { e.preventDefault(); e.stopPropagation(); }
      if (action === 'approve-plan') void work.approve(job.id, { gate: 'plan' });
      else if (action === 'recon-apply') void work.applyReconciliation(job.id);
      else if (action === 'recon-discard') void work.discardReconciliation(job.id);
      else if (action === 'launch-orchestrator') {
        const ta = root.querySelector('.launch-context-textarea');
        const context = ta?.value.trim() || undefined;
        void work.launchOrchestrator(job.id, context);
      }
      else if (action === 'add-step-end') openActionPickerDialog(job.id);
      else if (action === 'reopen-orchestrator') toggleReplanComposer(root, true);
      else if (action === 'replan-cancel') toggleReplanComposer(root, false);
      else if (action === 'replan-submit') submitReplan(root, job.id);
      else if (action === 'toggle-edit-plan') {
        editingPlanByJob.set(job.id, !isEditingPlan(job.id));
        renderTrackedDetail(root, job.id);
      }
      else if (action === 'insert-step-after') {
        const after = el.getAttribute('data-after-id') ?? undefined;
        openActionPickerDialog(job.id, { afterStepId: after });
      }
      else if (action === 'insert-step-before') {
        const before = el.getAttribute('data-before-id') ?? undefined;
        openActionPickerDialog(job.id, { beforeStepId: before });
      }
      else if (action === 'rerun-latest') {
        if (!confirm('Re-run the most recent step? Its prior output will be replaced.')) return;
        void work.rerunLatest(job.id).catch((e) => alert(`Rerun failed: ${e?.message ?? e}`));
      }
      else if (action === 'reset-job') {
        if (!confirm('Reset this job? Steps and plan will be wiped; back to planning. Any active sessions stay open — close them manually.')) return;
        void work.resetJob(job.id).catch((e) => alert(`Reset failed: ${e?.message ?? e}`));
      }
      else if (action === 'abandon-job') {
        if (!confirm('Abandon this job? Active sessions will be closed and worktrees archived. The record stays for history.')) return;
        void work.abandon(job.id).catch((e) => alert(`Abandon failed: ${e?.message ?? e}`));
      }
      else if (action === 'delete-job') {
        if (!confirm('Delete this job? Sessions will be closed, worktrees archived, and the record removed. This cannot be undone.')) return;
        void work.deleteJob(job.id).catch((e) => alert(`Delete failed: ${e?.message ?? e}`));
      }
    });
  });

  const priorityToggle = root.querySelector('.tk-priority-checkbox');
  if (priorityToggle) {
    priorityToggle.addEventListener('change', () => {
      void work.setPriority(job.id, priorityToggle.checked)
        .catch((e) => { alert(`Priority update failed: ${e?.message ?? e}`); priorityToggle.checked = !priorityToggle.checked; });
    });
  }

  root.querySelectorAll('.step-edit-tools').forEach((toolsEl) => {
    const stepId = toolsEl.getAttribute('data-step-id');
    toolsEl.querySelectorAll('[data-step-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (btn.hasAttribute('disabled')) return;
        const kind = btn.getAttribute('data-step-action');
        if (kind === 'edit-step') {
          const step = (job.steps ?? []).find((x) => x.id === stepId);
          if (step) openAddStepDialog(job.id, { editStep: step });
          return;
        }
        if (kind === 'cancel-step') {
          try { await work.cancelStep(job.id, stepId); }
          catch (err) { alert(`Cancel failed: ${err?.message ?? err}`); }
          return;
        }
        if (kind === 'move-up' || kind === 'move-down') {
          const live = (job.steps ?? []).filter((s) => !s.cancelled);
          const idx = live.findIndex((s) => s.id === stepId);
          if (idx < 0) return;
          const j = kind === 'move-up' ? idx - 1 : idx + 1;
          if (j < 0 || j >= live.length) return;
          const ids = (job.steps ?? []).map((s) => s.id);
          const liveSet = new Set(live.map((s) => s.id));
          const liveIdsInOrder = [...live];
          [liveIdsInOrder[idx], liveIdsInOrder[j]] = [liveIdsInOrder[j], liveIdsInOrder[idx]];
          let li = 0;
          for (let k = 0; k < ids.length; k++) {
            if (liveSet.has(ids[k])) ids[k] = liveIdsInOrder[li++].id;
          }
          try { await work.reorderSteps(job.id, ids); }
          catch (err) { alert(`Reorder failed: ${err?.message ?? err}`); }
        }
      });
    });
  });

  if (snap) restoreUi(root, snap);
}
