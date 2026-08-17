import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ActionsStore } from '../../src/storage/actions-store.js';
import { handleHook } from '../../src/permissions/hook-handler.js';
import { ApprovalModeStore } from '../../src/permissions/approval-mode.js';

const EMPTY = {
  alwaysAllow: [], alwaysAllowBashPatterns: [],
  alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
};

describe('spec pin #2: a write-shaped rule is refused at every non-gated destination', () => {
  it('refuses at global scope', () => {
    const al = new Allowlist({ ...EMPTY });
    expect(() => al.addRule('bash', '^gh(\\s|$)', 'global')).toThrow(/gh/i);
  });

  it('refuses at session scope', () => {
    const al = new Allowlist({ ...EMPTY });
    expect(() => al.addRule('bash', '^git ', { session: 's1' })).toThrow(/git/i);
  });

  it('refuses at action scope, through the ActionsStore delegation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new ActionsStore(join(dir, 'actions.json'));
    const al = new Allowlist({ ...EMPTY }, { actionsStore: store });
    expect(() => al.addRule('bash', '^gh(\\s|$)', { action: 'code.merge-pr' }))
      .toThrow(/gh/i);
    expect(store.get('code.merge-pr').allowlist.alwaysAllowBashPatterns).toEqual([]);
  });

  it('refuses when proposal-apply calls ActionsStore.addRule directly', () => {
    // routes/actions.ts:559 bypasses Allowlist entirely on proposal approval — this is
    // the path that would otherwise let meta.improve-actions install an ungated write.
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new ActionsStore(join(dir, 'actions.json'));
    expect(() => store.addRule('code.merge-pr', 'bash', '^gh(\\s|$)'))
      .toThrow(/gh/i);
  });

  it('still permits an ordinary read rule at every scope', () => {
    const al = new Allowlist({ ...EMPTY });
    expect(al.addRule('bash', '^sed(\\s|$)', 'global')).toBe(true);
    expect(al.addRule('bash', '^rg(\\s|$)', { session: 's1' })).toBe(true);
  });
});

describe('spec pin #3: a broad action-scoped rule cannot un-gate an admin merge', () => {
  const PUSH = {
    ...EMPTY,
    alwaysAllowBashPatterns: ['^gh pr merge [0-9]+ --squash$'],
  };

  function run(command: string, allowlist: Allowlist) {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'ask');
    return handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command }, session_id: 's1' },
      allowlist,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      actionForSession: () => 'code.merge-pr',
      gatedForAction: () => PUSH,
      onNotify: () => {},
    });
  }

  it('refuses to install the broad rule in the first place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new ActionsStore(join(dir, 'actions.json'));
    const al = new Allowlist({ ...EMPTY }, { actionsStore: store });
    expect(() => al.addRule('bash', '^gh(\\s|$)', { action: 'code.merge-pr' })).toThrow();
  });

  it('denies the admin merge with no broad rule present', async () => {
    const al = new Allowlist({ ...EMPTY });
    const res = await run('gh pr merge 12 --admin', al);
    expect(res.hookSpecificOutput?.permissionDecision).not.toBe('allow');
  });
});

describe('a colocated allowlist.json cannot smuggle a write past the registry', () => {
  it('fails the action load with the lint reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reg-'));
    const dir = join(root, 'code', 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'),
      '---\nname: code.bad\ndescription: d\noutpost:\n  runner: claude\n  kind: action\n'
      + '  category: code\n  side_effects: none\n  permissions: [read]\n---\nbody\n');
    writeFileSync(join(dir, 'input.schema.json'), '{"type":"object"}');
    writeFileSync(join(dir, 'output.schema.json'), '{"type":"object"}');
    writeFileSync(join(dir, 'allowlist.json'),
      JSON.stringify({ alwaysAllowBashPatterns: ['^gh(\\s|$)'] }));

    const { ActionRegistry } = await import('../../src/actions/registry.js');
    const groups = JSON.parse(
      (await import('node:fs')).readFileSync('config/permission-groups.default.json', 'utf8'));
    const reg = new ActionRegistry(root, { permissionGroups: groups });
    expect(() => reg.load()).toThrow(/gh/i);
  });
});
