import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PermissionGroupMap } from '../actions/types.js';
import { GATED_GROUPS } from '../actions/registry.js';
import { lintPermissionRule } from './write-shape.js';
import type { RuleKind } from './allowlist.js';

const ARRAY_FIELDS = [
  'alwaysAllow', 'alwaysAllowBashPatterns', 'alwaysAllowMcpPatterns', 'alwaysAllowPathPatterns',
] as const satisfies readonly (keyof PermissionGroupMap[string])[];

const FIELD_RULE_KIND: Record<typeof ARRAY_FIELDS[number], RuleKind> = {
  alwaysAllow: 'tool',
  alwaysAllowBashPatterns: 'bash',
  alwaysAllowMcpPatterns: 'mcp',
  alwaysAllowPathPatterns: 'path',
};

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

// Per group, per array field: entries present in `minuend` but not `subtrahend`. Plus the
// description when it differs — it's a scalar, so it has no "extra entries", but it IS locally
// editable through PUT /api/permission-groups/:name. Leaving it out of the diff made it
// default-owned, which silently reverted every description edit at the next boot.
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
    if ((group.description ?? '') !== (base?.description ?? '')) {
      extra.description = group.description ?? '';
      hasExtra = true;
    }
    if (hasExtra) result[name] = extra;
  }
  return result;
}

// `base` (current default) with `additions` (local-only rules and description) applied per array
// field, minus
// `removals` (default-derived rules the user deleted) filtered out of `base` first. A group
// that exists only in `additions` (a fully local group) is carried through as-is. Deduped, base
// order preserved: a local addition can converge with a rule the default just caught up on
// (e.g. dc hand-added `gh workflow run` live before the default synced it) — that must land
// once, not twice, in the file the checker (and the next diff) reads.
//
// Deliberate consequence of filtering by exact string: if the user removed rule R and a later
// default replaces R with a tightened R', R' is a different string, so it is not in `removals`
// and it lands — the user's removal doesn't suppress a rule the default hasn't reintroduced.
export function mergePermissionGroups(
  base: PermissionGroupMap, additions: PermissionGroupMap, removals: PermissionGroupMap = {},
): PermissionGroupMap {
  const merged: PermissionGroupMap = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(additions)])) {
    const baseGroup = base[name];
    const addGroup = additions[name];
    if (!baseGroup) { merged[name] = addGroup!; continue; }
    const removeGroup = removals[name];
    const mergedGroup = { ...baseGroup };
    for (const field of ARRAY_FIELDS) {
      const removeSet = new Set(removeGroup?.[field] ?? []);
      const baseList = (baseGroup[field] ?? []).filter((rule) => !removeSet.has(rule));
      const seen = new Set(baseList);
      const newOnly = (addGroup?.[field] ?? []).filter((rule) => {
        if (seen.has(rule)) return false;
        seen.add(rule);
        return true;
      });
      mergedGroup[field] = [...baseList, ...newOnly];
    }
    // A locally-edited description wins over the default's, the same way a local rule addition
    // does. A default that also rewords its description therefore loses to the user's edit —
    // deliberate: prose is theirs to own once they've touched it, and unlike a rule it grants
    // nothing, so there is no security cost to preferring it.
    if (addGroup?.description !== undefined) mergedGroup.description = addGroup.description;
    merged[name] = mergedGroup;
  }
  return merged;
}

// Refuses a local addition that shouldn't have been hand-added in the first place — the same
// policy the group-editor PUT route enforces, applied here to the untrusted half of the merge
// (the tracked default is reviewed repo content and is never linted; `push` legitimately
// carries write-shaped rules). Drops rather than throws: a bad hand-edit in the gitignored live
// file must not block the daemon from booting, and dropping is the fail-safe direction.
function lintLocalAdditions(additions: PermissionGroupMap): PermissionGroupMap {
  const linted: PermissionGroupMap = {};
  for (const [name, group] of Object.entries(additions)) {
    const gated = GATED_GROUPS.has(name);
    const clean = { ...group };
    for (const field of ARRAY_FIELDS) {
      clean[field] = (group[field] ?? []).filter((rule) => {
        const verdict = lintPermissionRule(FIELD_RULE_KIND[field], rule, gated);
        if (!verdict.ok) {
          console.warn(
            `[daemon] permission-groups.json: dropping local addition ${name}.${field} `
            + `(${verdict.reason}): ${rule}`,
          );
        }
        return verdict.ok;
      });
    }
    linted[name] = clean;
  }
  return linted;
}

// The live file exists deliberately so a checkout can carry setup-specific integrations
// (e.g. an extra MCP read pattern) without leaking them upstream — so a plain overwrite
// from `currentDefault` is wrong. But a plain union is also wrong: a rule can be in live
// but not default because it's a genuine local addition, OR because it's a stale draft of
// a rule the default has since replaced (stronger regex, narrower scope, etc.) — those two
// need opposite treatment. `seededPath` is a snapshot of the default the live file was last
// synced against, so `live − seeded` isolates exactly the local additions; anything else in
// live is default-derived and gets superseded by whatever `currentDefault` says now.
//
// Symmetrically, `seeded − live` isolates a local REMOVAL: a default-derived rule the user
// deleted from the group editor. Without honouring that, a removal reverts at the next boot
// (the merge below would just re-add whatever `currentDefault` still says), and a tightened
// default rule would leave both the loose original and the tightened copy present — a net
// non-narrowing. See mergePermissionGroups's header comment for the one deliberate exception
// (a later default that *replaces* the removed rule with a differently-worded tightened one
// still lands — a different string was never in this set to begin with).
export function loadRuntimePermissionGroups(path: string, seededPath: string, currentDefault: PermissionGroupMap): PermissionGroupMap {
  if (!existsSync(path)) {
    writeJsonAtomic(path, currentDefault);
    writeJsonAtomic(seededPath, currentDefault);
    return currentDefault;
  }

  const live = JSON.parse(readFileSync(path, 'utf8')) as PermissionGroupMap;
  let localAdditions: PermissionGroupMap;
  let localRemovals: PermissionGroupMap = {};

  if (existsSync(seededPath)) {
    const seeded = JSON.parse(readFileSync(seededPath, 'utf8')) as PermissionGroupMap;
    // Local additions are the untrusted half of the merge — a hand-edit to the gitignored
    // live file, never reviewed the way the tracked default is — so they're the only thing
    // linted here; see lintLocalAdditions.
    localAdditions = lintLocalAdditions(diffPermissionGroups(live, seeded));
    localRemovals = diffPermissionGroups(seeded, live);
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

  const merged = mergePermissionGroups(currentDefault, localAdditions, localRemovals);
  writeJsonAtomic(path, merged);
  writeJsonAtomic(seededPath, currentDefault);
  return merged;
}
