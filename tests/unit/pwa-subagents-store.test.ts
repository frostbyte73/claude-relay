// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { subagents, applyAgentMessageUse, applyAgentMessageResult } from '../../src/pwa/state/subagents.js';

beforeEach(() => {
  subagents.setFocused('s1');
  subagents.replaceFromDisk(new Map(), 's1');
});

describe('subagents store', () => {
  it('getOrCreateBucket creates and returns a bucket', () => {
    const b = subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    expect(b.agentType).toBe('Explore');
    expect(subagents.forSession('s1').byId.get('a1')).toBe(b);
  });

  it('addEntry pushes into entries[]', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.addEntry('a1', { kind: 'tool_use', toolUseId: 'u1' }, 's1');
    expect(subagents.forSession('s1').byId.get('a1')!.entries).toHaveLength(1);
  });

  it('bringToFront moves agent to position 0', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a2', agentType: 'Plan', firstSeenAt: 2 });
    subagents.bringToFront('a1', 's1');
    expect(subagents.forSession('s1').tabOrder[0]).toBe('a1');
  });

  it('markBlockSigSeen dedupes', () => {
    subagents.markBlockSigSeen('sig-x');
    expect(subagents.hasBlockSig('sig-x')).toBe(true);
    expect(subagents.hasBlockSig('sig-y')).toBe(false);
  });

  it('consumeUnboundInvocation FIFO by agentType', () => {
    subagents.recordUnboundInvocation({ toolUseId: 'u1', subagentType: 'Explore', description: 'd1' });
    subagents.recordUnboundInvocation({ toolUseId: 'u2', subagentType: 'Plan', description: 'd2' });
    const got = subagents.consumeUnboundInvocation({ agentType: 'Explore' });
    expect(got?.toolUseId).toBe('u1');
    expect(subagents.get().unboundInvocations).toHaveLength(1);
  });

  it('focused() returns the setFocused slice', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.setFocused('s1');
    expect(subagents.focused().byId.get('a1')?.agentType).toBe('Explore');
    subagents.setFocused('s2');
    expect(subagents.focused().byId.size).toBe(0);
  });

  it('resolveApproval flips a pending entry decision and notifies subscribers', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.addEntry('a1', { approvalId: 'ap1', toolUseId: 'u1', toolName: 'Read', decision: null }, 's1');
    let notified = 0;
    const unsub = subagents.subscribe(() => { notified += 1; });
    subagents.resolveApproval('ap1', 'allow', false);
    unsub();
    expect(subagents.forSession('s1').byId.get('a1')!.entries[0].decision).toBe('allow');
    // The rail repaints only off subagents.subscribe — a direct in-place write
    // would leave it frozen on a stale tail, so resolution MUST notify.
    expect(notified).toBe(1);
  });

  it('a SendMessage to a finished agent takes it out of "done" and keeps the round', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.addEntry('a1', { toolUseId: 'u1', toolName: 'Read', decision: 'allow' }, 's1');
    subagents.setCompletion('a1', 's1', { status: 'completed', summary: 'found it', completedAt: 10 });

    let notified = 0;
    const unsub = subagents.subscribe(() => { notified += 1; });
    expect(applyAgentMessageUse({ to: 'a1', summary: 'dig deeper' }, 's1')).toBe(true);
    unsub();

    const bucket = subagents.forSession('s1').byId.get('a1')!;
    expect(bucket.completion).toBeNull();
    expect(bucket.entries.map((e: { kind?: string }) => e.kind)).toEqual([undefined, 'completed-round', 'resumed']);
    expect(bucket.entries[1].completion.summary).toBe('found it');
    expect(notified).toBe(1);
  });

  it('a second send while the agent is running is not a resume', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.setCompletion('a1', 's1', { status: 'completed', completedAt: 10 });
    applyAgentMessageUse({ to: 'a1', summary: 'again' }, 's1');
    expect(applyAgentMessageUse({ to: 'a1', summary: 'and again' }, 's1')).toBe(false);
    expect(subagents.forSession('s1').byId.get('a1')!.entries).toHaveLength(2);
  });

  it('a name-addressed send resumes via the result\'s resumedAgentId', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.setCompletion('a1', 's1', { status: 'completed', completedAt: 10 });
    // `to` was a teammate name, which resolves to no bucket.
    expect(applyAgentMessageUse({ to: 'researcher', summary: 'dig deeper' }, 's1')).toBe(false);
    expect(subagents.forSession('s1').byId.get('a1')!.completion).not.toBeNull();
    const result = JSON.stringify({ data: { success: true, message: 'resumed it', resumedAgentId: 'a1' } });
    expect(applyAgentMessageResult(result, 's1')).toBe(true);
    expect(subagents.forSession('s1').byId.get('a1')!.completion).toBeNull();
  });

  it('slices for two sessions do not mingle', () => {
    subagents.getOrCreateBucket({ sessionId: 's1', agentId: 'a1', agentType: 'Explore', firstSeenAt: 1 });
    subagents.getOrCreateBucket({ sessionId: 's2', agentId: 'a2', agentType: 'Plan', firstSeenAt: 2 });
    expect(subagents.forSession('s1').byId.size).toBe(1);
    expect(subagents.forSession('s2').byId.size).toBe(1);
    expect(subagents.forSession('s1').byId.has('a2')).toBe(false);
  });
});
