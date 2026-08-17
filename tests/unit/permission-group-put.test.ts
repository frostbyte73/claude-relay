import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerMetaRoutes, validateGroupUpdate, type MetaRoutesDeps } from '../../src/routes/meta.js';
import type { Server } from '../../src/server.js';
import { ActionRegistry } from '../../src/actions/index.js';
import type { PermissionGroup, PermissionGroupMap } from '../../src/actions/types.js';
import { PermissionGroupRevisionsStore } from '../../src/storage/permission-group-revisions-store.js';
import { assertNotWriteShaped, classifyRuleShape, classifyInterpreterShape, classifyHttpWriteShape } from '../../src/permissions/write-shape.js';
import type { RuleKind } from '../../src/permissions/allowlist.js';

const G = (patterns: string[]): PermissionGroup => ({
  description: 'd',
  alwaysAllow: [], alwaysAllowBashPatterns: patterns,
  alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
});

function forKind(kind: RuleKind, value: string): PermissionGroup {
  const g = G([]);
  if (kind === 'tool') g.alwaysAllow = [value];
  else if (kind === 'bash') g.alwaysAllowBashPatterns = [value];
  else if (kind === 'mcp') g.alwaysAllowMcpPatterns = [value];
  else g.alwaysAllowPathPatterns = [value];
  return g;
}

describe('validateGroupUpdate', () => {
  it('accepts a read rule into a non-gated group', () => {
    expect(validateGroupUpdate('read', G(['^sed(\\s|$)']))).toEqual({ ok: true });
  });

  it('refuses a write-shaped rule into a non-gated group', () => {
    const r = validateGroupUpdate('read', G(['^gh(\\s|$)']));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/gated/i);
  });

  it('permits a write-shaped rule into the gated push group', () => {
    expect(validateGroupUpdate('push', G(['^gh pr merge [0-9]+ --squash$']))).toEqual({ ok: true });
    expect(validateGroupUpdate('push', G(['^git push origin [A-Za-z0-9._/-]+$']))).toEqual({ ok: true });
  });

  // The two above are narrow enough that no classifier fires at all, so they never reach the
  // gated branch. `^gh pr merge ` spans WRITE_PROBES' `gh pr merge 12 --admin` — the branch
  // this whole validator exists for.
  it('permits a genuinely write-shaped rule into push and refuses it elsewhere', () => {
    expect(classifyRuleShape('bash', '^gh pr merge ').writeShaped).toBe(true);
    expect(validateGroupUpdate('push', G(['^gh pr merge '])).ok).toBe(true);
    expect(validateGroupUpdate('read', G(['^gh pr merge '])).ok).toBe(false);
  });

  it('refuses a pattern that does not compile, in any group', () => {
    expect(validateGroupUpdate('push', G(['^git push ('])).ok).toBe(false);
    expect(validateGroupUpdate('read', G(['^git push ('])).ok).toBe(false);
  });

  it('refuses an unanchored interpreter even in the gated group', () => {
    // Anchoring is about arbitrary code execution, which the pin cannot inspect —
    // gating does not redeem it.
    const r = validateGroupUpdate('push', G(['^node(\\s|$)']));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/interpreter|anchor/i);
  });

  it('refuses an unknown group name', () => {
    expect(validateGroupUpdate('nope', G(['^ls'])).ok).toBe(false);
  });
});

