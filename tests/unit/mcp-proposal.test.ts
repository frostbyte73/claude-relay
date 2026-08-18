import { describe, it, expect } from 'vitest';
import { proposeForServer } from '../../src/permissions/mcp-proposal.js';
import { classifyTool } from '../../src/permissions/tool-classify.js';
import { lintPermissionRule } from '../../src/permissions/write-shape.js';
import type { CatalogResult, McpTool } from '../../src/integrations/mcp-catalog.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';
import realGroups from '../../config/permission-groups.default.json' with { type: 'json' };

function emptyGroup() {
  return { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] };
}

function ok(server: string, tools: McpTool[]): CatalogResult {
  return { server, status: 'ok', tools };
}

const noGrants: PermissionGroupMap = { pull: emptyGroup(), push: emptyGroup() };

describe('proposeForServer — prefixing before classification', () => {
  it('classifies differently as a local name vs. the full mcp__server__tool name', () => {
    // get_issue looks like a read either way — pick a tool whose LOCAL name alone can't be
    // told apart from noise, to prove the prefix is actually what drives the verdict.
    const local = classifyTool('get_issue');
    const full = classifyTool('mcp__sentry__get_issue');
    expect(local.effect).toBe('unknown');
    expect(full.effect).toBe('read');

    const proposal = proposeForServer(ok('sentry', [{ name: 'get_issue' }]), noGrants);
    expect(proposal.placements[0]!.tool).toBe('mcp__sentry__get_issue');
    expect(proposal.placements[0]!.effect).toBe('read');
  });
});

describe('proposeForServer — placement', () => {
  it('places a read tool in pull', () => {
    const proposal = proposeForServer(ok('sentry', [{ name: 'list_issues' }]), noGrants);
    expect(proposal.placements[0]).toMatchObject({
      tool: 'mcp__sentry__list_issues', effect: 'read', group: 'pull', alreadyGranted: false,
    });
  });

  it('places a known external-write tool in push', () => {
    const proposal = proposeForServer(ok('github', [{ name: 'merge_pull_request' }]), noGrants);
    expect(proposal.placements[0]).toMatchObject({
      tool: 'mcp__github__merge_pull_request', effect: 'external-write', group: 'push', alreadyGranted: false,
    });
  });

  it('gives an unknown tool group: null and excludes it from every rule', () => {
    const proposal = proposeForServer(ok('sentry', [{ name: 'do_the_thing' }]), noGrants);
    expect(proposal.placements[0]).toMatchObject({ effect: 'unknown', group: null });
    expect(proposal.rules).toHaveLength(0);
  });

  it('never auto-places a local-write or interpreter tool, even though nothing in tool-classify.ts produces those for an mcp__ name today', () => {
    // classifyTool only returns local-write/interpreter for plain built-in tool names or shell
    // commands, never for an mcp__ name — but groupFor's mapping is a defense-in-depth rule
    // about MCP tool placement specifically, not a fact currently reachable through classifyTool.
    // Cover it at the level the rule actually promises: no group besides pull/push is ever
    // produced by proposeForServer, for any tool this server reports.
    const proposal = proposeForServer(
      ok('weird', [{ name: 'get_thing' }, { name: 'update_thing' }, { name: 'nonsense_verb' }]),
      noGrants,
    );
    for (const p of proposal.placements) {
      expect(['pull', 'push', null]).toContain(p.group);
    }
  });
});

describe('proposeForServer — reconciling against existing grants', () => {
  it('marks a tool already covered by an existing pattern as alreadyGranted and excludes it from the rule', () => {
    const groups: PermissionGroupMap = {
      pull: { ...emptyGroup(), alwaysAllowMcpPatterns: ['^mcp__sentry__(get_issue)$'] },
      push: emptyGroup(),
    };
    const proposal = proposeForServer(
      ok('sentry', [{ name: 'get_issue' }, { name: 'list_issues' }]),
      groups,
    );
    const covered = proposal.placements.find((p) => p.tool === 'mcp__sentry__get_issue')!;
    const uncovered = proposal.placements.find((p) => p.tool === 'mcp__sentry__list_issues')!;
    expect(covered.alreadyGranted).toBe(true);
    expect(uncovered.alreadyGranted).toBe(false);

    expect(proposal.rules).toHaveLength(1);
    expect(proposal.rules[0]!.value).not.toMatch(/get_issue/);
    expect(proposal.rules[0]!.value).toMatch(/list_issues/);
  });

  it('a tool that classifies unknown but is already granted by the real pull group is not surfaced as needing review incorrectly (it is still unknown, but alreadyGranted is true)', () => {
    // The known classifier/pull disagreement: DataDog load_/aggregate_ classify unknown here
    // but pull already grants them by vendor pattern.
    const proposal = proposeForServer(
      ok('claude_ai_DataDog_MCP', [{ name: 'load_dashboard' }]),
      realGroups as unknown as PermissionGroupMap,
    );
    const p = proposal.placements[0]!;
    expect(p.effect).toBe('unknown');
    expect(p.alreadyGranted).toBe(true);
  });

  // isAlreadyGranted must be scoped to the tool's OWN destination group, never the whole map —
  // reproduced here with only literal pull/push maps, no third group involved, per the review
  // finding on the first cut of this module.
  it('a read tool matched only by push does not read as alreadyGranted, and a pull rule IS still proposed', () => {
    const groups: PermissionGroupMap = {
      pull: emptyGroup(),
      push: { ...emptyGroup(), alwaysAllowMcpPatterns: ['^mcp__sentry__(get_issue)$'] },
    };
    const proposal = proposeForServer(ok('sentry', [{ name: 'get_issue' }]), groups);
    const p = proposal.placements[0]!;
    expect(p).toMatchObject({ effect: 'read', group: 'pull', alreadyGranted: false });
    expect(proposal.rules).toContainEqual({ group: 'pull', kind: 'mcp', value: '^mcp__sentry__(get_issue)$' });
  });

  it('an external-write tool already matched by a non-gated group does not read as alreadyGranted for push, a push rule IS still proposed, and ungatedElsewhere names the leaking group', () => {
    const groups: PermissionGroupMap = {
      pull: { ...emptyGroup(), alwaysAllowMcpPatterns: ['^mcp__github__(merge_pull_request)$'] },
      push: emptyGroup(),
    };
    const proposal = proposeForServer(ok('github', [{ name: 'merge_pull_request' }]), groups);
    const p = proposal.placements[0]!;
    expect(p).toMatchObject({
      effect: 'external-write', group: 'push', alreadyGranted: false, ungatedElsewhere: 'pull',
    });
    expect(proposal.rules).toContainEqual({
      group: 'push', kind: 'mcp', value: '^mcp__github__(merge_pull_request)$',
    });
  });

  it('a read tool granted by pull itself still reads as alreadyGranted and is still excluded from rules (no regression)', () => {
    const groups: PermissionGroupMap = {
      pull: { ...emptyGroup(), alwaysAllowMcpPatterns: ['^mcp__sentry__(get_issue)$'] },
      push: emptyGroup(),
    };
    const proposal = proposeForServer(ok('sentry', [{ name: 'get_issue' }]), groups);
    const p = proposal.placements[0]!;
    expect(p).toMatchObject({ effect: 'read', group: 'pull', alreadyGranted: true });
    expect(p.ungatedElsewhere).toBeUndefined();
    expect(proposal.rules).toHaveLength(0);
  });
});

