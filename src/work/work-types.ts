export type JobState =
  | 'planning'
  | 'plan_pending_review'
  | 'executing'
  | 'done'
  | 'failed'
  | 'abandoned';

export type StepKind = 'open-pr' | 'action';

export type WorkspaceRef =
  | { kind: 'none' }
  | { kind: 'readonly'; repoCwd: string; ref?: string }
  | { kind: 'writable'; repoCwd: string; branch: string };

export interface PrComment {
  id: string;
  author: string;
  body: string;
  url?: string;
  file?: string;
  line?: number;
  diffHunk?: string;
  inReplyTo?: string;
  createdAt: number;
  respondedAt?: number;
  reopenedAt?: number;
  userReactions?: string[];
}

export interface ReviewComment {
  id: string;
  iterationId: string;
  kind: 'replies';
  file?: string;
  line?: number;
  author: 'user' | 'claude';
  body: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface IterationRecord {
  id: string;
  kind: 'replies';
  status: 'in_progress' | 'approved' | 'rejected';
  startedAt: number;
  postedAt?: number;
  resolvedAt?: number;
  feedback?: string;
}

export interface DraftedReply {
  commentId: string;
  recommendation: 'reply' | 'edit' | 'ignore';
  rationale: string;
  draftReply: string;
  userEdited?: boolean;
  // How sure the triage run was about `recommendation`. Optional — older drafts
  // and any external caller predating this field simply omit it.
  confidence?: 'high' | 'medium' | 'low';
}

export interface EditJob {
  id: string;
  commentId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  userNote?: string;
  sessionId?: string;
  startedAt?: number;
  finishedAt?: number;
  failure?: string;
}

export type StepEventKind =
  | 'spawned'
  | 'state_changed'
  | 'pr_discovered'
  | 'pr_state_changed'
  | 'comment_pending'
  | 'replies_posted'
  | 'replies_approved'
  | 'replies_rejected'
  | 'review_comment_added'
  | 'merged'
  | 'resolved'
  | 'failed'
  | 'cancelled';

export interface StepEvent {
  id: string;
  at: number;
  kind: StepEventKind;
  who: 'orchestrator' | 'user' | 'session' | 'pr-watcher' | 'system';
  body?: string;
}

interface StepBase {
  id: string;
  title: string;
  description: string;
  parallelGroup?: string;
  sessionId?: string;
  events?: StepEvent[];
  failure?: { reason: string; at: number };
  cancelled?: boolean;
  // Set true once a submit_continue step-review has covered this settled step, so
  // the engine doesn't re-review the same group. New steps start unreviewed.
  reviewed?: boolean;
  createdAt: number;
  updatedAt: number;
}

// One entry of the PR's status-check rollup — a single GitHub Actions job or
// commit-status context. `ciState` is the rollup of these; `ciChecks` is the
// per-workflow breakdown the PR block lists.
export interface CiCheck {
  name: string;
  state: 'success' | 'failure' | 'pending' | 'skipped';
  url?: string;
}

export interface OpenPrStep extends StepBase {
  type: 'open-pr';
  workspace: { kind: 'writable'; repoCwd: string; branch: string };
  goal: string;
  approach: string;
  risks?: string;
  state: 'speccing' | 'spec_pending_review' | 'planning' | 'implementing' | 'pr_open'
       | 'comment_pending_response' | 'reply_pending_review' | 'conflicting'
       | 'conflict_unresolved' | 'merged' | 'failed';
  // Spec → plan → implement artifacts. Stored as job state, never written to the
  // worktree, so the review diff stays pure implementation.
  spec?: string;         // design spec markdown (submit_spec)
  implPlan?: string;     // implementation plan markdown (submit_impl_plan)
  specFeedback?: string[]; // accumulated user revision notes across gate loops
  prUrl?: string;
  prState?: 'open' | 'merged' | 'closed';
  ciState?: 'pending' | 'success' | 'failure';
  ciChecks?: CiCheck[];
  // GitHub's mergeability, orthogonal to CI: a 'conflicting' PR can't merge until
  // conflicts are resolved even while its checks read as pending/blocked.
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  // True while a code.resolve-conflicts round is mid-flight on the shared session.
  // Guards decide() from re-emitting the gate and the watcher from re-flipping state.
  conflictResolving?: boolean;
  // Set when a squash-to-base attempt hit conflicts and spawned a resolve round;
  // markConflictResolved reads it to auto-retry the squash once conflicts are resolved.
  conflictPostAction?: 'squash-to-base';
  // True while a code.fix-ci round is mid-flight on the shared session. Guards
  // decide() from re-spawning and the watcher window before the fix push lands.
  ciFixing?: boolean;
  // How many auto-fix rounds we've spawned for this PR. Hard-capped (CI_FIX_CAP)
  // as a backstop against thrash between two distinct failure signatures.
  ciFixAttempts?: number;
  // Signature of the failing-check set we last attempted. If the same set fails
  // again after a fix, we stop instead of re-attempting the identical failure.
  ciFixLastSignature?: string;
  // Set once we've declined to keep auto-fixing (cap hit, or same failure
  // recurred, or the round reported unfixable). Surfaces "auto-fix stopped" in UI.
  ciFixGaveUp?: boolean;
  reviewState?: 'approved' | 'changes_requested' | 'review_required';
  comments?: PrComment[];
  iterations?: IterationRecord[];
  reviewComments?: ReviewComment[];
  draftedReplies?: DraftedReply[];
  editQueue?: EditJob[];
  threadHash?: string;
}

// Generic step: spawn a session for a named action. Side-effecting work (PR opening
// with multi-round comment handling) lives in OpenPrStep — everything else is this.
// `forwardOutput` controls whether the step's output is threaded into downstream
// steps as `previousSteps[].output`; defaults to true for read-only investigations,
// false for one-off operational work.
export interface ActionStep extends StepBase {
  type: 'action';
  workspace: WorkspaceRef;
  action: string;
  goal: string;
  inputs?: Record<string, unknown>;
  output?: string;
  forwardOutput?: boolean;
  // 'waiting' is a builtin-runner-only state: a meta.wait hold. The engine parks the
  // step here (no session spawned) until the user resumes or `resumeAt` elapses.
  state: 'running' | 'waiting' | 'resolved' | 'failed';
  // Epoch ms when a timed meta.wait auto-resumes. Unset for an indefinite manual hold.
  resumeAt?: number;
}

export type Step = OpenPrStep | ActionStep;

export type JobEventKind =
  | 'created'
  | 'state_changed'
  | 'plan_posted'
  | 'plan_approved'
  | 'plan_rejected'
  | 'plan_reconciled'
  | 'orchestrator_started'
  | 'orchestrator_reopened'
  | 'orchestrator_reviewed'
  | 'step_started'
  | 'step_resolved'
  | 'step_failed'
  | 'step_merged'
  | 'step_retried'
  | 'linear_state_written'
  | 'failed'
  | 'abandoned';

export interface JobEvent {
  id: string;
  at: number;
  kind: JobEventKind;
  who: 'orchestrator' | 'user' | 'session' | 'pr-watcher' | 'linear-poller' | 'linear-writer' | 'system';
  stepId?: string;
  body?: string;
}

type ProposedFields<S extends Step> = Omit<
  S,
  'id' | 'state' | 'sessionId' | 'events' | 'failure' | 'createdAt' | 'updatedAt' | 'workspace'
> & {
  keepId?: string;
  workspace?: S['workspace'];
};

export type ProposedStep =
  | ({ type: 'open-pr' } & ProposedFields<OpenPrStep>)
  | ({ type: 'action' }  & ProposedFields<ActionStep>);

export interface FindingEvidence {
  kind: string;         // 'datadog-logs' | 'repo-file' | 'linear-comment' | ...
  source?: string;      // URL, file:line, log query, ticket ID
  summary: string;
  excerpt?: string;
}

export interface FindingVerdict {
  kind: 'service-bug' | 'outage' | 'client-side' | 'external' | 'unknown';
  confidence: number;
  responsible_team?: string;
  suggested_title?: string;
  writeup?: string;
  customer_summary?: string;
}

// The orchestrator's up-front investigation, persisted on the plan so it is visible
// at the approval decision and auditable afterward. Same shape as
// read.investigate's output (mirrored, not shared — the repo has no $ref loader).
export interface Finding {
  findings: string;     // primary markdown writeup
  evidence?: FindingEvidence[];
  verdict?: FindingVerdict;
  caveats?: string[];
}

export interface PlanIteration {
  id: string;
  steps: ProposedStep[];
  feedback: string;
  rejectedAt: number;
  findings?: Finding;   // snapshot of the findings this rejected plan reasoned from
}

export interface JobRecord {
  id: string;
  source: string;        // 'linear' | 'manual' | any external source id (e.g. a second job source)
  dedupeKey?: string;    // idempotency key; a create_job with a seen key no-ops onto the existing job
  title: string;
  description: string;
  externalRef?: {
    url: string;
    issueIdentifier?: string;
    linearUuid?: string;
  };
  state: JobState;
  steps: Step[];
  orchestratorSessionId?: string;
  orchestratorAction?: string;
  plan?: {
    postedAt: number;
    iterationsRejected: PlanIteration[];
    findings?: Finding;
  };
  pendingReconciliation?: {
    proposed: ProposedStep[];
    drops: string[];
    feedback: string;
    proposedAt: number;
  };
  linearStateMarked?: { inProgress?: boolean; inReview?: boolean; done?: boolean };
  linearStatusDirty?: boolean;
  linearCommentId?: string;
  // Set on jobs created via "promote to tracked" (POST /api/work/jobs/from-session/:id) —
  // links the manual job back to the interactive session it was spun out of.
  originSessionId?: string;
  failure?: { reason: string; at: number };
  events?: JobEvent[];
  createdAt: number;
  updatedAt: number;
}
