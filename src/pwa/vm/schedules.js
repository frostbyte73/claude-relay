// Schedules view-model: humanizes triggers/guards and shapes the list cards +
// four detail-pane cards (Trigger / What to run / Where findings go / Recent
// runs) from the real backend shapes (src/schedules/types.ts):
//   ScheduleRecord: {id, name, enabled, trigger, what, guards, routing, ...}
//     trigger: {kind:'cron', expr, tz?} | {kind:'event', descriptor}
//     guards:  {kind:'usage-threshold', window, op, value} | {kind:'no-repo-changes', repo?}
//   ScheduleRun: {id, scheduleId, startedAt, finishedAt?, outcome, verdict?, skipReason?, refs?, delivery?}
// `nextRunAt` is server-computed and only present on records returned from
// GET /api/schedules (not persisted on the record itself).

import { relPast, relFuture } from '../utils/formatting.js';

// Re-exported so existing consumers (runs-card, list, detail renderers) keep
// importing the relative-time pair from this vm; the implementation is the
// shared utils/formatting.js one.
export { relPast, relFuture };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${pad2(m)} ${ampm}`;
}

export function humanizeCron(expr) {
  if (!expr || typeof expr !== 'string') return expr ?? '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every hour';
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `Daily at ${fmtTime(hour, min)}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d+$/.test(dow)) {
    return `Weekly ${DAY_NAMES[Number(dow) % 7]} at ${fmtTime(hour, min)}`;
  }
  // NB: no `dom=1-7`+`dow` "first <weekday> of the month" case here — the scheduler
  // (src/schedules/scheduler.ts) constructs `Cron` without `domAndDow: true`, so croner
  // applies legacy OR semantics to that idiom (fires on every day 1-7 AND every matching
  // weekday, ~10-11x/month) rather than the once-a-month intersection the label would imply.
  return expr;
}

export function fmtAbsolute(atMs) {
  if (atMs == null) return null;
  const d = new Date(atMs);
  const datePart = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const timePart = fmtTime(d.getHours(), d.getMinutes());
  return `${datePart} · ${timePart}`;
}

function fmtDateTime(atMs) {
  if (atMs == null) return null;
  const d = new Date(atMs);
  const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timePart = fmtTime(d.getHours(), d.getMinutes());
  return `${datePart} · ${timePart}`;
}

export function triggerWhen(trigger) {
  if (!trigger) return '';
  if (trigger.kind === 'token-opportunistic') return 'When tokens are free';
  if (trigger.kind === 'event') return trigger.descriptor ?? 'on event';
  if (trigger.kind === 'once') return `Once on ${fmtAbsolute(trigger.at) ?? 'a set time'}`;
  return humanizeCron(trigger.expr);
}

// The mono "muscle memory" string shown under the human sentence: raw cron
// expr for cron triggers, `once · <ISO>` for one-shots, `event · <descriptor>` for event ones.
export function triggerDescriptor(trigger) {
  if (!trigger) return '';
  if (trigger.kind === 'token-opportunistic') return 'token · opportunistic';
  if (trigger.kind === 'event') return `event · ${trigger.descriptor ?? ''}`;
  if (trigger.kind === 'once') return trigger.at != null ? `once · ${new Date(trigger.at).toISOString()}` : 'once';
  return trigger.expr ?? '';
}

// First non-blank line of a script, truncated — the closest thing a free-text
// script has to a name for the list pill / cockpit row.
export function scriptFirstLine(script) {
  const first = (script ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'script';
  return first.length > 48 ? `${first.slice(0, 48)}…` : first;
}

// One display token per `what` kind: the skill name, a prompt snippet, a
// script's first line, or a native handler's name. `mono` picks the code-pill
// treatment for skill/script/native.
export function whatSummary(what) {
  const kind = what?.kind ?? 'skill';
  if (kind === 'prompt') {
    const p = (what.prompt ?? '').trim().replace(/\s+/g, ' ');
    return { kind, label: p.length > 64 ? `${p.slice(0, 64)}…` : (p || 'prompt'), mono: false };
  }
  if (kind === 'script') return { kind, label: scriptFirstLine(what.script), mono: true };
  if (kind === 'native') return { kind, label: what?.handler ?? null, mono: true };
  return { kind, label: what?.skill ?? null, mono: true };
}

// Whether an in-progress draft (client-side, pre-persist) is complete enough to
// create + enable. Mirrors the backend create-time invariants (routes/schedules.ts
// validateWhat) so the enable toggle never offers to POST something the server rejects.
export function draftValidity(draft) {
  const missing = [];
  if (!draft?.name?.trim()) missing.push('a name');
  if (!draft?.trigger) missing.push('a trigger');
  const w = draft?.what;
  const whatOk =
    w?.kind === 'prompt' ? !!(w.prompt?.trim() && w.cwd?.trim())
    : w?.kind === 'script' ? !!(w.script?.trim() && w.cwd?.trim())
    : !!w?.skill?.trim();
  if (!whatOk) missing.push('what to run');
  return { valid: missing.length === 0, missing };
}

export function guardLabel(guard) {
  if (!guard) return '';
  if (guard.kind === 'usage-threshold') return `${guard.window} usage ${guard.op} ${guard.value}%`;
  if (guard.kind === 'no-repo-changes') {
    return guard.repo ? `no changes in ${guard.repo} since last run` : 'no repo changes since last run';
  }
  return guard.kind ?? '';
}

// ── List cards ─────────────────────────────────────────────────────────

// The trigger kind a list card/tab filters on. Legacy kind-less rows default to cron.
function triggerSourceKind(trigger) {
  if (trigger?.kind === 'token-opportunistic') return 'token';
  return trigger?.kind === 'event' || trigger?.kind === 'once' ? trigger.kind : 'cron';
}

// The next-run line for a card/detail. Token-opportunistic schedules have no clock nextRunAt —
// the server attaches a live `tokenStatus` ({state, reason}) instead, which is what we show.
function nextRunSummary(schedule, now) {
  if (!schedule.enabled) return 'Paused';
  if (schedule.trigger?.kind === 'token-opportunistic') return schedule.tokenStatus?.reason ?? 'Waiting for token headroom';
  return relFuture(schedule.nextRunAt, now);
}

export function scheduleCards(schedules = [], now = Date.now()) {
  return schedules.map((s) => ({
    id: s.id,
    name: s.name ?? '(schedule)',
    sourceKind: triggerSourceKind(s.trigger),
    when: triggerWhen(s.trigger),
    descriptor: triggerDescriptor(s.trigger),
    what: whatSummary(s.what),
    enabled: !!s.enabled,
    dimmed: !s.enabled,
    nextRunSummary: nextRunSummary(s, now),
    builtin: !!s.builtin,
  }));
}

export function filterScheduleCards(cards, tab) {
  if (!tab || tab === 'all') return cards;
  return cards.filter((c) => c.sourceKind === tab);
}

// ── Detail-pane cards ────────────────────────────────────────────────────

function outcomeTone(outcome) {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'error') return 'hot';
  if (outcome === 'skipped') return 'warn';
  if (outcome === 'running') return 'busy';
  return 'idle';
}

