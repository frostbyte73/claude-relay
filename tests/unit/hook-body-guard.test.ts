import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { HookServer, type HookServerOpts } from '../../src/permissions/hook-server.js';
import { parseJsonObject } from '../../src/routes/util.js';
import { handleMcpRequest } from '../../src/mcp-server.js';
import { freePort } from '../e2e/harness/port.js';

const SECRET = 'test-secret';

function post(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'x-daemon-auth': SECRET, 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Mirrors what every real daemon.ts hook callback does post-guard: parse, then throw
// rather than silently proceeding on a body that isn't a plain object.
function guarded(body: string): void {
  if (!parseJsonObject(body)) throw new Error('invalid json body');
}

function makeOpts(): HookServerOpts {
  return {
    port: 0,
    daemonAuthSecret: SECRET,
    onPreToolHook: async (body) => { guarded(body); return '{}'; },
    onStopHook: async (body) => { guarded(body); },
    onStatusLineHook: async (body) => { guarded(body); },
    onWorkPlanReady: async (body) => { guarded(body); },
    onWorkStepResolved: async (body) => { guarded(body); },
    onWorkStepFailed: async (body) => { guarded(body); },
    onActionProposal: async (body) => { guarded(body); },
    onWorkJournal: async (body) => { guarded(body); },
    onMcp: async () => ({ status: 200, headers: {}, body: '{}' }),
  };
}

let server: HookServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('HookServer — status mapping when a handler throws on a bad body', () => {
  it('answers 400, not 204, when a /work/ hook body is not an object', async () => {
    const port = await freePort();
    server = new HookServer({ ...makeOpts(), port });
    await server.listen();

    const res = await post(port, '/work/step-resolved', 'null');
    expect(res.status).toBe(400);
  });

  it('answers 400 for an unparsable /work/ hook body', async () => {
    const port = await freePort();
    server = new HookServer({ ...makeOpts(), port });
    await server.listen();

    const res = await post(port, '/work/journal', '{');
    expect(res.status).toBe(400);
  });

  it('still answers 204 for a fire-and-forget /hook/stop body', async () => {
    const port = await freePort();
    server = new HookServer({ ...makeOpts(), port });
    await server.listen();

    const res = await post(port, '/hook/stop', 'null');
    expect(res.status).toBe(204);
  });

  it('keeps /hook/pretool at 500 rather than downgrading to 400', async () => {
    const port = await freePort();
    server = new HookServer({ ...makeOpts(), port });
    await server.listen();

    const res = await post(port, '/hook/pretool', 'null');
    expect(res.status).toBe(500);
  });
});

describe('handleMcpRequest — rejects messages that are not plain objects', () => {
  it('rejects a body that parses to null with the same shape as a parse failure', async () => {
    const parseFailure = await handleMcpRequest('not json', [], {});
    const nonObject = await handleMcpRequest('null', [], {});

    expect(nonObject.status).toBe(parseFailure.status);
    expect(JSON.parse(nonObject.body)).toEqual(JSON.parse(parseFailure.body));
  });

  it('rejects an array/primitive top-level body the same way', async () => {
    for (const body of ['42', '"a string"', '[1,2,3]']) {
      const res = await handleMcpRequest(body, [], {});
      expect(res.status, body).toBe(400);
    }
  });

  it('rejects a whole batch when any element is not a plain object', async () => {
    const batch = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null]);
    const res = await handleMcpRequest(batch, [], {});
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' },
    });
  });

  it('still accepts a well-formed single request', async () => {
    const res = await handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      [],
      {},
    );
    expect(res.status).toBe(200);
  });
});
