// Skills library — the measured half of an action's detail pane. Objective run
// outcomes from the action-run ledger, as opposed to the journal section below it,
// which is what the action said about itself.

import { escapeHtml } from '../../util.js';
import { nav } from '../../state/nav.js';
import { scorecardRows, scorecardTiles } from '../../vm/library.js';

export function scorecardSectionHtml(item, libState) {
  if (item.kind !== 'action') return '';
  const sc = libState.scorecardByAction?.get?.(item.name);
  const loading = libState.scorecardLoading?.has?.(item.name);
  let body;
  if (!sc) {
    body = `<div class="lib-empty-note">${loading ? 'Loading…' : 'No runs recorded yet.'}</div>`;
  } else if (sc.runs === 0) {
    body = '<div class="lib-empty-note">No runs recorded yet.</div>';
  } else {
    body = tilesHtml(sc) + rowsHtml(sc) + pendingHtml(sc);
  }
  return `
    <div class="o-section lib-section lib-scorecard">
      <h4 class="lib-section-hdr o-microhead">Scorecard · last 30d</h4>
      ${body}
    </div>
  `;
}

function tilesHtml(sc) {
  const tiles = scorecardTiles(sc).map((t) => `
    <div class="lib-score-tile">
      <span class="lib-score-v ${escapeHtml(t.tone)}">${escapeHtml(t.value)}</span>
      <span class="lib-score-k">${escapeHtml(t.label)}</span>
    </div>
  `).join('');
  return `<div class="lib-score-tiles">${tiles}</div>`;
}

function rowsHtml(sc) {
  const rows = scorecardRows(sc).map((r) => `
    <button type="button" class="lib-score-row" data-job-id="${escapeHtml(r.jobId)}">
      <span class="lib-score-row-top">
        <span class="o-pill code">${escapeHtml(r.round)}${r.attempt > 1 ? ` ·${r.attempt}` : ''}</span>
        <span class="o-pill ${escapeHtml(r.tone === 'hot' ? 'danger' : r.tone)}">${escapeHtml(r.outcome)}</span>
      </span>
      <span class="lib-score-row-sub">
        <span>${escapeHtml(r.durationText)}</span>
        <span>${escapeHtml(r.costText)}</span>
        <span>${escapeHtml(r.whenText ?? '')}</span>
      </span>
    </button>
  `).join('');
  return `<div class="lib-score-rows">${rows}</div>`;
}

function pendingHtml(sc) {
  if (!sc.pending) return '';
  const label = sc.pending === 1 ? '1 run is' : `${sc.pending} runs are`;
  return `<div class="lib-perm-extra">${label} still awaiting a verdict and excluded from these rates.</div>`;
}

export function wireScorecard(view) {
  view.querySelectorAll('.lib-score-row[data-job-id]').forEach((btn) => {
    btn.addEventListener('click', () => nav.select('tracked', btn.dataset.jobId));
  });
}
