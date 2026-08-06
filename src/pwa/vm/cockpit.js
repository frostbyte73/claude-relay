// Cockpit view-model: derives the four home-view groups (waiting / in flight /
// upcoming / finished) from raw store snapshots. Zero DOM — renderers turn Row
// objects into markup, this module only decides which rows exist and how they sort.

import { stepNeedsYou } from './work-predicates.js';

const UPCOMING_CAP = 5;
const FINISHED_CAP = 8;
const FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

function approvalRow(a) {
  return {
    id: `approval-${a.approvalId}`,
    kind: 'approval',
    tone: 'hot',
    title: a.sessionTitle || a.toolName || 'Approval needed',
    ref: null,
    pills: [{ label: a.toolName ?? 'tool', variant: 'action' }],
    time: a.enqueuedAt || Date.now(),
    open: { surface: 'sessions', id: a.sessionId },
  };
}

function planReviewRow(j) {
  return {
    id: `job-plan-${j.id}`,
    kind: 'plan-review',
    tone: 'warn',
    title: j.title ?? '(untitled job)',
    ref: j.externalRef?.issueIdentifier ?? null,
    pills: [{ label: 'Plan review', variant: 'warn' }],
    time: j.updatedAt ?? 0,
    open: { surface: 'tracked', id: j.id },
  };
}

function stepWaitPill(s) {
  if (s.state === 'gate_pending_approval') {
    return { label: s.type === 'orchestrated' ? 'Approve move' : 'Approve write', variant: 'gate' };
  }
  if (s.type === 'action' && s.state === 'waiting') return { label: 'On hold', variant: 'gate' };
  return { label: 'Ready to merge', variant: 'ok' };
}

function stepWaitTone(s) {
  return (s.state === 'gate_pending_approval'
    || (s.type === 'action' && s.state === 'waiting')) ? 'hot' : 'warn';
}

function stepWaitingRows(j) {
  return (j.steps ?? [])
    .filter((s) => !s.cancelled && stepNeedsYou(s))
    .map((s) => ({
      id: `step-${j.id}-${s.id}`,
      kind: 'pr-step',
      tone: stepWaitTone(s),
      title: j.title ?? '(untitled job)',
      ref: j.externalRef?.issueIdentifier ?? null,
      pills: [stepWaitPill(s)],
      time: s.updatedAt ?? j.updatedAt ?? 0,
      open: { surface: 'tracked', id: j.id },
    }));
}

