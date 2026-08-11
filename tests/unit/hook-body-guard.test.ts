import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookServer, type HookServerOpts } from '../../src/permissions/hook-server.js';
import { writeDaemonSettings } from '../../src/settings-gen.js';
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
// rather than silently proceeding on a body that isn't a plain object. This is a stand-in
// on purpose — the subject of the suite below is HookServer's status mapping, and the real
// callbacks are closures over the whole daemon graph (session manager, engine, stores,
// tailscale certs, live ports), so driving them means booting the daemon. That the real
// callbacks still carry the guard is pinned separately, at the bottom of this file.
function guarded(body: string): void {
  if (!parseJsonObject(body)) throw new Error('invalid json body');
}

function makeOpts(): HookServerOpts {
  return {
    port: 0,
    daemonAuthSecret: SECRET,
    onPreToolHook: async (body) => { guarded(body); return '{}'; },
    onPostToolFailureHook: async (body) => { guarded(body); return '{}'; },
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

  // Round 0 shipped the wrong event name (`PostToolUse` instead of `PostToolUseFailure`)
  // and every test still passed, because all of them called handlePostToolFailureHook
  // directly — nothing traversed settings-gen's event key/URL through to a live
  // HookServer route. This does: derive the path settings-gen actually writes, and prove
  // it resolves to something other than a 404 on the real route table.
  it('the URL settings-gen writes for PostToolUseFailure resolves to a live HookServer route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'));
    const settingsPath = join(dir, 'daemon-settings.json');
    const port = await freePort();
    writeDaemonSettings({ outPath: settingsPath, hookPort: port });
    const j = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const url = new URL(j.hooks.PostToolUseFailure[0].hooks[0].url);

    server = new HookServer({ ...makeOpts(), port });
    await server.listen();

    const res = await post(port, url.pathname, JSON.stringify({ session_id: 's', tool_name: 'Bash' }));
    expect(res.status).not.toBe(404);
  });

  // /work/create-job parses its own body inside HookServer rather than in a daemon callback,
  // and was the last raw JSON.parse on the surface — a non-object body reached the field
  // checks and 400'd on whatever TypeError they happened to raise.
  it('/work/create-job reports a non-object body as a body problem', async () => {
    const port = await freePort();
    server = new HookServer({
      ...makeOpts(), port,
      onCreateJob: async () => ({ jobId: 'j1', created: true }),
    });
    await server.listen();

    for (const body of ['null', '42', '"a string"', '[{"source":"x","title":"y"}]']) {
      const res = await post(port, '/work/create-job', body);
      expect(res.status, body).toBe(400);
      expect(JSON.parse(res.body), body).toEqual({ error: 'invalid json body' });
    }
  });

  it('still rejects a well-formed object missing source/title on its own terms', async () => {
    const port = await freePort();
    server = new HookServer({
      ...makeOpts(), port,
      onCreateJob: async () => ({ jobId: 'j1', created: true }),
    });
    await server.listen();

    const res = await post(port, '/work/create-job', JSON.stringify({ title: 'no source' }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/source and title/);
  });
});

// The suite above proves HookServer maps a throwing callback to the right status. It cannot
// prove the real callbacks throw, because it supplies its own. This does: every hook callback
// that receives a raw body must run it through parseJsonObject and refuse a non-object,
// rather than JSON.parse-ing it or letting a bad body through as `undefined` fields.
describe('the real hook callbacks guard their bodies', () => {
  const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
  const daemon = readFileSync(`${srcDir}daemon.ts`, 'utf8');

  const BODY_CALLBACKS = [
    'onStatusLineHook', 'onStopHook', 'onPreToolHook', 'onPostToolFailureHook',
    'onWorkPlanReady', 'onWorkStepResolved', 'onWorkStepFailed', 'onWorkJournal',
  ];

  // From the callback's key to the next sibling key at the same indent — its whole body.
  function callbackBody(src: string, name: string): string {
    const at = src.indexOf(`${name}: async (body) => {`);
    expect(at, `${name} is not wired in daemon.ts with the expected shape`).toBeGreaterThan(-1);
    const next = src.indexOf('\n    on', at + 1);
    return src.slice(at, next > at ? next : at + 4000);
  }

  it.each(BODY_CALLBACKS)('%s parses via parseJsonObject and throws on a non-object', (name) => {
    const body = callbackBody(daemon, name);
    expect(body).toContain('parseJsonObject(body)');
    const guard = body.indexOf("throw new Error('invalid json body')");
    expect(guard, `${name} accepts a body that is not a plain object`).toBeGreaterThan(-1);
    // …and before anything reads a field off it.
    expect(body.slice(0, guard)).not.toMatch(/payload\.|hookInput\./);
  });

  it('onActionProposal delegates to a handler that carries the same guard', () => {
    expect(daemon).toContain('onActionProposal: (body) => onActionProposalHandler(body)');
    const actions = readFileSync(`${srcDir}routes/actions.ts`, 'utf8');
    const at = actions.indexOf('const onActionProposalHandler');
    expect(at).toBeGreaterThan(-1);
    const head = actions.slice(at, at + 400);
    expect(head).toContain('parseJsonObject(body)');
    expect(head).toContain("throw new Error('invalid json body')");
  });

  it('no hook callback reaches for JSON.parse directly', () => {
    const hookServer = readFileSync(`${srcDir}permissions/hook-server.ts`, 'utf8');
    expect(hookServer).not.toContain('JSON.parse(body)');
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
