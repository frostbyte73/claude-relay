import type { ActionStep, JobRecord } from '../work/work-types.js';
import { writeEnvelope, type ActionEnvelope } from '../work/envelope.js';
import { currentDraftForRaiser, writeGateFor } from '../work/write-draft.js';
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

  // `declined` is terminal-but-not-a-success (the user vetoed the step's write) — treated as
  // settled here on purpose: every call site that reads isResolved already ORs in `cancelled`
  // (another non-success terminal) for the same "is this step done, whatever the outcome"
  // question, so folding `declined` in here is consistent rather than adding a second method
  // nobody but this state would use.
  isResolved(s) { return s.state === 'resolved' || s.state === 'declined'; },

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
    // resume loop (acceptDraft/reviseDraft/denyDraft drive those imperatively), not decide().
    if (s.state !== 'running') return null;
    if (s.sessionId) return null;

    // First spawn: a gated-write action's session composes the write and submits it via
    // submit_write_draft (→ gate_pending_approval) WITHOUT posting — the hook hard-blocks the
    // external write until the user approves. A read-only or worktree-edit action just runs.
    const envelope = actionHandler.buildEnvelope(s, job, ctx);
    const path = writeEnvelope(ctx.jobsDir, job.id, s.id, envelope);
    return { kind: 'spawn-session', jobId: job.id, stepId: s.id, envelopePath: path };
  },

  buildEnvelope(s, job, ctx): ActionEnvelope {
    // An ActionStep's own draft is always raised as `{kind:'step'}` — submitDraft coerces the
    // kind to `controller` only for an orchestrated step.
    const writeGate = writeGateFor(currentDraftForRaiser(s, { kind: 'step' }));
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
      ...(s.attempts?.length ? { previousAttempts: s.attempts } : {}),
      workspace: s.workspace,
      typePayload: { ...(writeGate ? { writeGate } : {}) },
    };
  },
};
