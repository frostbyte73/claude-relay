import { describe, it, expect } from 'vitest';
import { withLiveness } from '../../src/work/job-liveness.js';
import type { JobRecord } from '../../src/work/work-types.js';

function job(partial: Partial<JobRecord>): JobRecord {
  return {
    id: 'j1', source: 'manual', title: 't', description: '', state: 'executing',
    steps: [], createdAt: 0, updatedAt: 0, ...partial,
  } as JobRecord;
}

describe('withLiveness', () => {
  it('marks the orchestrator live when its session is active', () => {
    const j = job({ state: 'planning', orchestratorSessionId: 'orch' });
    const out = withLiveness(j, (id) => id === 'orch');
    expect(out.live.orchestrator).toBe(true);
    expect(out.live.stepIds).toEqual([]);
  });

  it('lists steps whose session is active', () => {
    const j = job({ steps: [
      { id: 's1', type: 'action', state: 'running', sessionId: 'a' } as any,
      { id: 's2', type: 'action', state: 'running', sessionId: 'b' } as any,
    ] });
    const out = withLiveness(j, (id) => id === 'a');
    expect(out.live.stepIds).toEqual(['s1']);
  });

  it('counts a step live when one of its dispatch children is running', () => {
    const j = job({ steps: [
      { id: 's1', type: 'orchestrated', state: 'waiting', sessionId: 'x',
        dispatches: [{ id: 'd1', action: 'code.review-diff', brief: 'b', status: 'running', sessionId: 'child', attempts: 1 }] } as any,
    ] });
    const out = withLiveness(j, (id) => id === 'child');
    expect(out.live.stepIds).toEqual(['s1']);
    // ...but the controller's OWN session is not live, and sessionIds says so. This is the
    // distinction the inline feed runs on: the step has work in flight, yet the controller
    // has nothing to stream, so its feed states the status instead of a stale tail.
    expect(out.live.sessionIds).toEqual(['child']);
  });

  it('lists every live session on the job — orchestrator, step and dispatch child', () => {
    const j = job({ orchestratorSessionId: 'orch', steps: [
      { id: 's1', type: 'orchestrated', state: 'running', sessionId: 'ctrl',
        dispatches: [
          { id: 'd1', action: 'code.implement', brief: 'b', status: 'running', sessionId: 'child', attempts: 1 },
          { id: 'd2', action: 'code.spec', brief: 'b', status: 'done', sessionId: 'reaped', attempts: 1 },
        ] } as any,
      { id: 's2', type: 'action', state: 'running', sessionId: 'dead' } as any,
      { id: 's3', type: 'action', state: 'running', sessionId: 'skipme', cancelled: true } as any,
    ] });
    const out = withLiveness(j, (id) => id !== 'dead' && id !== 'reaped');
    expect(out.live.sessionIds).toEqual(['orch', 'ctrl', 'child']);
  });

  it('ignores cancelled steps and dead sessions', () => {
    const j = job({ steps: [
      { id: 's1', type: 'action', state: 'running', sessionId: 'dead', cancelled: true } as any,
      { id: 's2', type: 'action', state: 'resolved', sessionId: 'dead' } as any,
    ] });
    const out = withLiveness(j, () => false);
    expect(out.live).toEqual({ orchestrator: false, stepIds: [], sessionIds: [] });
  });

  it('does not mutate or persist onto the original job', () => {
    const j = job({ orchestratorSessionId: 'orch' });
    const out = withLiveness(j, () => true);
    expect((j as any).live).toBeUndefined();
    expect(out).not.toBe(j);
  });
});
