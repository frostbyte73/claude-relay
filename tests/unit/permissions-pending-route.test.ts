import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerMetaRoutes, type MetaRoutesDeps } from '../../src/routes/meta.js';
import type { Server } from '../../src/server.js';
import { ActionRegistry } from '../../src/actions/index.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';
import { PermissionGroupRevisionsStore } from '../../src/storage/permission-group-revisions-store.js';
import { DenialsStore, type ActionDenial } from '../../src/storage/denials-store.js';

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
let getPending: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

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
  getPending = routes.get('GET /api/permissions/pending')!;
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
  // A server that accepts the connection and never replies — MCP_PROBE_TIMEOUT_MS (2.5s) if
  // this route ever touches it. Present in every test to prove the route ignores it outright.
  writeMcpConfig({ hung: { url: 'http://127.0.0.1:1/mcp' } });

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

afterEach(() => {
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

  // F1 fix round: this route used to re-run GET /api/mcp/catalog's live `tools/list` probes
  // (up to MCP_PROBE_TIMEOUT_MS per hung server) just to ship a count. It must now answer
  // instantly and carry no `mcp` field at all — the MCP panel calls /api/mcp/catalog itself.
  it('never touches the network — answers fast with no mcp field, even with an unreachable server configured', async () => {
    const started = Date.now();
    const { res, out } = fakeRes();
    await getPending(fakeReq('/api/permissions/pending'), res);
    const elapsed = Date.now() - started;

    expect(out.status).toBe(200);
    expect(elapsed).toBeLessThan(200);
    const body = JSON.parse(out.body) as Record<string, unknown>;
    expect(body.mcp).toBeUndefined();
    expect(Array.isArray(body.denials)).toBe(true);
  });

  it('truncates a long command rather than shipping the whole payload', async () => {
    recordDenial({ toolInput: { command: 'x'.repeat(5000) } });

    const { res, out } = fakeRes();
    await getPending(fakeReq('/api/permissions/pending'), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { denials: Array<{ command: string | null }> };
    expect(body.denials).toHaveLength(1);
    expect(body.denials[0]!.command).not.toBeNull();
    expect(body.denials[0]!.command!.length).toBeLessThanOrEqual(200);
  });

  // F2 fix round: a missing/unusable payload used to come back as the literal string "Bash" —
  // indistinguishable from a genuine one-word command. It must now be `null` so the client can
  // tell the user the payload isn't available, rather than showing a plausible lie.
  it('reports a missing tool-input payload as null, not the tool name', async () => {
    recordDenial({ toolName: 'Bash', toolInput: undefined });
    recordDenial({ actionName: 'read.other', toolName: 'SomeTool', toolInput: undefined });

    const { res, out } = fakeRes();
    await getPending(fakeReq('/api/permissions/pending'), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { denials: Array<{ tool: string; command: string | null }> };
    for (const d of body.denials) {
      expect(d.command).toBeNull();
    }
  });
});
