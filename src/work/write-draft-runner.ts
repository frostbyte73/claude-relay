import type { JobRecord, Step } from './work-types.js';
import {
  extractFileReferences, hashFileContents, sameRaiser, writeFileContents,
  type DraftRaisedBy, type PinnedCall, type WriteDraft,
} from './write-draft.js';

export interface DraftHost {
  now(): number;
  newId(): string;
  getJob(jobId: string): JobRecord | undefined;
  getStep(jobId: string, stepId: string): Step | undefined;
  mutateStep(jobId: string, stepId: string, fn: (s: Step) => Step): void;
  appendStepEvent(jobId: string, stepId: string, who: 'user' | 'session', body: string): void;
  // Resumes whichever session actually owns this draft's next turn — an ActionStep's own
  // session, an orchestrated step's controller, or the specific dispatch that raised it.
  // Routing by raiser matters: dispatchActionResume is a no-op for anything but an ActionStep.
  // `action` is the draft's own `action` field — for a controller raiser this is what the
  // resumed round has to rebind to (whichever sub-action actually drafted the write), not the
  // controller's own action; resumeControllerRound defaults to the controller when no action is
  // given, which is correct for a plain wake-up but wrong here.
  resumeRaiser(jobId: string, stepId: string, raisedBy: DraftRaisedBy, action: string): void;
  settleDispatch(jobId: string, stepId: string, dispatchId: string, reason: string): void;
  // Wakes a parked controller with the deny outcome, out of band from the normal
  // shouldDeliver pull cycle (mirrors resolveGate's decline path) — a plain inbox push is
  // silently dropped while the step is still `gate_pending_approval` (gate-resolved isn't a
  // user-message, the only kind shouldDeliver accepts in that state).
  notifyControllerDenied(jobId: string, stepId: string, feedback: string): void;
  declineStep(jobId: string, stepId: string, reason: string): void;
  journal(action: string, jobId: string, stepId: string, outcome: string, lesson: string): void;
}

// accept/revise/deny's shared "resolve a PENDING draft by id, or explain precisely why not"
// step. Split into two misses rather than one: an id that matches nothing (stale card, typo,
// wrong job) is a 404 — refresh and look again; an id that matches an already-approved draft
// is a 409 — someone else's decision already landed, retrying this one won't help. Folding
// both into a single "no pending draft" miss (the previous shape) left the PWA no way to word
// those two cases differently for the user.
type DraftLookup = { found: true; draft: WriteDraft } | { found: false; result: DraftDecisionResult };

function findPendingDraft(step: Step, draftId: string, stepId: string): DraftLookup {
  const any = step.drafts?.find((d) => d.id === draftId);
  if (!any) return { found: false, result: { ok: false, reason: `no draft ${draftId} on step ${stepId}`, status: 404 } };
  if (any.approvedAt) {
    return { found: false, result: { ok: false, reason: `draft ${draftId} on step ${stepId} is already decided`, status: 409 } };
  }
  return { found: true, draft: any };
}

function replaceDraft(step: Step, draftId: string, fn: (d: WriteDraft) => WriteDraft): Step {
  return { ...step, drafts: (step.drafts ?? []).map((d) => d.id === draftId ? fn(d) : d) };
}

// A submit against a step that's already done — resolved, failed, cancelled, or (for an
// ActionStep) declined — is a stale or duplicate call; re-parking it would resurrect a
// terminal step and re-ask the user about something already settled.
function isTerminal(step: Step): boolean {
  return !!step.failure || !!step.cancelled || step.state === 'resolved'
    || (step.type === 'action' && step.state === 'declined');
}

// The MCP tool's error channel: a session calling submit_write_draft against a step that
// can't currently accept one (already terminal, wrong dispatch state, ...) needs a real
// failure back, not a silent no-op it can't distinguish from success — a call denied here
// would otherwise hang waiting for a decision the daemon never parked.
export type SubmitDraftResult = { ok: true } | { ok: false; reason: string };

