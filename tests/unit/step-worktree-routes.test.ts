import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '../../src/server.js';
import { registerGitRoutes } from '../../src/routes/git.js';
import { registerJobsRoutes } from '../../src/routes/jobs.js';
import { WorkEngine } from '../../src/work/engine.js';
import { JobQueue } from '../../src/work/work-queue.js';
import type { JobRecord, OrchestratedStep } from '../../src/work/work-types.js';
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'step-wt-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
  return dir;
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function jobRoutesHarness(jobState: JobRecord['state'], stepOver: Partial<OrchestratedStep> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'step-routes-'));
  const queue = new JobQueue(dir);
  const resumed: string[] = [];
  const archived: string[] = [];
  const engine = new WorkEngine({
    queue,
    sessionManager: {
      spawnDetached() {}, send() {}, isWorking() { return false; },
      sendOrResume(sessionId: string) { resumed.push(sessionId); },
      close: async () => {},
    } as never,
    worktreeManager: {
      provision: async () => ({ path: null }),
      get: (id: string) => ({ projectCwd: '/tmp/repo', worktreePath: `/tmp/wt/${id}`, branch: 'feat/x', baseBranch: 'main' }),
      archive: async (id: string) => { archived.push(id); },
    } as never,
    linearWriter: { setState: async () => undefined } as never,
    jobsDir: join(dir, 'jobs'), now: () => 1,
  });
  const step: OrchestratedStep = {
    id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
    controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    state: 'waiting', waitingOn: { reason: 'CI', events: ['ci'] },
    createdAt: 1, updatedAt: 1, sessionId: 'ctrl-sess', ...stepOver,
  } as OrchestratedStep;
  queue.upsert({
    id: 'job-1', source: 'manual', title: 't', description: 'd', state: jobState,
    steps: [step], createdAt: 1, updatedAt: 1,
  });
  return { queue, engine, resumed, archived, jobsDir: join(dir, 'jobs') };
}

// A step session runs under a freshly-minted sessionId while its worktree record is keyed by
// stepId, so a direct worktreeManager.get(sessionId) misses. /git/status and /git/finalize both
// resolve through engine.worktreeRecordForSession for exactly this reason; discard did not, so
// the PWA's Discard answered "only valid for active worktree sessions" on every step session.
describe('POST /api/sessions/:id/git/discard — step-keyed worktrees', () => {
  it('resolves a step session\'s worktree through the engine and discards in it', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'CHANGED\n');
    const record = { worktreePath: repo, projectCwd: repo, branch: 'feat/x', baseBranch: 'main' };
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerGitRoutes(server, {
      sessionStore: { findSession: () => undefined } as never,
      worktreeManager: { get: (key: string) => (key === 'step-1' ? record : undefined) } as never,
      engine: {
        worktreeRecordForSession: (sid: string) => (sid === 'sess-1' ? record : undefined),
      } as never,
      prWatcher: {} as never,
      preferencesStore: { getEditorCommand: () => undefined } as never,
    });
    await server.listen();

    const res = await post(port, '/api/sessions/sess-1/git/discard', {});
    expect(res.status).toBe(200);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
  });
});

// terminateJobResources closes the job's sessions and archives its worktrees but leaves the
// steps' own state alone — an abandoned job's step still reads `orchestrated` and non-terminal.
// A message delivered to it resumes the controller, and sendOrResume respawns the session that
// was just closed: a live Claude turn for a job the user threw away.
describe('POST /api/work/jobs/:id/steps/:stepId/message — terminated jobs', () => {
  it('refuses a step in an abandoned job, spawning nothing', async () => {
    const h = jobRoutesHarness('abandoned');
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerJobsRoutes(server, {
      jobQueue: h.queue, engine: h.engine,
      prWatcher: {} as never,
      prFilePatches: {} as never, scheduler: {} as never, sessionStore: {} as never,
      worktreeManager: {} as never, jobsDir: h.jobsDir,
    });
    await server.listen();

    const res = await post(port, '/api/work/jobs/job-1/steps/step-1/message', { body: 'still there?' });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.resumed).toEqual([]);
    expect((h.queue.get('job-1')!.steps[0] as OrchestratedStep).state).toBe('waiting');
  });

  it('still accepts a step in a halted (failed) job — that is a recoverable halt, not a grave', async () => {
    const h = jobRoutesHarness('failed');
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerJobsRoutes(server, {
      jobQueue: h.queue, engine: h.engine,
      prWatcher: {} as never,
      prFilePatches: {} as never, scheduler: {} as never, sessionStore: {} as never,
      worktreeManager: {} as never, jobsDir: h.jobsDir,
    });
    await server.listen();

    const res = await post(port, '/api/work/jobs/job-1/steps/step-1/message', { body: 'try again' });
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.resumed).toEqual(['ctrl-sess']);
  });
});