// The group editor and addRule are two doors onto the same allowlist; the editor is the more
// privileged one. If it ever runs fewer checks than assertNotWriteShaped, it becomes the way
// to install a write rule that skips the write-draft pin entirely.
const DRIFT_TABLE: Array<{ kind: RuleKind; value: string; caughtBy: 'rule' | 'interpreter' | 'http' | null }> = [
  { kind: 'bash', value: '^gh(\\s|$)', caughtBy: 'rule' },
  { kind: 'bash', value: '^git ', caughtBy: 'rule' },
  { kind: 'tool', value: 'Bash', caughtBy: 'rule' },
  { kind: 'mcp', value: '^mcp__github__(create|merge)', caughtBy: 'rule' },
  { kind: 'bash', value: '^node(\\s|$)', caughtBy: 'interpreter' },
  { kind: 'bash', value: '^python3 -c "print(1)"$', caughtBy: 'interpreter' },
  { kind: 'bash', value: '^ruby /tmp/run\\.rb .*$', caughtBy: 'interpreter' },
  // The shape an interpreter grant is supposed to take: anchored, no eval flag, no wildcard.
  { kind: 'bash', value: '^bash /tmp/[A-Za-z0-9_.-]+$', caughtBy: null },
  // Reaches classifyHttpWriteShape only: too narrow for any WRITE_PROBES entry to match.
  { kind: 'bash', value: '^gh api --method PATCH repos/\\{owner\\}/\\{repo\\}/pulls/[0-9]+$', caughtBy: 'http' },
  { kind: 'bash', value: '^gh api repos/\\{owner\\}/\\{repo\\}/issues -f title=x$', caughtBy: 'http' },
  { kind: 'bash', value: '^ls -o$', caughtBy: 'http' },
  { kind: 'bash', value: '^sed(\\s|$)', caughtBy: null },
  { kind: 'bash', value: '^rg(\\s|$)', caughtBy: null },
  { kind: 'tool', value: 'Read', caughtBy: null },
  { kind: 'mcp', value: '^mcp__github__(get|list|search)', caughtBy: null },
  { kind: 'path', value: 'Write:^/tmp/', caughtBy: null },
];

describe('the group editor refuses everything addRule refuses', () => {
  for (const { kind, value, caughtBy } of DRIFT_TABLE) {
    it(`${kind} ${value}`, () => {
      const classifiers = {
        rule: classifyRuleShape, interpreter: classifyInterpreterShape, http: classifyHttpWriteShape,
      };
      if (caughtBy) expect(classifiers[caughtBy](kind, value).writeShaped).toBe(true);

      let threw = false;
      try { assertNotWriteShaped(kind, value); } catch { threw = true; }
      expect(threw).toBe(caughtBy !== null);
      // Same verdict, both doors — for a non-gated group the two must agree exactly.
      expect(validateGroupUpdate('read', forKind(kind, value)).ok).toBe(!threw);
    });
  }
});

describe('every shipped group survives its own editor', () => {
  const groups = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8')) as PermissionGroupMap;
  for (const name of Object.keys(groups)) {
    it(name, () => {
      const r = validateGroupUpdate(name, groups[name]!);
      expect(r.ok === false ? r.error : 'ok').toBe('ok');
    });
  }
});

// --- route ---

interface Captured { status: number; body: string }

