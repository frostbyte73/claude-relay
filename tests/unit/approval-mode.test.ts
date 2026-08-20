import { describe, it, expect } from 'vitest';
import { ApprovalModeStore, PLAN_MODE_ALWAYS, PLAN_MODE_MCP_READ_RE, isPlanModeReadableMcpTool, type ApprovalMode } from '../../src/permissions/approval-mode.js';

describe('ApprovalModeStore', () => {
  it('defaults to "ask" for unknown sessions', () => {
    const s = new ApprovalModeStore();
    expect(s.get('unknown-session')).toBe('ask');
  });

  it('stores and retrieves a mode per session', () => {
    const s = new ApprovalModeStore();
    s.set('session-a', 'plan');
    s.set('session-b', 'bypass');
    expect(s.get('session-a')).toBe('plan');
    expect(s.get('session-b')).toBe('bypass');
    expect(s.get('session-c')).toBe('ask');
  });

  it('overwrites a session\'s mode', () => {
    const s = new ApprovalModeStore();
    s.set('s', 'plan');
    s.set('s', 'bypass');
    expect(s.get('s')).toBe('bypass');
  });

  it('rejects invalid mode strings (TS guards at compile-time; runtime accepts only the union)', () => {
    const s = new ApprovalModeStore();
    expect(() => s.set('s', 'nonsense' as ApprovalMode)).toThrow();
  });
});

describe('plan-mode constants', () => {
  it('PLAN_MODE_ALWAYS contains the documented read-shaped tools', () => {
    expect(PLAN_MODE_ALWAYS.has('Read')).toBe(true);
    expect(PLAN_MODE_ALWAYS.has('Grep')).toBe(true);
    expect(PLAN_MODE_ALWAYS.has('Write')).toBe(false);
    expect(PLAN_MODE_ALWAYS.has('Bash')).toBe(false);
  });

  it('PLAN_MODE_MCP_READ_RE matches verb-last read-shaped MCP tool names', () => {
    // original passing cases
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__github__pull_request_read')).toBe(true);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__incident-io__incident_list')).toBe(true);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__notion__notion-search')).toBe(true);
    // verb-last must still be blocked when it is a write verb
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__incident-io__incident_update')).toBe(false);
  });

  it('PLAN_MODE_MCP_READ_RE matches verb-first / verb-middle MCP tool names', () => {
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__github__list_issues')).toBe(true);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__github__search_code')).toBe(true);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__grafana__search_dashboards')).toBe(true);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__github__get_pull_request')).toBe(true);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__slack__slack_search_channels')).toBe(true);
  });

  it('PLAN_MODE_MCP_READ_RE does not match write-shaped or ambiguous MCP tool names', () => {
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__github__merge_pull_request')).toBe(false);
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__github__create_release')).toBe(false);
    // "widget" contains "get" as a substring but is not a verb segment — must not match
    expect(PLAN_MODE_MCP_READ_RE.test('mcp__foo__widget_data')).toBe(false);
  });
});

describe('isPlanModeReadableMcpTool', () => {
  it('allows pure read-shaped tools (regex hits, no mutator)', () => {
    expect(isPlanModeReadableMcpTool('mcp__github__list_issues')).toBe(true);
    expect(isPlanModeReadableMcpTool('mcp__github__search_code')).toBe(true);
    expect(isPlanModeReadableMcpTool('mcp__grafana__search_dashboards')).toBe(true);
    expect(isPlanModeReadableMcpTool('mcp__github__get_pull_request')).toBe(true);
    expect(isPlanModeReadableMcpTool('mcp__github__pull_request_read')).toBe(true);
    expect(isPlanModeReadableMcpTool('mcp__incident-io__incident_list')).toBe(true);
    expect(isPlanModeReadableMcpTool('mcp__notion__notion-search')).toBe(true);
  });

  it('rejects tools that match the read regex but contain a mutator verb', () => {
    // These all match PLAN_MODE_MCP_READ_RE but must be denied.
    expect(isPlanModeReadableMcpTool('mcp__foo__list_delete_all')).toBe(false);
    expect(isPlanModeReadableMcpTool('mcp__foo__get_and_update')).toBe(false);
    expect(isPlanModeReadableMcpTool('mcp__foo__search_then_send')).toBe(false);
    expect(isPlanModeReadableMcpTool('mcp__foo__list_creates')).toBe(false);   // plural form caught
    expect(isPlanModeReadableMcpTool('mcp__foo__view_and_modify')).toBe(false);
  });

  it('rejects tools with no read verb at all', () => {
    expect(isPlanModeReadableMcpTool('mcp__incident-io__incident_update')).toBe(false);
    expect(isPlanModeReadableMcpTool('mcp__github__merge_pull_request')).toBe(false);
    expect(isPlanModeReadableMcpTool('mcp__github__create_release')).toBe(false);
  });

  it('rejects non-MCP tools entirely', () => {
    expect(isPlanModeReadableMcpTool('Bash')).toBe(false);
    expect(isPlanModeReadableMcpTool('Edit')).toBe(false);
  });

  it('does not false-positive on "get" inside a word like "widget"', () => {
    expect(isPlanModeReadableMcpTool('mcp__foo__widget_data')).toBe(false);
  });
});