// Same shape as SubmitDraftResult, same reason: the HTTP routes (accept/revise/deny) need to
// tell a refused decision apart from a no-op success too, rather than answering 200 with
// nothing changed. `status` is the one addition over SubmitDraftResult — an HTTP route needs
// to pick a status code, an MCP tool call does not — and is optional (defaults to 409 at the
// route) because most refusal reasons here ARE a state conflict, not a missing resource.
export type DraftDecisionResult = { ok: true } | { ok: false; reason: string; status?: 404 | 409 };

export function submitDraft(
  host: DraftHost, jobId: string, stepId: string,
  incoming: Omit<WriteDraft, 'id' | 'requestedAt'>,
): SubmitDraftResult {
  const step = host.getStep(jobId, stepId);
  if (!step) return { ok: false, reason: `no step ${stepId} on job ${jobId}` };
  if (isTerminal(step)) return { ok: false, reason: 'step is already terminal' };
  // A controller-run step (`type: 'orchestrated'`) has no top-level session of its own for a
  // dispatch-less draft — a `{kind:'step'}` raiser only makes sense for an ActionStep. Coerce
  // it to `controller` so resumeRaiser/declineStep route to the controller's own session
  // instead of a step role that doesn't exist for this step type.
  const raisedBy = incoming.raisedBy.kind === 'step' && step.type === 'orchestrated'
    ? { kind: 'controller' as const }
    : incoming.raisedBy;

  if (raisedBy.kind === 'dispatch') {
    if (step.type !== 'orchestrated') return { ok: false, reason: 'dispatchId given but step is not orchestrated' };
    const d = step.dispatches.find((x) => x.id === raisedBy.dispatchId);
    if (!d) return { ok: false, reason: `no dispatch ${raisedBy.dispatchId} on step ${stepId}` };
    // The wire `dispatchId` is trusted (there is no session identity at the MCP boundary), and
    // the controller's own envelope lists every sibling dispatch id — a controller that
    // (mistakenly or not) names a `queued` child here would otherwise flip it straight to
    // `awaiting_approval` before it ever spawns: the parked launch's `run()` requires
    // `status === 'queued'` and refuses, `dispatchResume` early-returns on the still-missing
    // `sessionId`, and `untilAllDispatchesDone` never clears — a permanent, silent hang. Only a
    // dispatch that has actually spawned (and isn't already settled) may raise a draft.
    if (!d.sessionId || (d.status !== 'running' && d.status !== 'awaiting_approval')) {
      return { ok: false, reason: `dispatch ${raisedBy.dispatchId} is not a running child (status: ${d.status})` };
    }
  } else if (step.state !== 'running' && step.state !== 'gate_pending_approval') {
    // A dispatch's own status (checked above) gates a dispatch-raised draft; the parent
    // step's top-level state doesn't — it's routinely `waiting` while dispatches are in
    // flight, and that's not a reason to refuse the dispatch's own review request.
    return { ok: false, reason: `step is in state ${step.state}, not accepting a draft` };
  }

  const draft: WriteDraft = { ...incoming, raisedBy, id: host.newId(), requestedAt: host.now() };

  host.mutateStep(jobId, stepId, (s) => {
    // A redraft replaces the pending draft from the same raiser rather than stacking:
    // only the latest payload is the one the user is deciding on.
    const kept = (s.drafts ?? []).filter((d) => d.approvedAt || !sameRaiser(d.raisedBy, raisedBy));
    const carried = (s.drafts ?? []).find((d) => !d.approvedAt && sameRaiser(d.raisedBy, raisedBy));
    const withFeedback = carried?.feedback?.length
      ? { ...draft, feedback: carried.feedback }
      : draft;
    const next = { ...s, drafts: [...kept, withFeedback], updatedAt: host.now() };
    if (raisedBy.kind === 'dispatch') {
      if (next.type !== 'orchestrated') return next;
      return {
        ...next,
        dispatches: next.dispatches.map((d) =>
          d.id === raisedBy.dispatchId ? { ...d, status: 'awaiting_approval' as const } : d),
      };
    }
    return { ...next, state: 'gate_pending_approval' as const };
  });

  host.appendStepEvent(jobId, stepId, 'session', `${incoming.action} — draft ready for your approval`);
  return { ok: true };
}

