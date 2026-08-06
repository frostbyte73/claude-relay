// "ticket-row" by historical filename; since the redesign it renders no rows
// itself — it's the shared job-row derivation helpers (state labels, tones,
// step dots) that tracked/list.js and tracked/detail.js compose into their
// own markup.

import { needsYou } from '../../vm/work-predicates.js';

export const STATE_LABEL = {
  planning: 'Planning',
  plan_pending_review: 'Plan review',
  executing: 'Executing',
  done: 'Done',
  failed: 'Failed',
  abandoned: 'Abandoned',
};

export function jobTone(j) {
  if (j.state === 'failed') return 'danger';
  if (j.state === 'done') return 'ok';
  if (j.state === 'abandoned') return 'mute';
  if (needsYou(j)) return 'gate';
  if (j.state === 'planning' && !j.orchestratorSessionId) return 'mute';
  if (j.state === 'planning') return 'active';
  if (j.state === 'executing') return 'accent';
  return 'mute';
}

// Maps a vm/tracked.js launchBadge()'s `kind` onto an existing .o-pill modifier —
// no new pill color introduced for this feature.
export function launchPillClass(kind) {
  return kind === 'running' ? 'investigate' : 'warn';
}

export function ago(epochMs) {
  if (!epochMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function stepDotState(s) {
  if (s.failure) return 'failed';
  if (s.cancelled) return 'todo';
  if (s.state === 'resolved') return 'ok';
  if (s.state === 'gate_pending_approval') return 'gate';
  if (s.type === 'action' && s.state === 'waiting') return 'gate';
  if (s.type === 'orchestrated' && s.phase === 'pr_open'
    && s.pr?.reviewState === 'approved' && s.pr?.ciState === 'success') return 'gate';
  if (s.sessionId) return 'active';
  return 'todo';
}

function escapeAttr(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

export function stepDots(j) {
  const steps = (j.steps ?? []).filter((s) => !s.cancelled);
  if (steps.length === 0) return '<span class="step-dot" data-state="queued"></span>';
  return steps.map((s) => {
    const label = s.type === 'action' ? `action · ${s.action ?? ''}` : `orchestrated · ${s.controller ?? ''}`;
    return `<span class="step-dot" data-state="${stepDotState(s)}" title="${escapeAttr(label)}: ${escapeAttr(s.state)}"></span>`;
  }).join('');
}
