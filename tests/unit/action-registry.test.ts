import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRegistry } from '../../src/actions/index.js';

let root: string;
let actionsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-registry-'));
  actionsDir = join(root, 'actions');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAction(category: string, name: string, opts: {
  frontmatter?: string;
  input?: object;
  output?: object;
  allowlist?: object;
  omit?: 'input' | 'output';
} = {}): string {
  const dir = join(actionsDir, category, name);
  mkdirSync(dir, { recursive: true });
  const fm = opts.frontmatter ?? defaultActionFrontmatter(category, name);
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n# ${category}.${name}\n\nbody.\n`);
  if (opts.omit !== 'input') {
    writeFileSync(join(dir, 'input.schema.json'),
      JSON.stringify(opts.input ?? { type: 'object', additionalProperties: false }));
  }
  if (opts.omit !== 'output') {
    writeFileSync(join(dir, 'output.schema.json'),
      JSON.stringify(opts.output ?? { type: 'object', additionalProperties: false }));
  }
  if (opts.allowlist) {
    writeFileSync(join(dir, 'allowlist.json'), JSON.stringify(opts.allowlist));
  }
  return dir;
}

function defaultActionFrontmatter(category: string, name: string): string {
  return [
    `name: ${category}.${name}`,
    `description: test action ${category}.${name}`,
    'outpost:',
    '  kind: action',
    `  category: ${category}`,
    '  side_effects: none',
    '  runner: claude',
  ].join('\n');
}

