// What the inline feed shows instead of a transcript tail — the two states where a tail is
// either impossible or stale. A settled step gets the terminal chip ("✓ Finished in 10m37s");
// an orchestrated step whose controller session has gone quiet gets the idle chip carrying
// its status ("⏸ Watching CI"), in the same slot and the same shape.

import { escapeHtml } from '../../util.js';
import { orchestratedRows } from '../../vm/tracked.js';

const TERMINAL_END_KINDS = new Set(['resolved', 'failed', 'cancelled', 'merged']);

// Timing comes only from the run events (spawned → terminal), which session-mounts
// derives from the job timeline. Deliberately NO createdAt/updatedAt fallback:
// createdAt is plan-authoring time (days before the step runs) and updatedAt gets
// bumped by later plan reconciles — either produces a bogus multi-day "duration".
// If the run bounds are unknown, stepDurationText returns '' and the chip shows a
// bare "✓ Finished" instead of a fabricated span.
function stepStartAt(step) {
  const spawned = (step.events ?? []).find((e) => e.kind === 'spawned');
  return spawned?.at ?? 0;
}

function stepEndAt(step) {
  if (step.failure?.at) return step.failure.at;
  const events = step.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (TERMINAL_END_KINDS.has(events[i].kind)) return events[i].at;
  }
  return 0;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

export function stepDurationText(step) {
  const start = stepStartAt(step);
  const end = stepEndAt(step);
  if (!start || !end || end <= start) return '';
  return fmtDuration(end - start);
}

export function terminalChipVariant(step) {
  if (step.cancelled) return 'cancelled';
  if (step.failure) return 'failed';
  // ActionStep-only: the user denied this step's write draft. Terminal, but not a failure —
  // its own variant rather than folding into 'failed'.
  if (step.type === 'action' && step.state === 'declined') return 'declined';
  if (step.state === 'resolved') return 'finished';
  return null;
}

const GLYPH = { finished: '✓', failed: '✗', cancelled: '⊘', declined: '⊘' };
const LABEL = { finished: 'Finished', failed: 'Failed', cancelled: 'Cancelled', declined: 'Declined' };

function chipHtml(variant, text) {
  return (
    `<div class="inline-session-chip" data-variant="${escapeHtml(variant)}">` +
      `<span class="inline-session-chip-text">${escapeHtml(text)}</span>` +
    `</div>`
  );
}

export function renderTerminalChipHtml(step) {
  const variant = terminalChipVariant(step);
  if (!variant) return '';
  const duration = stepDurationText(step);
  const suffix = duration && variant !== 'cancelled' ? ` in ${duration}` : '';
  return chipHtml(variant, `${GLYPH[variant]} ${LABEL[variant]}${suffix}`);
}

// A live-but-quiet controller: parked on CI, on a dispatch it fanned out, or on you. Its own
// last two transcript lines are whatever it said before parking, which reads as activity that
// isn't happening — so the feed states the status instead. Only orchestrated steps have one;
// an action step's session going quiet means it's about to settle and take the terminal chip.
//
// `⏸` unconditionally rather than per-status: the glyph is answering "is this session
// running", which is already false by the time this renders.
export function renderIdleChipHtml(step) {
  if (!step || step.type !== 'orchestrated') return '';
  const status = orchestratedRows(step).statusLine;
  return status ? chipHtml('idle', `⏸ ${status}`) : '';
}
