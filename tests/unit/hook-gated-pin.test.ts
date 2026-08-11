import { describe, it, expect } from 'vitest';
import { handleHook } from '../../src/permissions/hook-handler.js';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ApprovalModeStore } from '../../src/permissions/approval-mode.js';

const PUSH = {
  alwaysAllow: [], alwaysAllowPathPatterns: [], alwaysAllowMcpPatterns: [],
  alwaysAllowBashPatterns: ['^git push origin [A-Za-z0-9._/-]+$'],
};

const LINEAR_COMMENT = {
  alwaysAllow: [], alwaysAllowPathPatterns: [], alwaysAllowBashPatterns: [],
  alwaysAllowMcpPatterns: ['^mcp__claude_ai_Linear__save_comment$'],
};

const WHOLE_TOOL_BASH = {
  alwaysAllow: ['Bash'], alwaysAllowPathPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowBashPatterns: [],
};

function realPushAllowlist(): Allowlist {
  return new Allowlist({
    alwaysAllow: [], alwaysAllowPathPatterns: [], alwaysAllowMcpPatterns: [],
    alwaysAllowBashPatterns: ['^git push origin [A-Za-z0-9._/-]+$'],
  });
}

function run(over: Record<string, unknown> = {}) {
  const modes = new ApprovalModeStore();
  modes.set('s1', 'ask');
  return handleHook({
    hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: 's1' },
    allowlist: { allows: () => true } as never,
    queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
    modes,
    actionForSession: () => 'code.fix-ci',
    gatedForAction: () => PUSH,
    onNotify: () => {},
    ...over,
  });
}

