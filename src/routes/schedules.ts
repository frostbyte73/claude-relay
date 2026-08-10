import type { Server } from '../server.js';
import type { SchedulesStore, CreateScheduleInput, ScheduleUpdate } from '../schedules/schedules-store.js';
import { validateCronExpr, type Scheduler } from '../schedules/scheduler.js';
import type { Trigger, What } from '../schedules/types.js';
import type { TokenStatus } from '../schedules/token-scheduler.js';
import { readJsonBody } from './util.js';

// Rejects a schedule/patch before it ever reaches store.create()/update() — an unvalidated
// cron expr persisted to disk gets re-armed by scheduler.start() on every daemon restart,
// so a bad pattern here must fail the request, not the daemon.
function validateTrigger(trigger: Trigger): string | null {
  if (trigger.kind === 'cron') {
    if (typeof trigger.expr !== 'string' || !trigger.expr.trim()) return 'trigger.expr is required for cron triggers';
    const error = validateCronExpr(trigger.expr, trigger.tz);
    return error ? `invalid cron expression: ${error}` : null;
  }
  if (trigger.kind === 'once') {
    if (typeof trigger.at !== 'number' || !Number.isFinite(trigger.at)) return 'trigger.at (epoch ms) is required for once triggers';
    if (trigger.at <= Date.now()) return 'trigger.at must be in the future';
    return null;
  }
  if (trigger.kind === 'event') {
    if (typeof trigger.descriptor !== 'string' || !trigger.descriptor.trim()) return 'trigger.descriptor is required for event triggers';
    return null;
  }
  if (trigger.kind === 'token-opportunistic') {
    const { debounceMs } = trigger;
    if (debounceMs !== undefined && (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0)) {
      return 'trigger.debounceMs must be a non-negative number of milliseconds';
    }
    return null;
  }
  return 'trigger.kind must be "cron", "once", "event", or "token-opportunistic"';
}

// A kind-less `what` is the legacy skill shape (normalized on store write). Prompt and script
// both require a cwd so the scheduler never dispatches a job into the daemon's own checkout.
// Exported for tests (see tests/unit/schedules-native.test.ts).
export function validateWhat(what: What): string | null {
  if (!what || typeof what !== 'object') return 'what is required';
  const kind = (what as { kind?: string }).kind ?? 'skill';
  if (kind === 'skill') {
    const w = what as Extract<What, { kind: 'skill' }>;
    if (typeof w.skill !== 'string' || !w.skill.trim()) return 'what.skill is required for skill schedules';
    return null;
  }
  if (kind === 'prompt') {
    const w = what as Extract<What, { kind: 'prompt' }>;
    if (typeof w.prompt !== 'string' || !w.prompt.trim()) return 'what.prompt is required for prompt schedules';
    if (typeof w.cwd !== 'string' || !w.cwd.trim()) return 'what.cwd is required for prompt schedules';
    return null;
  }
  if (kind === 'script') {
    const w = what as Extract<What, { kind: 'script' }>;
    if (typeof w.script !== 'string' || !w.script.trim()) return 'what.script is required for script schedules';
    if (typeof w.cwd !== 'string' || !w.cwd.trim()) return 'what.cwd is required for script schedules';
    return null;
  }
  if (kind === 'native') {
    const w = what as Extract<What, { kind: 'native' }>;
    if (typeof w.handler !== 'string' || !w.handler.trim()) return 'what.handler is required for native schedules';
    return null;
  }
  return 'what.kind must be "skill", "prompt", "script", or "native"';
}

export interface SchedulesRoutesDeps {
  store: SchedulesStore;
  scheduler: Scheduler;
  // Wired to the daemon's `notifyAll`. Fired with `{type:'schedules_changed'}` on any
  // create/update/delete/duplicate/pause of a schedule (list-shape change, not per-run).
  notify?: (message: unknown) => void;
  // Live token-headroom status for a token-opportunistic schedule, attached per-record on GET
  // (like `nextRunAt`). Wired to `TokenScheduler.describe`; token schedules have no clock nextRunAt.
  tokenStatus?: (scheduleId: string) => TokenStatus;
}

function idFromUrl(url: string | undefined, suffix: string): string | null {
  const m = (url ?? '').match(new RegExp(`^/api/schedules/([\\w-]+)${suffix}$`));
  return m ? m[1]! : null;
}

// ScheduleUpdate's allowed keys. Filtering the request body to this set before it reaches
// store.update's `{...cur, ...patch}` spread stops a client from smuggling in `builtin`
// (would flag a user schedule undeletable and let its script bypass assertKnownCwd) or
// `id`/`createdAt` (would desync the store's id-keyed map / persisted metadata).
const SCHEDULE_UPDATE_KEYS = ['name', 'enabled', 'trigger', 'what', 'guards', 'routing'] as const;

function pickScheduleUpdate(body: Record<string, unknown>): ScheduleUpdate {
  const patch: ScheduleUpdate = {};
  for (const key of SCHEDULE_UPDATE_KEYS) {
    if (key in body) (patch as Record<string, unknown>)[key] = body[key];
  }
  return patch;
}

