import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import type { JobQueue } from '../work/work-queue.js';
import type { WorkEngine } from '../work/engine.js';
import type { JobRecord, OrchestratedStep, Step } from '../work/work-types.js';
import type { PrWatcher } from '../integrations/pr-watcher.js';
import type { Scheduler } from '../schedules/scheduler.js';
import type { SessionStore } from '../session/session-store.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import { readJsonBody, readJsonObject } from './util.js';
import { serializeJob } from '../work/job-liveness.js';
import { readJobEvents } from '../storage/job-event-log.js';
import { parseDraftCalls } from '../work/write-draft.js';
import type { DraftDecisionResult } from '../work/write-draft-runner.js';

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

// Every orchestrated-step route 404s the same way for a missing job/step or a step that
// isn't type 'orchestrated' — message/gate/mark-resolved only make sense for a controller-
// owned step.
//
// A terminated job is refused here too. terminateJobResources closes the job's sessions and
// archives its worktrees but leaves each step's own state untouched, so an abandoned job's step
// still reads non-terminal — and delivering to it resumes the controller, which respawns the
// session that was just closed. `failed` is NOT terminal: it's a halt the user is expected to
// talk the step out of. (A deleted job leaves the queue entirely, so the lookup above misses.)
function orchestratedStep(jobQueue: JobQueue, jobId: string, stepId: string): OrchestratedStep | undefined {
  const job = jobQueue.get(jobId);
  if (!job || job.state === 'abandoned' || job.state === 'done') return undefined;
  const step = job.steps.find((s) => s.id === stepId);
  return step?.type === 'orchestrated' ? step : undefined;
}

// Same terminated-job guard as orchestratedStep, but not restricted to type 'orchestrated' —
// an ActionStep raises its own draft too (raisedBy: {kind:'step'}), so the accept/revise/deny
// routes need to find either step kind, not just a controller-owned one.
function liveStep(jobQueue: JobQueue, jobId: string, stepId: string): Step | undefined {
  const job = jobQueue.get(jobId);
  if (!job || job.state === 'abandoned' || job.state === 'done') return undefined;
  return job.steps.find((s) => s.id === stepId);
}

