import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
import { freePort } from '../e2e/harness/port.js';

// --- a minimal MCP server, same handshake as mcp-catalog.test.ts ---

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

// A read tool and an external-write tool from one fictitious vendor — 'get_widget' matches the
// classifier's read-verb-prefix table, 'delete_widget' needs its description to name a mutation
// since the vendor isn't in the classifier's hardcoded write-tool table.
const ACME_TOOLS = [
  { name: 'get_widget', description: 'Fetch a widget' },
  { name: 'delete_widget', description: 'Deletes a widget permanently' },
];
const ACME_PULL_RULE = { group: 'pull' as const, kind: 'mcp' as const, value: '^mcp__acme__(get_widget)$' };
const ACME_PUSH_RULE = { group: 'push' as const, kind: 'mcp' as const, value: '^mcp__acme__(delete_widget)$' };

// --- fake req/res, mirroring the pattern in permission-group-put.test.ts ---

interface Captured { status: number; body: string }

function fakeReq(url: string, body: unknown = {}): IncomingMessage {
  const s = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
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
let actionsDir: string;
let mcpConfigPath: string;
let groupsPath: string;
let permissionGroups: PermissionGroupMap;
let registry: ActionRegistry;
let revisions: PermissionGroupRevisionsStore;
let getCatalog: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let applyCatalog: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
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
    groupRevisions: revisions, mcpConfigPath,
  } as MetaRoutesDeps);
  getCatalog = routes.get('GET /api/mcp/catalog')! as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  applyCatalog = routes.get('POST /api/mcp/catalog/apply')! as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-mcp-onboarding-'));
  actionsDir = join(root, 'actions');
  mkdirSync(actionsDir, { recursive: true });
  mcpConfigPath = join(root, 'daemon-mcp.json');
  groupsPath = join(root, 'permission-groups.json');
  writeMcpConfig({});

  // The route merges in `~/.claude.json`'s mcpServers too — sandbox os.homedir() so these
  // tests don't pick up whatever real servers happen to be configured on the machine running
  // them (os.homedir() reads $HOME on POSIX before falling back to the passwd db).
  homeDir = mkdtempSync(join(tmpdir(), 'outpost-mcp-onboarding-home-'));
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
  mountRoutes();
});

afterEach(async () => {
  if (mcpServer) { await new Promise<void>((resolve) => mcpServer!.close(() => resolve())); mcpServer = undefined; }
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('GET /api/mcp/catalog', () => {
  it('proposes placements for every configured server, including a failed one with its status', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url }, ghost: { url: 'http://127.0.0.1:1/mcp' } });
    mountRoutes();

    const { res, out } = fakeRes();
    await getCatalog(fakeReq('/api/mcp/catalog'), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as {
      servers: Array<{ server: string; status: string; rules: Array<{ group: string; kind: string; value: string }> }>;
    };
    expect(body.servers).toHaveLength(2);

    const acme = body.servers.find((s) => s.server === 'acme')!;
    expect(acme.status).toBe('ok');
    expect(acme.rules).toContainEqual(ACME_PULL_RULE);
    expect(acme.rules).toContainEqual(ACME_PUSH_RULE);

    const ghost = body.servers.find((s) => s.server === 'ghost')!;
    expect(ghost.status).not.toBe('ok');
    expect(ghost.rules).toHaveLength(0);
  });

  it('runs enumeration concurrently — a hung server does not add its timeout to a fast server\'s wait', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    const hung = createServer(() => { /* never responds */ });
    const hungPort = await freePort();
    await new Promise<void>((resolve) => hung.listen(hungPort, '127.0.0.1', resolve));

    writeMcpConfig({ acme: { url: listening.url }, hung: { url: `http://127.0.0.1:${hungPort}/mcp` } });
    mountRoutes();

    const started = Date.now();
    const { res, out } = fakeRes();
    await getCatalog(fakeReq('/api/mcp/catalog'), res);
    const elapsed = Date.now() - started;

    await new Promise<void>((resolve) => hung.close(() => resolve()));

    expect(out.status).toBe(200);
    // listTools's own probe timeout is 2500ms; run serially the two servers would cost at
    // least that twice. Comfortably under 2x proves they ran concurrently, not one-after-another.
    expect(elapsed).toBeLessThan(4000);
    const body = JSON.parse(out.body) as { servers: Array<{ server: string; status: string }> };
    expect(body.servers.find((s) => s.server === 'hung')!.status).toBe('timeout');
    expect(body.servers.find((s) => s.server === 'acme')!.status).toBe('ok');
  }, 10_000);
});

