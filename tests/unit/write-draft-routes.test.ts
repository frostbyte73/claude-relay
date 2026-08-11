import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerJobsRoutes } from '../../src/routes/jobs.js';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { ActionStep, JobRecord } from '../../src/work/work-types.js';
import { freePort } from '../e2e/harness/port.js';

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const actionRegistry = {
  getAction() { return { frontmatter: { outpost: { runner: 'claude' } }, gated: {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  } }; },
  gatedFor() { return { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] }; },
  listActions() { return []; },
} as never;

// Mirrors engine-gate.test.ts's harness (same makeEngine/actionStep shape) but wired through
// the real HTTP surface — these tests exercise routes/jobs.ts's own request handling
// (payload validation, status mapping), not just the engine functions it calls.
function harness(provision: () => Promise<{ path: string | null }> = async () => ({ path: '/tmp' })) {
  const dir = mkdtempSync(join(tmpdir(), 'draft-routes-'));
  const queue = new JobQueue(dir);
  const resumed: string[] = [];
  let provisionCalls = 0;
  const engine = new WorkEngine({
    queue,
    sessionManager: {
      spawnDetached() {}, send() {}, isWorking() { return false; },
      sendOrResume(sessionId: string) { resumed.push(sessionId); },
      close: async () => {},
    } as never,
    worktreeManager: { provision: async () => { provisionCalls++; return provision(); } } as never,
    linearWriter: { setState: async () => undefined } as never,
    actionsStore: {} as never,
    actionRegistry,
    jobsDir: join(dir, 'jobs'),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });
  const step: ActionStep = {
    id: 'g1', type: 'action', title: 'g1', description: 'd', goal: 'g',
    action: 'write.linear-issue', inputs: {}, state: 'running',
    workspace: { kind: 'none' }, createdAt: 1000, updatedAt: 1000, sessionId: 'sess-1',
  };
  const job: JobRecord = {
    id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
    steps: [step], createdAt: 1000, updatedAt: 1000,
  };
  queue.upsert(job);
  return { queue, engine, resumed, jobsDir: join(dir, 'jobs'), provisionCalls: () => provisionCalls };
}

async function startServer(h: ReturnType<typeof harness>): Promise<number> {
  const port = await freePort();
  server = new Server({ httpPort: port, heartbeatMs: 0 });
  registerJobsRoutes(server, {
    jobQueue: h.queue, engine: h.engine,
    prWatcher: {} as never, scheduler: {} as never, sessionStore: {} as never,
    worktreeManager: {} as never, jobsDir: h.jobsDir,
  });
  await server.listen();
  return port;
}

const ORIGINAL_CALL = { id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'Bug', teamId: 'T1' } } };

