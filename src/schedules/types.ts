// Shared data shapes for the Schedules subsystem. Kept dependency-free (no imports from
// src/work or src/integrations) so this cluster can be unit-tested and wired independently.

export type Trigger =
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'once'; at: number; tz?: string }
  | { kind: 'event'; descriptor: string }
  // Fired by token headroom, not a clock: the TokenScheduler (token-scheduler.ts) launches these
  // opportunistically when 5h/7d usage leaves genuine spare capacity. Carries no schedule of its
  // own — the daemon's usage poller drives evaluation. A usage-threshold guard can still ride
  // alongside as a hard ceiling.
  | { kind: 'token-opportunistic' };

export type Guard =
  | { kind: 'usage-threshold'; window: '5h' | '7d'; op: '>' | '>='; value: number }
  | { kind: 'no-repo-changes'; repo?: string };

// A schedule runs one of four things, discriminated by `kind`:
//   - 'skill'  — a named action from the catalog (the original, kind-less shape)
//   - 'prompt' — free-text instructions dispatched as a job in `cwd`
//   - 'script' — a shell script dispatched as a job in `cwd`
//   - 'native' — an in-daemon handler (no job dispatch, no cwd) for builtin schedules
export type What =
  | { kind: 'skill'; skill: string; repos?: string[]; scope?: string; model?: string; args?: Record<string, unknown> }
  | { kind: 'prompt'; prompt: string; cwd: string; model?: string }
  | { kind: 'script'; script: string; cwd: string; model?: string; args?: Record<string, unknown> }
  | { kind: 'native'; handler: string };

// Rows persisted before the discriminated union existed have no `kind` — a bare
// {skill, ...} is a skill schedule. Applied on read (SchedulesStore) so nothing
// downstream has to special-case the legacy shape.
type LegacyWhat = { skill: string; repos?: string[]; scope?: string; model?: string; args?: Record<string, unknown> };
export function normalizeWhat(what: What | LegacyWhat): What {
  return 'kind' in what ? what : { kind: 'skill', ...what };
}

// The working directory a `what` targets: a skill's first repo, a prompt/script's cwd,
// or undefined for native (no job dispatch, so no worktree to point at).
export function whatCwd(what: What): string | undefined {
  if (what.kind === 'skill') return what.repos?.[0];
  if (what.kind === 'native') return undefined;
  return what.cwd;
}

// Short display/label token for a run — the skill name, the handler name, or the literal kind.
export function whatLabel(what: What): string {
  if (what.kind === 'skill') return what.skill;
  if (what.kind === 'native') return what.handler;
  return what.kind;
}

export interface Routing {
  cockpit?: { confidenceThreshold?: number };
  slack?: { summaryShape?: 'digest' | 'per-finding' };
  github?: { approvalBeforePosting: boolean };
}

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  what: What;
  guards: Guard[];
  routing: Routing;
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}

// One finding a run surfaced. `confidence` (0-1) is what `routing.cockpit.confidenceThreshold`
// filters against and what per-finding Slack summaries iterate over.
export interface RunFinding {
  title: string;
  body?: string;
  confidence?: number;
}

export interface RunVerdict {
  summary: string;
  confidence?: number;
  findings?: RunFinding[];
}

// Per-channel delivery outcome, attached to a run once routing has been evaluated
// (see routing.ts). Absent entries mean that channel wasn't configured on the schedule.
export interface RunDelivery {
  cockpit?: { surfaced: boolean };
  slack?: { status: 'sent' | 'skipped' | 'failed'; reason?: string };
  github?: {
    status: 'posted' | 'pending-approval' | 'skipped' | 'failed';
    reason?: string;
    repo?: string;
    body?: string;
    url?: string;
  };
}

// NOTE: 'running' is an addition beyond the literal `ok|error|skipped` outcome union in the
// spec — needed so an in-progress run has a real persisted state between the `startRun` and
// `completeRun` calls (the WS contract fires on both start and finish/skip of the same run id).
export type RunOutcome = 'running' | 'ok' | 'error' | 'skipped';

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  startedAt: number;
  finishedAt?: number;
  outcome: RunOutcome;
  verdict?: RunVerdict;
  skipReason?: string;
  refs?: { jobId?: string; sessionId?: string };
  delivery?: RunDelivery;
}
