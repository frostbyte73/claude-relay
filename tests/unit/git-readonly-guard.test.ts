import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Server } from '../../src/server.js';
import { registerGitRoutes } from '../../src/routes/git.js';
import { freePort } from '../e2e/harness/port.js';

function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: payload ? { 'content-type': 'application/json' } : undefined },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

let server: Server | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

// A readonly (review/investigation) worktree provisions with an empty `branch` — see
// WorktreeManager.provision(). None of these endpoints should be reachable against one:
// the whole point of `readonly` is that the user never owns a branch there to commit,
// stage, push, discard, or open a PR from.
const readonlyRecord = { worktreePath: '/tmp/wt-ro', projectCwd: '/tmp/repo', branch: '', baseBranch: '' };

function harness(record: Record<string, unknown> | undefined) {
  return {
    sessionStore: { findSession: () => undefined } as never,
    worktreeManager: { get: (key: string) => (key === 'sess-1' ? record : undefined) } as never,
    engine: {
      worktreeRecordForSession: () => undefined,
      jobIdForSession: () => undefined,
    } as never,
    prWatcher: { noteChanged: () => undefined } as never,
  };
}

async function start(record: Record<string, unknown> | undefined) {
  const port = await freePort();
  server = new Server({ httpPort: port, heartbeatMs: 0 });
  registerGitRoutes(server, harness(record));
  await server.listen();
  return port;
}

describe('readonly worktree guard — the class, not just discard', () => {
  it('refuses discard on a readonly checkout with 403, not the destructive git call', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/discard', {});
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/read-only/);
  });

  it('refuses commit on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/commit', { message: 'sneaky' });
    expect(res.status).toBe(403);
  });

  it('refuses stage on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/stage', { action: 'stage', paths: ['a.txt'] });
    expect(res.status).toBe(403);
  });

  it('refuses create-branch on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/create-branch', { newBranch: 'x' });
    expect(res.status).toBe(403);
  });

  it('refuses open-pr on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/open-pr', {});
    expect(res.status).toBe(403);
  });

  it('refuses push on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/push', undefined);
    expect(res.status).toBe(403);
  });

  it('refuses pull on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/pull', undefined);
    expect(res.status).toBe(403);
  });

  it('refuses finalize on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/finalize', { kind: 'merge-to-base', message: 'm' });
    expect(res.status).toBe(403);
  });

  it('refuses squash-to-base on a readonly checkout', async () => {
    const port = await start(readonlyRecord);
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/squash-to-base', { message: 'm' });
    expect(res.status).toBe(403);
  });

  it('does not block a writable worktree (has a real branch)', async () => {
    const writable = { worktreePath: '/tmp/wt-w', projectCwd: '/tmp/repo', branch: 'outpost/abc', baseBranch: 'main' };
    const port = await start(writable);
    // No repo actually exists at the stub path, so the underlying git call fails —
    // the point here is only that the guard itself does not short-circuit with 403.
    const res = await req(port, 'POST', '/api/sessions/sess-1/git/create-branch', { newBranch: 'x' });
    expect(res.status).not.toBe(403);
  });
});
