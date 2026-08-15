import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { trackedGroups, focusAction, launchBadge, jobLaunchBadge, stepLaunchBadge, isHighPriority, orchestratedRows } from '../../src/pwa/vm/tracked.js';

const live = (orchestrator: boolean, stepIds: string[] = []) => ({ orchestrator, stepIds });

describe('trackedGroups', () => {
  it('backlog = planning job never launched (no orchestrator session, no steps)', () => {
    const jobs = [{ id: 'j1', state: 'planning', steps: [] }];
    expect(trackedGroups(jobs).backlog.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('running = live orchestrator session', () => {
    const jobs = [{ id: 'j1', state: 'planning', orchestratorSessionId: 'o', steps: [], live: live(true) }];
    expect(trackedGroups(jobs).running.map((j: any) => j.id)).toEqual(['j1']);
    expect(trackedGroups(jobs).backlog).toEqual([]);
  });

  it('running = a step with a live session', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' }], live: live(false, ['s1']) }];
    expect(trackedGroups(jobs).running.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('implement phase with a DEAD session -> needs you (diff awaiting push)', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.needsYou.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.running).toEqual([]);
  });

  it('a gated controller move -> needs you', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'gate_pending_approval' }], live: live(false, []) }];
    expect(trackedGroups(jobs).needsYou.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('merge-ready (approved + green) -> waiting, not needs-you', () => {
    // Merging is the controller's own move; the user's turn only arrives if the
    // controller itself asks (a `gate` move, state -> gate_pending_approval), not before.
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
        pr: { reviewState: 'approved', ciState: 'success' } }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.waiting.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });

  it('a controller chewing on PR comments with no live session -> waiting (Outpost will triage)', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'running', phase: 'pr_comments' }], live: live(false, []) }];
    const g = trackedGroups(jobs);
    expect(g.waiting.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });

  it('PR open, CI pending, not approved -> waiting', () => {
    const jobs = [{ id: 'j1', state: 'executing',
      steps: [{ id: 's1', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
        pr: { ciState: 'pending', reviewState: 'review_required' } }], live: live(false, []) }];
    expect(trackedGroups(jobs).waiting.map((j: any) => j.id)).toEqual(['j1']);
  });

  it('failed -> needs you; done/abandoned -> done', () => {
    const jobs = [
      { id: 'j1', state: 'failed', steps: [{ id: 's1', failure: { reason: 'boom' } }], live: live(false, []) },
      { id: 'j2', state: 'done', steps: [] },
      { id: 'j3', state: 'abandoned', steps: [] },
    ];
    const g = trackedGroups(jobs);
    expect(g.needsYou.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.done.map((j: any) => j.id).sort()).toEqual(['j2', 'j3']);
  });

  it('running is evaluated before needs-you when both apply', () => {
    // s1 parked on a gate (needs you), s2 still implementing live -> job shows as running.
    const jobs = [{ id: 'j1', state: 'executing', steps: [
      { id: 's1', type: 'orchestrated', state: 'gate_pending_approval', phase: 'pr_open' },
      { id: 's2', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' },
    ], live: live(false, ['s2']) }];
    const g = trackedGroups(jobs);
    expect(g.running.map((j: any) => j.id)).toEqual(['j1']);
    expect(g.needsYou).toEqual([]);
  });
});