describe('POST /api/mcp/catalog/apply', () => {
  it('applies a rule the proposal generated, lands it in the group, and records one revision', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url } });
    mountRoutes();

    const { res, out } = fakeRes();
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', { server: 'acme', rules: [ACME_PULL_RULE] }), res);

    expect(out.status).toBe(200);
    expect(permissionGroups.pull!.alwaysAllowMcpPatterns).toContain(ACME_PULL_RULE.value);
    const onDisk = JSON.parse(readFileSync(groupsPath, 'utf8')) as PermissionGroupMap;
    expect(onDisk.pull!.alwaysAllowMcpPatterns).toContain(ACME_PULL_RULE.value);
    expect(revisions.list('pull')).toHaveLength(1);
  });

  it('refuses a rule bound for a different group than the recomputed proposal placed it in', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url } });
    mountRoutes();

    const { res, out } = fakeRes();
    // The value IS one the proposal actually generates — for push, not pull.
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', {
      server: 'acme', rules: [{ group: 'pull', kind: 'mcp', value: ACME_PUSH_RULE.value }],
    }), res);

    expect(out.status).toBe(400);
    expect(permissionGroups.pull!.alwaysAllowMcpPatterns).toEqual([]);
    expect(revisions.list('pull')).toHaveLength(0);
  });

  it('refuses a rule whose value subtly differs from what the proposal generated', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url } });
    mountRoutes();

    const { res, out } = fakeRes();
    // A widened alternation that includes a tool name this server never reported.
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', {
      server: 'acme',
      rules: [{ group: 'pull', kind: 'mcp', value: '^mcp__acme__(get_widget|list_widget)$' }],
    }), res);

    expect(out.status).toBe(400);
    expect(permissionGroups.pull!.alwaysAllowMcpPatterns).toEqual([]);
    expect(revisions.list('pull')).toHaveLength(0);
  });

  it('refuses when the destination group already carries an entry the lint rejects', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url } });
    // Pre-existing corruption in `pull` — applyGroup's validateGroupUpdate lints the WHOLE
    // resulting group, not just the new rule, so this must block the apply even though the
    // submitted rule itself is exactly what the recomputed proposal generated.
    permissionGroups.pull!.alwaysAllowMcpPatterns.push('^mcp__broken__(unterminated');
    mountRoutes();

    const { res, out } = fakeRes();
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', { server: 'acme', rules: [ACME_PULL_RULE] }), res);

    expect(out.status).toBe(400);
    expect(revisions.list('pull')).toHaveLength(0);
  });

  it('a batch spanning both groups is all-or-nothing: a corrupt push blocks pull too, leaving it untouched on disk with no revision', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url } });
    // Pre-existing corruption in `push` only — `pull` starts clean.
    permissionGroups.push!.alwaysAllowMcpPatterns.push('^mcp__broken__(unterminated');
    mountRoutes();

    const { res, out } = fakeRes();
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', {
      server: 'acme', rules: [ACME_PULL_RULE, ACME_PUSH_RULE],
    }), res);

    expect(out.status).toBe(400);
    // The whole batch must be validated before anything is written — pull's rule is valid on
    // its own, but the batch is rejected as a unit, so pull must show no trace of it: neither
    // in memory, nor on disk, nor as a revision.
    expect(permissionGroups.pull!.alwaysAllowMcpPatterns).toEqual([]);
    const onDisk = JSON.parse(readFileSync(groupsPath, 'utf8')) as PermissionGroupMap;
    expect(onDisk.pull!.alwaysAllowMcpPatterns).toEqual([]);
    expect(revisions.list('pull')).toHaveLength(0);
    expect(revisions.list('push')).toHaveLength(0);
  });

  it('a valid batch spanning both groups applies both and records a revision for each', async () => {
    const listening = await listenMcp(ACME_TOOLS);
    mcpServer = listening.server;
    writeMcpConfig({ acme: { url: listening.url } });
    mountRoutes();

    const { res, out } = fakeRes();
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', {
      server: 'acme', rules: [ACME_PULL_RULE, ACME_PUSH_RULE],
    }), res);

    expect(out.status).toBe(200);
    expect(permissionGroups.pull!.alwaysAllowMcpPatterns).toContain(ACME_PULL_RULE.value);
    expect(permissionGroups.push!.alwaysAllowMcpPatterns).toContain(ACME_PUSH_RULE.value);
    const onDisk = JSON.parse(readFileSync(groupsPath, 'utf8')) as PermissionGroupMap;
    expect(onDisk.pull!.alwaysAllowMcpPatterns).toContain(ACME_PULL_RULE.value);
    expect(onDisk.push!.alwaysAllowMcpPatterns).toContain(ACME_PUSH_RULE.value);
    expect(revisions.list('pull')).toHaveLength(1);
    expect(revisions.list('push')).toHaveLength(1);
  });

  it('404s for a server that is not configured', async () => {
    const { res, out } = fakeRes();
    await applyCatalog(fakeReq('/api/mcp/catalog/apply', { server: 'nope', rules: [ACME_PULL_RULE] }), res);
    expect(out.status).toBe(404);
  });

  it('400s a malformed body', async () => {
    for (const body of [
      {},
      { server: 'acme' },
      { server: '', rules: [ACME_PULL_RULE] },
      { server: 'acme', rules: [] },
      { server: 'acme', rules: [{ group: 'edit', kind: 'mcp', value: 'x' }] },
      { server: 'acme', rules: [{ group: 'pull', kind: 'bash', value: 'x' }] },
      { server: 'acme', rules: [{ group: 'pull', kind: 'mcp' }] },
    ]) {
      const { res, out } = fakeRes();
      await applyCatalog(fakeReq('/api/mcp/catalog/apply', body), res);
      expect(out.status).toBe(400);
    }
  });
});
