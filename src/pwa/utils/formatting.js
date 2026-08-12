// Shared pure formatting helpers: the canonical relative-time / duration trio
// (relPast/relFuture/formatDuration) used across cockpit, schedules, sessions
// and runs, plus the rate-limit / usage panel helpers extracted from app.js.
// vm/runs.js's calendar-aware formatRunWhen is the one deliberate exception
// that stays surface-local.

// "just now" / "3m ago" / "2h ago" / "5d ago" / "2w ago". Null-safe.
function relPast(atMs, now = Date.now()) {
  if (atMs == null) return null;
  const diff = Math.max(0, now - atMs);
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

// "in 12m" / "in 3h" / "in 2d 4h" / "overdue". Null-safe.
function relFuture(atMs, now = Date.now()) {
  if (atMs == null) return null;
  const diff = atMs - now;
  if (diff <= 0) return 'overdue';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(diff / 86_400_000);
  const remHours = Math.round((diff - days * 86_400_000) / 3_600_000);
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

// "42s" / "4m 08s" / "1h 02m". Returns null for non-finite/negative input so
// each caller picks its own fallback ('' vs '—').
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtCtxSize(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`;
  return n.toLocaleString('en-US');
}

function fmtResetAt(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '—';
  const now = Date.now();
  const target = epochSeconds * 1000;
  const diffMs = target - now;
  if (diffMs <= 0) return 'now';
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  const mins = totalMin % 60;
  let rel;
  if (days > 0) rel = `${days}d ${hours}h`;
  else if (hours > 0) rel = `${hours}h ${mins}m`;
  else rel = `${mins}m`;
  // Absolute clock time — short form, user's locale. Skip the date part; if the reset is
  // days away the relative duration already conveys "later this week" clearly enough.
  let clock;
  try {
    clock = new Date(target).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    clock = '';
  }
  return clock ? `in ${rel} · ${clock}` : `in ${rel}`;
}

// Compact remaining-time label for a rate-limit cell, e.g. "2D 14H", "3H 24M", "2M".
// Two-unit granularity, stopping at minutes; trailing zero unit is dropped.
// Returns null when the input isn't a number so the caller can fall back to the static
// "5H"/"7D" label. Returns "now" if the reset is already past (brief gap between reset
// and the next statusLine fire).
function fmtRemaining(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  const diffMs = epochSeconds * 1000 - Date.now();
  if (diffMs <= 0) return 'now';
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}D ${hours}H` : `${days}D`;
  if (hours > 0) return mins > 0 ? `${hours}H ${mins}M` : `${hours}H`;
  return `${mins}M`;
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// The last two path segments of a working directory — how a repo names itself in a row
// ("frostbyte73/outpost"). Had been copy-pasted identically into step-card.js, pr-block.js,
// tracked/detail.js and tracked/focus-rail.js.
function shortName(cwd) {
  return String(cwd ?? '').split('/').filter(Boolean).slice(-2).join('/');
}

export { relPast, relFuture, formatDuration, fmtCtxSize, fmtResetAt, fmtRemaining, fmtNumber, shortName };
