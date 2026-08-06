import { writeEnvelope, type OrchestratedEnvelope } from '../work/envelope.js';
import { MAX_ROUNDS } from './orchestrated-policy.js';
import { shouldDeliver } from './orchestrated-inbox.js';
import type { JobRecord, OrchestratedStep } from '../work/work-types.js';
import type { StepHandler } from './types.js';

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

export const orchestratedHandler: StepHandler<OrchestratedStep> = {
  type: 'orchestrated',
  initialState: 'running',

  isResolved(s) { return s.state === 'resolved'; },

  decide(s, job, ctx) {
    if (s.cancelled || s.failure) return null;
    if (s.state === 'resolved' || s.state === 'failed') return null;
    if (!s.sessionId) {
      const envelope = orchestratedHandler.buildEnvelope(s, job, ctx);
      const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
      return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
    }
    // A live controller is woken only through the inbox. sessionWorking is false here
    // because the engine checks liveness itself before acting on deliver-inbox; this
    // decide() only reports that something is owed.
    const timerDue = s.waitingOn?.resumeAt !== undefined && ctx.now() >= s.waitingOn.resumeAt;
    if (timerDue || shouldDeliver(s, false, ctx.now())) {
      return { kind: 'deliver-inbox', jobId: job.id, stepId: s.id };
    }
    return null;
  },

  buildEnvelope(s, job): OrchestratedEnvelope {
    return {
      kind: 'step',
      jobId: job.id,
      stepId: s.id,
      type: 'orchestrated',
      title: s.title,
      description: s.description,
      controller: s.controller,
      goal: s.goal,
      inputs: s.inputs,
      phase: s.phase,
      memo: s.memo,
      artifacts: s.artifacts,
      roundsRemaining: Math.max(0, MAX_ROUNDS - s.roundsSpent),
      dispatches: s.dispatches.map((d) => ({
        id: d.id, action: d.action, brief: d.brief, status: d.status,
        ...(d.output !== undefined ? { output: d.output } : {}),
        ...(d.failure !== undefined ? { failure: d.failure } : {}),
      })),
      pr: s.pr,
      ...(s.gateApproved !== undefined ? { gateApproved: s.gateApproved } : {}),
      ...(s.gateFeedback !== undefined ? { gateFeedback: s.gateFeedback } : {}),
      job: {
        source: job.source,
        title: job.title,
        description: job.description,
        externalRef: job.externalRef,
      },
      previousSteps: previousFindings(job, s.id),
      workspace: s.workspace,
    };
  },
};