// The terminal-step check below is duplicated (identically) at the top of acceptDraft,
// reviseDraft, and denyDraft rather than folded into findPendingDraft: findPendingDraft is a
// pure lookup used only after this gate passes, and inlining the terminal check into it would
// hide the asymmetry described there behind one shared function two of three callers don't
// obviously need — each call site should read as "refuse if terminal, THEN look up the draft."
export async function acceptDraft(
  host: DraftHost, jobId: string, stepId: string, draftId: string, calls: PinnedCall[],
): Promise<DraftDecisionResult> {
  const step = host.getStep(jobId, stepId);
  if (!step) return { ok: false, reason: `no step ${stepId} on job ${jobId}`, status: 404 };
  // For an ORCHESTRATED step this is defence-in-depth: settleOrchestratedStep already drops a
  // step's pending drafts when it settles (see engine.ts), so findPendingDraft below would
  // normally already miss on its own. For an ACTION step it is the ONLY gate — nothing prunes
  // an ActionStep's drafts on failure (settleOrchestratedStep early-returns for non-orchestrated
  // steps), so a draft raised before a provisioning failure stays pending forever otherwise,
  // and this check is what stops accept/revise/deny from reviving a dead step through it.
  if (isTerminal(step)) return { ok: false, reason: 'step is already terminal', status: 409 };
  const lookup = findPendingDraft(step, draftId, stepId);
  if (!lookup.found) return lookup.result;
  const draft = lookup.draft;
  if (!calls.length) return { ok: false, reason: 'calls must be a non-empty array' };

  // Per-call verdicts: the user answers each call in the same submission they edit it in, so a
  // draft that got two things right and one wrong doesn't need a redraft round-trip to fix. A
  // skipped call is stripped of everything but its identity — it is never pinned, so it can
  // never be consumed, and nothing about it needs verifying.
  const keep = calls.filter((c) => !c.skip);
  const skippedCalls: PinnedCall[] = calls
    .filter((c) => c.skip)
    .map((c) => ({ id: c.id, label: c.label, bash: c.bash, tool: c.tool }));
  // Every call skipped is a real, final decision — "post none of these" — not a complaint about
  // the action having been run, so it settles the draft rather than pinning an empty payload.
  // Pinning nothing would be worse than useless: writeGateFor reports a draft with no
  // unconsumed pins as spent, so the resumed session would see no gate at all and draft the
  // same calls again.
  if (!keep.length) return settleUnrun(host, jobId, stepId, draft, skippedCalls);

  // Rebuild from the identity/payload fields only (allowlist, not a denylist of consumption
  // fields) — a freshly approved draft has no pin history yet, whatever the caller's `calls`
  // payload happens to carry over from an earlier round (e.g. a revise-then-reaccept echoing
  // the previous calls array back), and a future consumption field added to PinnedCall should
  // have to be deliberately added here too, not silently pass through by default (round 3,
  // MINOR 4). `fileDigests` is computed below, from THESE rebuilt calls — never accepted from
  // the wire — so a client cannot smuggle in a digest of its own choosing either. `files` is
  // deliberately NOT carried into `rebuilt`: it's read straight off `calls[i]` below, used to
  // write the approved body, then dropped — the persisted pin is the digest, never a second
  // copy of the content.
  const rebuilt = keep.map((c) => ({ id: c.id, label: c.label, bash: c.bash, tool: c.tool }));

  // A call whose payload references a file (--input/--body-file/--notes-file) is pinned by
  // command TEXT only, which says nothing about the file's CONTENT at execution time. If the
  // user's (possibly edited) submission carries inline content for that path — `calls[i].files`,
  // already validated by parseDraftCalls at the wire boundary (referenced by this bash, anchored
  // under /tmp/) — the daemon writes it here, then hashes what it JUST wrote, so the digest can
  // never drift from the approved body. Without an inline entry, behavior is unchanged: hash
  // whatever's already on disk. Either way the file must end up readable — a write failure or a
  // missing file makes an unverifiable pin, which is worse than refusing the accept outright.
  const pinned: PinnedCall[] = [];
  for (let i = 0; i < rebuilt.length; i++) {
    const c = rebuilt[i]!;
    if (!c.bash) { pinned.push(c); continue; }
    const paths = extractFileReferences(c.bash);
    if (paths === null) {
      return {
        ok: false,
        reason: `cannot confidently identify the file(s) "${c.bash}" references — refusing to `
          + 'approve a payload this daemon cannot verify at execution time',
      };
    }
    if (paths.length === 0) { pinned.push(c); continue; }
    // `keep[i]`, not `calls[i]` — `rebuilt` is built from the kept calls, so a skipped call
    // earlier in the submission would otherwise shift this lookup onto the wrong body.
    const inlineFiles = keep[i]!.files;
    const fileDigests: Record<string, string> = {};
    for (const path of paths) {
      const inline = inlineFiles?.[path];
      if (inline !== undefined && !(await writeFileContents(path, inline))) {
        return {
          ok: false,
          reason: `could not write the approved content to "${path}" — draft again`,
        };
      }
      const digest = await hashFileContents(path);
      if (!digest) {
        return {
          ok: false,
          reason: `file "${path}", referenced by an approved call, does not exist — draft `
            + 'again once it has been written',
        };
      }
      fileDigests[path] = digest;
    }
    pinned.push({ ...c, fileDigests });
  }

  const at = host.now();
  host.mutateStep(jobId, stepId, (s) => {
    const withDraft = { ...replaceDraft(s, draftId, (d) => ({
      ...d,
      calls: pinned,
      ...(skippedCalls.length ? { skippedCalls } : {}),
      approvedAt: at,
    })), updatedAt: at };
    if (draft.raisedBy.kind === 'dispatch') {
      const dispatchId = draft.raisedBy.dispatchId;
      if (withDraft.type !== 'orchestrated') return withDraft;
      return {
        ...withDraft,
        dispatches: withDraft.dispatches.map((d) =>
          d.id === dispatchId ? { ...d, status: 'running' as const } : d),
      };
    }
    return { ...withDraft, state: 'running' as const };
  });

  host.appendStepEvent(jobId, stepId, 'user', skippedCalls.length
    ? `approved ${pinned.length} of ${calls.length} calls; skipped ${describeCalls(skippedCalls)}`
    : 'approved the write payload');
  host.resumeRaiser(jobId, stepId, draft.raisedBy, draft.action);
  return { ok: true };
}

