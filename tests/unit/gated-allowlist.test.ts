import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gatedMatch } from '../../src/permissions/allowlist.js';
import type { ActionAllowlist } from '../../src/actions/types.js';

const groups = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8'));
const push: ActionAllowlist = groups.push;
const empty: ActionAllowlist = {
  alwaysAllow: [], alwaysAllowBashPatterns: [],
  alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
};

describe('gatedMatch', () => {
  it('gates a bash command the push group grants', () => {
    expect(gatedMatch(push, 'Bash', { command: 'git push origin fix-ci' })).toBe(true);
    expect(gatedMatch(push, 'Bash', { command: 'git commit -m "fix"' })).toBe(true);
    expect(gatedMatch(push, 'Bash', { command: 'gh pr merge 12 --squash' })).toBe(true);
  });

  it('does not gate reads or test runners', () => {
    expect(gatedMatch(push, 'Bash', { command: 'git status' })).toBe(false);
    expect(gatedMatch(push, 'Bash', { command: 'npm test' })).toBe(false);
    expect(gatedMatch(push, 'Read', { file_path: '/tmp/x' })).toBe(false);
  });

  it('gates the whole command when ANY clause matches a gated rule', () => {
    expect(gatedMatch(push, 'Bash', { command: 'git status && git push origin b' })).toBe(true);
  });

  it('gates an MCP write tool the push group grants', () => {
    expect(gatedMatch(push, 'mcp__claude_ai_Linear__save_issue', { title: 'x' })).toBe(true);
    expect(gatedMatch(push, 'mcp__claude_ai_Linear__get_issue', { id: 'x' })).toBe(false);
  });

  it('gates nothing for an action that inherits no gated group', () => {
    expect(gatedMatch(empty, 'Bash', { command: 'git push origin b' })).toBe(false);
  });

  it('gates nothing when the command does not parse', () => {
    expect(gatedMatch(push, 'Bash', { command: 'git push "unterminated' })).toBe(false);
  });

  it('gates every bash call when a gated group hands out whole-tool Bash', () => {
    const wholeTool: ActionAllowlist = { ...empty, alwaysAllow: ['Bash'] };
    expect(gatedMatch(wholeTool, 'Bash', { command: 'git status' })).toBe(true);
    expect(gatedMatch(wholeTool, 'Bash', { command: 'git push "unterminated' })).toBe(true);
  });
});