export function registerSchedulesRoutes(server: Server, deps: SchedulesRoutesDeps): void {
  const { store, scheduler } = deps;
  const notifyChanged = () => deps.notify?.({ type: 'schedules_changed' });

  server.route('GET', '/api/schedules', (_req, res) => {
    const schedules = store.list().map((s) => ({
      ...s,
      nextRunAt: scheduler.nextRunAt(s.id),
      ...(s.trigger.kind === 'token-opportunistic' && deps.tokenStatus ? { tokenStatus: deps.tokenStatus(s.id) } : {}),
    }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schedules }));
  });

  server.route('POST', '/api/schedules', async (req, res) => {
    const body = await readJsonBody<Partial<CreateScheduleInput>>(req);
    if (!body || typeof body.name !== 'string' || !body.name.trim() || !body.trigger || !body.what) {
      res.statusCode = 400; res.end('name, trigger, and what are required'); return;
    }
    const triggerError = validateTrigger(body.trigger);
    if (triggerError) { res.statusCode = 400; res.end(triggerError); return; }
    const whatError = validateWhat(body.what);
    if (whatError) { res.statusCode = 400; res.end(whatError); return; }
    const schedule = store.create({
      name: body.name.trim(),
      enabled: body.enabled ?? true,
      trigger: body.trigger,
      what: body.what,
      guards: body.guards ?? [],
      routing: body.routing ?? {},
    });
    scheduler.onScheduleChanged(schedule.id);
    notifyChanged();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schedule }));
  });

  server.route('PATCH', '/api/schedules/:id', async (req, res) => {
    const id = idFromUrl(req.url, '');
    if (!id) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (!body) { res.statusCode = 400; res.end('invalid json'); return; }
    const patch = pickScheduleUpdate(body);
    if (patch.trigger) {
      const triggerError = validateTrigger(patch.trigger);
      if (triggerError) { res.statusCode = 400; res.end(triggerError); return; }
    }
    if (patch.what) {
      const whatError = validateWhat(patch.what);
      if (whatError) { res.statusCode = 400; res.end(whatError); return; }
    }
    const schedule = store.update(id, patch);
    if (!schedule) { res.statusCode = 404; res.end('schedule not found'); return; }
    scheduler.onScheduleChanged(id);
    notifyChanged();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schedule }));
  });

  server.route('DELETE', '/api/schedules/:id', (req, res) => {
    const id = idFromUrl(req.url, '');
    if (!id) { res.statusCode = 404; res.end('not found'); return; }
    const existing = store.get(id);
    if (existing?.builtin) {
      res.statusCode = 409;
      res.end('builtin schedule cannot be deleted (edit its timing/enabled state instead)');
      return;
    }
    const removed = store.remove(id);
    if (!removed) { res.statusCode = 404; res.end('schedule not found'); return; }
    scheduler.onScheduleDeleted(id);
    notifyChanged();
    res.statusCode = 204;
    res.end();
  });

  server.route('POST', '/api/schedules/:id/run-now', async (req, res) => {
    const id = idFromUrl(req.url, '/run-now');
    if (!id || !store.get(id)) { res.statusCode = 404; res.end('schedule not found'); return; }
    const run = await scheduler.runNow(id);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ run }));
  });

  server.route('POST', '/api/schedules/:id/pause', (req, res) => {
    const id = idFromUrl(req.url, '/pause');
    if (!id) { res.statusCode = 404; res.end('not found'); return; }
    const schedule = store.setEnabled(id, false);
    if (!schedule) { res.statusCode = 404; res.end('schedule not found'); return; }
    scheduler.onScheduleChanged(id);
    notifyChanged();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schedule }));
  });

  server.route('POST', '/api/schedules/:id/duplicate', (req, res) => {
    const id = idFromUrl(req.url, '/duplicate');
    if (!id) { res.statusCode = 404; res.end('not found'); return; }
    const schedule = store.duplicate(id);
    if (!schedule) { res.statusCode = 404; res.end('schedule not found'); return; }
    scheduler.onScheduleChanged(schedule.id);
    notifyChanged();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schedule }));
  });

  server.route('GET', '/api/schedules/:id/runs', (req, res) => {
    const id = idFromUrl(req.url, '/runs');
    if (!id || !store.get(id)) { res.statusCode = 404; res.end('schedule not found'); return; }
    const url = new URL(req.url ?? '', 'http://internal');
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runs: store.listRuns(id, limit) }));
  });

  // Not in the original route list but required to make `routing.github.approvalBeforePosting`
  // real rather than a dead-end: executes a drafted, pending-approval GitHub post.
  server.route('POST', '/api/schedules/:id/runs/:runId/approve-github', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/schedules\/([\w-]+)\/runs\/([\w-]+)\/approve-github$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const runId = m[2]!;
    try {
      const run = await scheduler.approveGithubPost(runId);
      if (!run) { res.statusCode = 404; res.end('run not found or not pending approval'); return; }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ run }));
    } catch (e) {
      res.statusCode = 500; res.end(`error: ${(e as Error).message}`);
    }
  });
}
