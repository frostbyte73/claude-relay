import { gatedMatch, type Allowlist } from './allowlist.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';
import { ApprovalModeStore, PLAN_MODE_ALWAYS, isPlanModeReadableMcpTool } from './approval-mode.js';
import type { ActionAllowlist } from '../actions/types.js';
import { verifyFileDigests } from '../work/write-draft.js';

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

// Claude Code dispatches tool completion through TWO distinct hook events, not one event with
// a result flag: `PostToolUse` fires on the tool's normal-completion path, with a
// `tool_response` whose shape is tool-specific and, for Bash, has no success/failure field at
// all. `PostToolUseFailure` fires separately — no `tool_response`, just `error`/`is_interrupt`
// — when the tool's own call() throws. A Bash command throws whenever its exit code classifies
// as an error (Claude Code's own default classifier: any non-zero exit, with a short allowlist
// of commands like `grep`/`find`/`diff`/`git diff`/`git grep` where a specific non-zero code
// has a documented non-error meaning — `git push` is not on that list), which is why a rejected
// `git push` lands here rather than on the unwired `PostToolUse`. That makes this the event
// worth listening on for the write-gate: no result-field guessing, the event itself IS the
// failure signal. Verified against the shipped `claude` binary's Bash tool call() and its exit
// classifier (round 0/1 of the Task 7 review).
export interface PostToolFailureHookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  // Claude's id for the tool_use block that failed — the same id PreToolUse saw for the same
  // call. Threaded through to releaseConsumedPin so it can release the pin THIS call actually
  // spent rather than merely one whose payload matches; see the comment there.
  tool_use_id?: string;
  error?: string;
  // Set when the call was cut short by an abort rather than run to a determinate failure — an
  // aborted controller, or the session's abort signal firing mid-call — not (for Bash) a plain
  // Ctrl-C on the command itself, which returns normally and would fire the unwired
  // `PostToolUse` instead (the throw here is gated on `!isInterrupted`, so a genuine interrupt
  // never reaches this path via that route). Whether the write reached its destination before
  // the abort is genuinely unknown, and releasing anyway risks the unsafe direction: an
  // already-executed write could run a second time. Leaving the pin consumed only costs the
  // user one extra re-approval, so that's the side to fail on.
  is_interrupt?: boolean;
}