describe('focusAction', () => {
  it('plan_pending_review -> review plan', () => {
    const a = focusAction({ id: 'j1', state: 'plan_pending_review', steps: [{ id: 's1' }, { id: 's2' }] });
    expect(a.cta.action).toBe('review-plan');
  });

  it('a gated controller move -> review gate, described by its question', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Handle PR feedback', type: 'orchestrated', state: 'gate_pending_approval',
        gate: { question: 'Merge this PR?' } }], live: live(false, []) });
    expect(a.cta.action).toBe('review-gate');
    expect(a.description).toBe('Merge this PR?');
  });

  // Critical 2: `step.state === 'gate_pending_approval'` alone misses a dispatch-raised
  // draft (only the dispatch's own status flips — see hasUnapprovedDraft's doc comment in
  // work-predicates.js), which used to fall through to the meta.wait branch below and offer
  // "Resume" — a CTA that calls `work.approve(job.id, {gate:'wait', stepId})`, which
  // `resolveWaitStep` flatly refuses for anything but an ActionStep: 200, nothing changed.
  it('an ActionStep draft (raisedBy: step) -> review-gate, not resume', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Post the comment', type: 'action', state: 'gate_pending_approval',
        drafts: [{ id: 'd1', raisedBy: { kind: 'step' } }] }], live: live(false, []) });
    expect(a.cta.action).toBe('review-gate');
  });

  it('a controller-raised draft -> review-gate, not resume', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Land the PR', type: 'orchestrated', state: 'gate_pending_approval',
        drafts: [{ id: 'd1', raisedBy: { kind: 'controller' } }] }], live: live(false, []) });
    expect(a.cta.action).toBe('review-gate');
  });

  it('a dispatch-raised draft -> review-gate, not resume, even though the parent step is still waiting', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Fix CI', type: 'orchestrated', state: 'waiting',
        drafts: [{ id: 'd1', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' } }] }], live: live(false, []) });
    expect(a.cta.action).toBe('review-gate');
    expect(a.title).toBe('Approval required');
  });

  it('merge-ready -> no action; the job is waiting on the controller to gate the merge', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Ship it', type: 'orchestrated', state: 'waiting', phase: 'pr_open',
        pr: { reviewState: 'approved', ciState: 'success' } }], live: live(false, []) });
    expect(a.cta.action).toBe('none');
    expect(a.title).toBe('Waiting');
  });

  it('an indefinite meta.wait hold -> resume', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Soak', type: 'action', state: 'waiting', inputs: { reason: 'Let the canary bake' } }],
      live: live(false, []) });
    expect(a.cta.action).toBe('resume-wait');
    expect(a.description).toBe('Let the canary bake');
  });

  it('implement phase with a dead session -> review diff & push', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Add feature', type: 'orchestrated', state: 'running', phase: 'implement', sessionId: 'a' }], live: live(false, []) });
    expect(a.cta.action).toBe('review-diff');
    expect(a.description).toContain('Add feature');
  });

  it('a live running step -> watch', () => {
    const a = focusAction({ id: 'j1', state: 'executing',
      steps: [{ id: 's1', title: 'Working', sessionId: 'sess1', state: 'running' }], live: live(false, ['s1']) });
    expect(a.cta.action).toBe('watch');
  });

  it('failed job -> retry', () => {
    const a = focusAction({ id: 'j1', state: 'failed',
      steps: [{ id: 's1', title: 'Broken', failure: { reason: 'boom', at: 1 } }], live: live(false, []) });
    expect(a.cta.action).toBe('retry');
    expect(a.description).toBe('boom');
  });

  it('done job -> no action', () => {
    const a = focusAction({ id: 'j1', state: 'done', steps: [] });
    expect(a.cta.action).toBe('none');
  });
});

