import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ActionsStore } from '../../src/storage/actions-store.js';
import { encodeRuleId, decodeRuleId } from '../../src/routes/meta.js';

function empty(): Allowlist {
  return new Allowlist({ alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] });
}

describe('Allowlist — session scope', () => {
  it('session rules apply only to the granting session', () => {
    const a = empty();
    a.addRule('bash', '^kubectl get pod ', { session: 'sess-1' });
    expect(a.allows('Bash', { command: 'kubectl get pod x' }, undefined, undefined, undefined, 'sess-1')).toBe(true);
    expect(a.allows('Bash', { command: 'kubectl get pod x' }, undefined, undefined, undefined, 'sess-2')).toBe(false);
    expect(a.allows('Bash', { command: 'kubectl get pod x' })).toBe(false);
  });

  it('clearSession revokes the grants', () => {
    const a = empty();
    a.addRule('tool', 'DangerousTool', { session: 'sess-1' });
    expect(a.allows('DangerousTool', {}, undefined, undefined, undefined, 'sess-1')).toBe(true);
    a.clearSession('sess-1');
    expect(a.allows('DangerousTool', {}, undefined, undefined, undefined, 'sess-1')).toBe(false);
  });

  it('never persists session rules to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-sess-'));
    const a = new Allowlist(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    a.addRule('tool', 'DangerousTool', { session: 'sess-1' });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('dedupes within a session', () => {
    const a = empty();
    expect(a.addRule('tool', 'X', { session: 's' })).toBe(true);
    expect(a.addRule('tool', 'X', { session: 's' })).toBe(false);
  });
});

describe('Allowlist — removeRule', () => {
  it('removes a global rule so it no longer allows', () => {
    // Plain placeholder command, deliberately not one of the scoped file ops
    // (allowlist-fileop-scope.test.ts owns that behaviour) — this test is only about
    // addRule/removeRule toggling a bash pattern.
    const a = empty();
    a.addRule('bash', '^echo ', 'global');
    expect(a.allows('Bash', { command: 'echo hi' })).toBe(true);
    expect(a.removeRule('bash', '^echo ', 'global')).toBe(true);
    expect(a.allows('Bash', { command: 'echo hi' })).toBe(false);
    expect(a.removeRule('bash', '^echo ', 'global')).toBe(false);
  });

  it('removes a project rule and re-persists the project file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-rm-'));
    const a = new Allowlist(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { projectAllowlistDir: dir },
    );
    const projCwd = '/tmp/projX';
    a.addRule('tool', 'DangerousTool', { project: projCwd });
    const file = join(dir, `${projCwd.replace(/\//g, '-')}.json`);
    expect(existsSync(file)).toBe(true);
    expect(a.removeRule('tool', 'DangerousTool', { project: projCwd })).toBe(true);
    expect(a.allows('DangerousTool', {}, projCwd)).toBe(false);
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { alwaysAllow: string[] };
    expect(persisted.alwaysAllow).toHaveLength(0);
  });

  it('keeps pattern sources and compiled regexes aligned after removal', () => {
    const a = empty();
    a.addRule('bash', '^first ', 'global');
    a.addRule('bash', '^second ', 'global');
    a.removeRule('bash', '^first ', 'global');
    expect(a.allows('Bash', { command: 'second thing' })).toBe(true);
    expect(a.allows('Bash', { command: 'first thing' })).toBe(false);
  });

  // F4 fix round: removeRule now delegates action scope to ActionsStore.removeRule (which
  // exists — the old comment predated it), the same way addRule already delegates addition.
  it('delegates action scope to ActionsStore', () => {
    const store = new ActionsStore(join(mkdtempSync(join(tmpdir(), 'al-rm-action-')), 'actions.json'));
    const a = new Allowlist(
      { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [] },
      { actionsStore: store },
    );
    a.addRule('tool', 'X', { action: 'read.investigate' });
    expect(a.removeRule('tool', 'X', { action: 'read.investigate' })).toBe(true);
    expect(store.get('read.investigate').allowlist.alwaysAllow).not.toContain('X');
    expect(a.removeRule('tool', 'X', { action: 'read.investigate' })).toBe(false);
  });

  it('throws for action scope with no actionsStore configured, same as addRule', () => {
    const a = empty();
    expect(() => a.removeRule('tool', 'X', { action: 'read.investigate' })).toThrow(/actionsStore/);
  });
});

describe('rule id encode/decode', () => {
  it('round-trips global, project, and action scopes', () => {
    const cases = [
      { kind: 'bash' as const, value: '^git push ', scope: 'global' as const },
      { kind: 'tool' as const, value: 'Write', scope: { project: '/Users/x/repo' } },
      { kind: 'mcp' as const, value: '^mcp__linear__', scope: { action: 'read.linear-issue' } },
      { kind: 'path' as const, value: 'Write:^/tmp/', scope: 'global' as const },
    ];
    for (const c of cases) {
      const id = encodeRuleId(c.kind, c.value, c.scope);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeRuleId(id)).toEqual(c);
    }
  });

  it('rejects malformed ids', () => {
    expect(decodeRuleId('not-base64-json')).toBeNull();
    expect(decodeRuleId(Buffer.from('{"a":1}').toString('base64url'))).toBeNull();
    expect(decodeRuleId(Buffer.from(JSON.stringify(['tool', 'X', 'bogus:scope'])).toString('base64url'))).toBeNull();
  });
});

describe('Allowlist — path rules and traversal', () => {
  function withWriteRule(): Allowlist {
    const a = new Allowlist({
      alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: ['Write:^/tmp/'],
    });
    return a;
  }

  it('normalises an absolute path before matching, so .. cannot walk out of the prefix', () => {
    const a = withWriteRule();
    expect(a.allows('Write', { file_path: '/tmp/scratch.json' })).toBe(true);
    for (const p of [
      '/tmp/../etc/crontab',
      '/tmp/../../etc/crontab',
      '/tmp/a/../../root/.ssh/authorized_keys',
      '/tmp/./../etc/hosts',
    ]) {
      expect(a.allows('Write', { file_path: p }), p).toBe(false);
    }
  });

  it('leaves a relative path as written — an absolute-anchored rule then denies it', () => {
    const a = withWriteRule();
    expect(a.allows('Write', { file_path: 'tmp/x' })).toBe(false);
    expect(a.allows('Write', { file_path: '../etc/x' })).toBe(false);
  });

  it('still matches a path that only looks traversal-ish', () => {
    const a = withWriteRule();
    expect(a.allows('Write', { file_path: '/tmp/a..b/c' })).toBe(true);
    expect(a.allows('Write', { file_path: '/tmp/nested/../other.txt' })).toBe(true);
  });
});
