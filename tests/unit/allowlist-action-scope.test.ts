import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ActionsStore } from '../../src/storage/actions-store.js';
import { ActionRegistry } from '../../src/actions/index.js';

function newStore(): ActionsStore {
  return new ActionsStore(join(mkdtempSync(join(tmpdir(), 'act-')), 'actions.json'));
}

const emptyCfg = { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] };

describe('Allowlist — action scope', () => {
  it('action rule allows where global denies', () => {
    // A read-shaped tool, deliberately: mcp__github__add_issue_comment is a genuine external
    // write and assertNotWriteShaped (write-shape.ts) now refuses to add it as an ungated
    // action-scoped rule — this test is about scope leakage, not write-gating, so it needs a
    // fixture addRule will actually accept.
    const store = newStore();
    store.addRule('code.triage-pr-comments', 'mcp', '^mcp__github__list_issues$');
    const a = new Allowlist(emptyCfg, { actionsStore: store });

    expect(a.allows('mcp__github__list_issues', {}, undefined, 'code.triage-pr-comments')).toBe(true);
    expect(a.allows('mcp__github__list_issues', {}, undefined, 'meta.orchestrate')).toBe(false);
    expect(a.allows('mcp__github__list_issues', {})).toBe(false);
  });

  it('addRule with action scope persists via the store', () => {
    const store = newStore();
    const a = new Allowlist(emptyCfg, { actionsStore: store });
    expect(a.addRule('tool', 'Glob', { action: 'code.implement' })).toBe(true);
    expect(store.get('code.implement').allowlist.alwaysAllow).toContain('Glob');
  });

  it('addRule action scope without store throws', () => {
    const a = new Allowlist(emptyCfg);
    // A read tool on purpose: a whole-tool write grant would throw at the write lint instead,
    // and this test is about the missing store.
    expect(() => a.addRule('tool', 'Glob', { action: 'x' })).toThrow(/actionsStore/);
  });

  it('action-registry bundled allowlist allows where global denies', () => {
    // Set up a tiny on-disk action with a colocated allowlist that allows Edit under /tmp.
    // Whole-tool `Edit` — what this bundled the capability as before — is `Edit:^/` in one
    // word, and the registry now refuses to load an action carrying it.
    const root = mkdtempSync(join(tmpdir(), 'act-reg-'));
    const dir = join(root, 'actions', 'code', 'thing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      'name: code.thing',
      'description: test',
      'outpost:',
      '  kind: action',
      '  category: code',
      '  side_effects: none',
      '  runner: claude',
      '---',
      '',
      '# code.thing',
    ].join('\n'));
    writeFileSync(join(dir, 'input.schema.json'), '{"type":"object"}');
    writeFileSync(join(dir, 'output.schema.json'), '{"type":"object"}');
    writeFileSync(join(dir, 'allowlist.json'), JSON.stringify({
      alwaysAllow: [],
      alwaysAllowBashPatterns: [],
      alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: ['Edit:^/tmp/'],
    }));
    const reg = new ActionRegistry(join(root, 'actions'));
    reg.load();

    const a = new Allowlist(emptyCfg, { actionRegistry: reg });

    expect(a.allows('Edit', { file_path: '/tmp/x' }, undefined, 'code.thing')).toBe(true);
    expect(a.allows('Edit', { file_path: '/tmp/x' }, undefined, 'unknown.action')).toBe(false);
    // Without an action name, no action scope is consulted.
    expect(a.allows('Edit', { file_path: '/tmp/x' })).toBe(false);
  });

  it('action-registry + actions-store union for the same name', () => {
    // Bundled action: tool Read. Hot-added rule via actions-store: tool Glob.
    // Both apply when looking up that name.
    const root = mkdtempSync(join(tmpdir(), 'act-reg-'));
    const dir = join(root, 'actions', 'read', 'thing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      'name: read.thing',
      'description: test',
      'outpost:',
      '  kind: action',
      '  category: read',
      '  side_effects: none',
      '  runner: claude',
      '---',
    ].join('\n'));
    writeFileSync(join(dir, 'input.schema.json'), '{"type":"object"}');
    writeFileSync(join(dir, 'output.schema.json'), '{"type":"object"}');
    writeFileSync(join(dir, 'allowlist.json'), JSON.stringify({
      alwaysAllow: ['Read'], alwaysAllowBashPatterns: [],
      alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
    }));
    const reg = new ActionRegistry(join(root, 'actions'));
    reg.load();

    const store = newStore();
    store.addRule('read.thing', 'tool', 'Glob');

    const a = new Allowlist(emptyCfg, { actionRegistry: reg, actionsStore: store });

    expect(a.allows('Read', {}, undefined, 'read.thing')).toBe(true);  // from bundled
    expect(a.allows('Glob', {}, undefined, 'read.thing')).toBe(true);  // from hot-added
    expect(a.allows('Write', {}, undefined, 'read.thing')).toBe(false);
  });

  it('sessionWorktreePath auto-allows path tools inside the worktree, nowhere else', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-scope-'));
    const a = new Allowlist(emptyCfg);

    // Under the worktree: allow. Sibling with a shared prefix: deny (no boundary confusion).
    expect(a.allows('Edit', { file_path: join(root, 'foo.ts') }, undefined, undefined, root)).toBe(true);
    expect(a.allows('Write', { file_path: join(root, 'nested/bar.ts') }, undefined, undefined, root)).toBe(true);
    expect(a.allows('Edit', { file_path: `${root}-sibling/foo.ts` }, undefined, undefined, root)).toBe(false);

    // Non-path tools ignore the scope.
    expect(a.allows('Bash', { command: 'ls' }, undefined, undefined, root)).toBe(false);

    // Without a scope, no scope-based allow fires.
    expect(a.allows('Edit', { file_path: join(root, 'foo.ts') })).toBe(false);
  });

  it('sessionWorktreePath rejects `..` traversal out of scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-scope-'));
    const a = new Allowlist(emptyCfg);
    // String prefix trick: resolves to /etc/passwd after collapsing `..`.
    expect(a.allows('Edit', { file_path: `${root}/../../../etc/passwd` }, undefined, undefined, root)).toBe(false);
    expect(a.allows('Write', { file_path: `${root}/nested/../../etc/hosts` }, undefined, undefined, root)).toBe(false);
    // Legitimate `..` that stays within scope still allows.
    mkdirSync(join(root, 'a'));
    expect(a.allows('Edit', { file_path: `${root}/a/../b.ts` }, undefined, undefined, root)).toBe(true);
  });

  it('sessionWorktreePath rejects symlink escapes out of scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-scope-'));
    const outside = mkdtempSync(join(tmpdir(), 'wt-outside-'));
    symlinkSync(outside, join(root, 'escape'));
    const a = new Allowlist(emptyCfg);
    // Realpath resolves the existing symlink before the prefix compare.
    expect(a.allows('Edit', { file_path: join(root, 'escape', 'file.ts') }, undefined, undefined, root)).toBe(false);
    expect(a.allows('Write', { file_path: join(root, 'escape', 'new-file.ts') }, undefined, undefined, root)).toBe(false);
    // Files directly under the worktree still allow.
    expect(a.allows('Edit', { file_path: join(root, 'legit.ts') }, undefined, undefined, root)).toBe(true);
  });
});
