import type { JobRecord, OpenPrStep, OrchestratedStep, PrFacts, Step, WaitSpec } from '../work/work-types.js';

const PR_WAIT: WaitSpec = {
  reason: 'PR is open — watching CI, reviews, and comments',
  events: ['ci', 'review-state', 'pr-state', 'pr-comments'],
};

const PHASE: Record<OpenPrStep['state'], string> = {
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

const STATE: Record<OpenPrStep['state'], OrchestratedStep['state']> = {
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

export function migrateOpenPrStep(s: OpenPrStep): OrchestratedStep {
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

  const out: OrchestratedStep = {
    id: s.id,
    title: s.title,
    description: s.description,
    type: 'orchestrated',
    controller: 'code.orchestrate-pr',
    workspace: s.workspace,
    goal: s.goal,
    inputs: { approach: s.approach, ...(s.risks ? { risks: s.risks } : {}) },
    phase: PHASE[s.state],
    state: STATE[s.state],
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
  if (s.state === 'pr_open') out.waitingOn = PR_WAIT;
  if (s.parallelGroup !== undefined) out.parallelGroup = s.parallelGroup;
  if (s.sessionId !== undefined) out.sessionId = s.sessionId;
  if (s.events !== undefined) out.events = s.events;
  if (s.failure !== undefined) out.failure = s.failure;
  if (s.cancelled !== undefined) out.cancelled = s.cancelled;
  if (s.reviewed !== undefined) out.reviewed = s.reviewed;
  if (s.iterations !== undefined) out.iterations = s.iterations;
  if (s.reviewComments !== undefined) out.reviewComments = s.reviewComments;
  if (s.draftedReplies !== undefined) out.draftedReplies = s.draftedReplies;
  return out;
}

export function migrateJob(job: JobRecord): JobRecord {
  if (!job.steps.some((s) => s.type === 'open-pr')) return job;
  const steps: Step[] = job.steps.map((s) => s.type === 'open-pr' ? migrateOpenPrStep(s) : s);
  return { ...job, steps };
}
