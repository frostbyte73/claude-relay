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
});
