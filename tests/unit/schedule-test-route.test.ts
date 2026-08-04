import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Server } from '../../src/server.js';
import { registerScheduleEditRoutes, type ScheduleEditDeps } from '../../src/routes/schedule-edits.js';
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

function fakeDeps(runScriptTest: ScheduleEditDeps['runScriptTest']): ScheduleEditDeps {
  return {
    manager: {} as ScheduleEditDeps['manager'],
    engine: {} as ScheduleEditDeps['engine'],
    notifyAll: () => {},
    config: { httpPort: null, hookPort: 0 },
    secret: 'test-secret',
    runtimeDir: '/tmp',
    actionCatalog: () => [],
    runScriptTest,
  };
}

describe('POST /api/schedules/test', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('runs a script draft via runScriptTest and returns its result', async () => {
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerScheduleEditRoutes(server, fakeDeps(async () => ({ outcome: 'error', output: 'boom' })));
    await server.listen();

    const r = await post(port, '/api/schedules/test', {
      what: { kind: 'script', script: 'x', cwd: '/tmp' },
    });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ outcome: 'error', output: 'boom' });
  });

  it('rejects non-script what with 400', async () => {
    const port = await freePort();
    server = new Server({ httpPort: port, heartbeatMs: 0 });
    registerScheduleEditRoutes(server, fakeDeps(async () => ({ outcome: 'error', output: 'boom' })));
    await server.listen();

    const r = await post(port, '/api/schedules/test', {
      what: { kind: 'skill', skill: 'x' },
    });

    expect(r.status).toBe(400);
    expect(r.body).toBe('test only applies to script schedules');
  });
});
