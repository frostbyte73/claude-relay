// @ts-expect-error — plain-JS PWA module
import { groupCards, groupContents, grantRows, pendingRows } from '../../src/pwa/vm/permissions.js';
import { describe, it, expect } from 'vitest';

const GROUPS = [
  { name: 'push', description: 'External writes', actionCount: 4, alwaysAllow: [], alwaysAllowBashPatterns: ['^git push \\S+ \\S+$'], alwaysAllowMcpPatterns: ['^mcp__github__create_pull_request$'], alwaysAllowPathPatterns: [] },
  { name: 'read', description: 'Local reads', actionCount: 9, alwaysAllow: ['Read', 'Glob'], alwaysAllowBashPatterns: ['^ls(\\s|$)'], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
];

describe('groupCards', () => {
  it('orders core,read,pull,edit,push and marks the gated one', () => {
    const cards = groupCards(GROUPS);
    expect(cards.map((c: any) => c.name)).toEqual(['read', 'push']);
    expect(cards.find((c: any) => c.name === 'push').gated).toBe(true);
    expect(cards.find((c: any) => c.name === 'read').gated).toBe(false);
  });

  it('counts rules across all four kinds', () => {
    expect(groupCards(GROUPS).find((c: any) => c.name === 'push').ruleCount).toBe(2);
  });
});

describe('groupContents', () => {
  it('groups by kind with stable kind order and preserves each rule index', () => {
    const sections = groupContents(GROUPS[1]);
    expect(sections.map((s: any) => s.kind)).toEqual(['tool', 'bash']);
    expect(sections[0].rules).toEqual([
      { kind: 'tool', value: 'Read', index: 0 },
      { kind: 'tool', value: 'Glob', index: 1 },
    ]);
  });

  it('omits kinds with no rules rather than rendering empty sections', () => {
    expect(groupContents(GROUPS[0]).map((s: any) => s.kind)).toEqual(['bash', 'mcp']);
  });
});

describe('grantRows', () => {
  const RULES = [
    { id: 'a1', kind: 'bash', value: '^ls(\\s|$)', scope: 'global', source: '/x/allowlist.json' },
    { id: 'b2', kind: 'bash', value: '^rg ', scope: { project: '/Users/dc/frostbyte73/outpost' }, source: '/x/p.json' },
    { id: 'c3', kind: 'mcp', value: '^mcp__linear__list_issues$', scope: { action: 'read.investigate' }, source: '/x/actions.json' },
  ];

  it('labels scope and marks action-scoped rows as not-editable-here', () => {
    const rows = grantRows(RULES);
    expect(rows.map((r: any) => r.scopeText)).toEqual(['global', 'project · outpost', 'action · read.investigate']);
    expect(rows.map((r: any) => r.editable)).toEqual([true, true, false]);
  });

  it('keeps the server id — revoke and edit both address the rule by it', () => {
    expect(grantRows(RULES)[0].id).toBe('a1');
  });
});

describe('pendingRows', () => {
  const PENDING = {
    mcp: [{ server: 'sentry', unclassified: 3 }, { server: 'github', unclassified: 0 }],
    denials: [
      { action: 'code.implement', id: 'd1', tool: 'Bash', command: 'gh pr view 42', suggested: { kind: 'bash', value: '^gh pr view ' }, count: 4, at: 100 },
      { action: 'read.investigate', id: 'd2', tool: 'Bash', command: 'protoc --es_out ./gen a.proto', suggested: { kind: 'bash', value: '^protoc ' }, count: 1, at: 200 },
    ],
  };

  it('drops servers with nothing unclassified', () => {
    expect(pendingRows(PENDING).mcp.map((r: any) => r.server)).toEqual(['sentry']);
  });

  it('batches denials by action, newest batch first', () => {
    const batches = pendingRows(PENDING).denials;
    expect(batches.map((b: any) => b.action)).toEqual(['read.investigate', 'code.implement']);
    expect(batches[1].rows[0].id).toBe('d1');
  });

  it('reports a total so the nav item can show a warn dot', () => {
    expect(pendingRows(PENDING).total).toBe(5);
  });

  it('is safe on an empty payload', () => {
    expect(pendingRows({})).toEqual({ mcp: [], denials: [], total: 0 });
  });
});
