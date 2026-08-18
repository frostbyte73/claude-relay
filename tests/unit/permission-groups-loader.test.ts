import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimePermissionGroups } from '../../src/permissions/permission-groups-loader.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';

const G = (bash: string[], mcp: string[] = []): PermissionGroupMap[string] => ({
  alwaysAllow: [], alwaysAllowBashPatterns: bash, alwaysAllowMcpPatterns: mcp, alwaysAllowPathPatterns: [],
});

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'pgl-'));
  return { live: join(dir, 'permission-groups.json'), seeded: join(dir, 'permission-groups.seeded.json') };
}

describe('loadRuntimePermissionGroups', () => {
  it('seeds both the live file and the snapshot on a fresh install', () => {
    const { live, seeded } = paths();
    const currentDefault: PermissionGroupMap = { push: G(['^git push']) };
    const result = loadRuntimePermissionGroups(live, seeded, currentDefault);
    expect(result).toEqual(currentDefault);
    expect(JSON.parse(readFileSync(live, 'utf8'))).toEqual(currentDefault);
    expect(JSON.parse(readFileSync(seeded, 'utf8'))).toEqual(currentDefault);
  });

  it('a local addition survives a default change once the snapshot exists', () => {
    const { live, seeded } = paths();
    const originalDefault: PermissionGroupMap = { pull: G([], ['^mcp__github__get_']) };
    writeFileSync(seeded, JSON.stringify(originalDefault));
    // The user hot-added a local MCP integration on top of the originally-seeded default.
    writeFileSync(live, JSON.stringify({ pull: G([], ['^mcp__github__get_', '^mcp__livekit-docs__']) }));
    // The default template has since changed (a new bash rule appeared).
    const newDefault: PermissionGroupMap = { pull: G(['^kubectl get'], ['^mcp__github__get_']) };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);
    expect(result.pull!.alwaysAllowMcpPatterns).toContain('^mcp__livekit-docs__');
    expect(result.pull!.alwaysAllowBashPatterns).toContain('^kubectl get');
  });

  // The merge reconciled only the four pattern arrays, so `description` came straight off the
  // default and a description edited through PUT /api/permission-groups/:name silently reverted
  // at the next daemon boot — with the revision log still claiming the edit had been applied.
  it('a locally-edited description survives the next boot', () => {
    const { live, seeded } = paths();
    const originalDefault: PermissionGroupMap = { pull: { ...G(['^kubectl get']), description: 'shipped wording' } };
    writeFileSync(seeded, JSON.stringify(originalDefault));
    writeFileSync(live, JSON.stringify({ pull: { ...G(['^kubectl get']), description: "dc's wording" } }));

    const result = loadRuntimePermissionGroups(live, seeded, originalDefault);
    expect(result.pull!.description).toBe("dc's wording");
    // And it has to be in the file too, or the boot after this one reverts it.
    expect(JSON.parse(readFileSync(live, 'utf8')).pull.description).toBe("dc's wording");
  });

  it('an untouched description still tracks the default', () => {
    const { live, seeded } = paths();
    const originalDefault: PermissionGroupMap = { pull: { ...G([]), description: 'old wording' } };
    writeFileSync(seeded, JSON.stringify(originalDefault));
    writeFileSync(live, JSON.stringify(originalDefault));
    const newDefault: PermissionGroupMap = { pull: { ...G([]), description: 'reworded upstream' } };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);
    expect(result.pull!.description).toBe('reworded upstream');
  });

  it('drops a superseded default rule once the snapshot exists', () => {
    const { live, seeded } = paths();
    const originalDefault: PermissionGroupMap = { edit: G(['^(yarn|pnpm)(\\s|$)']) };
    writeFileSync(seeded, JSON.stringify(originalDefault));
    // Live still carries the old draft rule verbatim — no local addition on top.
    writeFileSync(live, JSON.stringify(originalDefault));
    // Default has since replaced the rule with a narrower one.
    const newDefault: PermissionGroupMap = { edit: G(['^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)']) };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);
    expect(result.edit!.alwaysAllowBashPatterns).toEqual(['^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)']);
    expect(result.edit!.alwaysAllowBashPatterns).not.toContain('^(yarn|pnpm)(\\s|$)');
  });

  it('keeps unaccounted-for live rules and warns when no snapshot exists yet', () => {
    const { live, seeded } = paths();
    // Live has drifted from a default that never got a seeded snapshot written for it.
    writeFileSync(live, JSON.stringify({ edit: G(['^(yarn|pnpm)(\\s|$)']) }));
    const currentDefault: PermissionGroupMap = { edit: G(['^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)']) };

    const warn = console.warn;
    const messages: string[] = [];
    console.warn = (msg: string) => { messages.push(msg); };
    let result: PermissionGroupMap;
    try {
      result = loadRuntimePermissionGroups(live, seeded, currentDefault);
    } finally {
      console.warn = warn;
    }

    expect(result.edit!.alwaysAllowBashPatterns).toContain('^(yarn|pnpm)(\\s|$)');
    expect(result.edit!.alwaysAllowBashPatterns).toContain('^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)');
    expect(messages.some((m) => m.includes('^(yarn|pnpm)(\\s|$)'))).toBe(true);
  });

  it('writes the merged result back to the live file and the snapshot atomically (no .tmp left behind)', () => {
    const { live, seeded } = paths();
    writeFileSync(seeded, JSON.stringify({ push: G(['^git commit']) }));
    writeFileSync(live, JSON.stringify({ push: G(['^git commit', '^gh pr merge local-draft']) }));
    const newDefault: PermissionGroupMap = { push: G(['^git commit', '^gh workflow run']) };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);

    expect(JSON.parse(readFileSync(live, 'utf8'))).toEqual(result);
    expect(JSON.parse(readFileSync(seeded, 'utf8'))).toEqual(newDefault);
    expect(existsSync(`${live}.tmp`)).toBe(false);
    expect(existsSync(`${seeded}.tmp`)).toBe(false);
    expect(result.push!.alwaysAllowBashPatterns).toEqual(
      expect.arrayContaining(['^git commit', '^gh workflow run', '^gh pr merge local-draft']),
    );
  });

  it('does not duplicate a rule that is both a local addition and a newly-synced default entry', () => {
    const { live, seeded } = paths();
    writeFileSync(seeded, JSON.stringify({ push: G(['^git commit']) }));
    // Live picked up `gh workflow run` locally (e.g. hand-synced) before the default caught up —
    // relative to `seeded`, it's a local addition.
    writeFileSync(live, JSON.stringify({ push: G(['^git commit', '^gh workflow run']) }));
    // The default has since caught up and now also contains the same rule.
    const newDefault: PermissionGroupMap = { push: G(['^git commit', '^gh workflow run']) };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);

    expect(result.push!.alwaysAllowBashPatterns).toEqual(['^git commit', '^gh workflow run']);
  });

  // --- CRITICAL 1: a group-editor removal must survive a restart ---

  it('a removal survives a restart when the default is unchanged', () => {
    const { live, seeded } = paths();
    const original: PermissionGroupMap = { read: G(['^ls', '^rg(\\s|$)']) };
    writeFileSync(seeded, JSON.stringify(original));
    // The user deleted `^rg(\s|$)` via the group editor.
    writeFileSync(live, JSON.stringify({ read: G(['^ls']) }));

    const result = loadRuntimePermissionGroups(live, seeded, original);

    expect(result.read!.alwaysAllowBashPatterns).toEqual(['^ls']);
    expect(JSON.parse(readFileSync(live, 'utf8')).read.alwaysAllowBashPatterns).toEqual(['^ls']);
  });

  it('a removal survives a restart where the default gained an unrelated rule', () => {
    const { live, seeded } = paths();
    const originalDefault: PermissionGroupMap = { read: G(['^ls', '^rg(\\s|$)']) };
    writeFileSync(seeded, JSON.stringify(originalDefault));
    // The user deleted `^rg(\s|$)` via the group editor.
    writeFileSync(live, JSON.stringify({ read: G(['^ls']) }));
    // Meanwhile the default gained a new, unrelated rule.
    const newDefault: PermissionGroupMap = { read: G(['^ls', '^rg(\\s|$)', '^grep(\\s|$)']) };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);

    expect(result.read!.alwaysAllowBashPatterns).toEqual(['^ls', '^grep(\\s|$)']);
    expect(result.read!.alwaysAllowBashPatterns).not.toContain('^rg(\\s|$)');
  });

  it('a removed rule that the default independently tightens yields only the tightened form', () => {
    const { live, seeded } = paths();
    const originalDefault: PermissionGroupMap = { edit: G(['^(yarn|pnpm)(\\s|$)']) };
    writeFileSync(seeded, JSON.stringify(originalDefault));
    // The user deleted the loose rule outright (not just relying on the default to replace it).
    writeFileSync(live, JSON.stringify({ edit: G([]) }));
    // The default has since replaced it with a narrower rule — a different string, so it is
    // not covered by the removal set, and lands anyway (see mergePermissionGroups header).
    const newDefault: PermissionGroupMap = { edit: G(['^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)']) };

    const result = loadRuntimePermissionGroups(live, seeded, newDefault);

    expect(result.edit!.alwaysAllowBashPatterns).toEqual(['^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)']);
  });

  // --- CRITICAL 2: the loader must lint local additions ---

  it('drops a write-shaped local addition into a non-gated group and warns', () => {
    const { live, seeded } = paths();
    writeFileSync(seeded, JSON.stringify({ pull: G([]) }));
    // Hand-added directly to the gitignored live file — never went through the PUT editor.
    writeFileSync(live, JSON.stringify({ pull: G(['^gh pr merge']) }));

    const warn = console.warn;
    const messages: string[] = [];
    console.warn = (msg: string) => { messages.push(msg); };
    let result: PermissionGroupMap;
    try {
      result = loadRuntimePermissionGroups(live, seeded, { pull: G([]) });
    } finally {
      console.warn = warn;
    }

    expect(result.pull!.alwaysAllowBashPatterns).not.toContain('^gh pr merge');
    expect(messages.some((m) => m.includes('pull') && m.includes('^gh pr merge'))).toBe(true);
  });

  it('keeps the same write-shaped rule when hand-added to the gated push group', () => {
    const { live, seeded } = paths();
    writeFileSync(seeded, JSON.stringify({ push: G([]) }));
    writeFileSync(live, JSON.stringify({ push: G(['^gh pr merge']) }));

    const result = loadRuntimePermissionGroups(live, seeded, { push: G([]) });

    expect(result.push!.alwaysAllowBashPatterns).toContain('^gh pr merge');
  });

  it('drops an interpreter-shaped local addition even into the gated push group', () => {
    const { live, seeded } = paths();
    writeFileSync(seeded, JSON.stringify({ push: G([]) }));
    writeFileSync(live, JSON.stringify({ push: G(['^node(\\s|$)']) }));

    const warn = console.warn;
    console.warn = () => {};
    let result: PermissionGroupMap;
    try {
      result = loadRuntimePermissionGroups(live, seeded, { push: G([]) });
    } finally {
      console.warn = warn;
    }

    expect(result.push!.alwaysAllowBashPatterns).not.toContain('^node(\\s|$)');
  });

  it('keeps a benign local addition like the livekit-docs MCP pattern', () => {
    const { live, seeded } = paths();
    writeFileSync(seeded, JSON.stringify({ pull: G([], ['^mcp__github__get_']) }));
    writeFileSync(live, JSON.stringify({ pull: G([], ['^mcp__github__get_', '^mcp__livekit-docs__']) }));

    const result = loadRuntimePermissionGroups(live, seeded, { pull: G([], ['^mcp__github__get_']) });

    expect(result.pull!.alwaysAllowMcpPatterns).toContain('^mcp__livekit-docs__');
  });
});