// The route guard is the boundary check, but it is not the only door: PrWatcher.syncNow walks
// every job in the queue with no state filter, so an abandoned job whose branch still has an
// open PR keeps being polled and pushes `external` items straight into the engine.
describe('WorkEngine — inbox and gate on a terminated job', () => {
  it('ignores a watcher event pushed at an abandoned job\'s step', async () => {
    const h = jobRoutesHarness('abandoned');
    h.engine.pushStepInbox('job-1', 'step-1', {
      kind: 'external', source: 'pr-watcher', summary: 'CI went red', events: ['ci'],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.resumed).toEqual([]);
    const s = h.queue.get('job-1')!.steps[0] as OrchestratedStep;
    expect(s.state).toBe('waiting');
    expect(s.inbox).toEqual([]);
  });

  it('ignores a gate resolution on a done job\'s step', async () => {
    const h = jobRoutesHarness('done', {
      state: 'gate_pending_approval',
      gate: { draft: 'd', question: 'q', requestedAt: 1 },
    });
    h.engine.resolveStepGate('job-1', 'step-1', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.resumed).toEqual([]);
    expect((h.queue.get('job-1')!.steps[0] as OrchestratedStep).state).toBe('gate_pending_approval');
  });
});

// The generic resolve route is the second door onto the worktree-archiving path that
// markStepResolved deliberately avoids: archiving runs `git worktree remove --force` +
// `branch -D`, and a user closing out an orchestrated step is not a statement that the work
// landed. Both doors have to keep the worktree.
describe('POST /api/work/jobs/:id/steps/:stepId/resolve — orchestrated steps', () => {
  it('keeps the worktree, matching mark-resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'step-resolve-'));
    const queue = new JobQueue(dir);
    const archived: string[] = [];
    const engine = new WorkEngine({
      queue,
      sessionManager: {
        spawnDetached() {}, send() {}, isWorking() { return false; }, sendOrResume() {},
        close: async () => {},
      } as never,
      worktreeManager: {
        provision: async () => ({ path: null }),
        get: (id: string) => ({ projectCwd: '/tmp/repo', worktreePath: `/tmp/wt/${id}`, branch: 'feat/x', baseBranch: 'main' }),
        archive: async (id: string) => { archived.push(id); },
      } as never,
      linearWriter: { setState: async () => undefined } as never,
      jobsDir: join(dir, 'jobs'), now: () => 1,
    });
    const step: OrchestratedStep = {
      id: 'step-1', title: 'shepherd', description: 'd', type: 'orchestrated',
      controller: 'code.orchestrate-pr', workspace: { kind: 'none' }, goal: 'g',
      dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
      state: 'running', createdAt: 1, updatedAt: 1, sessionId: randomUUID(),
    };
    const job: JobRecord = {
      id: 'job-1', source: 'manual', title: 't', description: 'd', state: 'executing',
      steps: [step], createdAt: 1, updatedAt: 1,
    };
    queue.upsert(job);

    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerJobsRoutes(server, {
      jobQueue: queue, engine,
      prWatcher: {} as never,
      prFilePatches: {} as never, scheduler: {} as never, sessionStore: {} as never,
      worktreeManager: {} as never, jobsDir: join(dir, 'jobs'),
    });
    await server.listen();

    const res = await post(port, '/api/work/jobs/job-1/steps/step-1/resolve', {});
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    expect((queue.get('job-1')!.steps[0] as OrchestratedStep).state).toBe('resolved');
    expect(archived).toEqual([]);
  });

  it('404s on a terminated job rather than falling through to the action-step path', async () => {
    const h = jobRoutesHarness('abandoned');
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerJobsRoutes(server, {
      jobQueue: h.queue, engine: h.engine,
      prWatcher: {} as never,
      prFilePatches: {} as never, scheduler: {} as never, sessionStore: {} as never,
      worktreeManager: {} as never, jobsDir: h.jobsDir,
    });
    await server.listen();

    const res = await post(port, '/api/work/jobs/job-1/steps/step-1/resolve', {});
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.archived).toEqual([]);
    expect((h.queue.get('job-1')!.steps[0] as OrchestratedStep).state).toBe('waiting');
  });
});
