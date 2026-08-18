import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDenialVerdict, fixActionFeedback, type FixStarter, type VerdictRequestBody,
} from '../../src/routes/actions.js';
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

// Records every startFix call so a `fix-action` verdict can be checked for actually queuing the
// action-builder edit — the real FixStarter is a closure over a SessionManager, so the spawn
// itself is out of scope here; that it is CALLED, with the denial in its feedback, is not.
let fixCalls: Array<{ actionName: string; feedback: string }>;
let fixResult: ReturnType<FixStarter>;

function resolve(actionName: string, denialId: string, body: VerdictRequestBody) {
  return resolveDenialVerdict({
    denialsStore, permissionGroups, applyGroup,
    inheritedGroups: (name) => registry.inheritedGroups(name),
    startFix: (name, feedback) => { fixCalls.push({ actionName: name, feedback }); return fixResult; },
  }, actionName, denialId, body);
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
  // `read.thing` declares every group the promote tests target, because a promote into a group
  // the action does NOT inherit is now refused outright — those tests are about the gated-group
  // privilege check, and they'd otherwise be short-circuited by the inheritance check instead.
  // `read.narrow` is the action that inherits only `read`, for the inheritance check itself.
  writeAction(actionsDir, 'thing', ['read', 'pull', 'push']);
  writeAction(actionsDir, 'narrow', ['read']);
  registry = new ActionRegistry(actionsDir, { permissionGroups });
  registry.load();
  revisions = new PermissionGroupRevisionsStore(join(root, 'revisions.jsonl'));
  applyGroup = createGroupApplier({
    actionRegistry: registry, permissionGroups, permissionGroupsPath: groupsPath, groupRevisions: revisions,
  });
  denialsStore = new DenialsStore(denialsPath);
  fixCalls = [];
  fixResult = { ok: true, sessionId: 'edit-session-1' };
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

  it("the improver's fix-action records the verdict, grants nothing, and queues no builder session", () => {
    const denial = recordDenial();
    // No decidedBy supplied — the failed-closed default is 'improver', which must NOT spawn an
    // edit session: shellArtifactVerdict auto-stamps this disposition at record time, and one
    // builder session per malformed `cd` would be a session storm nobody asked for.
    const r = resolve('read.thing', denial.id, { disposition: 'fix-action', reason: 'malformed command' });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(denial.verdict).toMatchObject({ disposition: 'fix-action', decidedBy: 'improver' });
    expect(permissionGroups.pull).toEqual(expect.objectContaining({ alwaysAllowBashPatterns: ['^gh pr view '] }));
    expect(revisions.list('pull')).toHaveLength(0);
    expect(fixCalls).toEqual([]);
  });

  // The whole point of the disposition: it grants nothing, so if it also queues nothing it is
  // just a delete — unresolved() keys on verdict presence, so the stamp alone removes the
  // denial from the only evidence meta.improve-actions reads.
  it("a user's fix-action queues an action-builder edit carrying the blocked call", () => {
    const denial = recordDenial({ toolInput: { command: 'helm history my-release' } });
    const r = resolve('read.thing', denial.id, {
      disposition: 'fix-action', reason: 'should read the manifest instead', decidedBy: 'user',
    });
    expect(r).toMatchObject({ ok: true, status: 200, editSessionId: 'edit-session-1' });
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0]!.actionName).toBe('read.thing');
    expect(fixCalls[0]!.feedback).toContain('helm history my-release');
    expect(fixCalls[0]!.feedback).toContain('should read the manifest instead');
    expect(denial.verdict).toMatchObject({ disposition: 'fix-action', decidedBy: 'user' });
  });

  it('leaves the denial unresolved when the builder session cannot be started', () => {
    const denial = recordDenial();
    fixResult = { ok: false, status: 404, error: 'no such action' };
    const r = resolve('read.thing', denial.id, { disposition: 'fix-action', decidedBy: 'user' });
    expect(r).toMatchObject({ ok: false, status: 404 });
    // Evidence intact: a failed spawn must not consume the denial.
    expect(denial.verdict).toBeUndefined();
    expect(denialsStore.unresolved('read.thing')).toHaveLength(1);
  });

  it('tells the builder not to ask for allowlist additions', () => {
    const denial = recordDenial();
    const feedback = fixActionFeedback(denial, '');
    expect(feedback).toContain('Do NOT propose allowlist additions');
    expect(feedback).toContain('^gh pr view ');
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

  // The reproduced bug: read.narrow inherits only `read`, so promoting its denial into `edit`
  // answered 200 — the denial vanished from Pending, `edit` was permanently widened for every
  // action that DOES inherit it, and the original call stayed blocked. A verdict that unblocks
  // nothing must not be reachable, and it must not consume the evidence either.
  it('refuses a promote into a group the action does not inherit, writing nothing', () => {
    const denial = recordDenial({
      actionName: 'read.narrow',
      toolInput: { command: 'gh pr view 12' },
    });
    const r = resolve('read.narrow', denial.id, {
      disposition: 'promote', group: 'pull',
      rule: { kind: 'bash', value: '^gh pr view [0-9]+$' },
      reason: 'recurring view', decidedBy: 'user',
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toContain('does not inherit');
    // Names what it DOES inherit, so the refusal is actionable rather than a dead end.
    expect((r as { error: string }).error).toContain('core, read');
    expect(permissionGroups.pull!.alwaysAllowBashPatterns).toEqual(['^gh pr view ']);
    expect(revisions.list('pull')).toHaveLength(0);
    expect(denial.verdict).toBeUndefined();
    expect(denialsStore.unresolved('read.narrow')).toHaveLength(1);
  });

  it('allows a promote into the implicit core group, which every claude action does inherit', () => {
    const denial = recordDenial({ actionName: 'read.narrow', toolInput: { command: 'jq -r .x f' }, suggested: { kind: 'bash', value: '^jq ' } });
    const r = resolve('read.narrow', denial.id, {
      disposition: 'promote', group: 'core',
      rule: { kind: 'bash', value: '^jq -r [^|;&]+$' },
      reason: 'envelope read', decidedBy: 'user',
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(permissionGroups.core!.alwaysAllowBashPatterns).toContain('^jq -r [^|;&]+$');
  });

  it('409s a promote for an action that has left the catalog', () => {
    const denial = recordDenial({ actionName: 'read.deleted' });
    const r = resolve('read.deleted', denial.id, {
      disposition: 'promote', group: 'read',
      rule: { kind: 'bash', value: '^gh pr view [0-9]+$' },
      reason: 'stale', decidedBy: 'user',
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(denial.verdict).toBeUndefined();
    // `never` is still available — a stale denial has to be resolvable somehow.
    expect(resolve('read.deleted', denial.id, { disposition: 'never', reason: 'action gone' }))
      .toMatchObject({ ok: true, status: 200 });
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
