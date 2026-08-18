import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ActionRegistry } from '../../src/actions/registry.js';
import { readFileSync } from 'node:fs';

const GLOBAL = {
  alwaysAllow: ['WebFetch'],
  alwaysAllowBashPatterns: ['^kubectl get(\\s|$)'],
  alwaysAllowMcpPatterns: ['^mcp__example__read'],
  alwaysAllowPathPatterns: [],
};

// A minimal registry holding one action that inherits `read` only.
function registryWithReadAction(): ActionRegistry {
  const root = mkdtempSync(join(tmpdir(), 'conf-'));
  const dir = join(root, 'code', 'reader');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'),
    '---\nname: code.reader\ndescription: d\noutpost:\n  runner: claude\n  kind: action\n'
    + '  category: code\n  side_effects: none\n  permissions: [read]\n---\nbody\n');
  writeFileSync(join(dir, 'input.schema.json'), '{"type":"object"}');
  writeFileSync(join(dir, 'output.schema.json'), '{"type":"object"}');
  const groups = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8'));
  const reg = new ActionRegistry(root, { permissionGroups: groups });
  reg.load();
  return reg;
}

describe('spec pin #1: an action-bound call does not see a global grant', () => {
  const reg = registryWithReadAction();
  const al = new Allowlist(GLOBAL, { actionRegistry: reg });

  it('denies a global bash grant for an action-bound call', () => {
    expect(al.allows('Bash', { command: 'kubectl get pods' })).toBe(true);
    expect(al.allows('Bash', { command: 'kubectl get pods' }, undefined, 'code.reader')).toBe(false);
  });

  it('denies a global tool grant for an action-bound call', () => {
    expect(al.allows('WebFetch', {})).toBe(true);
    expect(al.allows('WebFetch', {}, undefined, 'code.reader')).toBe(false);
  });

  it('denies a global mcp grant for an action-bound call', () => {
    expect(al.allows('mcp__example__read_thing', {})).toBe(true);
    expect(al.allows('mcp__example__read_thing', {}, undefined, 'code.reader')).toBe(false);
  });

  it('still allows what the action’s own groups grant', () => {
    // `read` grants Grep; `core` grants `jq`.
    expect(al.allows('Grep', {}, undefined, 'code.reader')).toBe(true);
    expect(al.allows('Bash', { command: 'jq .x foo.json' }, undefined, 'code.reader')).toBe(true);
  });

  it('leaves non-action callers untouched', () => {
    expect(al.allows('Bash', { command: 'kubectl get pods' }, '/some/project')).toBe(true);
  });
});

describe('session scope survives confinement', () => {
  const reg = registryWithReadAction();
  const al = new Allowlist(GLOBAL, { actionRegistry: reg });

  it('honours a session-scoped rule for an action-bound call', () => {
    al.addRule('bash', '^sed(\\s|$)', { session: 's1' });
    expect(al.allows('Bash', { command: 'sed -n 1p f' }, undefined, 'code.reader', undefined, 's1')).toBe(true);
    expect(al.allows('Bash', { command: 'sed -n 1p f' }, undefined, 'code.reader', undefined, 's2')).toBe(false);
  });
});
