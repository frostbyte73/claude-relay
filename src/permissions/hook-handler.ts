import type { Allowlist } from './allowlist.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';
import { ApprovalModeStore, PLAN_MODE_ALWAYS, isPlanModeReadableMcpTool } from './approval-mode.js';

// An MCP call that mutates external state: not one of our own submit tools, and not
// read-shaped. Used to hard-block writes during a human_gate action's draft phase.
function isExternalWriteTool(toolName: string): boolean {
  if (EDIT_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith('mcp__')) return false;      // local Bash is allowlist-scoped already
  if (toolName.startsWith('mcp__outpost__')) return false; // our own submit/report tools
  return !isPlanModeReadableMcpTool(toolName);
}

export interface HookInput {
  tool_name: string;
  tool_input: unknown;
  session_id: string;
  // Claude's stream-json id for the tool_use block this hook is gating. We forward it
  // to the PWA so the client can match an approval-card decision against the eventual
  // tool_use entry that arrives over the session WS (used by the "expand-by-default
  // unless user approved" logic).
  tool_use_id?: string;
  // Claude Code's PreToolUse hook sets these for tool calls coming from a subagent
  // (Explore / general-purpose / etc.). Absent for the parent session's own calls.
  // We pass them through so the PWA can route subagent approvals into a dedicated
  // agents feed instead of mixing them into the parent transcript.
  agent_id?: string;
  agent_type?: string;
}

export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

export interface HandleHookOpts {
  hookInput: HookInput;
  allowlist: Allowlist;
  queue: ApprovalQueue;
  modes: ApprovalModeStore;
  // Lookup a session's cwd for project-scoped allowlist resolution. Returns undefined
  // if the session is unknown to the daemon (e.g. brand-new); allowlist then falls back
  // to global rules only.
  cwdForSession?: (sessionId: string) => string | undefined;
  // Lookup a session's active worktree path (from WorktreeManager). Returns undefined for
  // sessions without a worktree record (e.g. interactive PWA sessions). Used to auto-allow
  // path-shaped tool inputs that live inside the session's own worktree.
  worktreePathForSession?: (sessionId: string) => string | undefined;
  // Lookup a session's bound action name. The orchestrator binds this when it spawns
  // a step session; PWA-spawned sessions return undefined.
  actionForSession?: (sessionId: string) => string | undefined;
  // True while a human_gate action's session is in its draft/redraft phase (not yet
  // approved). When set, external-write tools are denied so nothing posts before the user
  // approves the draft — the hard backstop behind the draft→review→commit loop.
  writeGateHeldForSession?: (sessionId: string) => boolean;
  onNotify: (approval: PendingApproval) => void;
  // Called when an action-bound session has a tool call denied by allowlist-miss.
  // The daemon stores these so the user can review + add suggested rules in the PWA.
  onActionDenial?: (denial: {
    actionName: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
  }) => void;
}

function allowResp(): HookResponse {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}

function denyResp(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// Kept in sync with the PWA's EDIT_TOOLS (src/pwa/components/tool-use-tile.js) —
// accept-edits mirrors --permission-mode=acceptEdits: file-mutating tools skip
// the prompt, everything else still gates.
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export async function handleHook(opts: HandleHookOpts): Promise<HookResponse> {
  const { hookInput, allowlist, queue, modes, cwdForSession, worktreePathForSession, actionForSession, writeGateHeldForSession, onNotify, onActionDenial } = opts;
  const mode = modes.get(hookInput.session_id);

  // Bypass: short-circuit before any check. Equivalent to --dangerously-skip-permissions.
  if (mode === 'bypass') return allowResp();

  // Plan: allow read-shaped only; deny everything else with a clear reason. Plan mode
  // overrides even the allowlist — we want it to be a positive "lock the session into
  // read-only" gesture, not a "merge with allowlist" gesture.
  if (mode === 'plan') {
    if (PLAN_MODE_ALWAYS.has(hookInput.tool_name)) return allowResp();
    if (hookInput.tool_name.startsWith('mcp__') && isPlanModeReadableMcpTool(hookInput.tool_name)) {
      return allowResp();
    }
    return denyResp('Plan mode — read-only');
  }

  // Accept-edits: file-mutating tools auto-allow without going through the allowlist
  // or the interactive queue. Enforced server-side so the mode works even when the PWA
  // is closed / disconnected. Action-bound sessions still fall through to allowlist
  // checking below (action steps set mode='ask' by construction).
  if (mode === 'accept-edits' && EDIT_TOOLS.has(hookInput.tool_name) && !actionForSession?.(hookInput.session_id)) {
    return allowResp();
  }

  // Action sessions run with explicit allowlist only: hit → allow, miss → deny
  // and record a denial so the user can review what was attempted. We never enqueue
  // for interactive approval because there's no human attached to an action step.
  const projectCwd = cwdForSession?.(hookInput.session_id);
  const worktreePath = worktreePathForSession?.(hookInput.session_id);
  const action = actionForSession?.(hookInput.session_id);
  if (action) {
    // human_gate draft phase: the external write is held until the user approves the
    // draft. Reads and our own submit tools still pass so the session can research and
    // call submit_write_draft; the actual write (save_comment, etc.) is denied.
    if (writeGateHeldForSession?.(hookInput.session_id) && isExternalWriteTool(hookInput.tool_name)) {
      return denyResp('Held for approval — this write runs only after you approve the draft in the PWA.');
    }
    if (allowlist.allows(hookInput.tool_name, hookInput.tool_input, projectCwd, action, worktreePath, hookInput.session_id)) {
      return allowResp();
    }
    onActionDenial?.({
      actionName: action,
      sessionId: hookInput.session_id,
      toolName: hookInput.tool_name,
      toolInput: hookInput.tool_input,
    });
    return denyResp(`Not in action \`${action}\` allowlist — review the suggestion in the PWA.`);
  }

  // Ask / accept-edits (interactive sessions): consult allowlist; on miss, enqueue for
  // interactive approval.
  if (allowlist.allows(hookInput.tool_name, hookInput.tool_input, projectCwd, action, worktreePath, hookInput.session_id)) {
    return allowResp();
  }

  const decisionPromise = queue.enqueue({
    sessionId: hookInput.session_id,
    toolName: hookInput.tool_name,
    toolInput: hookInput.tool_input,
    toolUseId: hookInput.tool_use_id,
    agentId: hookInput.agent_id,
    agentType: hookInput.agent_type,
  });
  const pending = queue.listPending().at(-1);
  if (pending) onNotify(pending);

  const decision = await decisionPromise;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
}