export function reviseDraft(
  host: DraftHost, jobId: string, stepId: string, draftId: string, feedback: string,
): DraftDecisionResult {
  const note = feedback?.trim();
  if (!note) return { ok: false, reason: 'feedback must be a non-empty string' };
  const step = host.getStep(jobId, stepId);
  if (!step) return { ok: false, reason: `no step ${stepId} on job ${jobId}`, status: 404 };
  // See acceptDraft's comment: for an ActionStep this is the ONLY thing stopping a "Propose
  // changes" click from reviving a step that already failed provisioning — reviseDraft flips
  // `state` back to 'running' and calls resumeRaiser, which re-provisions the workspace.
  if (isTerminal(step)) return { ok: false, reason: 'step is already terminal', status: 409 };
  const lookup = findPendingDraft(step, draftId, stepId);
  if (!lookup.found) return lookup.result;
  const draft = lookup.draft;

  host.mutateStep(jobId, stepId, (s) => {
    const withFeedback = { ...replaceDraft(s, draftId, (d) => ({
      ...d, feedback: [...(d.feedback ?? []), note],
    })), updatedAt: host.now() };
    if (draft.raisedBy.kind === 'dispatch') {
      const dispatchId = draft.raisedBy.dispatchId;
      if (withFeedback.type !== 'orchestrated') return withFeedback;
      return {
        ...withFeedback,
        dispatches: withFeedback.dispatches.map((d) =>
          d.id === dispatchId ? { ...d, status: 'running' as const } : d),
      };
    }
    return { ...withFeedback, state: 'running' as const };
  });

  host.appendStepEvent(jobId, stepId, 'user', note);
  host.resumeRaiser(jobId, stepId, draft.raisedBy, draft.action);
  return { ok: true };
}

function describeCalls(calls: PinnedCall[]): string {
  return calls.map((c, i) => c.label ?? c.tool?.name ?? `call ${i + 1}`).join(', ');
}

