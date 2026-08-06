import type {
  CiCheck, DraftedReply, IterationRecord, JobRecord, OrchestratedStep, PrComment, PrFacts,
  ReviewComment, Step, StepEvent, WaitSpec,
} from '../work/work-types.js';

// The persisted shape of the deleted `open-pr` step type. It is declared here, and
// nowhere else, because on-disk records written before the orchestrated rewrite still
// have to load — the live type system knows nothing about it.
interface LegacyOpenPrStep {
  id: string;
  title: string;
  description: string;
  type: 'open-pr';
  workspace: { kind: 'writable'; repoCwd: string; branch: string };
  goal: string;
  approach: string;
  risks?: string;
  state: string;
  spec?: string;
  implPlan?: string;
  specFeedback?: string[];
  prUrl?: string;
  prState?: 'open' | 'merged' | 'closed';
  ciState?: 'pending' | 'success' | 'failure';
  ciChecks?: CiCheck[];
  reviewState?: 'approved' | 'changes_requested' | 'review_required';
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  comments?: PrComment[];
  threadHash?: string;
  parallelGroup?: string;
  sessionId?: string;
  events?: StepEvent[];
  failure?: { reason: string; at: number };
  cancelled?: boolean;
  reviewed?: boolean;
  iterations?: IterationRecord[];
  reviewComments?: ReviewComment[];
  draftedReplies?: DraftedReply[];
  createdAt: number;
  updatedAt: number;
}

const PR_WAIT: WaitSpec = {
  reason: 'PR is open — watching CI, reviews, and comments',
  events: ['ci', 'review-state', 'pr-state', 'pr-comments'],
};

const PHASE: Record<string, string> = {
  speccing: 'spec',
  spec_pending_review: 'spec',
  planning: 'plan',
  implementing: 'implement',
  pr_open: 'pr_open',
  comment_pending_response: 'pr_comments',
  reply_pending_review: 'pr_comments',
  conflicting: 'conflict',
  conflict_unresolved: 'conflict',
  merged: 'merged',
  failed: 'failed',
};

const STATE: Record<string, OrchestratedStep['state']> = {
  speccing: 'running',
  spec_pending_review: 'running',
  planning: 'running',
  implementing: 'running',
  pr_open: 'waiting',
  comment_pending_response: 'running',
  reply_pending_review: 'running',
  conflicting: 'running',
  conflict_unresolved: 'failed',
  merged: 'resolved',
  failed: 'failed',
};

function failureReason(state: string, known: boolean): string {
  if (!known) return `unrecognized legacy state ${JSON.stringify(state)} — retry the step to hand it to the controller`;
  if (state === 'conflict_unresolved') {
    return 'conflicts were never resolved before the orchestrated rewrite — retry to hand the step back to the controller';
  }
  return 'step was already failed before the orchestrated rewrite';
}

export function migrateOpenPrStep(raw: Record<string, unknown>): OrchestratedStep {
  const s = raw as unknown as LegacyOpenPrStep;

  const pr: PrFacts = {};
  if (s.prUrl !== undefined) pr.prUrl = s.prUrl;
  if (s.prState !== undefined) pr.prState = s.prState;
  if (s.ciState !== undefined) pr.ciState = s.ciState;
  if (s.ciChecks !== undefined) pr.ciChecks = s.ciChecks;
  if (s.reviewState !== undefined) pr.reviewState = s.reviewState;
  if (s.mergeable !== undefined) pr.mergeable = s.mergeable;
  if (s.comments !== undefined) pr.comments = s.comments;
  if (s.threadHash !== undefined) pr.threadHash = s.threadHash;

  const artifacts: Record<string, string> = {};
  if (s.spec) artifacts.spec = s.spec;
  if (s.implPlan) artifacts.implPlan = s.implPlan;

  // Pre-spec-flow records were materialized straight into 'implementing'; the
  // spec → plan → implement rounds came later. A step sitting in 'implementing'/'planning'
  // with no session, no PR and no artifacts was never actually dispatched — those states
  // were only reachable via a transition that also set a sessionId — so migrating it at
  // face value would hand the controller a phase it never earned and skip the spec round.
  const stranded = (s.state === 'implementing' || s.state === 'planning')
    && !s.sessionId && !s.prUrl && !s.spec && !s.implPlan && !s.cancelled;
  const state = stranded ? 'speccing' : s.state;

  // A hand-edited or corrupt record with an unknown state lands in "Needs you" rather
  // than carrying `state: undefined` into the engine, where nothing can recover it.
  const known = state in STATE;

  const out: OrchestratedStep = {
    id: s.id,
    title: s.title,
    description: s.description,
    type: 'orchestrated',
    controller: 'code.orchestrate-pr',
    workspace: s.workspace,
    goal: s.goal,
    inputs: { ...(s.approach ? { approach: s.approach } : {}), ...(s.risks ? { risks: s.risks } : {}) },
    phase: known ? PHASE[state] : 'failed',
    state: known ? STATE[state]! : 'failed',
    dispatches: [],
    inbox: [],
    roundsSpent: 0,
    consecutiveSelfRounds: 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (Object.keys(pr).length) out.pr = pr;
  if (Object.keys(artifacts).length) out.artifacts = artifacts;
  if (s.specFeedback?.length) out.gateFeedback = s.specFeedback;
  if (state === 'pr_open') out.waitingOn = PR_WAIT;
  if (s.parallelGroup !== undefined) out.parallelGroup = s.parallelGroup;
  if (s.sessionId !== undefined) out.sessionId = s.sessionId;
  if (s.events !== undefined) out.events = s.events;
  // A `failed` step with no `.failure` is inert in every direction: decide() ignores it, the
  // pr-watcher skips it, decideJobTransitions keys job failure on `.failure` (so the job neither
  // fails nor completes), and the cockpit's "Job failed → Retry" card keys on it too. That is a
  // silent permanent stall, so every failed landing gets a reason the user can act on.
  if (s.failure !== undefined) out.failure = s.failure;
  else if (out.state === 'failed') out.failure = { reason: failureReason(state, known), at: s.updatedAt };
  if (s.cancelled !== undefined) out.cancelled = s.cancelled;
  if (s.reviewed !== undefined) out.reviewed = s.reviewed;
  if (s.iterations !== undefined) out.iterations = s.iterations;
  if (s.reviewComments !== undefined) out.reviewComments = s.reviewComments;
  if (s.draftedReplies !== undefined) out.draftedReplies = s.draftedReplies;
  return out;
}

function isLegacyOpenPr(s: Step): boolean {
  return (s as unknown as { type: string }).type === 'open-pr';
}

export function migrateJob(job: JobRecord): JobRecord {
  if (!job.steps.some(isLegacyOpenPr)) return job;
  const steps: Step[] = job.steps.map((s) =>
    isLegacyOpenPr(s) ? migrateOpenPrStep(s as unknown as Record<string, unknown>) : s);
  return { ...job, steps };
}
