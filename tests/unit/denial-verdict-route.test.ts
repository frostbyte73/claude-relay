import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDenialVerdict, type VerdictRequestBody } from '../../src/routes/actions.js';
import { createGroupApplier, type GroupApplier } from '../../src/routes/meta.js';
import { ActionRegistry } from '../../src/actions/index.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';
import { PermissionGroupRevisionsStore } from '../../src/storage/permission-group-revisions-store.js';
import { DenialsStore, type ActionDenial } from '../../src/storage/denials-store.js';

// resolveDenialVerdict is exercised against a real ActionRegistry + PermissionGroupRevisionsStore
// (via the same createGroupApplier the group editor uses) rather than a mock, so a rule that
// would fail validateGroupUpdate or a registry reload fails here exactly like it would through
// PUT /api/permission-groups/:name — see permission-group-put.test.ts for the sibling coverage
// of that route.

function writeAction(actionsDir: string, name: string, permissions: string[]): void {
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

let root: string;
let permissionGroups: PermissionGroupMap;
let registry: ActionRegistry;
let revisions: PermissionGroupRevisionsStore;
let applyGroup: GroupApplier;
let denialsStore: DenialsStore;
let denialsPath: string;
let groupsPath: string;

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

function resolve(actionName: string, denialId: string, body: VerdictRequestBody) {
  return resolveDenialVerdict({ denialsStore, permissionGroups, applyGroup }, actionName, denialId, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-denial-verdict-'));
  const actionsDir = join(root, 'actions');
  groupsPath = join(root, 'permission-groups.json');
  denialsPath = join(root, 'denials.json');
  permissionGroups = {
    core: { description: 'c', alwaysAllow: ['ToolSearch'], alwaysAllowBashPatterns: ['^cat '], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    read: { description: 'r', alwaysAllow: ['Read'], alwaysAllowBashPatterns: ['^rg(\\s|$)'], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    pull: { description: 'p', alwaysAllow: [], alwaysAllowBashPatterns: ['^gh pr view '], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    push: { description: 'w', alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
  };
  writeFileSync(groupsPath, JSON.stringify(permissionGroups, null, 2) + '\n');
  writeAction(actionsDir, 'thing', ['read']);
  registry = new ActionRegistry(actionsDir, { permissionGroups });
  registry.load();
  revisions = new PermissionGroupRevisionsStore(join(root, 'revisions.jsonl'));
  applyGroup = createGroupApplier({
    actionRegistry: registry, permissionGroups, permissionGroupsPath: groupsPath, groupRevisions: revisions,
  });
  denialsStore = new DenialsStore(denialsPath);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('resolveDenialVerdict', () => {
  it('404s an unknown action', () => {
    const r = resolve('read.nope', 'whatever', { disposition: 'never', reason: 'x' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('404s an unknown denial id on a known action', () => {
    recordDenial();
    const r = resolve('read.thing', 'not-a-real-id', { disposition: 'never', reason: 'x' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('400s an invalid disposition', () => {
    const denial = recordDenial();
    const r = resolve('read.thing', denial.id, { disposition: 'yolo', reason: 'x' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(denial.verdict).toBeUndefined();
  });

  it('400s a promote missing group', () => {
    const denial = recordDenial();
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', rule: { kind: 'bash', value: '^gh pr view ' }, reason: 'recurring',
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('400s a promote missing rule', () => {
    const denial = recordDenial();
    const r = resolve('read.thing', denial.id, { disposition: 'promote', group: 'pull', reason: 'recurring' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('never persists across a store reopen', () => {
    const denial = recordDenial();
    const r = resolve('read.thing', denial.id, { disposition: 'never', reason: 'not worth granting' });
    expect(r).toMatchObject({ ok: true, status: 200 });

    const reopened = new DenialsStore(denialsPath);
    const persisted = reopened.list('read.thing').find((d) => d.id === denial.id);
    expect(persisted?.verdict).toMatchObject({ disposition: 'never', reason: 'not worth granting' });
    expect(reopened.unresolved('read.thing')).toHaveLength(0);
  });

  it('fix-action records the verdict and writes nothing else', () => {
    const denial = recordDenial();
    // No decidedBy supplied — fix-action doesn't gate on it, so the failed-closed default
    // ('improver') is fine to record here; this is just proving nothing else got touched.
    const r = resolve('read.thing', denial.id, { disposition: 'fix-action', reason: 'malformed command' });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(denial.verdict).toMatchObject({ disposition: 'fix-action', decidedBy: 'improver' });
    expect(permissionGroups.pull).toEqual(expect.objectContaining({ alwaysAllowBashPatterns: ['^gh pr view '] }));
    expect(revisions.list('pull')).toHaveLength(0);
  });

  it('treats an absent decidedBy as improver, so a gated promote is refused by default', () => {
    const denial = recordDenial({ toolInput: { command: 'gh pr merge 12 --squash' }, suggested: { kind: 'bash', value: '^gh pr merge ' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'push',
      rule: { kind: 'bash', value: '^gh pr merge [0-9]+ --squash$' },
      reason: 'recurring merge',
      // decidedBy omitted entirely — must fail closed, not default to the privileged 'user'.
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(permissionGroups.push!.alwaysAllowBashPatterns).toEqual([]);
    expect(revisions.list('push')).toHaveLength(0);
    expect(denial.verdict).toBeUndefined();
  });

  it('treats a malformed decidedBy the same as absent — improver, refused for a gated promote', () => {
    const denial = recordDenial({ toolInput: { command: 'gh pr merge 12 --squash' }, suggested: { kind: 'bash', value: '^gh pr merge ' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'push',
      rule: { kind: 'bash', value: '^gh pr merge [0-9]+ --squash$' },
      reason: 'recurring merge', decidedBy: 'Bob',
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a promote into push from the improver, writing nothing', () => {
    const denial = recordDenial({ toolInput: { command: 'gh pr merge 12 --squash' }, suggested: { kind: 'bash', value: '^gh pr merge ' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'push',
      rule: { kind: 'bash', value: '^gh pr merge [0-9]+ --squash$' },
      reason: 'recurring merge', decidedBy: 'improver',
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(permissionGroups.push!.alwaysAllowBashPatterns).toEqual([]);
    expect(revisions.list('push')).toHaveLength(0);
    expect(denial.verdict).toBeUndefined();
  });

  it('applies a promote into push from the user, recording a revision', () => {
    const denial = recordDenial({ toolInput: { command: 'gh pr merge 12 --squash' }, suggested: { kind: 'bash', value: '^gh pr merge ' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'push',
      rule: { kind: 'bash', value: '^gh pr merge [0-9]+ --squash$' },
      reason: 'recurring merge', decidedBy: 'user',
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(permissionGroups.push!.alwaysAllowBashPatterns).toContain('^gh pr merge [0-9]+ --squash$');
    expect(revisions.list('push')).toHaveLength(1);
    expect(denial.verdict).toMatchObject({ disposition: 'promote', group: 'push', decidedBy: 'user' });
  });

  it('a promote into a non-gated group does not require decidedBy user', () => {
    const denial = recordDenial({ toolInput: { command: 'gh pr view 99' }, suggested: { kind: 'bash', value: '^gh pr view ' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'read',
      rule: { kind: 'bash', value: '^gh pr view [0-9]+$' },
      reason: 'recurring view', decidedBy: 'improver',
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it('refuses a rule that fails lintPermissionRule, writing nothing', () => {
    const denial = recordDenial();
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'pull',
      rule: { kind: 'bash', value: '^gh(\\s|$)' },
      reason: 'too broad', decidedBy: 'user',
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(permissionGroups.pull!.alwaysAllowBashPatterns).toEqual(['^gh pr view ']);
    expect(revisions.list('pull')).toHaveLength(0);
    expect(denial.verdict).toBeUndefined();
  });

  it('refuses a write-shaped rule aimed at a gated group anyway when decidedBy is the improver', () => {
    // Even a rule that WOULD pass lint in push must not be applied on the improver's say-so.
    const denial = recordDenial({ toolInput: { command: 'git push origin main --force' }, suggested: { kind: 'bash', value: '^git push ' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'promote', group: 'push',
      rule: { kind: 'bash', value: '^git push origin [A-Za-z0-9._/-]+$' },
      reason: 'recurring push', decidedBy: 'improver',
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(permissionGroups.push!.alwaysAllowBashPatterns).toEqual([]);
  });
});
