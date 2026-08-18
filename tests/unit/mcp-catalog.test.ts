import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { listTools } from '../../src/integrations/mcp-catalog.js';
import { freePort } from '../e2e/harness/port.js';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function listen(server: HttpServer): Promise<string> {
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

describe('listTools', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('runs the full handshake and returns tools for a compliant server', async () => {
    let sawInitialized = false;
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string };
      if (body.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-123');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        expect(req.headers['mcp-session-id']).toBe('sess-123');
        sawInitialized = true;
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        expect(req.headers['mcp-session-id']).toBe('sess-123');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'get_issue', description: 'Fetch an issue' }, { name: 'list_issues' }] },
        }));
        return;
      }
      res.statusCode = 500;
      res.end();
    });
    const url = await listen(server);

    const result = await listTools('acme', { url });

    expect(sawInitialized).toBe(true);
    expect(result).toEqual({
      server: 'acme',
      status: 'ok',
      tools: [
        { name: 'get_issue', description: 'Fetch an issue' },
        { name: 'list_issues' },
      ],
    });
  });

  it('succeeds when the server never sends a session header', async () => {
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'ping' }] } }));
        return;
      }
      res.statusCode = 500;
      res.end();
    });
    const url = await listen(server);

    const result = await listTools('stateless', { url });

    expect(result).toEqual({ server: 'stateless', status: 'ok', tools: [{ name: 'ping' }] });
  });

  it('reports unauthorized on HTTP 401', async () => {
    server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    const url = await listen(server);

    const result = await listTools('oauth-vendor', { url });

    expect(result.status).toBe('unauthorized');
    expect(result).toMatchObject({ server: 'oauth-vendor' });
  });

  it('reports timeout when the server hangs', async () => {
    server = createServer(() => {
      // never respond
    });
    const url = await listen(server);

    const result = await listTools('slow-vendor', { url }, { timeoutMs: 50 });

    expect(result.status).toBe('timeout');
  });

  it('reports unsupported on an HTML response', async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!DOCTYPE html><html><body>please log in</body></html>');
    });
    const url = await listen(server);

    const result = await listTools('html-vendor', { url });

    expect(result.status).toBe('unsupported');
  });

  it('reports unsupported on a JSON-RPC error object', async () => {
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } }));
    });
    const url = await listen(server);

    const result = await listTools('erroring-vendor', { url });

    expect(result.status).toBe('unsupported');
    expect(result).toMatchObject({ reason: expect.stringContaining('Method not found') });
  });

  it('reports unsupported for a stdio config without spawning anything', async () => {
    const result = await listTools('grafana', { type: 'stdio', command: 'grafana-mcp' });

    expect(result).toEqual({
      server: 'grafana',
      status: 'unsupported',
      reason: 'stdio transport — enumeration requires spawning the server',
    });
  });

  it('paginates across three pages and accumulates every tool', async () => {
    const pages = [
      { tools: [{ name: 'get_a' }, { name: 'get_b' }], nextCursor: 'page-2' },
      { tools: [{ name: 'get_c' }], nextCursor: 'page-3' },
      { tools: [{ name: 'get_d' }] },
    ];
    let listCall = 0;
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string; params?: { cursor?: string } };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        const expectedCursor = listCall === 0 ? undefined : `page-${listCall + 1}`;
        expect(body.params?.cursor).toBe(expectedCursor);
        const page = pages[listCall]!;
        listCall++;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: page }));
        return;
      }
      res.statusCode = 500;
      res.end();
    });
    const url = await listen(server);

    const result = await listTools('paginating', { url });

    expect(listCall).toBe(3);
    expect(result).toEqual({
      server: 'paginating',
      status: 'ok',
      tools: [{ name: 'get_a' }, { name: 'get_b' }, { name: 'get_c' }, { name: 'get_d' }],
    });
  });

  it('reports truncated rather than ok when a server paginates forever', async () => {
    let listCall = 0;
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        listCall++;
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: `tool_${listCall}` }], nextCursor: `page-${listCall + 1}` },
        }));
        return;
      }
      res.statusCode = 500;
      res.end();
    });
    const url = await listen(server);

    const result = await listTools('infinite-vendor', { url }, { maxPages: 5 });

    expect(listCall).toBe(5);
    expect(result.status).toBe('truncated');
    expect(result).toMatchObject({
      server: 'infinite-vendor',
      reason: expect.stringContaining('5 page'),
    });
  });

  it('parses an SSE-framed tools/list response', async () => {
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string };
      if (body.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sse-sess');
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n\n`);
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        res.setHeader('content-type', 'text/event-stream');
        const payload = { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'sse_tool', description: 'via SSE' }] } };
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        return;
      }
      res.statusCode = 500;
      res.end();
    });
    const url = await listen(server);

    const result = await listTools('sse-vendor', { url });

    expect(result).toEqual({
      server: 'sse-vendor',
      status: 'ok',
      tools: [{ name: 'sse_tool', description: 'via SSE' }],
    });
  });

  it('degrades to unsupported on a malformed SSE body rather than throwing', async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('event: message\ndata: {not valid json\n\n');
    });
    const url = await listen(server);

    const result = await listTools('malformed-sse-vendor', { url });

    expect(result.status).toBe('unsupported');
  });

  it('still works for a bare-JSON single-page server (no nextCursor)', async () => {
    server = createServer(async (req, res) => {
      const body = (await readBody(req)) as { method: string };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (body.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'solo' }] } }));
        return;
      }
      res.statusCode = 500;
      res.end();
    });
    const url = await listen(server);

    const result = await listTools('single-page', { url });

    expect(result).toEqual({ server: 'single-page', status: 'ok', tools: [{ name: 'solo' }] });
  });
});
