import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerMetaRoutes, encodeRuleId, type MetaRoutesDeps } from '../../src/routes/meta.js';
import type { Server } from '../../src/server.js';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import { ActionsStore } from '../../src/storage/actions-store.js';

// PUT /api/allowlist/rules/:id and the action-scoped DELETE, driven against a real Allowlist +
// ActionsStore on a tmp dir — same fake req/res harness as mcp-onboarding-route.test.ts.

interface Captured { status: number; body: string }

function fakeReq(url: string, method: string, body: unknown = undefined): IncomingMessage {
  const s = Readable.from([body === undefined ? '' : JSON.stringify(body)]) as unknown as IncomingMessage;
  s.url = url;
  s.method = method;
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
let allowlistPath: string;
let actionsStorePath: string;
let allowlist: Allowlist;
let actionsStore: ActionsStore;
let putRule: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let deleteRule: (req: IncomingMessage, res: ServerResponse) => void;

function seedGlobalConfig(cfg: Partial<AllowlistConfig>): void {
  const full: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
    ...cfg,
  };
  writeFileSync(allowlistPath, JSON.stringify(full, null, 2) + '\n');
  allowlist = new Allowlist(full, { actionsStore });
}

function mountRoutes(): void {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>();
  const server = {
    route(method: string, path: string, h: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
      routes.set(`${method} ${path}`, h);
    },
  } as unknown as Server;
  registerMetaRoutes(server, {
    allowlist, allowlistPath, actionsStore, actionsStorePath,
    projectAllowlistDir: join(root, 'project-allowlists'),
    projectRegistry: { list: () => [] },
    worktreeManager: { list: () => [] },
  } as unknown as MetaRoutesDeps);
  putRule = routes.get('PUT /api/allowlist/rules/:id')! as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  deleteRule = routes.get('DELETE /api/allowlist/rules/:id')! as (req: IncomingMessage, res: ServerResponse) => void;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-allowlist-edit-'));
  allowlistPath = join(root, 'allowlist.json');
  actionsStorePath = join(root, 'actions.json');
  actionsStore = new ActionsStore(actionsStorePath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('PUT /api/allowlist/rules/:id', () => {
  it('refuses a write-shaped edit and leaves the original rule intact', async () => {
    seedGlobalConfig({ alwaysAllowBashPatterns: ['^ls(\\s|$)'] });
    const id = encodeRuleId('bash', '^ls(\\s|$)', 'global');
    mountRoutes();

    const { res, out } = fakeRes();
    await putRule(fakeReq(`/api/allowlist/rules/${id}`, 'PUT', { value: '^curl ' }), res);

    expect(out.status).toBe(400);
    expect(allowlist.toConfig('global').alwaysAllowBashPatterns).toEqual(['^ls(\\s|$)']);
    const onDisk = JSON.parse(readFileSync(allowlistPath, 'utf8')) as AllowlistConfig;
    expect(onDisk.alwaysAllowBashPatterns).toEqual(['^ls(\\s|$)']);
  });

  it('replaces the rule and returns the new id', async () => {
    seedGlobalConfig({ alwaysAllowBashPatterns: ['^ls(\\s|$)'] });
    const oldId = encodeRuleId('bash', '^ls(\\s|$)', 'global');
    mountRoutes();

    const { res, out } = fakeRes();
    await putRule(fakeReq(`/api/allowlist/rules/${oldId}`, 'PUT', { value: '^ls -la ' }), res);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { ok: boolean; rule: { id: string; value: string } };
    expect(body.rule.value).toBe('^ls -la ');
    expect(allowlist.toConfig('global').alwaysAllowBashPatterns).toEqual(['^ls -la ']);
    const onDisk = JSON.parse(readFileSync(allowlistPath, 'utf8')) as AllowlistConfig;
    expect(onDisk.alwaysAllowBashPatterns).toEqual(['^ls -la ']);

    // Old id is dead.
    const { res: res2, out: out2 } = fakeRes();
    await putRule(fakeReq(`/api/allowlist/rules/${oldId}`, 'PUT', { value: '^ls -a ' }), res2);
    expect(out2.status).toBe(404);

    const decoded = JSON.parse(Buffer.from(body.rule.id, 'base64url').toString('utf8')) as [string, string, string];
    expect(decoded[1]).toBe('^ls -la ');
  });

  it('refuses an edit that changes nothing rather than churning a revision', async () => {
    seedGlobalConfig({ alwaysAllowBashPatterns: ['^ls(\\s|$)'] });
    const id = encodeRuleId('bash', '^ls(\\s|$)', 'global');
    mountRoutes();

    const { res, out } = fakeRes();
    await putRule(fakeReq(`/api/allowlist/rules/${id}`, 'PUT', { value: '^ls(\\s|$)' }), res);

    expect(out.status).toBe(400);
    expect(out.body).toMatch(/no change/);
  });
});

describe('DELETE /api/allowlist/rules/:id (action scope)', () => {
  it('revokes an action-scoped rule instead of answering 409', () => {
    seedGlobalConfig({});
    actionsStore.addRule('read.investigate', 'bash', '^rg(\\s|$)');
    const id = encodeRuleId('bash', '^rg(\\s|$)', { action: 'read.investigate' });
    mountRoutes();

    const { res, out } = fakeRes();
    deleteRule(fakeReq(`/api/allowlist/rules/${id}`, 'DELETE'), res);

    expect(out.status).toBe(200);
    expect(actionsStore.list()['read.investigate']?.allowlist.alwaysAllowBashPatterns ?? []).not.toContain('^rg(\\s|$)');
  });
});
