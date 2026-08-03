import type { CiCheck, JobRecord, OpenPrStep } from '../work/work-types.js';
import { writeEnvelope, type OpenPrEnvelope } from '../work/envelope.js';
import type { ExternalEvent, StepHandler } from './types.js';

const CI_FIX_CAP = 3;

function ciSettled(checks: CiCheck[] | undefined): boolean {
  return !!checks && checks.length > 0 && !checks.some((c) => c.state === 'pending');
}

export function ciFailureSignature(checks: CiCheck[] | undefined): string {
  return (checks ?? []).filter((c) => c.state === 'failure').map((c) => c.name).sort().join('|');
}

export function shouldAutoFixCi(s: OpenPrStep): boolean {
  return s.prState === 'open'
    && s.ciState === 'failure'
    && ciSettled(s.ciChecks)
    && !s.ciFixing
    && (s.ciFixAttempts ?? 0) < CI_FIX_CAP
    && ciFailureSignature(s.ciChecks) !== s.ciFixLastSignature;
}

// A settled failure we are declining to fix (cap reached or identical failure
// recurred) and have not yet flagged as given-up.
function ciFixExhausted(s: OpenPrStep): boolean {
  return s.prState === 'open'
    && s.ciState === 'failure'
    && ciSettled(s.ciChecks)
    && !s.ciFixing
    && !s.ciFixGaveUp
    && !shouldAutoFixCi(s);
}

function previousFindings(job: JobRecord, selfId: string) {
  return job.steps
    .filter((st) => st.id !== selfId && st.type === 'action' && st.forwardOutput !== false && st.output)
    .map((st) => ({
      id: st.id,
      title: st.title,
      action: (st as { action?: string }).action,
      output: (st as { output?: string }).output,
    }));
}

function roundForState(s: OpenPrStep): OpenPrEnvelope['typePayload']['round'] {
  switch (s.state) {
    case 'speccing':
      return { kind: 'spec', feedback: s.specFeedback };
    case 'planning':
      return { kind: 'plan' };
    case 'comment_pending_response':
    case 'reply_pending_review':
      return {
        kind: 'pr-comments',
        comments: (s.comments ?? []).filter((c) => {
          if (c.respondedAt) return false;
          const drafted = (s.draftedReplies ?? []).some((d) => d.commentId === c.id);
          return !drafted;
        }),
      };
    default:
      return 'initial';
  }
}

export const openPrHandler: StepHandler<OpenPrStep> = {
  type: 'open-pr',
  initialState: 'speccing',

  isResolved(s) { return s.state === 'merged'; },

  decide(s, job, ctx) {
    if (s.cancelled || s.failure) return null;
    switch (s.state) {
      case 'speccing': {
        if (s.sessionId) return null;
        const envelope = openPrHandler.buildEnvelope(s, job, ctx);
        const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
        return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
      }
      case 'spec_pending_review':
        return null; // gate — user accepts (→ planning) or proposes changes (→ speccing)
      case 'planning':
      case 'implementing':
        // Entered only via engine transitions (approveSpec / onImplPlanReady), which
        // resume the shared session directly (see WorkEngine.dispatchRound). decide()
        // must NOT re-dispatch on subsequent ticks, or every incidental tick re-sends
        // the round to a busy session. The transition owns the one-shot dispatch.
        return null;
      case 'comment_pending_response':
      case 'reply_pending_review': {
        // One resumable session per step: don't open a triage round while an edit
        // round is mid-flight on the same session.
        if ((s.editQueue ?? []).some((e) => e.status === 'running')) return null;
        const drafted = new Set((s.draftedReplies ?? []).map((d) => d.commentId));
        const undrafted = (s.comments ?? []).filter((c) => !c.respondedAt && !drafted.has(c.id));
        if (undrafted.length === 0) return null;
        const busy = (s.iterations ?? []).some((it) => it.kind === 'replies' && it.status === 'in_progress' && !it.postedAt);
        if (busy) return null;
        const envelope = openPrHandler.buildEnvelope(s, job, ctx);
        const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
        return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
      }
      case 'pr_open': {
        const ready = s.prState === 'open'
          && s.ciState === 'success'
          && s.reviewState === 'approved';
        if (ready) return { kind: 'request-merge-approval', jobId: job.id, stepId: s.id };
        // CI auto-fix only runs from pr_open — comment/conflict rounds own the session first.
        if (shouldAutoFixCi(s)) return { kind: 'start-ci-fix', jobId: job.id, stepId: s.id };
        if (ciFixExhausted(s)) return { kind: 'note-ci-fix-exhausted', jobId: job.id, stepId: s.id };
        return null;
      }
      case 'conflicting': {
        if (s.conflictResolving) return null;
        return { kind: 'request-conflict-approval', jobId: job.id, stepId: s.id };
      }
      case 'conflict_unresolved':
        return null;
      case 'merged':
      case 'failed':
        return null;
    }
  },

  buildEnvelope(s, job) {
    return {
      kind: 'step',
      jobId: job.id,
      stepId: s.id,
      type: 'open-pr',
      title: s.title,
      description: s.description,
      goal: s.goal,
      approach: s.approach,
      risks: s.risks,
      spec: s.spec,
      implPlan: s.implPlan,
      job: {
        source: job.source,
        title: job.title,
        description: job.description,
        externalRef: job.externalRef,
      },
      previousSteps: previousFindings(job, s.id),
      workspace: s.workspace,
      typePayload: {
        branch: s.workspace.branch,
        round: roundForState(s),
      },
    };
  },

  onExternalEvent(s, ev): OpenPrStep {
    switch (ev.kind) {
      case 'pr-discovered':
        return {
          ...s,
          prUrl: ev.prUrl,
          prState: 'open',
          state: s.state === 'implementing' ? 'pr_open' : s.state,
        };
      case 'pr-state-changed':
        return {
          ...s,
          prState: ev.prState,
          state: ev.prState === 'merged' ? 'merged' : s.state,
        };
      case 'ci-state-changed':
        return { ...s, ciState: ev.ciState };
      case 'review-state-changed':
        return { ...s, reviewState: ev.reviewState };
      case 'pr-comments-changed':
        return { ...s, comments: ev.comments as OpenPrStep['comments'] };
    }
  },
};

export type { ExternalEvent };
