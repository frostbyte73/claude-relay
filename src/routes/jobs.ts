import type { Server } from '../server.js';
import type { JobQueue } from '../work/work-queue.js';
import type { WorkEngine } from '../work/engine.js';
import type { JobRecord } from '../work/work-types.js';
import type { PrWatcher } from '../integrations/pr-watcher.js';
import type { Scheduler } from '../schedules/scheduler.js';
import type { SessionStore } from '../session/session-store.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import { readBody, readJsonBody } from './util.js';
import { serializeJob } from '../work/job-liveness.js';
import { readJobEvents } from '../storage/job-event-log.js';

export interface JobsRoutesDeps {
  jobQueue: JobQueue;
  engine: WorkEngine;
  prWatcher: PrWatcher;
  scheduler: Scheduler;
  sessionStore: SessionStore;
  worktreeManager: WorktreeManager;
  jobsDir: string;
}

const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 5000;

export function registerJobsRoutes(server: Server, deps: JobsRoutesDeps): void {
  const { jobQueue, engine, prWatcher, scheduler, sessionStore, worktreeManager, jobsDir } = deps;

  const serialize = (j: JobRecord) =>
    serializeJob(j, (id) => engine.isSessionWorking(id), (job) => engine.launchStatusFor(job));

  server.route('GET', '/api/work/jobs', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    const jobs = jobQueue.list().map(serialize);
    res.end(JSON.stringify({ jobs, lastLinearSyncAt: jobQueue.lastLinearSyncAt ?? null }));
  });

  server.route('GET', '/api/work/jobs/:id', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const j = jobQueue.get(m[1]!);
    if (!j) { res.statusCode = 404; res.end('not found'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: serialize(j) }));
  });

  // Whole timeline from the spill log — the JobRecord itself only keeps the last 50.
  server.route('GET', '/api/work/jobs/:id/events', (req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const m = path.match(/^\/api\/work\/jobs\/([\w-]+)\/events$/);
    if (!m || !jobQueue.get(m[1]!)) { res.statusCode = 404; res.end('not found'); return; }
    const url = new URL(req.url ?? '', 'http://internal');
    const raw = Number(url.searchParams.get('limit') ?? DEFAULT_EVENT_LIMIT);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_EVENT_LIMIT) : DEFAULT_EVENT_LIMIT;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ events: readJobEvents(jobsDir, m[1]!, limit) }));
  });

  server.route('POST', '/api/work/jobs', async (req, res) => {
    const body = await readBody(req);
    let payload: { title?: string; description?: string; externalUrl?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (typeof payload.title !== 'string' || !payload.title.trim()) { res.statusCode = 400; res.end('title required'); return; }
    const j = engine.createJob({
      source: 'manual',
      title: payload.title.trim(),
      description: payload.description ?? '',
      externalRef: payload.externalUrl ? { url: payload.externalUrl } : undefined,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: j }));
  });

  // "Promote to tracked": spin a manual job out of an interactive session, pre-filled
  // from its title/cwd/worktree and linked back via originSessionId. No session-history
  // migration beyond that link — the new job starts in the normal orchestrator flow.
  server.route('POST', '/api/work/jobs/from-session/:sessionId', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/from-session\/([\w-]+)$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sessionId = m[1]!;
    const found = sessionStore.findSession(sessionId);
    if (!found) { res.statusCode = 404; res.end('session not found'); return; }
    const wt = worktreeManager.get(sessionId);
    const descriptionLines = [
      `Promoted from session ${sessionId}.`,
      `cwd: ${found.cwd}`,
      ...(wt && !wt.archivedAt ? [`worktree: ${wt.worktreePath} (branch ${wt.branch} from ${wt.baseBranch})`] : []),
    ];
    const job = engine.createJob({
      source: 'manual',
      title: found.session.title || `Session ${sessionId.slice(0, 8)}`,
      description: descriptionLines.join('\n'),
    });
    jobQueue.mutate(job.id, (j) => ({ ...j, originSessionId: sessionId }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(job.id) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/approve', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/approve$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    const body = await readBody(req);
    let payload: { gate?: string; stepId?: string; note?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    try {
      switch (payload.gate) {
        case 'plan':
          engine.onPlanApproved(id);
          break;
        case 'wait':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          engine.resumeWait(id, payload.stepId, payload.note);
          break;
        case 'replies':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          engine.approveReplies(id, payload.stepId);
          break;
        case 'spec':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          engine.approveSpec(id, payload.stepId);
          break;
        case 'gate':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          engine.approveGate(id, payload.stepId);
          break;
        case 'merge':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          engine.mergePr(id, payload.stepId);
          break;
        case 'resolve-conflicts':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          await engine.resolveConflicts(id, payload.stepId);
          break;
        default: res.statusCode = 400; res.end('gate must be plan|wait|replies|spec|gate|merge|resolve-conflicts'); return;
      }
    } catch (e) {
      res.statusCode = 500; res.end(`error: ${(e as Error).message}`); return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(id) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/reject', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/reject$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    const body = await readBody(req);
    let payload: { gate?: string; stepId?: string; feedback?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    switch (payload.gate) {
      case 'plan':
        if (typeof payload.feedback !== 'string' || !payload.feedback.trim()) { res.statusCode = 400; res.end('feedback required'); return; }
        engine.onPlanRejected(id, payload.feedback);
        break;
      case 'replies':
        if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
        if (typeof payload.feedback !== 'string' || !payload.feedback.trim()) { res.statusCode = 400; res.end('feedback required'); return; }
        engine.rejectReplies(id, payload.stepId, payload.feedback);
        break;
      case 'spec':
        if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
        if (typeof payload.feedback !== 'string' || !payload.feedback.trim()) { res.statusCode = 400; res.end('feedback required'); return; }
        engine.rejectSpec(id, payload.stepId, payload.feedback);
        break;
      case 'gate':
        if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
        if (typeof payload.feedback !== 'string' || !payload.feedback.trim()) { res.statusCode = 400; res.end('feedback required'); return; }
        engine.rejectGate(id, payload.stepId, payload.feedback);
        break;
      case 'resolve-conflicts':
        if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
        engine.markConflictResolved(id, payload.stepId, { status: 'unresolvable', failure: payload.feedback?.trim() || 'user chose to resolve manually' });
        break;
      default: res.statusCode = 400; res.end('gate must be plan|replies|spec|gate|resolve-conflicts'); return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(id) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/abandon', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/abandon$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    try { await engine.abandonJob(m[1]!); }
    catch (e) { res.statusCode = 500; res.end(`abandon error: ${(e as Error).message}`); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/mark-done', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/mark-done$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    try { await engine.markJobDone(m[1]!); }
    catch (e) { res.statusCode = 500; res.end(`mark-done error: ${(e as Error).message}`); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('DELETE', '/api/work/jobs/:id', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const j = jobQueue.get(m[1]!);
    if (!j) { res.statusCode = 404; res.end('not found'); return; }
    if (j.source !== 'manual') { res.statusCode = 409; res.end('only manual jobs can be deleted'); return; }
    try { await engine.deleteJob(m[1]!); }
    catch (e) { res.statusCode = 500; res.end(`delete error: ${(e as Error).message}`); return; }
    res.statusCode = 204;
    res.end();
  });

  // Launch a queued step now: force-fires whatever's parked for that step under the
  // token-launch queue, bypassing both the headroom and slot gates. (The orchestrator
  // has no equivalent here — its "Launch orchestrator" button force-launches directly.)
  server.route('POST', '/api/work/jobs/:id/steps/:stepId/launch', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/launch$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const [, id, stepId] = m;
    const job = jobQueue.get(id!);
    if (!job || !job.steps.some((s) => s.id === stepId)) { res.statusCode = 404; res.end('not found'); return; }
    const launched = engine.launchNow(id!, stepId!);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ launched }));
  });

  server.route('POST', '/api/work/jobs/:id/priority', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/priority$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    if (!jobQueue.get(id)) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonBody<{ highPriority?: unknown }>(req);
    if (typeof payload?.highPriority !== 'boolean') { res.statusCode = 400; res.end('highPriority (boolean) required'); return; }
    engine.setHighPriority(id, payload.highPriority);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: serialize(jobQueue.get(id)!) }));
  });

  server.route('POST', '/api/work/jobs/:id/launch-orchestrator', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/launch-orchestrator$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonBody<{ context?: string }>(req);
    try { await engine.launchOrchestrator(m[1]!, payload?.context); }
    catch (e) { res.statusCode = 500; res.end(`launch error: ${(e as Error).message}`); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/replan', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/replan$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { feedback?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    engine.reopenOrchestrator(m[1]!, payload.feedback ?? '');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/reconciliation/apply', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/reconciliation\/apply$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    engine.onReconciliationApproved(m[1]!);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/reconciliation/discard', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/reconciliation\/discard$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    engine.onReconciliationDiscarded(m[1]!);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    const { afterStepId, ...stepFields } = payload;
    let step;
    try {
      step = engine.addStepManually(
        m[1]!,
        stepFields as never,
        typeof afterStepId === 'string' ? { afterStepId } : undefined,
      );
    } catch (e) {
      res.statusCode = 400;
      res.end((e as Error).message);
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ step }));
  });

  server.route('PATCH', '/api/work/jobs/:id/steps/:stepId', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    const EDITABLE_FIELDS = ['title', 'description', 'goal', 'approach', 'risks', 'inputs', 'action', 'workspace'];
    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) if (field in payload) patch[field] = payload[field];
    let ok: boolean;
    try { ok = engine.editStepManually(m[1]!, m[2]!, patch as never); }
    catch (e) { res.statusCode = 400; res.end((e as Error).message); return; }
    if (!ok) {
      res.statusCode = 409;
      res.end('step cannot be edited (already running, resolved, merged, or cancelled)');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/cancel', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/cancel$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const ok = engine.cancelStepManually(m[1]!, m[2]!);
    if (!ok) {
      res.statusCode = 409;
      res.end('step cannot be cancelled (already running, resolved, or merged)');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/reorder', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/reorder$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { ids?: unknown };
    try { payload = body ? JSON.parse(body) : {}; } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (!Array.isArray(payload.ids) || !payload.ids.every((x) => typeof x === 'string')) {
      res.statusCode = 400; res.end('body.ids must be string[]'); return;
    }
    const ok = engine.reorderSteps(m[1]!, payload.ids as string[]);
    if (!ok) {
      res.statusCode = 409;
      res.end('reorder rejected (ids mismatch or moves a started step)');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/resolve', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/resolve$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { output?: string };
    try { payload = body ? JSON.parse(body) : {}; } catch { res.statusCode = 400; res.end('invalid json'); return; }
    engine.onStepResolved(m[1]!, m[2]!, payload);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/retry', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/retry$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    try { engine.onStepRetry(m[1]!, m[2]!); }
    catch (e) { res.statusCode = 400; res.end((e as Error).message); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/tick', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/tick$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    void engine.tick(m[1]!);
    res.statusCode = 202; res.end();
  });

  server.route('POST', '/api/work/jobs/:id/rerun-latest', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/rerun-latest$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    let stepId: string | undefined;
    try { stepId = engine.rerunLatest(m[1]!); }
    catch (e) { res.statusCode = 400; res.end((e as Error).message); return; }
    res.statusCode = stepId ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ stepId: stepId ?? null, job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/reset', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/reset$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const ok = await engine.resetJob(m[1]!);
    res.statusCode = ok ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/comments', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/comments$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { kind?: 'replies'; file?: string; line?: number; body?: string; iterationId?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (typeof payload.body !== 'string' || !payload.body.length) { res.statusCode = 400; res.end('body required'); return; }
    if (payload.kind !== 'replies') { res.statusCode = 400; res.end('kind must be replies'); return; }
    const comment = engine.addReviewComment(m[1]!, m[2]!, {
      kind: payload.kind,
      author: 'user',
      body: payload.body,
      ...(payload.file ? { file: payload.file } : {}),
      ...(payload.line !== undefined ? { line: payload.line } : {}),
      ...(payload.iterationId ? { iterationId: payload.iterationId } : {}),
    });
    if (!comment) { res.statusCode = 404; res.end('not found / no iteration to attach'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ comment }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/comments/:commentId/resolve', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/comments\/([\w-]+)\/resolve$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    engine.resolveReviewComment(m[1]!, m[2]!, m[3]!);
    res.statusCode = 204; res.end();
  });

  server.route('POST', '/api/work/sync', async (_req, res) => {
    try {
      await scheduler.runNow('linear');
      await prWatcher.syncNow();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ lastLinearSyncAt: jobQueue.lastLinearSyncAt ?? null }));
    } catch (e) {
      res.statusCode = 502; res.end(`sync error: ${(e as Error).message}`);
    }
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/replies/resolve', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/replies\/resolve$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { commentId?: string; action?: 'approve' | 'ignore' | 'reject'; feedback?: string; body?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (!payload.commentId || !payload.action) { res.statusCode = 400; res.end('commentId, action required'); return; }
    if (!['approve','ignore','reject'].includes(payload.action)) { res.statusCode = 400; res.end('action must be approve|ignore|reject'); return; }
    try {
      engine.resolveReplyComment(m[1]!, m[2]!, payload.commentId, payload.action, payload.feedback, payload.body);
    } catch (e) { res.statusCode = 500; res.end(`resolve error: ${(e as Error).message}`); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/replies/regenerate', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/replies\/regenerate$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { commentId?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (!payload.commentId) { res.statusCode = 400; res.end('commentId required'); return; }
    const ok = engine.regenerateReply(m[1]!, m[2]!, payload.commentId);
    if (!ok) { res.statusCode = 404; res.end('job/step/comment not found or step merged'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/reactions', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/reactions$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { commentId?: string; content?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    const ALLOWED = ['THUMBS_UP','THUMBS_DOWN','LAUGH','HOORAY','CONFUSED','HEART','ROCKET','EYES'];
    if (!payload.commentId || !payload.content || !ALLOWED.includes(payload.content)) {
      res.statusCode = 400; res.end('commentId + content (' + ALLOWED.join('|') + ') required'); return;
    }
    engine.reactToComment(m[1]!, m[2]!, payload.commentId, payload.content);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/edits/enqueue', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/edits\/enqueue$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { commentId?: string; userNote?: string };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (!payload.commentId) { res.statusCode = 400; res.end('commentId required'); return; }
    engine.enqueueEdit(m[1]!, m[2]!, payload.commentId, payload.userNote);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/replies/lock', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/replies\/lock$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const body = await readBody(req);
    let payload: { commentId?: string; edited?: boolean };
    try { payload = JSON.parse(body); } catch { res.statusCode = 400; res.end('invalid json'); return; }
    if (!payload.commentId || typeof payload.edited !== 'boolean') { res.statusCode = 400; res.end('commentId + edited required'); return; }
    engine.setDraftUserEdited(m[1]!, m[2]!, payload.commentId, payload.edited);
    res.statusCode = 204; res.end();
  });

  server.route('POST', '/api/work/jobs/:id/sync', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/sync$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const id = m[1]!;
    if (!jobQueue.get(id)) { res.statusCode = 404; res.end('job not found'); return; }
    try {
      await prWatcher.syncJob(id);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ job: jobQueue.get(id) ?? null }));
    } catch (e) {
      res.statusCode = 502; res.end(`sync error: ${(e as Error).message}`);
    }
  });
}
