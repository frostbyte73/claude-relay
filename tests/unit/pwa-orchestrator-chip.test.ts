// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { orchestratorStepShim, withStepTiming } from '../../src/pwa/components/tracked/session-mounts.js';
// @ts-expect-error PWA modules are plain JS.
import { renderTerminalChipHtml, stepDurationText } from '../../src/pwa/components/work/session-terminal-chip.js';

const T0 = 1_700_000_000_000;
const SEC = 1000;

describe('orchestratorStepShim', () => {
  it('returns null while the orchestrator is still running (planning state)', () => {
    const job = {
      state: 'planning',
      events: [{ kind: 'orchestrator_started', at: T0 }],
    };
    expect(orchestratorStepShim(job)).toBeNull();
  });

  it('returns null when no plan has been posted yet', () => {
    const job = {
      state: 'failed',
      events: [{ kind: 'orchestrator_started', at: T0 }],
    };
    expect(orchestratorStepShim(job)).toBeNull();
  });

  it('synthesizes a resolved step spanning the most recent orchestrator run', () => {
    const job = {
      state: 'plan_pending_review',
      events: [
        { kind: 'orchestrator_started', at: T0 },
        { kind: 'plan_posted', at: T0 + 90 * SEC },
      ],
    };
    const shim = orchestratorStepShim(job);
    expect(shim.state).toBe('resolved');
    expect(renderTerminalChipHtml(shim)).toContain('Finished in 1m30s');
  });

  it('scopes duration to the latest reopen→post pair on a replanned job', () => {
    const job = {
      state: 'plan_pending_review',
      events: [
        { kind: 'orchestrator_started', at: T0 },
        { kind: 'plan_posted', at: T0 + 60 * SEC },
        { kind: 'orchestrator_reopened', at: T0 + 600 * SEC },
        { kind: 'plan_posted', at: T0 + 610 * SEC },
      ],
    };
    expect(renderTerminalChipHtml(orchestratorStepShim(job))).toContain('Finished in 10s');
  });

  it('bounds duration on a step-review continue (orchestrator_reviewed, no trailing plan_posted)', () => {
    const job = {
      state: 'executing',
      events: [
        { kind: 'orchestrator_started', at: T0 },
        { kind: 'plan_posted', at: T0 + 60 * SEC },
        { kind: 'orchestrator_started', at: T0 + 700 * SEC },
        { kind: 'orchestrator_reviewed', at: T0 + 715 * SEC },
      ],
    };
    const shim = orchestratorStepShim(job);
    expect(shim.state).toBe('resolved');
    expect(renderTerminalChipHtml(shim)).toContain('Finished in 15s');
  });
});

// A step's own `events` array is never populated by the engine — per-step timing
// lives on the JOB timeline (step_started → step_resolved/merged/failed). Regression
// guard for the regression where every step read one bogus multi-day "92h38m" because the
// chip fell back to createdAt→updatedAt (the latter bumped by a later plan reconcile).
describe('withStepTiming', () => {
  const RECONCILE = T0 + 92 * 3600 * SEC; // a much-later plan reconcile bumped updatedAt

  it('derives a resolved action step duration from step_started → step_resolved', () => {
    const step = { id: 'a', type: 'action', state: 'resolved', createdAt: T0, updatedAt: RECONCILE, events: [] };
    const job = {
      events: [
        { kind: 'step_started', stepId: 'a', at: T0 + 30 * SEC },
        { kind: 'step_resolved', stepId: 'a', at: T0 + (7 * 60 + 39) * SEC },
      ],
    };
    expect(stepDurationText(withStepTiming(job, step))).toBe('7m09s');
  });

  it('uses the last run when a step was retried', () => {
    const step = { id: 'b', type: 'action', state: 'resolved', createdAt: T0, updatedAt: RECONCILE, events: [] };
    const job = {
      events: [
        { kind: 'step_started', stepId: 'b', at: T0 },
        { kind: 'step_retried', stepId: 'b', at: T0 + 500 * SEC },
        { kind: 'step_started', stepId: 'b', at: T0 + 500 * SEC },
        { kind: 'step_resolved', stepId: 'b', at: T0 + 560 * SEC },
      ],
    };
    expect(stepDurationText(withStepTiming(job, step))).toBe('1m00s');
  });

  it('settled step with no end event on the job timeline: no fabricated duration', () => {
    const step = { id: 'c', type: 'orchestrated', state: 'resolved', phase: 'merged', createdAt: T0, updatedAt: RECONCILE, events: [] };
    const job = { events: [{ kind: 'step_started', stepId: 'c', at: T0 }] };
    const html = renderTerminalChipHtml(withStepTiming(job, step));
    expect(html).toContain('data-variant="finished"');
    expect(html).not.toMatch(/in \d/);
  });
});