// Settle a draft nothing will run from: drop it, tell whoever raised it, and journal one
// lesson. Deny and skip-everything share every bit of the plumbing and differ only in the
// record they leave — who the lesson is about, and what it says — so the routing lives here
// once rather than in two copies that can drift on which raiser wakes how.
function settleDraftUnrun(
  host: DraftHost, jobId: string, stepId: string, draft: WriteDraft,
  record: { event: string; note: string; journalAction: string; outcome: string; lesson: string },
): DraftDecisionResult {
  host.mutateStep(jobId, stepId, (s) => ({
    ...s, drafts: (s.drafts ?? []).filter((d) => d.id !== draft.id), updatedAt: host.now(),
  }));
  host.appendStepEvent(jobId, stepId, 'user', record.event);

  if (draft.raisedBy.kind === 'dispatch') {
    // settleDispatch's own dispatch-done push is what wakes the controller — a live dispatch
    // never parks the PARENT step in gate_pending_approval, so the normal delivery path isn't
    // blocked here the way it is for a controller-raised draft. A second, redundant push would
    // just be a no-op inbox item nobody reads.
    host.settleDispatch(jobId, stepId, draft.raisedBy.dispatchId, record.note);
    host.journal(record.journalAction, jobId, stepId, record.outcome, record.lesson);
    return { ok: true };
  }
  if (draft.raisedBy.kind === 'controller') {
    host.notifyControllerDenied(jobId, stepId, record.note);
    host.journal(record.journalAction, jobId, stepId, record.outcome, record.lesson);
    return { ok: true };
  }
  host.declineStep(jobId, stepId, record.note);
  host.journal(record.journalAction, jobId, stepId, record.outcome, record.lesson);
  return { ok: true };
}

// Every call in the submission carried the user's skip verdict. Unlike a deny, this is not a
// complaint about the action having been run at all — running it was right, the user simply
// wants none of what it proposed — so the lesson goes to the action that DRAFTED the calls,
// under its own outcome, rather than to whoever chose to run it.
function settleUnrun(
  host: DraftHost, jobId: string, stepId: string, draft: WriteDraft,
  skipped: PinnedCall[],
): DraftDecisionResult {
  const which = describeCalls(skipped);
  return settleDraftUnrun(host, jobId, stepId, draft, {
    event: `skipped every drafted call from ${draft.action}: ${which}`,
    note: `The user reviewed the drafted calls and chose to run none of them (${which}). `
      + 'Treat them as deliberately skipped, record them as such, and do not draft them again.',
    journalAction: draft.action,
    outcome: 'skipped',
    lesson: `the user skipped every call ${draft.action} drafted here (${which}) — it proposed `
      + 'writes they did not want made, though running the action itself was right',
  });
}

// The reason is feedback on the DECISION to run this action now, not on the action's
// execution — so it routes to whoever chose it and journals against that chooser.
export function denyDraft(
  host: DraftHost, jobId: string, stepId: string, draftId: string, reason: string,
): DraftDecisionResult {
  const note = reason?.trim();
  if (!note) return { ok: false, reason: 'reason must be a non-empty string' };
  const step = host.getStep(jobId, stepId);
  if (!step) return { ok: false, reason: `no step ${stepId} on job ${jobId}`, status: 404 };
  // See acceptDraft's comment: for an ActionStep this is the ONLY thing stopping a stale Deny
  // click from declining (and journaling against the orchestrator) a step that already failed
  // for an unrelated reason — declineStep would set `state:'declined'` on top of `.failure`.
  if (isTerminal(step)) return { ok: false, reason: 'step is already terminal', status: 409 };
  const lookup = findPendingDraft(step, draftId, stepId);
  if (!lookup.found) return lookup.result;
  const draft = lookup.draft;

  // Whoever CHOSE to run this action: the controller for a draft raised under it, the job's
  // own orchestrator for a plain ActionStep.
  const chooser = draft.raisedBy.kind === 'step'
    ? host.getJob(jobId)?.orchestratorAction ?? 'meta.orchestrate'
    : step.type === 'orchestrated' ? step.controller : draft.action;

  return settleDraftUnrun(host, jobId, stepId, draft, {
    event: `denied ${draft.action}: ${note}`,
    note: draft.raisedBy.kind === 'dispatch' ? `denied: ${note}` : note,
    journalAction: chooser,
    outcome: 'denied',
    lesson: `${draft.action} was run here and the user denied its write: ${note}`,
  });
}
