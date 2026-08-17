import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerMetaRoutes, validateGroupUpdate, type MetaRoutesDeps } from '../../src/routes/meta.js';
import type { Server } from '../../src/server.js';
import { ActionRegistry } from '../../src/actions/index.js';
import type { PermissionGroup, PermissionGroupMap } from '../../src/actions/types.js';
import { PermissionGroupRevisionsStore } from '../../src/storage/permission-group-revisions-store.js';

const G = (patterns: string[]) => ({
  description: 'd',
  alwaysAllow: [], alwaysAllowBashPatterns: patterns,
  alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
});

describe('revert re-validates rather than trusting history', () => {
  it('refuses to reinstate a snapshot the current lint rejects', () => {
    // A revision captured before the lint existed can hold `^gh(\s|$)` in `read`.
    expect(validateGroupUpdate('read', G(['^gh(\\s|$)'])).ok).toBe(false);
  });

  it('allows reinstating a snapshot that still passes', () => {
    expect(validateGroupUpdate('read', G(['^sed(\\s|$)'])).ok).toBe(true);
  });
});

// --- endpoint tests ---

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
let actionsDir: string;
let groupsPath: string;
let permissionGroups: PermissionGroupMap;
let registry: ActionRegistry;
let revisions: PermissionGroupRevisionsStore;
let putHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
let revisionsHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
let revertHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

function writeAction(name: string, permissions: string[]): void {
  const dir = join(actionsDir, 'read', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---', `name: read.${name}`, `description: test action ${name}`, 'outpost:',
    '  kind: action', '  category: read', '  side_effects: none', '  runner: claude',
    `  permissions: [${permissions.join(', ')}]`, '---', '', 'body.',
  ].join('\n'));
  const schema = JSON.stringify({ type: 'object', additionalProperties: false });
  writeFileSync(join(dir, 'input.schema.json'), schema);
  writeFileSync(join(dir, 'output.schema.json'), schema);
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
    groupRevisions: revisions,
  } as MetaRoutesDeps);
  putHandler = routes.get('PUT /api/permission-groups/:name')!;
  revisionsHandler = routes.get('GET /api/permission-groups/:name/revisions')!;
  revertHandler = routes.get('POST /api/permission-groups/:name/revert/:revisionId')!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-group-revert-'));
  actionsDir = join(root, 'actions');
  groupsPath = join(root, 'permission-groups.json');
  permissionGroups = {
    core: { description: 'c', alwaysAllow: ['ToolSearch'], alwaysAllowBashPatterns: ['^cat '], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    read: { description: 'r', alwaysAllow: ['Read'], alwaysAllowBashPatterns: ['^rg(\\s|$)'], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    push: { description: 'p', alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
  };
  writeFileSync(groupsPath, JSON.stringify(permissionGroups, null, 2) + '\n');
  writeAction('thing', ['read']);
  registry = new ActionRegistry(actionsDir, { permissionGroups });
  registry.load();
  revisions = new PermissionGroupRevisionsStore(join(root, 'revisions.jsonl'));
  mountRoutes();
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('GET /api/permission-groups/:name/revisions', () => {
  it('returns revisions newest first', async () => {
    await putHandler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^rg(\\s|$)', '^find(\\s|$)'] },
    }), fakeRes().res);
    await putHandler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^rg(\\s|$)', '^find(\\s|$)', '^sed(\\s|$)'] },
    }), fakeRes().res);

    const { res, out } = fakeRes();
    await revisionsHandler(fakeReq('/api/permission-groups/read/revisions'), res);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { revisions: Array<{ after: PermissionGroup }> };
    expect(body.revisions).toHaveLength(2);
    // Newest first: the second PUT's `after` (three patterns) comes before the first's (two).
    expect(body.revisions[0]!.after.alwaysAllowBashPatterns).toHaveLength(3);
    expect(body.revisions[1]!.after.alwaysAllowBashPatterns).toHaveLength(2);
  });

  it('tolerates a query string on the url', async () => {
    const { res, out } = fakeRes();
    await revisionsHandler(fakeReq('/api/permission-groups/read/revisions?x=1'), res);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ revisions: [] });
  });
});

describe('POST /api/permission-groups/:name/revert/:revisionId', () => {
  it('404s on an unknown revision id', async () => {
    const { res, out } = fakeRes();
    await revertHandler(fakeReq('/api/permission-groups/read/revert/no-such-id'), res);
    expect(out.status).toBe(404);
  });

  it('404s when the revision belongs to a different group', async () => {
    await putHandler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^rg(\\s|$)', '^find(\\s|$)'] },
    }), fakeRes().res);
    const readRev = revisions.list('read')[0]!;

    const { res, out } = fakeRes();
    // Same revision id, but requested against `push` instead of `read`.
    await revertHandler(fakeReq(`/api/permission-groups/push/revert/${readRev.id}`), res);
    expect(out.status).toBe(404);
  });

  it('applies the reverted-to revision and records a new revision with revertOf set', async () => {
    // Two edits: rev1 lands `find`, rev2 layers `sed` on top. Reverting to rev1 restores
    // its `after` (rg + find), discarding rev2's `sed` — a real change, not a no-op.
    await putHandler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^rg(\\s|$)', '^find(\\s|$)'] },
    }), fakeRes().res);
    const rev1 = revisions.list('read')[0]!;
    await putHandler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^rg(\\s|$)', '^find(\\s|$)', '^sed(\\s|$)'] },
    }), fakeRes().res);
    expect(permissionGroups.read!.alwaysAllowBashPatterns).toContain('^sed(\\s|$)');

    const { res, out } = fakeRes();
    await revertHandler(fakeReq(`/api/permission-groups/read/revert/${rev1.id}`), res);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { ok: true; group: PermissionGroup };
    expect(body.group.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)', '^find(\\s|$)']);
    expect(permissionGroups.read!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)', '^find(\\s|$)']);
    expect(registry.getAction('read.thing')!.allowlist.alwaysAllowBashPatterns).not.toContain('^sed(\\s|$)');

    const all = revisions.list('read');
    expect(all).toHaveLength(3);
    expect(all[0]!.revertOf).toBe(rev1.id);
    expect(all[0]!.after.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)', '^find(\\s|$)']);
  });

  it('returns 400 and does not apply when the current lint refuses the snapshot', async () => {
    // Simulate a revision recorded before a lint rule tightened: hand-craft a `before`
    // snapshot the current validateGroupUpdate rejects, then try to revert to it.
    const staleRev = revisions.record({
      group: 'read', author: 'user',
      before: permissionGroups.read!,
      after: { ...permissionGroups.read!, alwaysAllowBashPatterns: ['^gh(\\s|$)'] },
    });

    const { res, out } = fakeRes();
    await revertHandler(fakeReq(`/api/permission-groups/read/revert/${staleRev.id}`), res);
    expect(out.status).toBe(400);
    expect(out.body).toMatch(/gated/i);
    // Untouched: still the original rule, no new revision recorded.
    expect(permissionGroups.read!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)']);
    expect(revisions.list('read')).toHaveLength(1);
  });
});
