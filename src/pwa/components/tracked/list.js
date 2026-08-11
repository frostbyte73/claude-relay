// Tracked list column — jobs bucketed by attention priority (vm/tracked.js's
// trackedGroups), rendered as o-row cards. Reuses ticket-row.js's pure
// derivation (jobTone/ago/stepDots) rather than reimplementing job-state math.

import { work } from '../../state/work.js';
import { nav } from '../../state/nav.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { trackedGroups, jobLaunchBadge } from '../../vm/tracked.js';
import { jobTone, ago, stepDots, launchPillClass } from '../work/ticket-row.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

const TONE_ICON = { gate: 'warn', danger: 'hot', ok: 'ok', accent: 'busy', active: 'busy', mute: 'idle' };

function rowHtml(j) {
  const tone = jobTone(j);
  const ref = j.externalRef?.issueIdentifier ?? '';
  // "Running" is already implied by the row landing in the Running group / active
  // icon tone — only the queued case (parked behind the token queue) is news the
  // compact row can't otherwise convey, so that's the only badge shown here.
  const badge = jobLaunchBadge(j);
  const queuedPill = badge?.kind === 'queued'
    ? `<span class="o-pill ${launchPillClass(badge.kind)}">${escapeHtml(badge.label)}</span>` : '';
  return `
    <button type="button" class="o-row lr-row" data-job-id="${escapeHtml(j.id)}">
      <span class="o-row-icon ${TONE_ICON[tone] ?? 'idle'}">●</span>
      <span class="tracked-row-body">
        <div class="o-row-title">${ref ? `<span class="o-ref">${escapeHtml(ref)}</span>` : ''}${escapeHtml(j.title ?? '(untitled)')}</div>
        <div class="o-row-sub">${stepDots(j)}${queuedPill}</div>
      </span>
      <span class="o-row-time">${ago(j.updatedAt)}</span>
    </button>
  `;
}

function groupHtml(title, jobs) {
  if (!jobs.length) return '';
  return `
    <div class="o-group-hdr"><h3>${escapeHtml(title)}</h3><span class="o-group-count">${jobs.length}</span><span class="o-group-rule"></span></div>
    <div class="o-row-group">${jobs.map(rowHtml).join('')}</div>
  `;
}

function collapsedGroupHtml(title, jobs, open) {
  if (!jobs.length) return '';
  return `
    <details class="o-group-collapse" ${open ? 'open' : ''}>
      <summary class="o-group-hdr"><span class="o-group-title">${escapeHtml(title)}</span><span class="o-group-count">${jobs.length}</span><span class="o-group-rule"></span></summary>
      <div class="o-row-group">${jobs.map(rowHtml).join('')}</div>
    </details>
  `;
}

export function renderTrackedList(body) {
  let doneOpen = false;
  const paint = () => {
    const jobs = work.get().jobs ?? [];
    const { running, needsYou, waiting, backlog, done } = trackedGroups(jobs);
    const html = [
      groupHtml('Running', running),
      groupHtml('Needs you', needsYou),
      groupHtml('Waiting', waiting),
      groupHtml('Backlog', backlog),
      collapsedGroupHtml('Done', done, doneOpen),
    ].join('');
    // Guarded: a work-store event for ANY job notifies every subscriber, and a
    // row's step dots (.step-dot[data-state="running"]) pulse forever — a rebuild
    // restarts them. renderTrackedDetail guards the same way with its paintKey.
    // Skipping also avoids re-binding a click handler per row.
    if (!setHtmlIfChanged(body, html || '<div class="lr-empty">No jobs in the queue yet.</div>')) {
      highlightSelected();
      return;
    }
    highlightSelected();
    body.querySelectorAll('.lr-row').forEach((el) => {
      el.addEventListener('click', () => nav.select('tracked', el.dataset.jobId));
    });
    const doneEl = body.querySelector('.o-group-collapse');
    if (doneEl) doneEl.addEventListener('toggle', () => { doneOpen = doneEl.open; });
  };
  const highlightSelected = () => {
    const selected = nav.get().selectionBySurface.tracked ?? null;
    for (const el of body.querySelectorAll('.lr-row')) {
      el.classList.toggle('is-open', !!selected && el.dataset.jobId === selected);
    }
  };
  paint();
  const unsubWork = work.subscribe(paint);
  const unsubNav = nav.subscribe(highlightSelected);
  return () => { unsubWork(); unsubNav(); };
}
