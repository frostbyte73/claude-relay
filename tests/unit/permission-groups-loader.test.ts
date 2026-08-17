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
});