describe('hook — gated calls require a pin', () => {
  it('denies a gated call with no approved pin', async () => {
    const r = await run({ pinFor: () => undefined });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('submit_write_draft');
  });

  it('allows a gated call that matches a pin, and consumes it', async () => {
    const consumed: string[] = [];
    const r = await run({
      pinFor: () => ({ id: 'c1' }),
      onPinConsumed: (_s: string, id: string) => consumed.push(id),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(consumed).toEqual(['c1']);
  });

  it('leaves ungated calls on the normal allowlist path', async () => {
    const r = await run({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'npm test' }, session_id: 's1' },
      pinFor: () => undefined,
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('does not gate a session with no bound action', async () => {
    const r = await run({ actionForSession: () => undefined, pinFor: () => undefined });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies a gated call even though the ordinary allowlist would allow it, and consumes no pin', async () => {
    const consumed: string[] = [];
    const r = await run({
      pinFor: () => undefined,
      onPinConsumed: (_s: string, id: string) => consumed.push(id),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(consumed).toEqual([]);
  });

  it('does not gate an interactive session with no bound action, even for a gated-shaped call', async () => {
    const r = await run({
      actionForSession: () => undefined,
      gatedForAction: () => { throw new Error('must not be called without a bound action'); },
      pinFor: () => { throw new Error('must not be called without a bound action'); },
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  // Review round 1, CRITICAL 1: a pin match must not skip the ordinary allowlist — a
  // well-formed pin passes allows() by construction, so this only ever catches a smuggling
  // shape (unquoted expansion, redirect outside the worktree) the draft/pin path never
  // validated against shell-safety.
  it('denies a pinned command smuggling an unquoted expansion through a gated clause', async () => {
    const consumed: string[] = [];
    const cmd = 'git push origin fix && echo $SECRET';
    const r = await run({
      hookInput: { tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's1' },
      allowlist: realPushAllowlist(),
      pinFor: () => ({ id: 'c1' }),
      onPinConsumed: (_s: string, id: string) => consumed.push(id),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).not.toContain('submit_write_draft');
    expect(consumed).toEqual([]);
  });

  it('denies a pinned command redirecting to a path outside the worktree', async () => {
    const consumed: string[] = [];
    const cmd = 'git push origin fix && cat notes.txt > /etc/cron.d/pwn';
    const r = await run({
      hookInput: { tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's1' },
      allowlist: realPushAllowlist(),
      pinFor: () => ({ id: 'c1' }),
      onPinConsumed: (_s: string, id: string) => consumed.push(id),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(consumed).toEqual([]);
  });

  // IMPORTANT 3: bypass ("allow everything") must not be reachable by an action-bound
  // session — a stray approval_mode_set / `?mode=` landing on a step session's id must not
  // silently disable the write gate for the rest of the step.
  it('still gates an action-bound session even in bypass mode', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'bypass');
    const r = await handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'git push origin fix' }, session_id: 's1' },
      allowlist: { allows: () => true } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      actionForSession: () => 'code.fix-ci',
      gatedForAction: () => PUSH,
      pinFor: () => undefined,
      onNotify: () => {},
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('bypass mode still allows a session with no bound action (unchanged)', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'bypass');
    const r = await handleHook({
      hookInput: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 's1' },
      allowlist: { allows: () => false } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      onNotify: () => {},
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  // MINOR 3: plan mode's read-shortcut is the same class of leak as bypass — a stray
  // approval_mode_set landing on a step session must not let Read/WebFetch/WebSearch
  // through a mode gesture instead of the action's own (possibly narrower) allowlist.
  it("still routes an action-bound session's reads through the action allowlist in plan mode", async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'plan');
    const r = await handleHook({
      hookInput: { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, session_id: 's1' },
      allowlist: { allows: () => false } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      actionForSession: () => 'code.fix-ci',
      gatedForAction: () => PUSH,
      onNotify: () => {},
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('plan mode still allows a read for a session with no bound action (unchanged)', async () => {
    const modes = new ApprovalModeStore();
    modes.set('s1', 'plan');
    const r = await handleHook({
      hookInput: { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, session_id: 's1' },
      allowlist: { allows: () => false } as never,
      queue: { enqueue: async () => ({ allow: true }), listPending: () => [] } as never,
      modes,
      onNotify: () => {},
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  // IMPORTANT 4: the deny reason must branch on why the pin missed instead of always
  // pointing at submit_write_draft — telling a model with an approved draft to redraft
  // costs the user a second, redundant approval.
  it('tells the model to run an approved call verbatim when an approved draft exists but this call is not one of its pins', async () => {
    const r = await run({ pinFor: () => undefined, draftStateFor: () => 'approved' });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = r.hookSpecificOutput.permissionDecisionReason!;
    expect(reason).toContain('approvedCalls');
    expect(reason).not.toContain('submit_write_draft');
  });

  it('tells the model to wait when a draft is pending the user\'s review', async () => {
    const r = await run({ pinFor: () => undefined, draftStateFor: () => 'pending' });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = r.hookSpecificOutput.permissionDecisionReason!;
    expect(reason.toLowerCase()).toContain('wait');
    expect(reason).not.toContain('submit_write_draft');
  });

  it('tells the model to draft when nothing has been drafted yet', async () => {
    const r = await run({ pinFor: () => undefined, draftStateFor: () => 'none' });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('submit_write_draft');
  });

  // MINOR 5: the registry not recognizing the bound action (deleted/renamed mid-run) must
  // fail closed, not fall through to the ordinary allowlist.
  it('denies when the registry no longer recognizes the bound action', async () => {
    const consumed: string[] = [];
    const gatedDenials: Array<{ action: string; reason: string }> = [];
    const r = await run({
      gatedForAction: () => undefined,
      pinFor: () => ({ id: 'c1' }),
      onPinConsumed: (_s: string, id: string) => consumed.push(id),
      onGatedDenial: (_s: string, action: string, reason: string) => gatedDenials.push({ action, reason }),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(consumed).toEqual([]);
    // Unknown-action is unconditionally worth a lesson — it's never "normal first-turn
    // behavior" the way an unmatched pin can be.
    expect(gatedDenials).toEqual([{ action: 'code.fix-ci', reason: expect.stringContaining('not recognized') }]);
  });

  // MINOR 6 (round 1) + IMPORTANT 1/2 (round 2): a gated denial is journal-only — never the
  // allowlist-miss rule suggestion — and is reported with the ACTION the hook actually
  // denied, not left for the callee to derive (a dispatch session's bound step is the
  // parent controller, not the child action; see engine-gate.test.ts for that case).
  it('reports a gated denial via onGatedDenial with the denied action, never via onActionDenial', async () => {
    const gatedDenials: Array<{ action: string; reason: string }> = [];
    const actionDenials: unknown[] = [];
    const r = await run({
      pinFor: () => undefined,
      draftStateFor: () => 'approved',
      onGatedDenial: (_s: string, action: string, reason: string) => gatedDenials.push({ action, reason }),
      onActionDenial: (d: unknown) => actionDenials.push(d),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(gatedDenials).toEqual([{ action: 'code.fix-ci', reason: expect.stringContaining('approvedCalls') }]);
    expect(actionDenials).toHaveLength(0);
  });

  // ALSO (round 2): 'none' and 'pending' are ordinary first-turn/impatience behavior the
  // deny message already teaches in-band — journaling every one would crowd out the real
  // lessons a bounded journal has room for.
  it('does not journal a denial for draft state none or pending', async () => {
    const gatedDenials: unknown[] = [];
    const onGatedDenial = (..._args: unknown[]) => gatedDenials.push(_args);
    const rNone = await run({ pinFor: () => undefined, draftStateFor: () => 'none', onGatedDenial });
    const rPending = await run({ pinFor: () => undefined, draftStateFor: () => 'pending', onGatedDenial });
    expect(rNone.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(rPending.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(gatedDenials).toHaveLength(0);
  });

  // Round 2, CRITICAL-1-adjacent: a pin that matches but fails allows() is exactly as
  // pathological as a mismatched approved draft — must still journal.
  it('journals a denial when a pin matches but the payload fails allows()', async () => {
    const gatedDenials: unknown[] = [];
    const cmd = 'git push origin fix && echo $SECRET';
    const r = await run({
      hookInput: { tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's1' },
      allowlist: realPushAllowlist(),
      pinFor: () => ({ id: 'c1' }),
      onGatedDenial: (..._args: unknown[]) => gatedDenials.push(_args),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(gatedDenials).toHaveLength(1);
  });

  // MINOR 7: gated matching also reaches MCP tools via rulesAllow's mcp-pattern branch,
  // and gatedMatch special-cases a whole-tool `Bash` grant as gating everything under it.
  it('gates an MCP tool call matched by a gated mcp pattern', async () => {
    const consumed: string[] = [];
    const r = await run({
      hookInput: {
        tool_name: 'mcp__claude_ai_Linear__save_comment',
        tool_input: { issueId: 'X-1', body: 'hi' },
        session_id: 's1',
      },
      gatedForAction: () => LINEAR_COMMENT,
      pinFor: () => ({ id: 'c1' }),
      onPinConsumed: (_s: string, id: string) => consumed.push(id),
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(consumed).toEqual(['c1']);
  });

  it('gates every command under a whole-tool Bash grant, the most dangerous gated config shape', async () => {
    const r = await run({
      gatedForAction: () => WHOLE_TOOL_BASH,
      hookInput: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 's1' },
      pinFor: () => undefined,
    });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('submit_write_draft');
  });
});
