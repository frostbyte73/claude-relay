// Outpost's two primitives, on-disk and in-memory. See CLAUDE.md for the
// conceptual overview; this file is the canonical TS shape.

export type ActionCategory = 'read' | 'write' | 'code' | 'meta';
export type SideEffects = 'none' | 'gated-write' | 'worktree-edit' | 'external-write';
export type ActionRunner = 'claude' | 'builtin';
// 'step-orchestrator' marks a controller: an action that owns an orchestrated step
// end to end, deciding its own next move each turn instead of running once.
export type ActionKind = 'action' | 'step-orchestrator';

// The frontmatter block of an action's SKILL.md. `name` is "<category>.<rest>"
// and must match the dir path: actions/<category>/<rest>/SKILL.md.
export interface ActionFrontmatter {
  name: string;
  description: string;
  outpost: {
    kind: ActionKind;
    category: ActionCategory;
    side_effects: SideEffects;
    // 'claude' spawns a session; 'builtin' is daemon-implemented (body is docs only).
    runner: ActionRunner;
    // Inherited permission groups (read/pull/edit/push); core is implicit for claude-runners.
    permissions?: string[];
    timeout_sec?: number;
    retries?: number;
  };
}

export interface ActionAllowlist {
  alwaysAllow: string[];
  alwaysAllowBashPatterns: string[];
  alwaysAllowMcpPatterns: string[];
  alwaysAllowPathPatterns: string[];
}

export type PermissionGroupMap = Record<string, ActionAllowlist>;

export interface ActionDef {
  name: string;
  dir: string;
  frontmatter: ActionFrontmatter;
  body: string;
  inputSchema: unknown;
  outputSchema: unknown;
  allowlist: ActionAllowlist;
  // The subset of `allowlist` that came from a gated group — calls matching these run
  // only when pinned by an approved WriteDraft. See GATED_GROUPS in registry.ts.
  gated: ActionAllowlist;
}

// A plan node. The orchestrator emits a PlanStep[] and it persists on
// JobRecord.plan once approved.
export interface PlanStep {
  id: string;
  action: string;
  inputs: Record<string, InputRef>;
  parallel_group?: number;
  optional?: boolean;
  notes?: string;
}

// How a step's input slot is wired. Either a literal value, or a dotted path
// into a prior step's output (the plan editor validates against that step's
// outputSchema to catch type mismatches before the job runs).
export type InputRef =
  | { literal: unknown }
  | { from: string; path: string; default?: unknown };