describe('proposeForServer — rule shape', () => {
  it('generates a $-anchored, alternation-shaped rule, never a prefix', () => {
    const proposal = proposeForServer(
      ok('sentry', [{ name: 'get_issue' }, { name: 'list_issues' }, { name: 'search_issues' }]),
      noGrants,
    );
    expect(proposal.rules).toHaveLength(1);
    const rule = proposal.rules[0]!;
    expect(rule.group).toBe('pull');
    expect(rule.kind).toBe('mcp');
    expect(rule.value).toBe('^mcp__sentry__(get_issue|list_issues|search_issues)$');
  });

  it('escapes a regex metacharacter in a tool name', () => {
    const proposal = proposeForServer(ok('sentry', [{ name: 'get_issue.v2' }, { name: 'get_issue+extra' }]), noGrants);
    const rule = proposal.rules.find((r) => r.group === 'pull')!;
    expect(rule.value).toBe('^mcp__sentry__(get_issue\\.v2|get_issue\\+extra)$');
    // The escaped pattern matches only the literal tool name, not an arbitrary character/one-or-more.
    const re = new RegExp(rule.value);
    expect(re.test('mcp__sentry__get_issue.v2')).toBe(true);
    expect(re.test('mcp__sentry__get_issueXv2')).toBe(false);
    expect(re.test('mcp__sentry__get_issue+extra')).toBe(true);
    expect(re.test('mcp__sentry__get_issueextraextra')).toBe(false);
  });
});

describe('proposeForServer — failed catalog', () => {
  it('carries the status through with no placements and no rules', () => {
    for (const status of ['unreachable', 'unauthorized', 'unsupported', 'timeout'] as const) {
      const result: CatalogResult = { server: 'sentry', status, reason: 'nope' };
      const proposal = proposeForServer(result, noGrants);
      expect(proposal.status).toBe(status);
      expect(proposal.placements).toHaveLength(0);
      expect(proposal.rules).toHaveLength(0);
    }
  });
});

describe('proposeForServer — generated rules pass the shared lint', () => {
  it('a generated pull rule (reads) passes lintPermissionRule for pull (ungated)', () => {
    const proposal = proposeForServer(
      ok('sentry', [{ name: 'get_issue' }, { name: 'list_issues' }]),
      noGrants,
    );
    const rule = proposal.rules.find((r) => r.group === 'pull')!;
    const verdict = lintPermissionRule('mcp', rule.value, false);
    expect(verdict.ok, verdict.reason).toBe(true);
  });

  it('a generated push rule (writes) passes lintPermissionRule for push (gated) but is refused for pull (ungated)', () => {
    const proposal = proposeForServer(
      ok('github', [{ name: 'merge_pull_request' }, { name: 'create_pull_request' }]),
      noGrants,
    );
    const rule = proposal.rules.find((r) => r.group === 'push')!;
    const gatedVerdict = lintPermissionRule('mcp', rule.value, true);
    expect(gatedVerdict.ok, gatedVerdict.reason).toBe(true);

    const ungatedVerdict = lintPermissionRule('mcp', rule.value, false);
    expect(ungatedVerdict.ok).toBe(false);
    expect(ungatedVerdict.ungatedWrite).toBe(true);
  });

  it('every rule proposeForServer can generate, across a broad mixed catalog, passes the lint for its own destination group', () => {
    const tools: McpTool[] = [
      { name: 'get_issue' }, { name: 'list_issues' }, { name: 'search_issues' },
      { name: 'merge_pull_request' }, { name: 'create_pull_request' }, { name: 'update_pull_request' },
      { name: 'delete_file' }, { name: 'push_files' },
    ];
    const proposal = proposeForServer(ok('github', tools), noGrants);
    expect(proposal.rules.length).toBeGreaterThan(0);
    for (const rule of proposal.rules) {
      const gated = rule.group === 'push';
      const verdict = lintPermissionRule('mcp', rule.value, gated);
      expect(verdict.ok, `${rule.group} rule failed lint: ${verdict.reason}`).toBe(true);
    }
  });
});
