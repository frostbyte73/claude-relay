import type { JobRecord, Step } from '../work/work-types.js';

export type Action =
  | { kind: 'spawn-session'; jobId: string; stepId: string; envelopePath: string }
  | { kind: 'spawn-orchestrator'; jobId: string; mode: 'initial' | 'replan'; envelopePath: string }
  | { kind: 'request-merge-approval'; jobId: string; stepId: string }
  | { kind: 'request-conflict-approval'; jobId: string; stepId: string }
  | { kind: 'start-ci-fix'; jobId: string; stepId: string }
  | { kind: 'note-ci-fix-exhausted'; jobId: string; stepId: string }
  | { kind: 'write-linear-in-progress'; linearUuid: string; jobId: string }
  | { kind: 'write-linear-in-review';   linearUuid: string; jobId: string }
  | { kind: 'write-linear-done';        linearUuid: string; jobId: string }
  | { kind: 'upsert-status-comment';    jobId: string };

export type ExternalEvent =
  | { kind: 'pr-discovered'; prUrl: string; branch: string }
  | { kind: 'pr-state-changed'; prState: 'open' | 'merged' | 'closed' }
  | { kind: 'ci-state-changed'; ciState: 'pending' | 'success' | 'failure' }
  | { kind: 'review-state-changed'; reviewState: 'approved' | 'changes_requested' | 'review_required' }
  | { kind: 'pr-comments-changed'; comments: unknown[] };

export interface HandlerCtx {
  jobsDir: string;
  newId: () => string;
  now: () => number;
}

export interface StepHandler<S extends Step> {
  type: S['type'];
  initialState: S['state'];
  isResolved(step: S): boolean;
  decide(step: S, job: JobRecord, ctx: HandlerCtx): Action | null;
  buildEnvelope(step: S, job: JobRecord, ctx: HandlerCtx): object;
  onExternalEvent?(step: S, event: ExternalEvent): S;
}
