import { buildActionCatalog, writeEnvelope, type OrchestratedEnvelope } from '../work/envelope.js';
import { MAX_ROUNDS } from './orchestrated-policy.js';
import { shouldDeliver } from './orchestrated-inbox.js';
import { currentDraftForRaiser, writeGateFor } from '../work/write-draft.js';
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

  buildEnvelope(s, job, ctx): OrchestratedEnvelope {
    // Turn 1 comes through here, not through resumeControllerRound — so the two fields the
    // SKILL leans on hardest have to be set here too: which hat the controller is wearing
    // (its own, on a cold spawn) and what it may dispatch.
    const actionCatalog = buildActionCatalog(ctx.actionRegistry, { kind: 'controller', controller: s.controller });
    // The controller's own draft (never one raised by a dispatch child — those carry their own
    // writeGate on their own dispatch envelope). Needed here, not just in resumeControllerRound,
    // because reconcileInterruptedSteps clears `sessionId` on a `running` step after a daemon
    // restart — including one that crashed mid-commit of an already-approved draft — which
    // routes the next decide() through THIS cold-spawn path rather than a resume. That same
    // reconcile also resets `boundAction` to undefined, so `s.boundAction ?? s.controller` here
    // always agrees with the freshly-cold-spawned `boundAction` field below — never a sub-action
    // stale from before the crash. Scoped the same way resumeControllerRound scopes its own
    // writeGate: an approved-but-partially-consumed draft from an earlier round bound to a
    // DIFFERENT action must not surface once the controller is (or, here, cold-spawns as) a
    // different one — see currentDraftForRaiser.
    const boundAction = s.boundAction ?? s.controller;
    const writeGate = writeGateFor(currentDraftForRaiser(s, { kind: 'controller' }, boundAction));
    return {
      boundAction,
      ...(actionCatalog ? { actionCatalog } : {}),
      ...(writeGate ? { writeGate } : {}),
      // A batch can be drained with no live session to hand it to — reconcileInterruptedSteps
      // clears a dead controller's session, and a dispatch settling right after drains into
      // `lastDelivered` with no resume to carry it. The cold spawn comes through here, so it
      // has to show what woke it or that batch is lost.
      ...(s.lastDelivered?.length ? { delivered: s.lastDelivered } : {}),
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
      ...(s.attempts?.length ? { previousAttempts: s.attempts } : {}),
      workspace: s.workspace,
    };
  },
};