function sessionTitleFromCwd(cwd) {
  if (!cwd) return 'session';
  const parts = String(cwd).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function sessionRow(slice) {
  return {
    id: `session-${slice.id}`,
    kind: 'session',
    tone: 'busy',
    title: sessionTitleFromCwd(slice.cwd ?? slice.spawnCwd),
    ref: null,
    pills: [{ label: slice.runState === 'foreground' ? 'active' : 'background', variant: 'kind' }],
    // No honest per-session timestamp exists in the slice (a `now` here would
    // just measure time-since-paint) — leave the time cell empty.
    time: null,
    open: { surface: 'sessions', id: slice.id },
  };
}

function executingJobRow(j) {
  // Surface the token-launch queue's verdict in place of a flat "Executing" pill
  // when the job's own launch is parked — the job is "in flight" in the sense
  // that it's active work, but it isn't actually burning tokens right now.
  const launch = j.launchStatus?.job;
  const queued = launch?.state === 'queued';
  const pill = queued ? { label: `Queued — ${launch.reason}`, variant: 'warn' } : { label: 'Executing', variant: 'accent' };
  return {
    id: `job-exec-${j.id}`,
    kind: 'job',
    tone: queued ? 'warn' : 'busy',
    title: j.title ?? '(untitled job)',
    ref: j.externalRef?.issueIdentifier ?? null,
    pills: [pill],
    time: j.updatedAt ?? 0,
    open: { surface: 'tracked', id: j.id },
  };
}

function scheduleNextRun(s) {
  return s.nextRunAt ?? null;
}

function scheduleRow(s) {
  return {
    id: `schedule-${s.id}`,
    kind: 'schedule',
    tone: 'ok',
    title: s.name ?? '(schedule)',
    ref: null,
    pills: [{ label: s.what?.skill ?? s.what?.kind ?? 'schedule', variant: 'kind' }],
    time: scheduleNextRun(s) ?? 0,
    open: { surface: 'schedules', id: s.id },
  };
}

function runEndedAt(r) {
  return (r.startedAt ?? 0) + (r.durationMs ?? 0);
}

function runTone(r) {
  const v = String(r.verdict ?? '').toLowerCase();
  if (/fail|error/.test(v)) return 'warn';
  if (/skip/.test(v)) return 'idle';
  return 'ok';
}

const RUN_KIND_VARIANT = { sess: 'purple', track: 'accent', sched: 'warn' };

function finishedRunRow(r) {
  return {
    id: `run-${r.id}`,
    kind: 'run',
    tone: runTone(r),
    title: r.title ?? '(run)',
    ref: null,
    pills: [{ label: r.kind ?? 'run', variant: RUN_KIND_VARIANT[r.kind] ?? 'kind' }],
    time: runEndedAt(r),
    open: { surface: 'runs', id: r.id },
    // appBridge.openRunDetail(run) wants the full run record, not just an id —
    // carried alongside `open` rather than replacing it so `open` stays a
    // uniform {surface, id} shape across every row kind.
    raw: r,
  };
}

export function cockpitGroups({
  pendingApprovals = [],
  jobs = [],
  sessionsById = new Map(),
  schedules = [],
  runs = [],
  now = Date.now(),
} = {}) {
  const waiting = [
    ...pendingApprovals.map(approvalRow),
    ...jobs.filter((j) => j.state === 'plan_pending_review').map(planReviewRow),
    // Only executing jobs can genuinely wait on a step — abandoned/failed/done
    // jobs keep stale step states (see isTerminalJob in work-predicates.js).
    ...jobs.filter((j) => j.state === 'executing').flatMap(stepWaitingRows),
  ].sort((a, b) => (b.time ?? 0) - (a.time ?? 0));

  const runningSessions = [...sessionsById.values()]
    .filter((s) => s.runState === 'foreground' || s.runState === 'background');
  const inFlight = [
    ...runningSessions.map(sessionRow),
    ...jobs.filter((j) => j.state === 'executing').map(executingJobRow),
  ].sort((a, b) => ((b.time ?? 0) - (a.time ?? 0)) || String(a.title).localeCompare(String(b.title)));

  const upcoming = schedules
    .filter((s) => s.enabled && scheduleNextRun(s) != null)
    .map(scheduleRow)
    .sort((a, b) => a.time - b.time)
    .slice(0, UPCOMING_CAP);

  const finished = runs
    .map((r) => ({ row: finishedRunRow(r), endedAt: runEndedAt(r) }))
    .filter(({ endedAt }) => endedAt <= now && now - endedAt <= FINISHED_WINDOW_MS)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, FINISHED_CAP)
    .map(({ row }) => row);

  return { waiting, inFlight, upcoming, finished };
}

export function sentimentSummary(groups) {
  const waiting = groups.waiting.length;
  const flight = groups.inFlight.length;
  const hot = groups.waiting.some((r) => r.tone === 'hot');

  const waitingPart = waiting === 0
    ? 'Nothing needs you right now.'
    : `${waiting} thing${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you.`;
  const flightPart = flight === 0
    ? 'Nothing running.'
    : `${flight} workstream${flight === 1 ? '' : 's'} running.`;
  const firePart = hot ? 'Something needs urgent attention.' : 'Nothing on fire.';

  return `${waitingPart} ${flightPart} ${firePart}`;
}
