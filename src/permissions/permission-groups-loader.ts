import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PermissionGroupMap } from '../actions/types.js';

const ARRAY_FIELDS = [
  'alwaysAllow', 'alwaysAllowBashPatterns', 'alwaysAllowMcpPatterns', 'alwaysAllowPathPatterns',
] as const satisfies readonly (keyof PermissionGroupMap[string])[];

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

// Per group, per array field: entries present in `minuend` but not `subtrahend`.
export function diffPermissionGroups(minuend: PermissionGroupMap, subtrahend: PermissionGroupMap): PermissionGroupMap {
  const result: PermissionGroupMap = {};
  for (const [name, group] of Object.entries(minuend)) {
    const base = subtrahend[name];
    const extra = { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] } as PermissionGroupMap[string];
    let hasExtra = false;
    for (const field of ARRAY_FIELDS) {
      const baseSet = new Set(base?.[field] ?? []);
      extra[field] = (group[field] ?? []).filter((rule) => !baseSet.has(rule));
      if (extra[field].length > 0) hasExtra = true;
    }
    if (hasExtra) result[name] = extra;
  }
  return result;
}

// `base` (current default) with `additions` (local-only rules) appended per array field.
// A group that exists only in `additions` (a fully local group) is carried through as-is.
// Deduped, base order preserved: a local addition can converge with a rule the default just
// caught up on (e.g. dc hand-added `gh workflow run` live before the default synced it) — that
// must land once, not twice, in the file the checker (and the next diff) reads.
export function mergePermissionGroups(base: PermissionGroupMap, additions: PermissionGroupMap): PermissionGroupMap {
  const merged: PermissionGroupMap = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(additions)])) {
    const baseGroup = base[name];
    const addGroup = additions[name];
    if (!baseGroup) { merged[name] = addGroup!; continue; }
    const mergedGroup = { ...baseGroup };
    for (const field of ARRAY_FIELDS) {
      const baseList = baseGroup[field] ?? [];
      const seen = new Set(baseList);
      const newOnly = (addGroup?.[field] ?? []).filter((rule) => {
        if (seen.has(rule)) return false;
        seen.add(rule);
        return true;
      });
      mergedGroup[field] = [...baseList, ...newOnly];
    }
    merged[name] = mergedGroup;
  }
  return merged;
}

// The live file exists deliberately so a checkout can carry setup-specific integrations
// (e.g. an extra MCP read pattern) without leaking them upstream — so a plain overwrite
// from `currentDefault` is wrong. But a plain union is also wrong: a rule can be in live
// but not default because it's a genuine local addition, OR because it's a stale draft of
// a rule the default has since replaced (stronger regex, narrower scope, etc.) — those two
// need opposite treatment. `seededPath` is a snapshot of the default the live file was last
// synced against, so `live − seeded` isolates exactly the local additions; anything else in
// live is default-derived and gets superseded by whatever `currentDefault` says now.
export function loadRuntimePermissionGroups(path: string, seededPath: string, currentDefault: PermissionGroupMap): PermissionGroupMap {
  if (!existsSync(path)) {
    writeJsonAtomic(path, currentDefault);
    writeJsonAtomic(seededPath, currentDefault);
    return currentDefault;
  }

  const live = JSON.parse(readFileSync(path, 'utf8')) as PermissionGroupMap;
  let localAdditions: PermissionGroupMap;

  if (existsSync(seededPath)) {
    const seeded = JSON.parse(readFileSync(seededPath, 'utf8')) as PermissionGroupMap;
    localAdditions = diffPermissionGroups(live, seeded);
  } else {
    // No snapshot yet: we can't tell a genuine local addition apart from a stale
    // draft of a rule the default has since replaced. Keep everything unaccounted
    // for and log it — keeping a stale rule is recoverable by hand, silently
    // dropping a user's own integration is not.
    localAdditions = diffPermissionGroups(live, currentDefault);
    for (const [name, extra] of Object.entries(localAdditions)) {
      for (const field of ARRAY_FIELDS) {
        for (const rule of extra[field]) {
          console.warn(`[daemon] permission-groups.json: keeping unaccounted-for ${name}.${field} rule (verify by hand, no seeded snapshot to compare against): ${rule}`);
        }
      }
    }
  }

  const merged = mergePermissionGroups(currentDefault, localAdditions);
  writeJsonAtomic(path, merged);
  writeJsonAtomic(seededPath, currentDefault);
  return merged;
}