describe('orchestratedRows', () => {
  const step = (o = {}) => ({
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Ship it',
    state: 'running', dispatches: [], inbox: [], ...o,
  });

  it('falls back to the phase label, known or controller-coined, when nothing else applies', () => {
    expect(orchestratedRows(step({ phase: 'implement', state: 'pending' })).statusLine).toBe('Implement');
    expect(orchestratedRows(step({ phase: 'merged', state: 'resolved' })).statusLine).toBe('Merged');
    expect(orchestratedRows(step({ phase: 'awaiting_qa', state: 'pending' })).statusLine).toBe('Awaiting qa');
  });

  // A `running` step with no dispatch in flight is between rounds: the inbox has been drained
  // onto it and resumeControllerRound is still provisioning / queued behind the governor. The
  // phase label used to win here, so a step woken by review comments from the git view rendered
  // "⏸ Implement" — identical to a step parked for an hour, for the whole resume window.
  it('a running step reports the resume, not its phase, and names what woke it', () => {
    expect(orchestratedRows(step({ phase: 'implement', state: 'running' })).statusLine).toBe('Resuming');
    expect(orchestratedRows(step({ phase: 'implement', state: 'running' })).statusKind).toBe('starting');
    expect(orchestratedRows(step({
      phase: 'implement', state: 'running',
      lastDelivered: [{ id: 'i1', at: 1, kind: 'user-message', body: 'no' }],
    })).statusLine).toBe('Picking up your message');
  });

  it('surfaces the wait reason only while waiting', () => {
    const waiting = { waitingOn: { reason: 'Watching CI' } };
    expect(orchestratedRows(step({ state: 'waiting', ...waiting })).statusLine).toBe('Watching CI');
    expect(orchestratedRows(step({ state: 'waiting', ...waiting })).statusKind).toBe('parked');
    // A stale waitingOn on a running step is not a status — it has already been drained.
    expect(orchestratedRows(step({ state: 'running', ...waiting })).statusLine).toBe('Resuming');
  });

  it('falls back to the running dispatch brief for the status line', () => {
    const dispatches = [
      { id: 'd1', action: 'code.spec', brief: 'done that', status: 'done' },
      { id: 'd2', action: 'code.implement', brief: 'rewriting the reply path', status: 'running' },
    ];
    expect(orchestratedRows(step({ state: 'running', dispatches })).statusLine)
      .toBe('rewriting the reply path');
    // A wait outranks it: what the step is parked ON is the truer answer to "what now".
    expect(orchestratedRows(step({ state: 'waiting', waitingOn: { reason: 'CI' }, dispatches })).statusLine)
      .toBe('CI');
    // ...and both outrank the phase, which is why "PR open" no longer restates the PR block.
    expect(orchestratedRows(step({ state: 'running', phase: 'pr_open', dispatches })).statusLine)
      .toBe('rewriting the reply path');
    // A controller parked on a child it fanned out really has stopped, so this stays 'parked'
    // — it is the dispatch that is moving, and that child now carries its own feed.
    expect(orchestratedRows(step({ state: 'running', dispatches })).statusKind).toBe('parked');
  });

  it('marks the newest artifact only while the step is still moving', () => {
    const artifacts = { spec: '# S', implPlan: '# P' };
    expect(orchestratedRows(step({ memo: 'm', artifacts })).artifactRows.map((a: any) => a.latest))
      .toEqual([false, false, true]);
    for (const settled of [{ state: 'resolved' }, { state: 'failed' }, { cancelled: true }]) {
      expect(orchestratedRows(step({ memo: 'm', artifacts, ...settled })).artifactRows.map((a: any) => a.latest))
        .toEqual([false, false, false]);
    }
  });

  it('tones dispatch rows by status and carries the child session', () => {
    const rows = orchestratedRows(step({ dispatches: [
      { id: 'd1', action: 'code.implement', brief: 'do it', status: 'running', sessionId: 'sess1' },
      { id: 'd2', action: 'code.fix-ci', brief: 'fix', status: 'failed', failure: 'boom' },
    ] })).dispatchRows;
    expect(rows.map((r: any) => [r.status, r.tone, r.sessionId]))
      .toEqual([['running', 'investigate', 'sess1'], ['failed', 'danger', null]]);
    expect(rows[1].failure).toBe('boom');
  });

  it('puts the memo ahead of the artifacts and labels the known keys', () => {
    const rows = orchestratedRows(step({ memo: 'where I am', artifacts: { spec: '# S', implPlan: '# P', notes: 'n' } }));
    expect(rows.artifactRows.map((a: any) => [a.key, a.label]))
      .toEqual([['memo', 'Memo'], ['spec', 'Spec'], ['implPlan', 'Plan'], ['notes', 'Notes']]);
  });

  it('drops empty artifacts rather than rendering a blank disclosure', () => {
    expect(orchestratedRows(step({ artifacts: { spec: '   ' } })).artifactRows).toEqual([]);
  });

  it('slugs an artifact key into a safe CSS class token, keeping key for the label lookup', () => {
    const rows = orchestratedRows(step({
      artifacts: { 'weird key! with/slashes': 'body', '': 'body2', '!!!': 'body3' },
    })).artifactRows;
    expect(rows.map((a: any) => [a.key, a.slug])).toEqual([
      ['weird key! with/slashes', 'weird-key-with-slashes'],
      ['', 'artifact'],
      // Both empty-ish keys fall back to 'artifact'; the second is disambiguated rather
      // than sharing the first's disclosure state.
      ['!!!', 'artifact-2'],
    ]);
    // Every slug is a lone token match for the CSS class regex — no injected space, no
    // leftover punctuation that would break out of `orc-artifact-<slug>`.
    for (const a of rows) expect((a as any).slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('breaks a slug collision so two artifacts cannot share one disclosure', () => {
    // tracked/detail.js keys each <details>'s open/closed state off its className, so two
    // keys normalising to the same slug would toggle each other across repaints.
    const rows = orchestratedRows(step({
      artifacts: { notes: 'a', 'Notes!': 'b', 'NOTES': 'c' },
    })).artifactRows;
    const slugs = rows.map((a: any) => a.slug);
    expect(slugs).toEqual(['notes', 'notes-2', 'notes-3']);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('exposes the voluntary gate whenever s.gate is set, independent of state', () => {
    // s.gate and state:'gate_pending_approval' are set/cleared together by the real engine
    // (openGate/resolveGate), but a controller-raised write draft ALSO uses that same state
    // without ever touching s.gate — so gating this purely on state (the old behavior) would
    // render a hollow gate card for a draft instead of the draft's own content. See
    // controllerDraft below for the write-draft case.
    const gated = step({
      state: 'gate_pending_approval',
      gate: { draft: 'gh pr merge', question: 'Merge?' },
      gateFeedback: ['not yet'],
    });
    expect(orchestratedRows(gated).gate).toEqual({ draft: 'gh pr merge', question: 'Merge?', feedback: ['not yet'] });
    expect(orchestratedRows(step()).gate).toBeNull();
  });

  it('exposes the controller\'s own pending write draft separately from the voluntary gate', () => {
    const draft = { id: 'd1', raisedBy: { kind: 'controller' }, action: 'code.fix-ci', summary: 'push a fix', calls: [] };
    const s = step({ state: 'gate_pending_approval', drafts: [draft] });
    const rows = orchestratedRows(s);
    expect(rows.gate).toBeNull();
    expect(rows.controllerDraft).toEqual(draft);
  });

  it('does not surface an approved draft as pending, and ignores a draft raised by a different party', () => {
    const approved = { id: 'd1', raisedBy: { kind: 'controller' }, action: 'code.fix-ci', summary: 'x', calls: [], approvedAt: 5 };
    const dispatchDraft = { id: 'd2', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' }, action: 'code.implement', summary: 'y', calls: [] };
    expect(orchestratedRows(step({ drafts: [approved, dispatchDraft] })).controllerDraft).toBeNull();
  });

  it('folds a dispatch-raised draft into that dispatch\'s own row, not the controller\'s', () => {
    const draft = { id: 'd1', raisedBy: { kind: 'dispatch', dispatchId: 'dp1' }, action: 'code.implement', summary: 'push a fix', calls: [] };
    const rows = orchestratedRows(step({
      dispatches: [
        { id: 'dp1', action: 'code.implement', brief: 'do it', status: 'awaiting_approval' },
        { id: 'dp2', action: 'code.fix-ci', brief: 'fix', status: 'running' },
      ],
      drafts: [draft],
    }));
    expect(rows.dispatchRows[0].draft).toEqual(draft);
    expect(rows.dispatchRows[1].draft).toBeNull();
    expect(rows.controllerDraft).toBeNull();
    // awaiting_approval is "your move" the same as a gate — it must not render untoned.
    expect(rows.dispatchRows[0].tone).toBe('warn');
  });

  it('offers mark-resolved while the step is live, and as the escape from a failed one', () => {
    expect(orchestratedRows(step()).canMarkResolved).toBe(true);
    expect(orchestratedRows(step({ state: 'resolved' })).canMarkResolved).toBe(false);
    // A failed step's sessionId is permanent (engine.ts never clears it outside Retry), which
    // blocks Edit and Cancel server-side too — mark-resolved is the only working way to
    // unblock the plan and add a corrected step. See markStepResolved's explicit
    // `failure: undefined` in engine.ts.
    expect(orchestratedRows(step({ state: 'failed' })).canMarkResolved).toBe(true);
    expect(orchestratedRows(step({ cancelled: true })).canMarkResolved).toBe(false);
    expect(orchestratedRows(step({ cancelled: true, state: 'failed' })).canMarkResolved).toBe(false);
  });

  it('labels mark-resolved by why it applies: failed step, watching vigil, or the generic rescue', () => {
    expect(orchestratedRows(step()).markResolved).toEqual({ label: 'Mark resolved', hint: '' });
    expect(orchestratedRows(step({ state: 'failed' })).markResolved.label).toBe('Mark resolved — skip this step');
    expect(orchestratedRows(step({ phase: 'watching' })).markResolved.label).toBe('Mark resolved — end review');
    // A failed step's own reason wins even if it also carries a stale phase.
    expect(orchestratedRows(step({ state: 'failed', phase: 'watching' })).markResolved.label)
      .toBe('Mark resolved — skip this step');
  });
});

describe('launchBadge', () => {
  it('running -> Running badge', () => {
    expect(launchBadge({ state: 'running' })).toEqual({ label: 'Running', kind: 'running' });
  });

  it('queued -> Queued badge with reason', () => {
    expect(launchBadge({ state: 'queued', reason: 'no token headroom' }))
      .toEqual({ label: 'Queued — no token headroom', kind: 'queued' });
  });

  it('idle -> no badge', () => {
    expect(launchBadge({ state: 'idle' })).toBeNull();
  });

  it('absent -> no badge', () => {
    expect(launchBadge(undefined)).toBeNull();
  });
});

describe('jobLaunchBadge / stepLaunchBadge', () => {
  const job = {
    id: 'j1',
    highPriority: true,
    launchStatus: {
      job: { state: 'queued', reason: '1/1 slots busy' },
      steps: { s1: { state: 'running' }, s2: { state: 'idle' } },
    },
  };

  it('reads the job-level status', () => {
    expect(jobLaunchBadge(job)).toEqual({ label: 'Queued — 1/1 slots busy', kind: 'queued' });
  });

  it('reads a running step', () => {
    expect(stepLaunchBadge(job, 's1')).toEqual({ label: 'Running', kind: 'running' });
  });

  it('idle step -> no badge', () => {
    expect(stepLaunchBadge(job, 's2')).toBeNull();
  });

  it('unknown step -> no badge', () => {
    expect(stepLaunchBadge(job, 's-missing')).toBeNull();
  });

  it('missing launchStatus -> no badge', () => {
    expect(jobLaunchBadge({ id: 'j2' })).toBeNull();
  });

  it('isHighPriority passthrough', () => {
    expect(isHighPriority(job)).toBe(true);
    expect(isHighPriority({ id: 'j2' })).toBe(false);
  });
});