describe('POST .../drafts/:draftId/accept', () => {
  it('pins the EDITED payload from the request, not the stored draft', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    const port = await startServer(h);

    const edited = [{ id: 'c1', tool: { name: 'mcp__linear__save_issue', args: { title: 'Edited', teamId: 'T1' } } }];
    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/accept`, { calls: edited });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(h.engine.pinFor('sess-1', 'mcp__linear__save_issue', { title: 'Edited', teamId: 'T1' })?.id).toBe('c1');
    expect(h.engine.pinFor('sess-1', 'mcp__linear__save_issue', { title: 'Bug', teamId: 'T1' })).toBeUndefined();
    expect(h.resumed).toContain('sess-1');
  });

  it('rejects a malformed calls payload with a 4xx, without parking or silently ignoring it', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    const port = await startServer(h);

    // Neither `bash` nor `tool` — parseDraftCalls's exactly-one check must catch this before
    // it ever reaches acceptDraft's own field-pick rebuild.
    const malformed = [{ id: 'c1', label: 'nothing pinned here' }];
    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/accept`, { calls: malformed });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const s = h.queue.get('job-1')!.steps[0]!;
    expect(s.state).toBe('gate_pending_approval'); // untouched — not parked, not accepted
    expect(s.drafts![0]!.approvedAt).toBeUndefined();
    expect(h.resumed).toEqual([]);
  });

  it('rejects a non-array calls payload with a 4xx', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    const port = await startServer(h);

    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/accept`, { calls: 'not-an-array' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(h.queue.get('job-1')!.steps[0]!.state).toBe('gate_pending_approval');
  });

  it('a refused accept (unknown draftId) answers 404, not silent success', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const port = await startServer(h);

    const res = await post(port, '/api/work/jobs/job-1/steps/g1/drafts/no-such-draft/accept', { calls: [ORIGINAL_CALL] });

    expect(res.status).toBe(404);
    expect(h.resumed).toEqual([]);
  });

  it('accepting a draft twice: the second call answers 409 (already decided), not 404', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    const port = await startServer(h);

    const first = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/accept`, { calls: [ORIGINAL_CALL] });
    expect(first.status).toBe(200);

    const second = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/accept`, { calls: [ORIGINAL_CALL] });
    expect(second.status).toBe(409);
    expect(second.body).toContain('already decided');
  });
});

describe('POST .../drafts/:draftId/revise', () => {
  it('a refused revise (unknown draftId) answers 404', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const port = await startServer(h);

    const res = await post(port, '/api/work/jobs/job-1/steps/g1/drafts/no-such-draft/revise', { feedback: 'shorter please' });

    expect(res.status).toBe(404);
  });

  it('empty feedback is refused at the boundary with a 4xx', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    const port = await startServer(h);

    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/revise`, { feedback: '   ' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // IMPORTANT 1 fix-round-1 regression: settleOrchestratedStep (the thing that prunes pending
  // drafts on settle) is orchestrated-only and early-returns for an ActionStep, so a failed
  // ActionStep keeps its pending draft — the terminal-step check in reviseDraft is the ONLY
  // thing standing between a stale "Propose changes" click and reviving a dead step: without
  // it, `state` flips back to 'running' and resumeRaiser re-provisions the workspace.
  it('revise on a failed ActionStep with a pending draft is refused, not resurrected', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    h.engine.onStepFailed('job-1', 'g1', 'provisioning blew up', { journal: false });
    // The draft survives the failure — nothing prunes an ActionStep's drafts on settle.
    expect(h.queue.get('job-1')!.steps[0]!.drafts).toHaveLength(1);
    const port = await startServer(h);

    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/revise`, { feedback: 'shorter please' });

    expect(res.status).toBe(409);
    expect(res.body).toContain('already terminal');
    const s = h.queue.get('job-1')!.steps[0]!;
    expect(s.state).not.toBe('running'); // not flipped back to life
    expect(s.failure).toBeDefined();     // still failed
    expect(h.provisionCalls()).toBe(0);  // never re-provisioned
    expect(h.resumed).toEqual([]);
  });
});

describe('POST .../drafts/:draftId/deny', () => {
  it('a refused deny (unknown draftId) answers 404', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const port = await startServer(h);

    const res = await post(port, '/api/work/jobs/job-1/steps/g1/drafts/no-such-draft/deny', { reason: 'not needed' });

    expect(res.status).toBe(404);
  });

  it('a successful deny declines the step and answers 200', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    const port = await startServer(h);

    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/deny`, { reason: 'not needed' });

    expect(res.status).toBe(200);
    expect(h.queue.get('job-1')!.steps[0]!.state).toBe('declined');
  });

  // Same IMPORTANT 1 regression as revise, for deny: without the terminal-step check, denying
  // a draft on an already-failed ActionStep would set `state:'declined'` on top of `.failure`
  // (two terminal markers at once) and journal a `denied` lesson against the orchestrator for
  // a step that actually died of a provisioning error.
  it('deny on a failed ActionStep with a pending draft is refused, not double-terminalized', async () => {
    const h = harness();
    h.engine.onWriteDraftReady('job-1', 'g1', {
      action: 'write.linear-issue', raisedBy: { kind: 'step' }, summary: 's', calls: [ORIGINAL_CALL],
    });
    const draftId = h.queue.get('job-1')!.steps[0]!.drafts![0]!.id;
    h.engine.onStepFailed('job-1', 'g1', 'provisioning blew up', { journal: false });
    const port = await startServer(h);

    const res = await post(port, `/api/work/jobs/job-1/steps/g1/drafts/${draftId}/deny`, { reason: 'not needed' });

    expect(res.status).toBe(409);
    expect(res.body).toContain('already terminal');
    const s = h.queue.get('job-1')!.steps[0]!;
    expect(s.state).not.toBe('declined');
    expect(s.drafts).toHaveLength(1); // not dropped by a refused deny
  });
});

describe('/approve and /reject: the gate case is gone', () => {
  it('/approve refuses gate:"gate" now that accept/revise moved to their own draft routes', async () => {
    const h = harness();
    const port = await startServer(h);
    const res = await post(port, '/api/work/jobs/job-1/approve', { gate: 'gate', stepId: 'g1' });
    expect(res.status).toBe(400);
    expect(res.body).toContain('plan|wait');
  });

  it('/reject refuses gate:"gate" now that accept/revise moved to their own draft routes', async () => {
    const h = harness();
    const port = await startServer(h);
    const res = await post(port, '/api/work/jobs/job-1/reject', { gate: 'gate', stepId: 'g1', feedback: 'no' });
    expect(res.status).toBe(400);
    expect(res.body).toBe('gate must be plan');
  });
});
