import type { ActionStep, JobRecord } from '../work/work-types.js';
import { writeEnvelope } from '../work/envelope.js';
import type { StepHandler } from './types.js';

function previousOutputs(job: JobRecord, selfId: string) {
  return job.steps
    .filter((st) => st.id !== selfId && st.type === 'action' && st.forwardOutput !== false && st.output)
    .map((st) => ({
      id: st.id,
      title: st.title,
      action: (st as ActionStep).action,
      output: (st as ActionStep).output,
    }));
}

export const actionHandler: StepHandler<ActionStep> = {
  type: 'action',
  initialState: 'running',

  isResolved(s) { return s.state === 'resolved'; },

  decide(s, job, ctx) {
    if (s.cancelled || s.failure) return null;

    // Builtin-runner actions are daemon-implemented — never spawn a Claude session.
    // meta.wait is the only one today: a hold that parks the step until the user
    // resumes or its soak timer (`resumeAt`) elapses.
    const runner = ctx.actionRegistry?.getAction(s.action)?.frontmatter.outpost.runner;
    if (runner === 'builtin') {
      if (s.action !== 'meta.wait') return null;
      if (s.state === 'running') {
        const durationSec = typeof s.inputs?.duration_sec === 'number' ? s.inputs.duration_sec : undefined;
        return { kind: 'enter-wait', jobId: job.id, stepId: s.id, durationSec };
      }
      if (s.state === 'waiting' && s.resumeAt != null && ctx.now() >= s.resumeAt) {
        return { kind: 'resolve-wait', jobId: job.id, stepId: s.id, by: 'timer' };
      }
      return null;
    }

    // gate_pending_approval / an already-attached session are owned by the draft/commit
    // resume loop (approveGate / rejectGate drive those imperatively), not decide().
    if (s.state !== 'running') return null;
    if (s.sessionId) return null;

    // First spawn. For a human_gate action this is the draft phase: the session composes
    // the write and submits it for review (submit_write_draft → gate_pending_approval)
    // WITHOUT posting — the hook hard-blocks the external write until the user approves.
    const envelope = actionHandler.buildEnvelope(s, job, ctx);
    const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
    return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
  },

  buildEnvelope(s, job, ctx) {
    // human_gate actions run a draft→commit loop. `phase` tells the skill which turn it
    // is: `draft` composes the payload and calls submit_write_draft (no external write —
    // the hook blocks it); `commit` posts the approved `draft` and calls submit_step_output.
    const humanGate = !!ctx?.actionRegistry?.getAction(s.action)?.frontmatter.outpost.human_gate;
    return {
      kind: 'step',
      jobId: job.id,
      stepId: s.id,
      type: 'action',
      action: s.action,
      title: s.title,
      description: s.description,
      goal: s.goal,
      inputs: s.inputs ?? {},
      job: {
        source: job.source,
        title: job.title,
        description: job.description,
        externalRef: job.externalRef,
      },
      previousSteps: previousOutputs(job, s.id),
      workspace: s.workspace,
      typePayload: humanGate
        ? {
            humanGate: true,
            phase: s.gateApproved ? 'commit' : 'draft',
            draft: s.draft,
            feedback: s.gateFeedback ?? [],
          }
        : {},
    };
  },
};
