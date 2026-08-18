// Turns Task 3's tool enumeration into a proposed set of permission-group grants. Nothing here
// is applied — this only proposes; Task 5 writes only what a user approved.

import { classifyTool, type ToolEffect } from './tool-classify.js';
import type { CatalogResult } from '../integrations/mcp-catalog.js';
import type { PermissionGroupMap, PermissionGroup } from '../actions/types.js';
import { GATED_GROUPS } from '../actions/registry.js';

export interface ToolPlacement {
  tool: string; // the FULL mcp__server__tool name
  effect: ToolEffect;
  group: 'pull' | 'push' | null; // null when the effect is unknown/ambiguous — needs a human
  alreadyGranted: boolean;
  // Set only for an external-write tool that is NOT already covered by push, but IS already
  // matched by some other, non-gated group's pattern — i.e. a write that already runs today
  // with no pin. Names that group. See findUngatedGrantingGroup.
  ungatedElsewhere?: string;
}

export interface ServerProposal {
  server: string;
  status: CatalogResult['status'];
  placements: ToolPlacement[];
  rules: Array<{ group: 'pull' | 'push'; kind: 'mcp'; value: string }>;
}

// A tool's local name can contain any character its vendor likes — including regex
// metacharacters (`.`, `+`, ...). Left unescaped inside the generated alternation, one of
// those either fails to compile or silently widens what the rule matches. Every alternative
// in the rule goes through this first.
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testsPattern(tool: string, pattern: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return false;
  }
  return re.test(tool);
}

// True when the ONE group a tool is actually bound for already grants it. Scoped to that single
// group, never the whole map: an external-write tool already matched by `pull`'s pattern (a
// misconfigured read grant that happens to also cover a write) must NOT read as `alreadyGranted`
// just because *some* group matches it — that would silently confirm the misconfiguration by
// proposing no `push` rule and saying nothing. Likewise a read tool matched only by `push` must
// not be reported as covered while proposing no `pull` rule for it (leaving it needlessly gated
// forever). Reconciliation is meaningful only against the group a rule would actually be added
// to, not against "any group, whichever."
function isGrantedByGroup(tool: string, group: PermissionGroup | undefined): boolean {
  return (group?.alwaysAllowMcpPatterns ?? []).some((pattern) => testsPattern(tool, pattern));
}

// Used only for a tool with no destination group at all (`group: null` — unknown/local-write/
// interpreter): there is no rule being generated for it either way, so scanning every group
// carries none of the cross-group-leakage risk `isGrantedByGroup` guards against above. This is
// purely informational — it lets an operator see that a tool the classifier couldn't place is
// nonetheless already reachable (e.g. DataDog's `load_`/`aggregate_` verbs, which `pull` already
// grants by vendor pattern even though this classifier calls them `unknown`).
function isGrantedAnywhere(tool: string, groups: PermissionGroupMap): boolean {
  return Object.values(groups).some((group) => isGrantedByGroup(tool, group));
}

// The single case `alreadyGranted` must never paper over: an external-write tool not covered by
// `push` (so a `push` rule is about to be proposed for it) that some OTHER, non-gated group's
// pattern already matches — meaning the write already runs today, ungated, with no approval pin.
// Names that group so the proposal surfaces the pre-existing misconfiguration instead of quietly
// adding a redundant gated rule alongside it.
function findUngatedGrantingGroup(tool: string, groups: PermissionGroupMap, destGroup: string): string | undefined {
  for (const [name, group] of Object.entries(groups)) {
    if (name === destGroup || GATED_GROUPS.has(name)) continue;
    if (isGrantedByGroup(tool, group)) return name;
  }
  return undefined;
}

// read -> pull, external-write -> push (both gated by the group they land in). Everything
// else is surfaced for a human rather than placed:
//   - unknown: the classifier refused to guess, on purpose — see tool-classify.ts.
//   - local-write / interpreter: an MCP server claiming either is either mis-modelled (no
//     remote tool should report itself as a local filesystem write) or actually dangerous
//     (a remote "interpreter" is arbitrary code execution by definition). Never auto-placed.
function groupFor(effect: ToolEffect): 'pull' | 'push' | null {
  if (effect === 'read') return 'pull';
  if (effect === 'external-write') return 'push';
  return null;
}

export function proposeForServer(result: CatalogResult, groups: PermissionGroupMap): ServerProposal {
  if (result.status !== 'ok') {
    return { server: result.server, status: result.status, placements: [], rules: [] };
  }

  const placements: ToolPlacement[] = result.tools.map((tool) => {
    // Task 3 returns the server's LOCAL tool name (`get_issue`); the classifier and every
    // permission pattern key on the full `mcp__<server>__<tool>` form. Classifying the local
    // name instead would make every verdict `unknown` and the whole proposal empty-but-plausible
    // — the failure mode this module exists to avoid, so the prefix is built before anything
    // else touches the name.
    const fullName = `mcp__${result.server}__${tool.name}`;
    const verdict = classifyTool(fullName, tool.description);
    const group = groupFor(verdict.effect);

    if (group === null) {
      return { tool: fullName, effect: verdict.effect, group, alreadyGranted: isGrantedAnywhere(fullName, groups) };
    }

    const alreadyGranted = isGrantedByGroup(fullName, groups[group]);
    const ungatedElsewhere = !alreadyGranted && group === 'push'
      ? findUngatedGrantingGroup(fullName, groups, group)
      : undefined;
    return {
      tool: fullName,
      effect: verdict.effect,
      group,
      alreadyGranted,
      ...(ungatedElsewhere !== undefined ? { ungatedElsewhere } : {}),
    };
  });

  // One rule per server per group, built from the tools this server proposes for that group
  // and not already covered by an existing pattern. Anchored, enumerated alternations only —
  // never a prefix: `^mcp__sentry__(get_issue|list_issues)$`, not `^mcp__sentry__(get|list)`.
  // The unanchored `^mcp__claude_ai_DataDog_MCP__` prefix in the shipped global allowlist is
  // exactly how a write (`submit_metric`) slipped into a read grant — a prefix grants every
  // tool the vendor adds after the user approved it, including ones that didn't exist yet.
  const byGroup = new Map<'pull' | 'push', string[]>();
  for (const p of placements) {
    if (p.group === null || p.alreadyGranted) continue;
    const locals = byGroup.get(p.group) ?? [];
    const local = p.tool.slice(`mcp__${result.server}__`.length);
    locals.push(local);
    byGroup.set(p.group, locals);
  }

  const escapedServer = escapeForRegex(result.server);
  const rules: ServerProposal['rules'] = [];
  for (const group of ['pull', 'push'] as const) {
    const locals = byGroup.get(group);
    if (!locals || locals.length === 0) continue;
    const alternation = locals.map(escapeForRegex).join('|');
    rules.push({ group, kind: 'mcp', value: `^mcp__${escapedServer}__(${alternation})$` });
  }

  return { server: result.server, status: 'ok', placements, rules };
}