describe('ActionRegistry', () => {
  it('loads a valid action and exposes it by name', () => {
    writeAction('read', 'thing', {
      input: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
      output: { type: 'object', required: ['y'], properties: { y: { type: 'number' } } },
      allowlist: { alwaysAllow: ['Read'], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    });
    const reg = new ActionRegistry(actionsDir);
    const stats = reg.load();
    expect(stats.actions).toBe(1);
    const a = reg.getAction('read.thing');
    expect(a).toBeDefined();
    expect(a!.frontmatter.outpost.category).toBe('read');
    expect(a!.frontmatter.outpost.runner).toBe('claude');
    expect(a!.allowlist.alwaysAllow).toEqual(['Read']);
    expect(a!.body).toContain('# read.thing');
  });

  it('rejects an action whose frontmatter name does not match its dir', () => {
    writeAction('read', 'thing', {
      frontmatter: defaultActionFrontmatter('read', 'thing').replace('name: read.thing', 'name: read.misnamed'),
    });
    const reg = new ActionRegistry(actionsDir);
    expect(() => reg.load()).toThrow(/dir-derived/);
  });

  it('rejects an action whose category does not match its parent dir', () => {
    writeAction('read', 'thing', {
      frontmatter: defaultActionFrontmatter('read', 'thing').replace('category: read', 'category: write'),
    });
    const reg = new ActionRegistry(actionsDir);
    expect(() => reg.load()).toThrow(/dir category/);
  });

  it('rejects an action with an unknown category', () => {
    mkdirSync(join(actionsDir, 'bogus', 'thing'), { recursive: true });
    writeFileSync(join(actionsDir, 'bogus', 'thing', 'SKILL.md'),
      `---\nname: bogus.thing\ndescription: x\noutpost:\n  kind: action\n  category: bogus\n  side_effects: none\n  runner: claude\n---\n`);
    writeFileSync(join(actionsDir, 'bogus', 'thing', 'input.schema.json'), '{}');
    writeFileSync(join(actionsDir, 'bogus', 'thing', 'output.schema.json'), '{}');
    const reg = new ActionRegistry(actionsDir);
    expect(() => reg.load()).toThrow(/outpost\.category/);
  });

  it('rejects an action whose input schema is malformed JSON-schema', () => {
    writeAction('read', 'badschema', {
      input: { type: 'banana' } as object,
    });
    const reg = new ActionRegistry(actionsDir);
    expect(() => reg.load()).toThrow(/input\.schema\.json invalid/);
  });

  it('rejects an action missing input.schema.json', () => {
    writeAction('read', 'missingschema', { omit: 'input' });
    const reg = new ActionRegistry(actionsDir);
    expect(() => reg.load()).toThrow(/ENOENT|no such file/);
  });

  it('reports all errors at once, not just the first', () => {
    writeAction('read', 'badschema', { input: { type: 'banana' } as object });
    writeAction('read', 'misnamed', {
      frontmatter: defaultActionFrontmatter('read', 'misnamed').replace('name: read.misnamed', 'name: read.OOPS'),
    });
    const reg = new ActionRegistry(actionsDir);
    try {
      reg.load();
      expect.fail('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/2 invalid entries/);
      expect(msg).toMatch(/input\.schema\.json invalid/);
      expect(msg).toMatch(/dir-derived/);
    }
  });

  it('handles a missing actions dir gracefully (zero count)', () => {
    const reg = new ActionRegistry(join(root, 'nope-actions'));
    const stats = reg.load();
    expect(stats.actions).toBe(0);
  });
});

describe('ActionRegistry — permission groups', () => {
  const groups = {
    core: {
      alwaysAllow: ['ToolSearch'],
      alwaysAllowBashPatterns: ['^cat '],
      alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: [],
    },
    read: {
      alwaysAllow: ['Read', 'Glob'],
      alwaysAllowBashPatterns: ['^ls'],
      alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: [],
    },
    push: {
      alwaysAllow: [],
      alwaysAllowBashPatterns: ['^git push'],
      alwaysAllowMcpPatterns: ['^mcp__github__create_'],
      alwaysAllowPathPatterns: [],
    },
  };

  it('grants implicit core to claude-runner actions with no permissions field', () => {
    writeAction('read', 'plain');
    const reg = new ActionRegistry(actionsDir, { permissionGroups: groups });
    reg.load();
    const a = reg.getAction('read.plain')!;
    expect(a.allowlist.alwaysAllow).toContain('ToolSearch');
    expect(a.allowlist.alwaysAllowBashPatterns).toContain('^cat ');
  });

  it('does NOT grant core to builtin-runner actions', () => {
    writeAction('meta', 'wait', {
      frontmatter: defaultActionFrontmatter('meta', 'wait').replace('runner: claude', 'runner: builtin'),
    });
    const reg = new ActionRegistry(actionsDir, { permissionGroups: groups });
    reg.load();
    const a = reg.getAction('meta.wait')!;
    expect(a.allowlist.alwaysAllow).not.toContain('ToolSearch');
    expect(a.allowlist.alwaysAllow.length).toBe(0);
  });

  it('unions multiple permission groups + extras', () => {
    writeAction('write', 'thing', {
      frontmatter: defaultActionFrontmatter('write', 'thing') + '\n  permissions: [read, push]',
      allowlist: {
        alwaysAllow: [],
        alwaysAllowBashPatterns: [],
        // A write-shaped extra (e.g. `save_comment`) is refused at load — writes belong
        // in the `push` group, never a colocated allowlist.json. This extra is a narrower
        // read-only grant, which is exactly what colocated extras are for.
        alwaysAllowMcpPatterns: ['^mcp__claude_ai_Linear__get_issue$'],
        alwaysAllowPathPatterns: [],
      },
    });
    const reg = new ActionRegistry(actionsDir, { permissionGroups: groups });
    reg.load();
    const al = reg.getAction('write.thing')!.allowlist;
    expect(al.alwaysAllow).toContain('ToolSearch');           // core
    expect(al.alwaysAllow).toContain('Read');                 // read
    expect(al.alwaysAllowBashPatterns).toContain('^cat ');    // core
    expect(al.alwaysAllowBashPatterns).toContain('^ls');      // read
    expect(al.alwaysAllowBashPatterns).toContain('^git push'); // push
    expect(al.alwaysAllowMcpPatterns).toContain('^mcp__github__create_');         // push
    expect(al.alwaysAllowMcpPatterns).toContain('^mcp__claude_ai_Linear__get_issue$'); // extras
  });

  it('rejects an unknown permission group name', () => {
    writeAction('read', 'thing', {
      frontmatter: defaultActionFrontmatter('read', 'thing') + '\n  permissions: [readd]',
    });
    const reg = new ActionRegistry(actionsDir, { permissionGroups: groups });
    expect(() => reg.load()).toThrow(/unknown permission group/);
  });

  it('dedups rules across groups + extras', () => {
    writeAction('read', 'thing', {
      frontmatter: defaultActionFrontmatter('read', 'thing') + '\n  permissions: [read]',
      // Extras duplicates rules already in core + read.
      allowlist: {
        alwaysAllow: ['ToolSearch', 'Read'],
        alwaysAllowBashPatterns: ['^cat ', '^ls'],
        alwaysAllowMcpPatterns: [],
        alwaysAllowPathPatterns: [],
      },
    });
    const reg = new ActionRegistry(actionsDir, { permissionGroups: groups });
    reg.load();
    const al = reg.getAction('read.thing')!.allowlist;
    // Each unique rule appears exactly once.
    expect(al.alwaysAllow.filter((x) => x === 'ToolSearch')).toHaveLength(1);
    expect(al.alwaysAllow.filter((x) => x === 'Read')).toHaveLength(1);
    expect(al.alwaysAllowBashPatterns.filter((x) => x === '^cat ')).toHaveLength(1);
    expect(al.alwaysAllowBashPatterns.filter((x) => x === '^ls')).toHaveLength(1);
  });

  it('rejects a non-array permissions field', () => {
    writeAction('read', 'thing', {
      frontmatter: defaultActionFrontmatter('read', 'thing') + '\n  permissions: read',
    });
    const reg = new ActionRegistry(actionsDir, { permissionGroups: groups });
    expect(() => reg.load()).toThrow(/permissions must be a string/);
  });
});
