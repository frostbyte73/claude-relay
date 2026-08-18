// Turns Task 3's tool enumeration into a proposed set of permission-group grants. Nothing here
// is applied — this only proposes; Task 5 writes only what a user approved.

import { classifyTool, type ToolEffect } from './tool-classify.js';
import type { CatalogResult } from '../integrations/mcp-catalog.js';
import type { PermissionGroupMap } from '../actions/types.js';

export interface ToolPlacement {
  tool: string; // the FULL mcp__server__tool name
  effect: ToolEffect;
  group: 'pull' | 'push' | null; // null when the effect is unknown/ambiguous — needs a human
  alreadyGranted: boolean;
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

// True when some existing group already grants this exact tool name. Checked against every
// group's real resolved `alwaysAllowMcpPatterns`, not just `pull`/`push` — the classifier and
// `pull` disagree about what counts as a read (DataDog `load_`/`aggregate_`, github
// `pull_request_read`/`issue_read`, Slack `slack_read_*`/`slack_search_*`, incident-io
// `alert_stats`/`ask`, all classify `unknown` here but are already granted). A tool the running
// config already covers must never be presented as "needs review", regardless of what this
// module's own classification says about it — so this check runs independently of, and prior
// to, the effect-to-group mapping below.
function isAlreadyGranted(tool: string, groups: PermissionGroupMap): boolean {
  for (const group of Object.values(groups)) {
    for (const pattern of group.alwaysAllowMcpPatterns ?? []) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      if (re.test(tool)) return true;
    }
  }
  return false;
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
    return {
      tool: fullName,
      effect: verdict.effect,
      group: groupFor(verdict.effect),
      alreadyGranted: isAlreadyGranted(fullName, groups),
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
