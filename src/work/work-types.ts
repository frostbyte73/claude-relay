export type JobState =
  | 'planning'
  | 'plan_pending_review'
  | 'executing'
  | 'done'
  | 'failed'
  | 'abandoned';

export type StepKind = 'action' | 'orchestrated';

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

// The step's own run bounds, which the job timeline can't give: a plan reconcile
// bumps every surviving step's updatedAt to the same instant, so createdAt→updatedAt
// reads as one bogus multi-day duration. Consumed by the inline session's terminal chip.
export type StepEventKind = 'spawned' | 'resolved' | 'failed' | 'merged';

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

// Generic step: spawn a session for a named action. Side-effecting work that needs a
// controller deciding its own next move each turn lives in OrchestratedStep —
// everything else is this.
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
  // 'gate_pending_approval' is the hard human-gate: an action whose frontmatter
  // declares `human_gate: true` parks here (no session spawned) before its session
  // ever runs, until the user approves (→ running) or declines (→ cancelled). The
  // daemon enforces this regardless of whether a planner inserted a meta.wait.
  state: 'running' | 'waiting' | 'gate_pending_approval' | 'resolved' | 'failed';
  // Epoch ms when a timed meta.wait auto-resumes. Unset for an indefinite manual hold.
  resumeAt?: number;
  // human_gate draft/review/commit loop. The action
  // runs in a draft phase that composes `draft` and parks in gate_pending_approval WITHOUT
  // performing the external write (the hook hard-blocks the write until gateApproved). The
  // user approves (→ commit phase posts it) or proposes changes (→ redraft phase with the
  // accumulated gateFeedback). The write only ever fires once gateApproved is set.
  draft?: string;
  gateFeedback?: string[];
  gateApproved?: boolean;
}

export interface Dispatch {
  id: string;
  action: string;
  brief: string;
  inputs?: Record<string, unknown>;
  workspace?: WorkspaceRef;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  sessionId?: string;
  output?: string;
  failure?: string;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  // Id of the prior dispatch this one retries. Set only when the controller named it
  // explicitly via retryOf — the sole way an identical (action, brief) is allowed through.
  retryOf?: string;
}

export type WatchedEvent = 'pr-comments' | 'ci' | 'review-state' | 'pr-state';

export type InboxItem =
  | { id: string; at: number; kind: 'user-message'; body: string }
  | { id: string; at: number; kind: 'dispatch-done'; dispatchId: string }
  | { id: string; at: number; kind: 'external'; source: 'pr-watcher'; summary: string; events: WatchedEvent[] }
  | { id: string; at: number; kind: 'gate-resolved'; approved: boolean; feedback?: string }
  | { id: string; at: number; kind: 'timer' }
  | { id: string; at: number; kind: 'policy-rejection'; reason: string };

export interface WaitSpec {
  reason: string;
  events?: Array<WatchedEvent | 'dispatches'>;
  untilAllDispatchesDone?: boolean;
  resumeAt?: number;
}

export type NextMove =
  | { kind: 'self-round'; action?: string; note?: string }
  | { kind: 'dispatch'; dispatches: Array<{ action: string; brief: string; inputs?: Record<string, unknown>; workspace?: WorkspaceRef; retryOf?: string }> }
  | { kind: 'wait'; wait: WaitSpec }
  | { kind: 'gate'; draft: string; question: string }
  | { kind: 'resolve'; output: string }
  | { kind: 'fail'; reason: string };

export interface GateRequest {
  draft: string;
  question: string;
  requestedAt: number;
  // The move this gate holds. Executed verbatim on approval WITHOUT re-validating —
  // otherwise a force-gated write would be re-gated forever.
  deferredMove: NextMove;
}

export interface PrFacts {
  prUrl?: string;
  prState?: 'open' | 'merged' | 'closed';
  ciState?: 'pending' | 'success' | 'failure';
  ciChecks?: CiCheck[];
  reviewState?: 'approved' | 'changes_requested' | 'review_required';
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  comments?: PrComment[];
  threadHash?: string;
}

export interface OrchestratedStep extends StepBase {
  type: 'orchestrated';
  controller: string;
  workspace: WorkspaceRef;
  goal: string;
  inputs?: Record<string, unknown>;
  phase?: string;
  memo?: string;
  artifacts?: Record<string, string>;
  dispatches: Dispatch[];
  inbox: InboxItem[];
  // The batch most recently handed to the controller. Persisted rather than passed as an
  // argument so a cold resume can still show the controller what woke it.
  lastDelivered?: InboxItem[];
  waitingOn?: WaitSpec;
  roundsSpent: number;
  consecutiveSelfRounds: number;
  // Set when the controller's last move was a policy rejection it hasn't yet corrected.
  // Cleared by any accepted move — an accepted move is what earns forgiveness. A second
  // rejection while this is still set fails the step (validateNext's "twice in a row" cap).
  pendingPolicyStrike?: boolean;
  pr?: PrFacts;
  gate?: GateRequest;
  gateApproved?: boolean;
  gateFeedback?: string[];
  iterations?: IterationRecord[];
  reviewComments?: ReviewComment[];
  draftedReplies?: DraftedReply[];
  state: 'running' | 'waiting' | 'gate_pending_approval' | 'resolved' | 'failed';
}

export type Step = ActionStep | OrchestratedStep;

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
  | 'dispatches' | 'inbox' | 'roundsSpent' | 'consecutiveSelfRounds'
> & {
  keepId?: string;
  workspace?: S['workspace'];
};

export type ProposedStep =
  | ({ type: 'action' }  & ProposedFields<ActionStep>)
  | ({ type: 'orchestrated' } & ProposedFields<OrchestratedStep>);

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
  // Set while a mid-execution step-review orchestrator session is in flight; the value is
  // the step whose completion triggered it. The job stays `executing` — a review is not a
  // planning phase, and parking it in `planning` made the PWA tear down the whole step
  // timeline (it reads that state as "no execution yet") every time a step finished. So
  // this field, not the state, is what gates step dispatch and keeps owesStepReview from
  // re-firing while the review runs.
  reviewingStepId?: string;
  linearStateMarked?: { inProgress?: boolean; inReview?: boolean; done?: boolean };
  linearStatusDirty?: boolean;
  linearCommentId?: string;
  // Set on jobs created via "promote to tracked" (POST /api/work/jobs/from-session/:id) —
  // links the manual job back to the interactive session it was spun out of.
  originSessionId?: string;
  // Bypasses the token-launch queue: a high-priority job's launches fire immediately,
  // regardless of token headroom or the concurrency slot budget. Absent = normal.
  highPriority?: boolean;
  failure?: { reason: string; at: number };
  events?: JobEvent[];
  createdAt: number;
  updatedAt: number;
}