// Maps a WorkEngine draft-decision outcome onto an HTTP response: 200 + body on success,
// otherwise the reason as plain text under `result.status` — 404 when the draftId matches
// nothing (stale card, typo, wrong job: refresh and look again), 409 when it matches a draft
// that's already been decided or a step that's already terminal (someone/something else got
// there first: retrying this exact decision won't help). Defaults to 409 for the handful of
// reasons that don't set `status` explicitly (all of them are state conflicts, not missing
// resources). Shared by the three accept/revise/deny routes so they answer refusals identically.
function respondDraftDecision(res: ServerResponse, result: DraftDecisionResult): void {
  if (!result.ok) { res.statusCode = result.status ?? 409; res.end(result.reason); return; }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

// One handler for all three verbs — draftId is already resolved by the route's regex, so
// there is no "find the pending draft" step left (a step can hold several at once, one per
// live dispatch, so guessing which one the PWA means is not safe).
async function handleDraftDecision(
  engine: WorkEngine, req: IncomingMessage, res: ServerResponse,
  jobId: string, stepId: string, draftId: string, verb: 'accept' | 'revise' | 'deny',
): Promise<void> {
  const payload = await readJsonObject<{ calls?: unknown; feedback?: unknown; reason?: unknown }>(req, res);
  if (!payload) return;

  if (verb === 'accept') {
    // The user's (possibly edited) calls are a second untrusted boundary, same as the
    // session's own submit_write_draft payload — reuse the one validator rather than trusting
    // shape here and letting acceptDraft's own field-pick rebuild silently produce an
    // unconsumable pin (neither `bash` nor `tool`, or both).
    // `allowSkip`: this boundary — and only this one — carries the user's per-call verdict.
    const calls = parseDraftCalls(payload.calls, { allowSkip: true });
    if (!calls) {
      res.statusCode = 400;
      res.end('calls must be a non-empty array, each element with exactly one of '
        + '`bash` (string) or `tool: {name: string, args: object}`');
      return;
    }
    respondDraftDecision(res, await engine.acceptDraft(jobId, stepId, draftId, calls));
  } else if (verb === 'revise') {
    if (typeof payload.feedback !== 'string' || !payload.feedback.trim()) {
      res.statusCode = 400; res.end('feedback required'); return;
    }
    respondDraftDecision(res, engine.reviseDraft(jobId, stepId, draftId, payload.feedback));
  } else {
    if (typeof payload.reason !== 'string' || !payload.reason.trim()) {
      res.statusCode = 400; res.end('reason required'); return;
    }
    respondDraftDecision(res, engine.denyDraft(jobId, stepId, draftId, payload.reason));
  }
}

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
    const payload = await readJsonObject<{ title?: string; description?: string; externalUrl?: string }>(req, res);
    if (!payload) return;
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
    const payload = await readJsonObject<{ gate?: string; stepId?: string; note?: string }>(req, res);
    if (!payload) return;
    try {
      switch (payload.gate) {
        case 'plan':
          engine.onPlanApproved(id);
          break;
        case 'wait':
          if (!payload.stepId) { res.statusCode = 400; res.end('stepId required'); return; }
          engine.resumeWait(id, payload.stepId, payload.note);
          break;
        default: res.statusCode = 400; res.end('gate must be plan|wait'); return;
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
    const payload = await readJsonObject<{ gate?: string; stepId?: string; feedback?: string }>(req, res);
    if (!payload) return;
    switch (payload.gate) {
      case 'plan':
        if (typeof payload.feedback !== 'string' || !payload.feedback.trim()) { res.statusCode = 400; res.end('feedback required'); return; }
        engine.onPlanRejected(id, payload.feedback);
        break;
      default: res.statusCode = 400; res.end('gate must be plan'); return;
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
    const payload = await readJsonObject<{ feedback?: string }>(req, res);
    if (!payload) return;
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

  // `feedback` is optional: with it, the discarded amendment goes back to the orchestrator as a
  // rejected iteration; without it, the amendment is simply dropped.
  server.route('POST', '/api/work/jobs/:id/reconciliation/discard', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/reconciliation\/discard$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonBody<{ feedback?: unknown }>(req);
    const feedback = typeof payload?.feedback === 'string' ? payload.feedback : undefined;
    engine.onReconciliationDiscarded(m[1]!, feedback);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonObject<Record<string, unknown>>(req, res);
    if (!payload) return;
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
    const payload = await readJsonObject<Record<string, unknown>>(req, res);
    if (!payload) return;
    const EDITABLE_FIELDS = ['title', 'description', 'goal', 'inputs', 'action', 'workspace'];
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
    const payload = await readJsonObject<{ ids?: unknown }>(req, res, { allowEmpty: true });
    if (!payload) return;
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
    const payload = await readJsonObject<{ output?: string }>(req, res, { allowEmpty: true });
    if (!payload) return;
    // A user resolving an orchestrated step is a force-close, not the controller reporting that
    // the work landed — route it to markStepResolved, which keeps the worktree (it may still
    // hold uncommitted work on an unpushed branch). Archiving is reserved for the controller's
    // own resolve move. The type is read directly rather than through orchestratedStep() so a
    // terminated job answers 404 here instead of falling through to the action-step path.
    const step = jobQueue.get(m[1]!)?.steps.find((s) => s.id === m[2]!);
    if (step?.type === 'orchestrated') {
      if (!orchestratedStep(jobQueue, m[1]!, m[2]!)) { res.statusCode = 404; res.end('not found'); return; }
      engine.markStepResolved(m[1]!, m[2]!);
    } else {
      engine.onStepResolved(m[1]!, m[2]!, payload);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  // `note` is optional — the user's account of why the last attempt was wrong, carried to the
  // respawned session (which is a cold spawn and knows nothing else about the attempt it
  // replaces). A bare `{}` is still a plain retry.
  server.route('POST', '/api/work/jobs/:id/steps/:stepId/retry', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/retry$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonObject<{ note?: unknown }>(req, res, { allowEmpty: true });
    if (!payload) return;
    if (payload.note !== undefined && typeof payload.note !== 'string') { res.statusCode = 400; res.end('note must be a string'); return; }
    try { engine.onStepRetry(m[1]!, m[2]!, payload.note as string | undefined); }
    catch (e) { res.statusCode = 400; res.end((e as Error).message); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ job: jobQueue.get(m[1]!) ?? null }));
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/message', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/message$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const [, jobId, stepId] = m;
    if (!orchestratedStep(jobQueue, jobId!, stepId!)) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonObject<{ body?: unknown }>(req, res);
    if (!payload) return;
    if (typeof payload.body !== 'string' || !payload.body.trim()) { res.statusCode = 400; res.end('body (non-empty string) required'); return; }
    engine.pushStepInbox(jobId!, stepId!, { kind: 'user-message', body: payload.body });
    res.statusCode = 204; res.end();
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/gate', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/gate$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const [, jobId, stepId] = m;
    if (!orchestratedStep(jobQueue, jobId!, stepId!)) { res.statusCode = 404; res.end('not found'); return; }
    const payload = await readJsonObject<{ approved?: unknown; feedback?: unknown }>(req, res);
    if (!payload) return;
    if (typeof payload.approved !== 'boolean') { res.statusCode = 400; res.end('approved (boolean) required'); return; }
    if (payload.feedback !== undefined && typeof payload.feedback !== 'string') { res.statusCode = 400; res.end('feedback must be a string'); return; }
    engine.resolveStepGate(jobId!, stepId!, payload.approved, payload.feedback);
    res.statusCode = 204; res.end();
  });

  server.route('POST', '/api/work/jobs/:id/steps/:stepId/mark-resolved', (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/mark-resolved$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const [, jobId, stepId] = m;
    if (!orchestratedStep(jobQueue, jobId!, stepId!)) { res.statusCode = 404; res.end('not found'); return; }
    engine.markStepResolved(jobId!, stepId!);
    res.statusCode = 204; res.end();
  });

  // A step can hold several drafts at once (two live dispatches under one controller can each
  // be parked) — draftId is what disambiguates which one this decision is about, not "the"
  // pending draft on the step.
  server.route('POST', '/api/work/jobs/:id/steps/:stepId/drafts/:draftId/:verb', async (req, res) => {
    const m = (req.url ?? '').match(
      /^\/api\/work\/jobs\/([\w-]+)\/steps\/([\w-]+)\/drafts\/([\w-]+)\/(accept|revise|deny)$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const [, jobId, stepId, draftId, verb] = m;
    if (!liveStep(jobQueue, jobId!, stepId!)) { res.statusCode = 404; res.end('not found'); return; }
    await handleDraftDecision(engine, req, res, jobId!, stepId!, draftId!, verb as 'accept' | 'revise' | 'deny');
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