function outcomeGlyph(outcome) {
  if (outcome === 'ok') return '✓';
  if (outcome === 'error') return '✕';
  if (outcome === 'skipped') return '◆';
  if (outcome === 'running') return '●';
  return '·';
}

// Summarizes a run's findings + per-channel delivery outcome into one
// human line ("2 findings · 1 below cockpit threshold · GitHub pending
// approval") — grounded in what RunDelivery actually records, no invented
// "still open" tracking (the data model doesn't carry that).
function followUpSummary(run) {
  const parts = [];
  const findings = run.verdict?.findings ?? [];
  if (findings.length) parts.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  const d = run.delivery ?? {};
  if (d.cockpit && d.cockpit.surfaced === false) parts.push('below cockpit threshold');
  if (d.slack?.status === 'sent') parts.push('sent to Slack');
  if (d.slack?.status === 'failed') parts.push(`Slack failed${d.slack.reason ? `: ${d.slack.reason}` : ''}`);
  if (d.slack?.status === 'skipped') parts.push('Slack skipped — not configured');
  if (d.github?.status === 'posted') parts.push('posted to GitHub');
  if (d.github?.status === 'pending-approval') parts.push('GitHub post pending approval');
  if (d.github?.status === 'failed') parts.push(`GitHub failed${d.github.reason ? `: ${d.github.reason}` : ''}`);
  return parts.join(' · ');
}

export function runRow(run, now = Date.now()) {
  const outcome = run.outcome ?? 'ok';
  const isSkipped = outcome === 'skipped';
  return {
    id: run.id,
    outcome,
    tone: outcomeTone(outcome),
    glyph: outcomeGlyph(outcome),
    title: fmtDateTime(run.startedAt),
    verdictText: isSkipped
      ? `Skipped — ${run.skipReason ?? 'guard not met'}`
      : (run.verdict?.summary ?? (outcome === 'running' ? 'Running…' : outcome === 'error' ? 'Failed' : 'No verdict recorded')),
    followUp: isSkipped ? '' : followUpSummary(run),
    durationMs: run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null,
    timeAgo: relPast(run.startedAt, now),
    canApproveGithub: run.delivery?.github?.status === 'pending-approval',
    refs: run.refs ?? null,
  };
}

export function scheduleDetail(schedule, runs = [], now = Date.now()) {
  const trigger = schedule.trigger ?? { kind: 'cron', expr: '' };
  const isToken = trigger.kind === 'token-opportunistic';
  return {
    id: schedule.id,
    name: schedule.name ?? '(schedule)',
    enabled: !!schedule.enabled,
    trigger: {
      sourceKind: triggerSourceKind(trigger),
      when: triggerWhen(trigger),
      descriptor: triggerDescriptor(trigger),
      tz: trigger.tz ?? null,
      nextRunAbsolute: schedule.enabled && !isToken ? fmtAbsolute(schedule.nextRunAt) : null,
      nextRunRelative: nextRunSummary(schedule, now),
      guards: (schedule.guards ?? []).map((g) => ({ raw: g, label: guardLabel(g) })),
    },
    whatToRun: {
      kind: schedule.what?.kind ?? 'skill',
      summary: whatSummary(schedule.what),
      skill: schedule.what?.skill ?? null,
      prompt: schedule.what?.prompt ?? null,
      script: schedule.what?.script ?? null,
      handler: schedule.what?.handler ?? null,
      cwd: schedule.what?.cwd ?? null,
      repos: schedule.what?.repos ?? [],
      scope: schedule.what?.scope ?? null,
      model: schedule.what?.model ?? null,
      args: schedule.what?.args ?? {},
    },
    routing: {
      cockpit: schedule.routing?.cockpit ?? null,
      slack: schedule.routing?.slack ?? null,
      github: schedule.routing?.github ?? null,
    },
    recentRuns: runs.map((r) => runRow(r, now)),
  };
}
