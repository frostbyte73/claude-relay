import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, type IncomingMessage as HttpIncomingMessage, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerMetaRoutes, type MetaRoutesDeps } from '../../src/routes/meta.js';
import type { Server } from '../../src/server.js';
import { ActionRegistry } from '../../src/actions/index.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';
import { PermissionGroupRevisionsStore } from '../../src/storage/permission-group-revisions-store.js';
import { DenialsStore, type ActionDenial } from '../../src/storage/denials-store.js';
import { freePort } from '../e2e/harness/port.js';

// --- minimal MCP server, same handshake as mcp-onboarding-route.test.ts ---

function readReqBody(req: HttpIncomingMessage): Promise<{ method: string }> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
  });
}

async function listenMcp(tools: Array<{ name: string; description?: string }>): Promise<{ server: HttpServer; url: string }> {
  const server = createServer(async (req, res) => {
    const body = await readReqBody(req);
    res.setHeader('content-type', 'application/json');
    if (body.method === 'initialize') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); return; }
    if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
    if (body.method === 'tools/list') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } })); return; }
    res.statusCode = 500;
    res.end();
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${port}/mcp` };
}

// A read tool (classifies to pull) and a tool with no classifiable effect at all — no vendor
// write-verb match, no description hinting a mutation — so it lands as `group: null`, i.e.
// "unclassified" from a human's perspective.
const MIXED_TOOLS = [
  { name: 'get_widget', description: 'Fetch a widget' },
  { name: 'frobnicate', description: 'does a thing to the thing' },
];

interface Captured { status: number; body: string }

function fakeReq(url: string): IncomingMessage {
  const s = Readable.from(['']) as unknown as IncomingMessage;
  s.url = url;
  return s;
}

function fakeRes(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: 0, body: '' };
  const res = {
    set statusCode(v: number) { out.status = v; },
    get statusCode() { return out.status; },
    setHeader() { /* ignored */ },
    end(chunk?: string) { out.body = chunk ?? ''; },
  } as unknown as ServerResponse;
  return { res, out };
}

let root: string;
let homeDir: string;
let originalHome: string | undefined;
let mcpConfigPath: string;
let groupsPath: string;
let permissionGroups: PermissionGroupMap;
let registry: ActionRegistry;
let revisions: PermissionGroupRevisionsStore;
let denialsStore: DenialsStore;
let getPending: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let mcpServer: HttpServer | undefined;

function writeMcpConfig(servers: Record<string, { url: string }>): void {
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: servers }));
}

function mountRoutes(): void {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>();
  const server = {
    route(method: string, path: string, h: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
      routes.set(`${method} ${path}`, h);
    },
  } as unknown as Server;
  registerMetaRoutes(server, {
    actionRegistry: registry, permissionGroups, permissionGroupsPath: groupsPath,
    groupRevisions: revisions, mcpConfigPath, denialsStore,
  } as MetaRoutesDeps);
  getPending = routes.get('GET /api/permissions/pending')! as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function recordDenial(overrides: Partial<Parameters<DenialsStore['record']>[0]> = {}): ActionDenial {
  return denialsStore.record({
    actionName: 'read.thing',
    sessionId: 's1',
    toolName: 'Bash',
    toolInput: { command: 'gh pr view 12' },
    suggested: { kind: 'bash', value: '^gh pr view ' },
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-permissions-pending-'));
  const actionsDir = join(root, 'actions');
  mkdirSync(actionsDir, { recursive: true });
  mcpConfigPath = join(root, 'daemon-mcp.json');
  groupsPath = join(root, 'permission-groups.json');
  writeMcpConfig({});

  homeDir = mkdtempSync(join(tmpdir(), 'outpost-permissions-pending-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  permissionGroups = {
    pull: { description: 'p', alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    push: { description: 'w', alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
  };
  writeFileSync(groupsPath, JSON.stringify(permissionGroups, null, 2) + '\n');
  registry = new ActionRegistry(actionsDir, { permissionGroups });
  registry.load();
  revisions = new PermissionGroupRevisionsStore(join(root, 'revisions.jsonl'));
  denialsStore = new DenialsStore(join(root, 'denials.json'));
  mountRoutes();
});

afterEach(async () => {
  if (mcpServer) { await new Promise<void>((resolve) => mcpServer!.close(() => resolve())); mcpServer = undefined; }
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('GET /api/permissions/pending', () => {
  it('returns only unresolved denials, across every action', async () => {
    const d1 = recordDenial({ actionName: 'read.thing', toolInput: { command: 'gh pr view 12' } });
    const d2 = recordDenial({
      actionName: 'read.thing', toolInput: { command: 'gh pr view 99' },
      suggested: { kind: 'bash', value: '^gh pr view 99' },
    });
    const d3 = recordDenial({
      actionName: 'write.other', toolInput: { command: 'gh pr merge 1' },
      suggested: { kind: 'bash', value: '^gh pr merge ' },
    });
    denialsStore.setVerdict('read.thing', d1.id, {
      disposition: 'never', reason: 'nah', decidedAt: Date.now(), decidedBy: 'user',
    });

    const { res, out } = fakeRes();
    await getPending(fakeReq('/api/permissions/pending'), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { denials: Array<{ id: string; action: string }> };
    const ids = body.denials.map((d) => d.id);
    expect(ids).not.toContain(d1.id);
    expect(ids).toContain(d2.id);
    expect(ids).toContain(d3.id);
    expect(body.denials.find((d) => d.id === d2.id)!.action).toBe('read.thing');
    expect(body.denials.find((d) => d.id === d3.id)!.action).toBe('write.other');
  });

  it('reports unclassified MCP counts without blocking on a probe that fails', async () => {
    const listening = await listenMcp(MIXED_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url }, ghost: { url: 'http://127.0.0.1:1/mcp' } });
    mountRoutes();

    const { res, out } = fakeRes();
    await getPending(fakeReq('/api/permissions/pending'), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { mcp: Array<{ server: string; unclassified: number }> };
    const acme = body.mcp.find((s) => s.server === 'acme');
    expect(acme?.unclassified).toBe(1); // 'frobnicate' has no classifiable effect

    const ghost = body.mcp.find((s) => s.server === 'ghost');
    expect(ghost === undefined || ghost.unclassified === 0).toBe(true);
  });

  it('truncates a long command rather than shipping the whole payload', async () => {
    recordDenial({ toolInput: { command: 'x'.repeat(5000) } });

    const { res, out } = fakeRes();
    await getPending(fakeReq('/api/permissions/pending'), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { denials: Array<{ command: string }> };
    expect(body.denials).toHaveLength(1);
    expect(body.denials[0]!.command.length).toBeLessThanOrEqual(200);
  });
});