export function handlePostToolFailureHook(
  input: PostToolFailureHookInput,
  releaseConsumedPin: (sessionId: string, toolName: string, toolInput: unknown, toolUseId?: string) => void,
): void {
  if (!input.session_id || !input.tool_name) return;
  if (input.is_interrupt) return;
  releaseConsumedPin(input.session_id, input.tool_name, input.tool_input, input.tool_use_id);
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
  // The action's gated rules — calls matching these run only when pinned by an approved
  // WriteDraft. `undefined` here means the registry doesn't recognize `action` at all
  // (e.g. deleted/renamed mid-run), NOT "inherits no gated group": a known action's `gated`
  // is always an ActionAllowlist, even an all-empty one, and gatedMatch never matches that.
  gatedForAction?: (action: string) => ActionAllowlist | undefined;
  // `fileDigests` is present when the pinned call's payload references a file (see
  // write-draft.ts's FILE_REFERENCING_FLAGS) — verified below before the pin is honoured.
  pinFor?: (sessionId: string, toolName: string, toolInput: unknown) =>
    { id: string; fileDigests?: Record<string, string> } | undefined;
  // `toolUseId` is recorded on the pin so a later PostToolUseFailure can prove it's releasing
  // the pin THIS call spent — see WorkEngine.consumePin/releaseConsumedPin.
  onPinConsumed?: (sessionId: string, callId: string, toolUseId?: string) => void;
  // The session's draft state, consulted only to pick the right deny-reason wording when a
  // gated call has no live pin — see gatedDenyReason.
  draftStateFor?: (sessionId: string) => 'none' | 'pending' | 'approved';
  // A gated call was denied for a reason worth leaving evidence of (see the call sites for
  // which denials qualify). Journal-only — deliberately distinct from onActionDenial, which
  // offers a rule suggestion that makes no sense here (no rule would "fix" an unpinned
  // write). `action` is passed explicitly rather than left for the callee to derive from the
  // session's step: for a dispatch session, the bound step is the parent orchestrated step,
  // whose action is the CONTROLLER, not the child action the hook actually denied.
  onGatedDenial?: (sessionId: string, action: string, reason: string) => void;
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

// The deny reason a gated miss gets, branched on why it missed — a model denied here reliably
// retries with a different spelling or a helper script unless told plainly not to, and the
// wrong branch actively misdirects it (telling it to draft again when one is already approved
// costs the user a second, redundant approval). `pinMatched` covers Critical-1's case: an
// approved pin whose payload still fails the action's own allowlist — approval never overrides
// it, so this is not the same as "no pin at all" and must not be told to (re)draft.
function gatedDenyReason(pinMatched: boolean, draftState: 'none' | 'pending' | 'approved'): string {
  if (pinMatched) {
    return 'This call matches a payload you had approved, but it is not permitted by this '
      + "action's own allowlist — an approved draft never overrides the allowlist. Do not retry "
      + 'it, and do not try a different spelling or a workaround; the allowlist needs to grant '
      + 'this exact call before it can run.';
  }
  if (draftState === 'approved') {
    return 'An approved draft already exists for this step, but this exact call is not one of '
      + 'its remaining approved pins. Do not draft again — that costs the user a second approval '
      + 'for a payload they already approved. Run one of the calls in your envelope\'s '
      // `writeGate` sits under `typePayload` for an action-type step but at the top level for
      // an orchestrated one (no typePayload wrapper there) — say just the part that's the same
      // in both rather than a path that's wrong for whichever role reads this.
      + 'writeGate.approvedCalls verbatim instead, and do not try a different spelling or a '
      + 'workaround.';
  }
  if (draftState === 'pending') {
    return "A draft for this step is still awaiting the user's review. Wait for it to be approved "
      + 'before writing — do not attempt this call now, do not submit a second draft, and do not '
      + 'try a different spelling or a workaround.';
  }
  return "You haven't drafted this write yet. Compose the payload and call "
    + 'mcp__outpost__submit_write_draft — it runs only once the user approves it. Do not attempt '
    + 'this write directly, and do not try a different spelling or a workaround.';
}

// The pin matched the command text, but a file it references (--input/--body-file/
// --notes-file) no longer hashes the same as it did at approval — rewritten, or gone. The
// command-text match alone can't see this; verifyFileDigests is the other half of the pin.
// Told explicitly not to retry: the daemon cannot tell whether the CURRENT content is what the
// session intends, only that it differs from what the user approved, so the only safe recovery
// is a fresh draft the user gets to see.
function fileDigestMismatchReason(): string {
  return 'The file this call references has changed since the draft was approved (rewritten, '
    + 'or no longer exists) — the payload that would run is not provably the one the user '
    + 'approved. Do not retry this call. Compose a fresh draft with the current content via '
    + 'mcp__outpost__submit_write_draft and wait for a new approval.';
}

export async function handleHook(opts: HandleHookOpts): Promise<HookResponse> {
  const {
    hookInput, allowlist, queue, modes, cwdForSession, worktreePathForSession, actionForSession,
    gatedForAction, pinFor, onPinConsumed, draftStateFor, onGatedDenial, onNotify, onActionDenial,
  } = opts;
  const mode = modes.get(hookInput.session_id);
  const action = actionForSession?.(hookInput.session_id);

  // Bypass: short-circuit before any check — except for an action-bound session. A step
  // session is never put in bypass deliberately (it has no mode selector of its own), but
  // nothing stops a stray approval_mode_set / `?mode=` from reaching its session id anyway
  // (see src/ws/client-messages.ts's approval_mode_set, which has no action-bound guard);
  // that must not silently disable the write gate for the rest of the step.
  if (mode === 'bypass' && !action) return allowResp();

  // Plan: allow read-shaped only; deny everything else with a clear reason. Plan mode
  // overrides even the allowlist — we want it to be a positive "lock the session into
  // read-only" gesture, not a "merge with allowlist" gesture. Same `!action` guard as
  // bypass below: nothing grants a gated write through PLAN_MODE_ALWAYS or a read-verb MCP
  // pattern today, but an action-bound session has no business getting Read/WebFetch/
  // WebSearch through a mode gesture instead of its own (possibly narrower) allowlist.
  if (mode === 'plan' && !action) {
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
  if (mode === 'accept-edits' && EDIT_TOOLS.has(hookInput.tool_name) && !action) {
    return allowResp();
  }

  // Action sessions run with explicit allowlist only: hit → allow, miss → deny
  // and record a denial so the user can review what was attempted. We never enqueue
  // for interactive approval because there's no human attached to an action step.
  const projectCwd = cwdForSession?.(hookInput.session_id);
  const worktreePath = worktreePathForSession?.(hookInput.session_id);
  if (action) {
    const gated = gatedForAction?.(action);
    if (gatedForAction && !gated) {
      // The registry has never heard of this action — not "inherits no gated group" (that
      // case is an all-empty ActionAllowlist, still truthy). Fail closed rather than fall
      // through to allows(), which would consult global/project/session scopes regardless of
      // whatever narrow allowlist this now-unknown action was meant to be confined to.
      const reason = `Action \`${action}\` is not recognized by the daemon right now — it may `
        + 'have been deleted or renamed while this job was running. Do not retry this or any '
        + 'other write, and do not try a workaround; stop and let the user know the job needs '
        + 'attention.';
      onGatedDenial?.(hookInput.session_id, action, reason);
      return denyResp(reason);
    }
    // Gated calls match the ordinary allowlist too (that's how they were auto-approved
    // before drafts existed), so this must run before the plain allows() check below or every
    // gated write would pass through unpinned. A call only runs once it BOTH matches a pin
    // from a draft the user approved AND clears allows() — a well-formed pin passes allows()
    // by construction (it only got gated because a gated rule matched it), so this only ever
    // rejects a smuggling shape the drafting/pinning path never validated (e.g. an unquoted
    // `$VAR` or a `>` redirect outside the worktree, see Critical 1 in review round 1).
    if (gated && gatedMatch(gated, hookInput.tool_name, hookInput.tool_input)) {
      const pin = pinFor?.(hookInput.session_id, hookInput.tool_name, hookInput.tool_input);
      const pinMatched = !!pin;
      if (!pin || !allowlist.allows(hookInput.tool_name, hookInput.tool_input, projectCwd, action, worktreePath, hookInput.session_id)) {
        const draftState = draftStateFor?.(hookInput.session_id) ?? 'none';
        const reason = gatedDenyReason(pinMatched, draftState);
        // Only the states that indicate an actual problem are worth a journal entry.
        // 'none' (attempted before drafting) and 'pending' (attempted while awaiting the
        // user) are ordinary first-turn/impatience behavior the deny message already
        // teaches in-band — journaling every one would be noise crowding out real lessons
        // in a bounded journal. `pinMatched` (Critical 1: an approved payload that still
        // fails the allowlist) and draftState 'approved' (an approved payload the model
        // can't reproduce — including a pin it already spent) are the wedge M6 exists to
        // surface.
        if (pinMatched || draftState === 'approved') {
          onGatedDenial?.(hookInput.session_id, action, reason);
        }
        return denyResp(reason);
      }
      // The pin matched command TEXT; a file it references (--input/--body-file/
      // --notes-file) could still have been rewritten since approval — verified here, not at
      // pinFor, because pinFor's job is "which pin matches," not "is it still trustworthy," and
      // because the pin must NOT be consumed on a mismatch (returning before onPinConsumed
      // below is what guarantees that).
      if (pin.fileDigests && !(await verifyFileDigests(pin.fileDigests))) {
        const reason = fileDigestMismatchReason();
        onGatedDenial?.(hookInput.session_id, action, reason);
        return denyResp(reason);
      }
      onPinConsumed?.(hookInput.session_id, pin.id, hookInput.tool_use_id);
      return allowResp();
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
