import type { JobRecord, Step } from '../work/work-types.js';
import type { ActionRegistry } from '../actions/registry.js';

export type Action =
  | { kind: 'spawn-session'; jobId: string; stepId: string; envelopePath: string }
  | { kind: 'spawn-orchestrator'; jobId: string; mode: 'initial' | 'replan'; envelopePath: string }
  // meta.wait (builtin runner): park the step in a daemon-side hold rather than spawn a
  // session. `resolve-wait` fires when the soak timer elapses; the user-resume path calls
  // engine.resumeWait() directly.
  | { kind: 'enter-wait'; jobId: string; stepId: string; durationSec?: number }
  | { kind: 'resolve-wait'; jobId: string; stepId: string; by: 'timer' }
  | { kind: 'deliver-inbox'; jobId: string; stepId: string }
  | { kind: 'write-linear-in-progress'; linearUuid: string; jobId: string }
  | { kind: 'write-linear-in-review';   linearUuid: string; jobId: string }
  | { kind: 'write-linear-done';        linearUuid: string; jobId: string }
  | { kind: 'upsert-status-comment';    jobId: string };

export interface HandlerCtx {
  jobsDir: string;
  newId: () => string;
  now: () => number;
  // Lets a step handler read an action's frontmatter (e.g. runner) at decide time.
  // Optional so tests can construct a ctx without a registry.
  actionRegistry?: ActionRegistry;
}

export interface StepHandler<S extends Step> {
  type: S['type'];
  initialState: S['state'];
  isResolved(step: S): boolean;
  decide(step: S, job: JobRecord, ctx: HandlerCtx): Action | null;
  buildEnvelope(step: S, job: JobRecord, ctx: HandlerCtx): object;
}