function fakeReq(url: string, body: unknown): IncomingMessage {
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
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

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

function mountRoutes(overrides: Partial<MetaRoutesDeps> = {}): void {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>();
  const server = {
    route(method: string, path: string, h: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
      routes.set(`${method} ${path}`, h);
    },
  } as unknown as Server;
  registerMetaRoutes(server, {
    actionRegistry: registry, permissionGroups, permissionGroupsPath: groupsPath,
    groupRevisions: revisions, ...overrides,
  } as MetaRoutesDeps);
  handler = routes.get('PUT /api/permission-groups/:name')!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-group-put-'));
  actionsDir = join(root, 'actions');
  groupsPath = join(root, 'permission-groups.json');
  permissionGroups = {
    core: { description: 'c', alwaysAllow: ['ToolSearch'], alwaysAllowBashPatterns: ['^cat '], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    read: { description: 'r', alwaysAllow: ['Read'], alwaysAllowBashPatterns: ['^rg(\\s|$)'], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
  };
  writeFileSync(groupsPath, JSON.stringify(permissionGroups, null, 2) + '\n');
  writeAction('thing', ['read']);
  registry = new ActionRegistry(actionsDir, { permissionGroups });
  registry.load();
  revisions = new PermissionGroupRevisionsStore(join(root, 'revisions.jsonl'));
  mountRoutes();
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('PUT /api/permission-groups/:name', () => {
  it('writes the group, reloads the registry, and records one revision', async () => {
    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^rg(\\s|$)', '^find(\\s|$)'] },
      rationale: 'need find',
    }), res);

    expect(out.status).toBe(200);
    expect(registry.getAction('read.thing')!.allowlist.alwaysAllowBashPatterns).toContain('^find(\\s|$)');
    expect(JSON.parse(readFileSync(groupsPath, 'utf8')).read.alwaysAllowBashPatterns).toContain('^find(\\s|$)');
    const revs = revisions.list('read');
    expect(revs).toHaveLength(1);
    expect(revs[0]!.before!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)']);
    expect(revs[0]!.rationale).toBe('need find');
  });

  it('refuses a write-shaped rule with 400 and touches nothing', async () => {
    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^gh(\\s|$)'] },
    }), res);

    expect(out.status).toBe(400);
    expect(out.body).toMatch(/gated/i);
    expect(permissionGroups.read!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)']);
    expect(revisions.list('read')).toHaveLength(0);
  });

  it('rolls back to the old resolution when the reload rejects the new grant', async () => {
    // A malformed action makes every load() throw; the route treats that as a failed apply.
    mkdirSync(join(actionsDir, 'read', 'broken'), { recursive: true });
    writeFileSync(join(actionsDir, 'read', 'broken', 'SKILL.md'), 'no frontmatter here\n');

    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^find(\\s|$)'] },
    }), res);

    expect(out.status).toBe(500);
    expect(permissionGroups.read!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)']);
    // The registry must be serving the OLD resolution, not the rejected one.
    const resolved = registry.getAction('read.thing')!.allowlist.alwaysAllowBashPatterns;
    expect(resolved).toContain('^rg(\\s|$)');
    expect(resolved).not.toContain('^find(\\s|$)');
    expect(revisions.list('read')).toHaveLength(0);
    // The rejected edit must never reach disk either — a reload failure that still wrote the
    // file would silently take effect at the next daemon restart with no audit row.
    const onDisk = JSON.parse(readFileSync(groupsPath, 'utf8')) as PermissionGroupMap;
    expect(onDisk.read!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)']);
    expect(onDisk.read!.alwaysAllowBashPatterns).not.toContain('^find(\\s|$)');
  });

  it('rolls back and records nothing when the config write fails', async () => {
    groupsPath = join(root, 'no-such-dir', 'permission-groups.json');
    mountRoutes();

    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/read', {
      group: { ...permissionGroups.read, alwaysAllowBashPatterns: ['^find(\\s|$)'] },
    }), res);

    expect(out.status).toBe(500);
    expect(existsSync(groupsPath)).toBe(false);
    expect(permissionGroups.read!.alwaysAllowBashPatterns).toEqual(['^rg(\\s|$)']);
    expect(registry.getAction('read.thing')!.allowlist.alwaysAllowBashPatterns).not.toContain('^find(\\s|$)');
    expect(revisions.list('read')).toHaveLength(0);
  });

  it('creates a group that did not exist, with a null before', async () => {
    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/pull', {
      group: { description: 'p', alwaysAllow: ['WebFetch'], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
    }), res);

    expect(out.status).toBe(200);
    expect(revisions.list('pull')[0]!.before).toBeNull();
    expect(permissionGroups.pull!.alwaysAllowPathPatterns).toEqual([]);
  });

  it('rejects a body that is not a group', async () => {
    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/read', { group: { alwaysAllow: ['Read'] } }), res);
    expect(out.status).toBe(400);
  });

  it('tolerates a query string on the url', async () => {
    const { res, out } = fakeRes();
    await handler(fakeReq('/api/permission-groups/read?x=1', { group: permissionGroups.read }), res);
    expect(out.status).toBe(200);
  });
});
