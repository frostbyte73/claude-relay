import { randomUUID } from 'node:crypto';
import type { JobQueue } from './work-queue.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorktreeManager, WorktreeRecord } from '../git/worktree-manager.js';
import type { LinearWriter } from '../integrations/linear-writer.js';
import type {
  ActionStep,
  Dispatch,
  Finding,
  IterationRecord,
  JobEvent,
  JobEventKind,
  JobRecord,
  OrchestratedStep,
  PlanIteration,
  PrFacts,
  ProposedStep,
  Step,
  StepEvent,
  StepEventKind,
  WorkspaceRef,
} from './work-types.js';
import { augmentEnvelopeWithLessons, buildActionCatalog, writeEnvelope, STEP_TYPE_CATALOG, type OrchestratorEnvelope, type ActionCatalogEntry } from './envelope.js';
import { readonlyView, workspaceError } from './workspace.js';
import { expectRepoOf, parsePrUrl } from './pr-url.js';
import type { ActionRegistry } from '../actions/index.js';
import { handlerFor, initialStateForType } from '../steps/index.js';
import { orchestratedHandler } from '../steps/orchestrated.js';
import type { Action, HandlerCtx } from '../steps/types.js';
import {
  applyMove, deliverInbox, pushInbox, resolveGate,
  type NewItem, type OrchestratedHost, type ProgressPayload,
} from './orchestrated-runner.js';
import { reconcile, validateDispositions } from './reconcile.js';
import { decideJobTransitions, owesStepReview } from '../jobs/lifecycle.js';
import { appendJobEvent } from '../storage/job-event-log.js';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ApprovalModeStore } from '../permissions/approval-mode.js';
import type { JournalStore } from '../storage/journal-store.js';
import type { LaunchGovernor, LaunchState, LaunchPriority } from './launch-governor.js';

const MAX_EVENTS_PER_JOB = 50;
const MAX_STEP_EVENTS = 40;

// How long a step session must stay completely silent after ending its turn before the
// "never submitted" failure lands. Sized for the quiet stretch between a parent yielding
// to background subagents and the next tool call on the session — generous, because the
// only cost of waiting is a later failure report, while firing early kills a live round.
const UNRESOLVED_GRACE_MS = 5 * 60_000;

// createExternalJob threads dedupeKey through as the job id, which becomes a filesystem
// path component (see createExternalJob) — same path-traversal / argv-flag-smuggling
// concern as worktree-manager.ts's SESSION_ID_RE/BRANCH_NAME_RE.
const DEDUPE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Fields the plan editor may PATCH onto an existing step. `action` only applies to action
// steps — editStepManually picks the applicable subset by the step's own `type`.
export interface StepEditPatch {
  title?: string;
  description?: string;
  goal?: string;
  inputs?: Record<string, unknown>;
  action?: string;
  workspace?: WorkspaceRef;
}

// Rounds that continue an already-open PR (CI red, merge conflict, review comment/edit).
// These launch immediately — they resume an in-flight unit of work rather than starting a
// new one, so the token-headroom + concurrency gate that throttles fresh launches doesn't
// apply. A controller's self-round rebound to one of these (the common shape of the reactive
// workflow) is included by design: submitLaunch reads the BOUND action, so the round that
// actually fixes the red CI jumps the queue. An unbound self-round routes as `queued` and
// self-unblocks when the prior turn's Stop frees the slot — see releaseLaunchSlot.
const REACTIVE_ACTIONS = new Set([
  'code.fix-ci', 'code.resolve-conflicts', 'code.fix-pr-comment', 'code.triage-pr-comments',
]);
export function isReactiveAction(action: string): boolean {
  return REACTIVE_ACTIONS.has(action);
}

export function actionNameForStep(s: Step): string {
  return s.type === 'orchestrated' ? s.controller : s.action;
}

// A step accepts plan-editor patches before it starts, and again once it has FAILED. `sessionId`
// alone can't be the gate: it is set on the first spawn and never cleared outside onStepRetry, so
// a controller that validates its inputs and fails on turn 1 (code.orchestrate-review on a bad
// prUrl) would be frozen with its bad inputs forever — Retry being the only enabled control, and
// Retry re-spawns exactly what failed. A failure is terminal for dispatch (decide() returns null
// for it, settleOrchestratedStep already closed its session), so nothing is racing the patch. A
// live session with NO failure is mid-turn: it has already read the envelope a patch would
// rewrite, so it stays locked.
function stepAcceptsEdits(s: Step): boolean {
  return !s.sessionId || !!s.failure;
}

function sameWorkspace(a: WorkspaceRef | undefined, b: WorkspaceRef | undefined): boolean {
  const flat = (w: WorkspaceRef | undefined) => {
    const r = w as { kind?: unknown; repoCwd?: unknown; ref?: unknown; branch?: unknown } | undefined;
    return JSON.stringify([r?.kind ?? null, r?.repoCwd ?? null, r?.ref ?? null, r?.branch ?? null]);
  };
  return flat(a) === flat(b);
}

// The PR a workspace is checked out at, when it names one. `refs/pull/<N>/head` is the only
// spelling a planner may author — WorktreeManager rewrites it to its own `refs/outpost/pr-<N>`.
const WORKSPACE_PR_REF_RE = /^refs\/pull\/(\d+)\/head$/;
function workspacePrNumber(ws: WorkspaceRef | undefined): string | undefined {
  const ref = ws?.kind === 'readonly' ? ws.ref : undefined;
  return ref ? WORKSPACE_PR_REF_RE.exec(ref)?.[1] : undefined;
}

export function activeGroup(j: JobRecord): Step[] {
  const steps = j.steps;
  let i = 0;
  while (i < steps.length) {
    const groupKey = steps[i]!.parallelGroup ?? `__solo_${i}`;
    let k = i;
    while (k < steps.length && (steps[k]!.parallelGroup ?? `__solo_${k}`) === groupKey) k++;
    const members = steps.slice(i, k);
    // A failed step is NOT "done" — it blocks its group so the scan never advances
    // to a later group. (The handler's own decide() returns null for a failed step,
    // so returning it here doesn't re-dispatch it; it just stalls forward progress
    // until the user retries or edits the plan.)
    const allDone = members.every((s) => s.cancelled || handlerFor(s).isResolved(s));
    if (!allDone) return members.filter((s) => !s.cancelled);
    i = k;
  }
  return [];
}

// Returns every action ready to dispatch right now — one per unblocked member of
// the active group. Parallel-group members all launch in the same tick; a solo
// group yields at most one. (Members already dispatched return null from their
// handler's decide(), so re-running is idempotent.)
export function decide(j: JobRecord, ctx: HandlerCtx): Action[] {
  if (j.state === 'planning' || j.state === 'plan_pending_review') return [];
  if (j.state === 'done' || j.state === 'abandoned' || j.state === 'failed') return [];
  // A step-review in flight holds the plan: the orchestrator may still amend it, so
  // don't advance to the next group behind its back. The job stays `executing`.
  if (j.reviewingStepId) return [];
  const actions: Action[] = [];
  for (const s of activeGroup(j)) {
    const a = handlerFor(s).decide(s, j, ctx);
    if (a) actions.push(a);
  }
  return actions;
}

export interface WorkEngineOpts {
  queue: JobQueue;
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
  linearWriter: LinearWriter;
  jobsDir: string;
  newId?: () => string;
  now?: () => number;
  actionsStore?: ActionsStore;
  modes?: ApprovalModeStore;
  journalStore?: JournalStore;
  actionRegistry?: ActionRegistry;
  // Token-aware launch queue. Every autonomous launch routes through it via submitLaunch;
  // reactive rounds and high-priority jobs fire immediately, everything else waits for token
  // headroom + a free concurrency slot. Optional so the unit harnesses (which omit it) keep
  // firing launches synchronously — the daemon always wires it.
  governor?: LaunchGovernor;
  // Persists a durable {action, title} marker for a spawned action session so the PWA
  // sessions list can label + title it without loading the transcript. Wired to
  // SessionStore.writeActionMeta in the daemon.
  writeActionMeta?: (sessionId: string, meta: { action: string; title: string }) => void;
  // Overrides UNRESOLVED_GRACE_MS (tests).
  unresolvedGraceMs?: number;
}

type SessionRole =
  | { role: 'orchestrator'; jobId: string }
  | { role: 'step'; jobId: string; stepId: string }
  | { role: 'dispatch'; jobId: string; stepId: string; dispatchId: string };

export class WorkEngine {
  private readonly ctx: HandlerCtx;
  private readonly roleBySession = new Map<string, SessionRole>();
  private readonly actionBySession = new Map<string, string>();
  // Per (long-lived, cross-round) step session: count of Stop hooks owed by turns that
  // were already superseded by a queued resume. When a round is dispatched onto a session
  // that's still mid-turn (e.g. a fast spec approval resumes /code.plan before the spec
  // turn's Stop has landed), the trailing Stop belongs to that old round — not the new one.
  // consumeStaleTurnStop() lets the Stop handler drop it instead of failing the live step.
  private readonly owedStaleStops = new Map<string, number>();
  // Live soak timers for parked meta.wait steps, keyed `${jobId}:${stepId}`. Set when a
  // step enters a timed wait, cleared on resume/resolve/abandon, and rebuilt at boot by
  // reconcileWaits (setTimeout does not survive a daemon restart).
  private readonly waitTimers = new Map<string, NodeJS.Timeout>();
  // Per step session: a pending "ended without submitting" check, armed at the Stop hook
  // and cancelled by further activity on the session. A turn boundary is not proof the
  // round is over — a session that yields while background subagents run gets re-invoked
  // by the harness once they report, and their tool calls keep arriving on the PreToolUse
  // hook meanwhile. Failing on the Stop edge killed spec rounds that went on to submit
  // minutes later, so the check now waits for the session to actually fall silent.
  private readonly unresolvedTimers = new Map<string, NodeJS.Timeout>();

  actionForSession(sessionId: string): string | undefined {
    return this.actionBySession.get(sessionId);
  }

  // Liveness for the PWA Tracked bucketing: is this session actively mid-turn?
  // (Not merely "subprocess alive" — see SessionManager.isWorking.)
  isSessionWorking(sessionId?: string): boolean {
    return !!sessionId && this.opts.sessionManager.isWorking(sessionId);
  }

  // Reverse lookup: which job (if any) owns this session. Covers orchestrator and
  // step sessions (both are registered in roleBySession on spawn and at boot).
  jobIdForSession(sessionId: string): string | undefined {
    return this.roleBySession.get(sessionId)?.jobId;
  }

  // Resolves the worktree path for a spawned step session. Worktree records are
  // keyed by stepId (see WorktreeManager.provision), but step sessions run under a
  // freshly-minted sessionId — so a direct `worktreeManager.get(sessionId)` misses.
  // Route through roleBySession → stepId → worktree record.
  worktreePathForSession(sessionId: string): string | undefined {
    const role = this.roleBySession.get(sessionId);
    if (!role || role.role !== 'step') return undefined;
    const rec = this.opts.worktreeManager.get(role.stepId);
    return rec && !rec.archivedAt ? rec.worktreePath : undefined;
  }

  // Same stepId indirection as worktreePathForSession, but returns the whole
  // record so callers (git/status) can surface branch/base metadata. Without
  // this, a direct worktreeManager.get(sessionId) misses and the PWA never
  // learns the session is worktree-backed — hiding the merge/squash/discard UI.
  worktreeRecordForSession(sessionId: string): WorktreeRecord | undefined {
    const role = this.roleBySession.get(sessionId);
    if (!role || role.role !== 'step') return undefined;
    return this.opts.worktreeManager.get(role.stepId);
  }

  // Binds a spawned session to an action name. The hook-handler reads this binding
  // and enforces deny-on-allowlist-miss for the session — no per-action mode.
  // Public so the daemon can bind sessions it spawns directly (e.g. action-builder
  // edits) without routing through a step handler.
  bindAction(sessionId: string, actionName: string): void {
    if (!this.opts.actionsStore) return;
    this.actionBySession.set(sessionId, actionName);
  }

  // Durably marks a freshly-spawned session as an action (name + readable title) for
  // the PWA sessions list. Unlike bindAction (in-memory, for the permission hook), this
  // persists — so a finished orchestrator/step/edit session still reads as an action
  // with a readable title after a daemon restart. Public so the actions route can stamp
  // the action-builder edit sessions it spawns directly.
  stampActionSession(sessionId: string, action: string, title: string): void {
    this.opts.writeActionMeta?.(sessionId, { action, title });
  }

  // A Stop hook fired for `sessionId`. Returns true iff this Stop is owed to a round that
  // was already superseded by a queued resume (see spawnStepSession) — the caller must
  // then ignore it (skip armUnresolvedCheck / onSessionTurnEnded), because the step is
  // actively running its next round and the real turn-end Stop is still to come.
  consumeStaleTurnStop(sessionId: string): boolean {
    const n = this.owedStaleStops.get(sessionId) ?? 0;
    if (n <= 0) return false;
    if (n === 1) this.owedStaleStops.delete(sessionId);
    else this.owedStaleStops.set(sessionId, n - 1);
    return true;
  }

  // Called from the Stop hook when a spawned step session ends its turn. Every step is
  // expected to resolve via `mcp__outpost__submit_step_output` (or a role-specific
  // submit_* tool); if it never does, the step would sit in its initial state forever and
  // hang the orchestrator. But a Stop only marks a *turn* boundary, not the end of the
  // round: a session that dispatches background subagents and yields until they report
  // gets re-invoked by the harness. So arm the failure instead of applying it, and let
  // any further activity on the session (noteSessionActivity) call it off. Returns true
  // iff a check was armed. Idempotent for already-resolved / failed / cancelled steps.
  armUnresolvedCheck(sessionId: string, reason: string): boolean {
    if (!this.unresolvedFailable(sessionId)) return false;
    this.cancelUnresolvedCheck(sessionId);
    const t = setTimeout(() => {
      this.unresolvedTimers.delete(sessionId);
      const role = this.unresolvedFailable(sessionId);
      if (!role) return;
      this.onStepFailed(role.jobId, role.stepId, reason);
    }, this.opts.unresolvedGraceMs ?? UNRESOLVED_GRACE_MS);
    t.unref?.();
    this.unresolvedTimers.set(sessionId, t);
    return true;
  }

  // Any tool call on the session proves it is still working, so a Stop that preceded it
  // did not end the round. Subagent calls count: they carry the parent's session id on the
  // PreToolUse hook, and while background agents run they are the *only* signal the parent
  // is still alive — its own stdout stays quiet (see SessionManager.startIdleTimer).
  noteSessionActivity(sessionId: string): void {
    this.cancelUnresolvedCheck(sessionId);
  }

  private cancelUnresolvedCheck(sessionId: string): void {
    const t = this.unresolvedTimers.get(sessionId);
    if (t) { clearTimeout(t); this.unresolvedTimers.delete(sessionId); }
  }

  // The step behind `sessionId`, when a turn ending without a submit_* call would be a
  // genuine hang. Undefined when the session isn't a step's, or when ending the turn is
  // legitimate for the state it's in.
  private unresolvedFailable(sessionId: string): { jobId: string; stepId: string } | undefined {
    const role = this.roleBySession.get(sessionId);
    if (!role) return undefined;
    if (role.role === 'dispatch') {
      const j = this.opts.queue.get(role.jobId);
      const step = j?.steps.find((s) => s.id === role.stepId);
      if (step?.type !== 'orchestrated') return undefined;
      const d = step.dispatches.find((x) => x.id === role.dispatchId);
      if (!d || d.sessionId !== sessionId || d.status !== 'running') return undefined;
      // Route to the dispatch, not the parent step: onStepFailed checks a dispatchId
      // against every orchestrated step's dispatches before falling back to a plain
      // step lookup (see findDispatch/settleDispatch) — the parent step must not fail
      // just because one of its children hung.
      return { jobId: role.jobId, stepId: role.dispatchId };
    }
    if (role.role !== 'step') return undefined;
    const j = this.opts.queue.get(role.jobId);
    if (!j) return undefined;
    const step = j.steps.find((s) => s.id === role.stepId);
    if (!step) return undefined;
    // Deferring the check opens a window the edge-triggered version didn't have: the step
    // can be retried (fresh session, state reset to speccing) while a check armed by the
    // old session is still pending. That check is owed by a round that no longer exists.
    if (step.sessionId !== sessionId) return undefined;
    // A human_gate action's draft turn ends by submitting a draft and parking for approval
    // (submit_write_draft → gate_pending_approval). That's a legitimate turn end, not a
    // hang — don't fail it. The commit/redraft turns run when the user acts.
    if (step.type === 'action' && step.state === 'gate_pending_approval') return undefined;
    // A parked controller (waiting on an event, or on the user's gate decision) legitimately
    // ends its turn without submitting again until deliverInbox/resolveStepGate resumes it.
    if (step.type === 'orchestrated' && (step.state === 'waiting' || step.state === 'gate_pending_approval')) return undefined;
    if (step.state === 'resolved' || step.failure || step.cancelled) return undefined;
    return { jobId: role.jobId, stepId: role.stepId };
  }

  constructor(private readonly opts: WorkEngineOpts) {
    this.ctx = {
      jobsDir: opts.jobsDir,
      newId: opts.newId ?? (() => randomUUID()),
      now: opts.now ?? (() => Date.now()),
      actionRegistry: opts.actionRegistry,
    };
  }

  async tick(jobId?: string): Promise<void> {
    if (jobId) { await this.tickSafe(jobId); return; }
    for (const j of this.opts.queue.list()) await this.tickSafe(j.id);
  }

  // Called once at daemon startup. A step still in its in-flight state with a sessionId
  // set is orphaned — the previous daemon died with its child session mid-turn (a routine
  // `kickstart -k` bounce kills every spawned Claude process). Without this, decide() keeps
  // returning null for such a step (state is in-flight, but sessionId is already set) and
  // the job hangs forever. Action steps are read-only and single-turn: clear the sessionId
  // so decide() re-spawns a fresh session on the next tick, reusing the stepId-keyed
  // worktree. The bounce becomes non-destructive to the investigation.
  //
  // An orchestrated step in `running` is owed nothing by anyone — no inbox item is queued and
  // no timer is armed — so it gets the same treatment: clearing sessionId cold-spawns a fresh
  // controller, which reads phase/memo/artifacts/pr off its envelope and picks up where the
  // dead round left off. A `waiting` controller is NOT touched: whatever it parked on (a
  // watcher event, a dispatch, the user, a soak timer re-armed by reconcileWaits) resumes it,
  // and sendOrResume respawns the dead session with --resume rather than losing it.
  reconcileInterruptedSteps(): void {
    for (const j of this.opts.queue.list()) {
      for (const s of j.steps) {
        if (s.cancelled || s.failure) continue;
        // Clear the dead session BEFORE settling any dispatch below: a settle that delivers to
        // a still-`running` parent would resume the session we are about to drop, leaving two
        // controller sessions on one step.
        if (s.sessionId && s.state === 'running') {
          const label = this.stepLabel(j.id, s.id);
          this.mutateStep(j.id, s.id, (st) => ({ ...st, sessionId: undefined, updatedAt: this.ctx.now() }));
          this.mutate(j.id, (jj) => this.appendEvent(jj, {
            kind: 'step_retried', who: 'system', stepId: s.id,
            body: `${label} — session interrupted by daemon restart; re-running`,
          }));
        }
        // A dispatch child is a one-shot action session — nothing resumes it, and left
        // `running` it holds its parent's untilAllDispatchesDone wait open forever. Fail it so
        // the controller sees the gap and can retry it (settleDispatch pushes the done marker,
        // which is what wakes the parent).
        if (s.type !== 'orchestrated') continue;
        for (const d of s.dispatches) {
          if (d.status !== 'running') continue;
          this.settleDispatch(j.id, s.id, d.id, 'failed', { failure: 'session interrupted by daemon restart' });
        }
      }
    }
  }

  // roleBySession/actionBySession are in-memory only, but orchestratorSessionId and
  // step.sessionId are persisted on the job. On daemon restart the maps come back
  // empty while those ids survive, so any resumed session (orchestrator reopen, step
  // continuation) would miss its action binding — the hook-handler then treats it
  // as an interactive session and enqueues approval cards instead of auto-allowing
  // its action's reads. Rebind every persisted session at boot so the maps reflect
  // what's on disk, mirroring what the spawn paths set. Call once at startup.
  rehydrateSessionBindings(): void {
    for (const j of this.opts.queue.list()) {
      if (j.orchestratorSessionId) {
        this.roleBySession.set(j.orchestratorSessionId, { role: 'orchestrator', jobId: j.id });
        this.bindAction(j.orchestratorSessionId, j.orchestratorAction ?? 'meta.orchestrate');
      }
      for (const s of j.steps) {
        if (s.sessionId) {
          this.roleBySession.set(s.sessionId, { role: 'step', jobId: j.id, stepId: s.id });
          this.bindAction(s.sessionId, actionNameForStep(s));
        }
        // A still-running dispatch's session is persisted on the Dispatch record, but its
        // role is not. Without rebinding it, its submit_step_output falls through the
        // dispatch branch of onStepResolved and resolves the PARENT step on the child's
        // behalf — see findDispatchStepId.
        if (s.type !== 'orchestrated') continue;
        for (const d of s.dispatches) {
          if (d.status !== 'running' || !d.sessionId) continue;
          this.roleBySession.set(d.sessionId, { role: 'dispatch', jobId: j.id, stepId: s.id, dispatchId: d.id });
          this.bindAction(d.sessionId, d.action);
        }
      }
    }
  }

  // Never let a per-job tick failure bubble to `void orchestrator.tick()` —
  // Node treats an unhandled rejection as fatal and launchd will crashloop.
  private async tickSafe(jobId: string): Promise<void> {
    try {
      await this.tickOne(jobId);
    } catch (e) {
      console.error(`[work] tickOne(${jobId}) threw: ${(e as Error).stack ?? e}`);
    }
  }

  // No-op stub kept for parity with the prior interface. Session role bookkeeping
  // is in-memory only; on daemon restart all child sessions die anyway.
  onSessionExit(_sessionId: string, _code: number | null): void { /* intentionally empty */ }

  private async tickOne(jobId: string): Promise<void> {
    let j = this.opts.queue.get(jobId);
    if (!j) return;

    // A `failed` job is a halt, not a grave. `failed` is set the moment any step
    // carries a failure (decideJobTransitions), so once every failure has cleared —
    // the failing step was retried, merged, or otherwise recovered — lift the halt
    // and let the plan settle to done/executing. Retry paths flip this explicitly;
    // this catches recoveries that don't (squash-to-base, PR-watcher merge).
    if (j.state === 'failed' && !j.steps.some((s) => !s.cancelled && s.failure)) {
      this.mutate(jobId, (jj) => this.appendEvent({ ...jj, state: 'executing' }, {
        kind: 'state_changed', who: 'orchestrator', body: 'resumed: failing step recovered',
      }));
      j = this.opts.queue.get(jobId) ?? j;
    }

    // Per-step review: once a group has fully settled, run the orchestrator once
    // (via a step-review session) before advancing or marking done. Entry-agnostic
    // — fires no matter which path settled the step (action resolve, PR merge,
    // watcher). The spawn flips state to 'planning', so a re-entrant tick before
    // the orchestrator answers is a no-op here (owesStepReview requires executing).
    const reviewStepId = owesStepReview(j);
    if (reviewStepId) {
      this.spawnStepReviewSession(jobId, reviewStepId);
      return;
    }

    const transitions = decideJobTransitions(j);
    let markedDone = false;
    let markedFailed = false;
    for (const t of transitions) {
      if (t.kind === 'mark-done') {
        this.mutate(jobId, (jj) => this.appendEvent({ ...jj, state: 'done' }, { kind: 'state_changed', who: 'orchestrator', body: 'all steps resolved' }));
        markedDone = true;
      } else if (t.kind === 'mark-failed') {
        this.mutate(jobId, (jj) => this.appendEvent({ ...jj, state: 'failed' }, { kind: 'state_changed', who: 'orchestrator', body: 'halted: a step failed' }));
        markedFailed = true;
      } else if (t.kind === 'mark-linear-state') {
        const linearUuid = j.externalRef?.linearUuid;
        if (!linearUuid) continue;
        // setState is idempotent; await + retry on next tick beats the optimistic mark.
        try {
          await this.opts.linearWriter.setState(linearUuid, t.state);
          this.mutate(jobId, (jj) => ({ ...jj, linearStateMarked: { ...jj.linearStateMarked, [t.state]: true } }));
        } catch (e) {
          console.warn(`[work] Linear setState(${jobId}, ${t.state}) failed; will retry next tick: ${(e as Error).message}`);
        }
      }
    }
    if (markedDone || markedFailed) return;

    const actions = decide(this.opts.queue.get(jobId) ?? j, this.ctx);
    for (const action of actions) await this.execute(action);
  }

  private async execute(a: Action): Promise<void> {
    switch (a.kind) {
      case 'spawn-session':
        await this.spawnStepSession(a.jobId, a.stepId, a.envelopePath);
        break;
      case 'spawn-orchestrator':
        await this.spawnOrchestratorSession(a.jobId, a.mode, a.envelopePath, 'meta.orchestrate');
        break;
      case 'enter-wait':
        this.enterWait(a.jobId, a.stepId, a.durationSec);
        break;
      case 'resolve-wait':
        this.resolveWaitStep(a.jobId, a.stepId, 'timer');
        break;
      case 'deliver-inbox':
        deliverInbox(this.orchestratedHost(), a.jobId, a.stepId);
        this.syncOrchestratedWake(a.jobId, a.stepId);
        break;
      case 'write-linear-in-progress':
      case 'write-linear-in-review':
      case 'write-linear-done':
      case 'upsert-status-comment':
        // Linear writes are handled by tickOne directly; status-comment upsert is wired in linear-writer.
        break;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Public entry points (called by Linear poller, hook server,
  // PWA server, pr-watcher).
  // ─────────────────────────────────────────────────────────

  createJob(input: {
    source: JobRecord['source'];
    title: string;
    description: string;
    externalRef?: JobRecord['externalRef'];
    dedupeKey?: string;
    id?: string;
    autoPlan?: boolean;
    highPriority?: boolean;
  }): JobRecord {
    const id = input.id ?? this.ctx.newId();
    const now = this.ctx.now();
    const j: JobRecord = {
      id,
      source: input.source,
      dedupeKey: input.dedupeKey,
      title: input.title,
      description: input.description,
      externalRef: input.externalRef,
      ...(input.highPriority ? { highPriority: true } : {}),
      state: 'planning',
      steps: [],
      events: [{ id: this.ctx.newId(), at: now, kind: 'created', who: input.source === 'linear' ? 'linear-poller' : 'user' }],
      createdAt: now,
      updatedAt: now,
    };
    this.opts.queue.upsert(j);
    if (input.autoPlan) void this.spawnInitialOrchestrator(j, 'meta.orchestrate');
    return j;
  }

  // Single entry point for externally-sourced jobs (Linear script, other job-source scripts,
  // native watchers). Idempotent on dedupeKey: a key that already maps to a job no-ops and
  // returns that job (issue triaged once → never re-enqueued, even after it's done), rather
  // than spawning a duplicate on the next poll tick.
  createExternalJob(input: {
    source: string;
    title: string;
    body?: string;
    dedupeKey?: string;
    externalRef?: JobRecord['externalRef'];
    autoPlan?: boolean;
    highPriority?: boolean;
  }): { jobId: string; created: boolean } {
    // dedupeKey doubles as the job id below, which becomes a filesystem path component
    // (jobFile in work-queue.ts, writeEnvelope's jobsDir/jobId dir) — reject anything that
    // could traverse out of jobsDir, mirroring worktree-manager.ts's sessionId/branch guards.
    if (input.dedupeKey !== undefined) {
      if (!DEDUPE_KEY_RE.test(input.dedupeKey) || input.dedupeKey.includes('..')) {
        throw new Error(`invalid dedupeKey: must be a path-safe token (alphanumeric, dot, dash, underscore; no "..")`);
      }
    }
    if (input.dedupeKey) {
      const existing = this.opts.queue.get(input.dedupeKey);
      if (existing) return { jobId: existing.id, created: false };
    }
    const job = this.createJob({
      source: input.source,
      id: input.dedupeKey,               // dedupeKey doubles as the deterministic job id (as Linear does today)
      dedupeKey: input.dedupeKey,
      title: input.title,
      description: input.body ?? '',
      externalRef: input.externalRef,
      autoPlan: input.autoPlan ?? true,
      ...(input.highPriority ? { highPriority: true } : {}),
    });
    return { jobId: job.id, created: true };
  }

  // Explicit launcher — user clicks "Launch orchestrator" on a job that has no plan yet.
  async launchOrchestrator(jobId: string, context?: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    if (j.steps.length > 0) return; // use reopenOrchestrator for amendments
    await this.spawnInitialOrchestrator(j, 'meta.orchestrate', context, { userInitiated: true });
  }

  // ─────────────────────────────────────────────────────────
  // Token-launch queue (LaunchGovernor) integration.
  // ─────────────────────────────────────────────────────────

  // Routes an autonomous launch through the governor. The actual spawn/send AND the
  // mutation that records the session id live in `run` — a parked (queued, not yet fired)
  // launch must leave the job/step looking un-started (orchestratorSessionId / step.sessionId
  // unset) so decide() + reconcilePendingLaunches recreate it after a daemon restart.
  private submitLaunch(o: {
    key: string; jobId: string; stepId?: string; sessionId: string;
    action: string; label?: string; run: () => boolean;
    // Explicit user action (Launch orchestrator / replan / redraft). Fires immediately,
    // bypassing the headroom + concurrency gate — a manual run must always start.
    userInitiated?: boolean;
  }): void {
    const gov = this.opts.governor;
    if (!gov) { o.run(); return; }  // no governor wired (unit harnesses) → fire synchronously
    const job = this.opts.queue.get(o.jobId);
    const priority: LaunchPriority =
      (o.userInitiated || job?.highPriority || isReactiveAction(o.action)) ? 'immediate' : 'queued';
    const jobInProgress = !!job && job.steps.some((s) => !!s.sessionId || handlerFor(s).isResolved(s));
    gov.submit({
      key: o.key, jobId: o.jobId, stepId: o.stepId, sessionId: o.sessionId,
      priority, enqueuedAt: this.ctx.now(), jobInProgress,
      ...(o.label ? { label: o.label } : {}),
      run: o.run,
    });
  }

  // Force-fires the specific parked launch for a job's orchestrator (no stepId) or a step
  // (stepId given), bypassing the headroom/slot gate. False if nothing was parked there.
  launchNow(jobId: string, stepId?: string): boolean {
    return this.opts.governor?.forceFire(stepId ? `${jobId}#${stepId}` : `${jobId}#orchestrator`) ?? false;
  }

  // Toggles a job's high-priority flag. Turning it on fires any of the job's parked launches
  // immediately (they were queued behind token headroom / a busy slot).
  setHighPriority(jobId: string, value: boolean): void {
    const j = this.opts.queue.get(jobId);
    if (!j || (j.highPriority ?? false) === value) return;
    this.mutate(jobId, (jj) => this.appendEvent({ ...jj, highPriority: value }, {
      kind: 'state_changed', who: 'user',
      body: value ? 'marked high-priority — launches bypass the token queue' : 'cleared high-priority',
    }));
    if (value) this.opts.governor?.forceFireJob(jobId);
  }

  // Launch-queue status for a job's orchestrator and each of its steps (PWA consumes this).
  launchStatusFor(job: JobRecord): { job: LaunchState; steps: Record<string, LaunchState> } {
    const gov = this.opts.governor;
    const idle: LaunchState = { state: 'idle' };
    const steps: Record<string, LaunchState> = {};
    for (const s of job.steps) steps[s.id] = gov ? gov.describe(`${job.id}#${s.id}`) : idle;
    return { job: gov ? gov.describe(`${job.id}#orchestrator`) : idle, steps };
  }

  // Frees the governor slot a finished turn held, then drains any launch it unblocked.
  // Called UNCONDITIONALLY from the daemon Stop hook — deliberately NOT from onSessionTurnEnded,
  // which early-returns for orchestrator sessions (leaking their slot) and is skipped entirely
  // on a stale/superseded Stop (deadlocking a queued follow-up round behind the un-freed slot).
  releaseLaunchSlot(sessionId: string): void {
    this.opts.governor?.turnEnded(sessionId);
  }

  // Startup recovery: re-submit the initial orchestrator for any job stuck in `planning` with
  // no orchestrator session — its launch was parked (never fired) when the daemon stopped.
  // Executing jobs recover via the daemon's existing tick()/decide() re-emit for sessionless
  // active-group steps, which now route through submitLaunch — no duplication needed here.
  //
  // A step-review is the exception that needs clearing rather than re-launching: its session
  // died with the previous process, so the gate would block every dispatch forever. Drop it
  // and let owesStepReview re-fire on the next tick, which spawns a fresh review.
  reconcilePendingLaunches(): void {
    for (const j of this.opts.queue.list()) {
      if (j.reviewingStepId) {
        this.mutate(j.id, (jj) => ({ ...jj, reviewingStepId: undefined }));
      }
      if (j.state === 'planning' && !j.orchestratorSessionId) {
        void this.spawnInitialOrchestrator(j, j.orchestratorAction ?? 'meta.orchestrate');
      }
    }
  }

  async abandonJob(jobId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    await this.terminateJobResources(j);
    this.mutate(jobId, (jj) => this.appendEvent({ ...jj, state: 'abandoned' }, { kind: 'abandoned', who: 'user' }));
  }

  // Settle a job as done by hand — the work finished outside Outpost (CI fixed manually,
  // PR merged by someone else, the task turned out to be a no-op). Unfinished steps are
  // cancelled rather than left frozen so a `done` job never contains a step still claiming
  // to be mid-flight. That also makes allStepsResolved() true, so the Linear done-write
  // rides the same mark-linear-state transition organic completion uses — hence the tick
  // rather than a second setState call here.
  async markJobDone(jobId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    if (j.state === 'done') return;
    await this.terminateJobResources(j);
    const now = this.ctx.now();
    this.mutate(jobId, (jj) => this.appendEvent({
      ...jj,
      state: 'done',
      steps: jj.steps.map((s) => (s.cancelled || handlerFor(s).isResolved(s)
        ? s
        : ({ ...s, cancelled: true, updatedAt: now } as Step))),
    }, { kind: 'state_changed', who: 'user', body: 'marked done by user' }));
    void this.tickOne(jobId);
  }

  async deleteJob(jobId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    if (j.source !== 'manual') throw new Error('only manual jobs can be deleted');
    await this.terminateJobResources(j);
    this.opts.queue.delete(jobId);
  }

  // Close any live sessions bound to this job and archive every worktree it owns.
  // Archive (not remove) so JSONL transcripts survive for review.
  private async terminateJobResources(j: JobRecord): Promise<void> {
    // Drop any parked launches for this job so a later drain can't resurrect it after
    // abandon/delete/reset. Live sessions are closed below.
    this.opts.governor?.cancel(j.id);
    const sessionIds = new Set<string>();
    if (j.orchestratorSessionId) sessionIds.add(j.orchestratorSessionId);
    for (const s of j.steps) {
      if (s.sessionId) sessionIds.add(s.sessionId);
      // Dispatch children aren't in job.steps and don't carry a top-level sessionId —
      // without this a job abandoned/deleted mid-dispatch would leak their live sessions.
      if (s.type === 'orchestrated') {
        for (const d of s.dispatches) if (d.sessionId) sessionIds.add(d.sessionId);
      }
    }
    // Free any governor slots these live sessions hold. closeSessions SIGTERMs them, and a
    // SIGTERM fires no Stop hook — so release here rather than waiting on the async proc exit
    // (which does the same via onSessionExit; turnEnded is idempotent).
    for (const sid of sessionIds) this.opts.governor?.turnEnded(sid);
    await this.closeSessions(sessionIds);
    // Drop any armed meta.wait soak timers so an abandoned/deleted job doesn't keep a
    // stale wake pending (the resolve would no-op anyway, but don't leak the timer).
    for (const s of j.steps) this.clearWaitTimer(j.id, s.id);
    // Worktrees are keyed by stepId (see worktreePathForSession comment). Reap every
    // step's — readonly/detached steps own worktrees too, and skipping them was the
    // original orphan source; archiveWorktreeFor no-ops when there is none. A dispatch's
    // worktree is keyed by its own id (see spawnDispatchSession), so it needs its own
    // pass or it outlives the job that spawned it.
    for (const s of j.steps) {
      await this.archiveWorktreeFor(s.id);
      if (s.type === 'orchestrated') {
        for (const d of s.dispatches) await this.archiveWorktreeFor(d.id);
      }
    }
  }

  private async closeSessions(sessionIds: Iterable<string>): Promise<void> {
    for (const sid of sessionIds) {
      try { await this.opts.sessionManager.close(sid); }
      catch (e) { console.error(`[work] close session ${sid.slice(0,8)}: ${(e as Error).message}`); }
      this.roleBySession.delete(sid);
      this.actionBySession.delete(sid);
      this.owedStaleStops.delete(sid);
    }
  }

  // Keyed by the worktree's own key, which is a stepId for a step and a dispatchId for a
  // dispatch child.
  private async archiveWorktreeFor(key: string): Promise<void> {
    const rec = this.opts.worktreeManager.get(key);
    if (!rec || rec.archivedAt) return;
    try { await this.opts.worktreeManager.archive(key, rec.projectCwd); }
    catch (e) { console.error(`[work] archive worktree ${key.slice(0,8)}: ${(e as Error).message}`); }
  }

  // A step that reached a terminal state no longer needs its session or worktree;
  // archive both so they don't linger until job teardown.
  private async archiveStepResources(jobId: string, stepId: string): Promise<void> {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (!step) return;
    await this.closeSessions(step.sessionId ? [step.sessionId] : []);
    await this.archiveWorktreeFor(step.id);
  }

  onPlanReady(jobId: string, mode: 'initial' | 'replan', proposed: ProposedStep[], drops?: string[], feedback?: string, findings?: Finding): void {
    const j = this.opts.queue.get(jobId);
    if (!j) throw new Error(`unknown jobId: ${jobId}`);
    // Reject a malformed workspace here, where the throw becomes a JSON-RPC error the planner
    // can act on. Past the plan boundary it is unrecoverable: the step materializes, then fails
    // at provision on every dispatch and retry.
    proposed.forEach((p, i) => {
      const err = workspaceError(p.workspace);
      if (err) throw new Error(`step ${i + 1} ("${p.title}"): ${err}`);
    });
    const activeSteps = j.steps.filter((s) => !s.cancelled);
    // Wholesale-replace path: no active steps to reconcile against, or the
    // orchestrator explicitly declared this as an initial plan (e.g. after a
    // rejection wiped the steps). `drops` is meaningless here.
    if (mode === 'initial' || activeSteps.length === 0) {
      const steps = proposed.map((p) => this.materialize(p));
      this.mutate(jobId, (jj) => this.appendEvent({
        ...jj,
        state: 'plan_pending_review',
        reviewingStepId: undefined,
        plan: {
          postedAt: this.ctx.now(),
          iterationsRejected: jj.plan?.iterationsRejected ?? [],
          ...(findings ? { findings } : jj.plan?.findings ? { findings: jj.plan.findings } : {}),
        },
        steps,
      }, { kind: 'plan_posted', who: 'orchestrator', body: `${steps.length} steps proposed` }));
      return;
    }
    // Amendment path: every non-cancelled step needs a disposition. The check
    // throws (caught by the MCP dispatcher and surfaced as a JSON-RPC error)
    // rather than silently applying a partial reconciliation.
    const check = validateDispositions(j.steps, proposed, drops ?? []);
    if (!check.ok) throw new Error(check.error);
    this.mutate(jobId, (jj) => this.appendEvent({
      ...jj,
      state: 'plan_pending_review',
      reviewingStepId: undefined,
      plan: {
        postedAt: jj.plan?.postedAt ?? this.ctx.now(),
        iterationsRejected: jj.plan?.iterationsRejected ?? [],
        ...(findings ? { findings } : jj.plan?.findings ? { findings: jj.plan.findings } : {}),
      },
      pendingReconciliation: { proposed, drops: drops ?? [], feedback: feedback ?? '', proposedAt: this.ctx.now() },
    }, { kind: 'plan_posted', who: 'orchestrator', body: 'amendment proposed' }));
  }

  onPlanApproved(jobId: string): void {
    this.mutate(jobId, (j) => this.appendEvent({ ...j, state: 'executing' }, { kind: 'plan_approved', who: 'user' }));
    void this.tickOne(jobId);
  }

  onPlanRejected(jobId: string, feedback: string): void {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    const trimmed = feedback.trim();
    if (!trimmed) return;
    const iter: PlanIteration = {
      id: this.ctx.newId(),
      steps: j.steps.map((s) => stepToProposed(s)),
      feedback: trimmed,
      rejectedAt: this.ctx.now(),
      ...(j.plan?.findings ? { findings: j.plan.findings } : {}),
    };
    this.mutate(jobId, (jj) => this.appendEvent({
      ...jj,
      state: 'planning',
      steps: [],
      reviewingStepId: undefined,
      plan: {
        postedAt: jj.plan?.postedAt ?? this.ctx.now(),
        iterationsRejected: [...(jj.plan?.iterationsRejected ?? []), iter],
      },
    }, { kind: 'plan_rejected', who: 'user', body: trimmed }));

    const after = this.opts.queue.get(jobId);
    if (!after) return;
    const actionName = after.orchestratorAction ?? 'meta.orchestrate';
    const env: OrchestratorEnvelope = {
      kind: 'orchestrator',
      mode: 'replan',
      jobId,
      job: { source: after.source, title: after.title, description: after.description, externalRef: after.externalRef },
      stepTypeCatalog: STEP_TYPE_CATALOG,
      actionCatalog: this.buildActionCatalog(),
      userFeedback: trimmed,
      rejectedIterations: after.plan?.iterationsRejected,
      recentLessons: this.opts.journalStore?.recent(actionName) ?? [],
    };
    const path = writeEnvelope(this.ctx.jobsDir, jobId, null, env);
    void this.spawnOrchestratorSession(jobId, 'replan', path, actionName, { userInitiated: true });
  }

  reopenOrchestrator(jobId: string, feedback: string): void {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    const actionName = j.orchestratorAction ?? 'meta.orchestrate';
    const env: OrchestratorEnvelope = {
      kind: 'orchestrator',
      mode: 'replan',
      jobId,
      job: { source: j.source, title: j.title, description: j.description, externalRef: j.externalRef },
      stepTypeCatalog: STEP_TYPE_CATALOG,
      actionCatalog: this.buildActionCatalog(),
      currentSteps: j.steps,
      userFeedback: feedback,
      rejectedIterations: j.plan?.iterationsRejected,
      recentLessons: this.opts.journalStore?.recent(actionName) ?? [],
    };
    const envelopePath = writeEnvelope(this.ctx.jobsDir, jobId, null, env);
    this.mutate(jobId, (jj) => this.appendEvent({ ...jj, state: 'planning', reviewingStepId: undefined }, { kind: 'orchestrator_reopened', who: 'user', body: feedback }));

    const followup = `User reopened the orchestrator with this feedback:\n\n${feedback}\n\nRe-read $OUTPOST_ENVELOPE (now in mode=replan, with currentSteps and userFeedback). Post an amended plan via /work/plan-ready with mode=replan.`;

    if (j.orchestratorSessionId) {
      // Rebind the session's role/action before resuming. These maps are in-memory
      // only and aren't rehydrated on boot, so after a daemon restart orchestratorSessionId
      // survives on the job but the binding is gone — without this the hook-handler
      // treats the resumed orchestrator as an ordinary interactive session and enqueues
      // approval cards instead of auto-allowing its read-only actions.
      this.roleBySession.set(j.orchestratorSessionId, { role: 'orchestrator', jobId });
      this.bindAction(j.orchestratorSessionId, actionName);
      // Resume — sendOrResume respawns the proc if it was idle-reaped, applying
      // the new env var (so the envelope path is correct after a respawn too).
      this.opts.sessionManager.sendOrResume(
        j.orchestratorSessionId,
        this.orchestratorCwd(),
        { type: 'user', message: { role: 'user', content: followup } },
        { OUTPOST_ENVELOPE: envelopePath, JOB_ID: jobId },
      );
      return;
    }
    // No prior session — fresh spawn in replan mode.
    void this.spawnOrchestratorSession(jobId, 'replan', envelopePath, actionName, { userInitiated: true });
  }

  onReconciliationApproved(jobId: string): void {
    const j = this.opts.queue.get(jobId);
    if (!j || !j.pendingReconciliation) return;
    const recon = reconcile(j.steps, j.pendingReconciliation.proposed, j.pendingReconciliation.drops);
    const byId = new Map(j.steps.map((s) => [s.id, s]));
    const cancelledSet = new Set(recon.cancelled);

    let addedCursor = 0;
    const proposedOrdered: Step[] = j.pendingReconciliation.proposed.map((_, i) => {
      const kept = recon.kept[i];
      if (kept) {
        const cur = byId.get(kept.stepId)!;
        return { ...cur, ...kept.patch, updatedAt: this.ctx.now() } as Step;
      }
      const add = recon.added[addedCursor++];
      return this.materialize(add!);
    });

    const cancelledTail: Step[] = j.steps
      .filter((s) => cancelledSet.has(s.id))
      .map((s) => ({ ...s, cancelled: true, updatedAt: this.ctx.now() } as Step));

    // Mark currently-settled non-cancelled steps reviewed (mirrors onOrchestratorContinue)
    // so owesStepReview doesn't spawn a redundant re-review of the step that already
    // triggered this reconciliation.
    const steps: Step[] = [...proposedOrdered, ...cancelledTail].map((s) =>
      !s.cancelled && handlerFor(s).isResolved(s) ? ({ ...s, reviewed: true } as Step) : s);

    this.mutate(jobId, (jj) => this.appendEvent({
      ...jj,
      steps,
      pendingReconciliation: undefined,
      state: 'executing',
    }, { kind: 'plan_reconciled', who: 'user' }));
    void this.tickOne(jobId);
  }

  onReconciliationDiscarded(jobId: string): void {
    this.mutate(jobId, (j) => ({
      ...j,
      pendingReconciliation: undefined,
      state: 'executing',
      steps: j.steps.map((s) =>
        !s.cancelled && handlerFor(s).isResolved(s) ? ({ ...s, reviewed: true } as Step) : s),
    }));
  }

  // Dispatch children are never in job.steps — they live in an orchestrated step's
  // `dispatches`, keyed by their own id (which a dispatch session is given as `stepId`;
  // see spawnDispatchSession). Finds the orchestrated step that owns `dispatchId`, if any.
  private findDispatchStepId(jobId: string, dispatchId: string): string | undefined {
    const j = this.opts.queue.get(jobId);
    const step = j?.steps.find((s) => s.type === 'orchestrated' && s.dispatches.some((d) => d.id === dispatchId));
    return step?.id;
  }

  private settleDispatch(
    jobId: string, stepId: string, dispatchId: string, status: 'done' | 'failed',
    result: { output?: string; failure?: string },
  ): void {
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'orchestrated') return s;
      return {
        ...s,
        dispatches: s.dispatches.map((d) => d.id === dispatchId ? {
          ...d, status, finishedAt: this.ctx.now(),
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.failure !== undefined ? { failure: result.failure } : {}),
        } : d),
      };
    });
    pushInbox(this.orchestratedHost(), jobId, stepId, { kind: 'dispatch-done', dispatchId });
  }

  // A session POSTs /work/step-resolved (or calls submit_step_output). `payload.output` is
  // captured as the step's stored output; agent steps with `forwardOutput` will then thread it
  // into downstream steps' `previousSteps`.
  onStepResolved(jobId: string, stepId: string, payload?: { output?: string }): void {
    // A dispatch child submits through the same tool as any other action step, using its
    // own dispatch id as `stepId` (see spawnDispatchSession's envelope). Route it to the
    // dispatch record — its parent orchestrated step resolves only via a NextMove.resolve.
    const parentStepId = this.findDispatchStepId(jobId, stepId);
    if (parentStepId) {
      this.settleDispatch(jobId, parentStepId, stepId, 'done', { output: payload?.output });
      return;
    }
    // An orchestrated step is NOT resolvable from here. A bound work round runs on the
    // controller's own session under the controller's stepId, so an action whose SKILL ends in
    // submit_step_output (code.review-diff, code.review-ui, code.security-review) lands right
    // here — and settling on its behalf would end the step AND archive its worktree
    // (`git worktree remove --force` + `branch -D`) in the middle of the work it was reviewing.
    // Resolution is the controller's own decision, taken as a `resolve` move through
    // resolveStepByController; the user's force-close goes through markStepResolved. The round
    // still owes a submit_step_progress, which is what actually reports its findings.
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (step?.type === 'orchestrated') return;
    let didResolve = false;
    this.mutateStep(jobId, stepId, (s) => {
      didResolve = true;
      const next: Step = { ...s, state: 'resolved', updatedAt: this.ctx.now() };
      if (payload?.output && next.type === 'action') next.output = payload.output;
      return this.appendStepEvent(next, 'resolved', 'session');
    });
    if (didResolve) {
      this.mutate(jobId, (j) => this.appendEvent(j, {
        kind: 'step_resolved', who: 'session', stepId, body: this.stepLabel(jobId, stepId),
      }));
    }
    void this.tickOne(jobId);
  }

  // ─────────────────────────────────────────────────────────
  // meta.wait — daemon-side hold between steps.
  // ─────────────────────────────────────────────────────────

  // A meta.wait step just became active. Park it in `waiting` (no session spawned).
  // With duration_sec, stamp `resumeAt` and arm a soak timer that ticks the job when it
  // elapses; without one, hold indefinitely until the user resumes.
  private enterWait(jobId: string, stepId: string, durationSec?: number): void {
    const now = this.ctx.now();
    const resumeAt = durationSec != null && durationSec > 0 ? now + durationSec * 1000 : undefined;
    let entered = false;
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'action' || s.state !== 'running') return s;
      entered = true;
      return { ...s, state: 'waiting', resumeAt, updatedAt: now };
    });
    if (!entered) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'orchestrator', stepId,
      body: resumeAt != null
        ? `${this.stepLabel(jobId, stepId)} — waiting ${formatWait(durationSec!)} before continuing`
        : `${this.stepLabel(jobId, stepId)} — waiting for you to resume`,
    }));
    if (resumeAt != null) this.scheduleWaitWake(jobId, stepId, resumeAt - now);
  }

  private scheduleWaitWake(jobId: string, stepId: string, delayMs: number): void {
    const key = `${jobId}:${stepId}`;
    const existing = this.waitTimers.get(key);
    if (existing) clearTimeout(existing);
    // setTimeout caps at ~24.8 days; longer soaks fire early, land back in `waiting`
    // (decide() sees now < resumeAt), and reconcileWaits/next tick re-arms the remainder.
    const clamped = Math.min(Math.max(0, delayMs), 2_147_483_647);
    const t = setTimeout(() => { this.waitTimers.delete(key); void this.tick(jobId); }, clamped);
    if (typeof t.unref === 'function') t.unref();
    this.waitTimers.set(key, t);
  }

  private clearWaitTimer(jobId: string, stepId: string): void {
    const key = `${jobId}:${stepId}`;
    const t = this.waitTimers.get(key);
    if (t) { clearTimeout(t); this.waitTimers.delete(key); }
  }

  // Resolve a parked meta.wait — the soak timer elapsed (`by: 'timer'`) or the user
  // resumed (`by: 'user'`). Stores the schema-shaped output and ticks so the next step
  // dispatches. No-op unless the step is still `waiting` (guards double-fire).
  private resolveWaitStep(jobId: string, stepId: string, by: 'timer' | 'user', note?: string): void {
    this.clearWaitTimer(jobId, stepId);
    let resolved = false;
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'action' || s.state !== 'waiting') return s;
      resolved = true;
      const output = JSON.stringify({ resumed_by: by, ...(note ? { note } : {}) });
      // reviewed:true so owesStepReview skips it — a hold has no output worth an
      // orchestrator reflection, and we don't want a Claude session spawned between
      // the wait and the step it's gating. The gated step's own settle still reviews.
      return this.appendStepEvent(
        { ...s, state: 'resolved', resumeAt: undefined, output, reviewed: true, updatedAt: this.ctx.now() },
        'resolved', by === 'user' ? 'user' : 'orchestrator',
      );
    });
    if (!resolved) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'step_resolved', who: by === 'user' ? 'user' : 'orchestrator', stepId,
      body: `${this.stepLabel(jobId, stepId)} — resumed by ${by}`,
    }));
    void this.tickOne(jobId);
  }

  // PWA "Resume" action on a parked meta.wait step.
  resumeWait(jobId: string, stepId: string, note?: string): void {
    this.resolveWaitStep(jobId, stepId, 'user', note?.trim() || undefined);
  }

  // Called once at daemon startup: soak timers don't survive a restart. Re-arm every
  // parked meta.wait — resolve immediately if its deadline already passed, otherwise
  // schedule a fresh wake for the remaining time. Indefinite holds (no resumeAt) just
  // stay parked until the user resumes. Orchestrated waits carrying `resumeAt` are re-armed
  // the same way (a due one fires on the next macrotask rather than resolving the step —
  // the tick is what delivers it; see syncOrchestratedWake).
  reconcileWaits(): void {
    const now = this.ctx.now();
    for (const j of this.opts.queue.list()) {
      if (j.state !== 'executing' && j.state !== 'failed') continue;
      for (const s of j.steps) {
        if (s.cancelled || s.failure || s.state !== 'waiting') continue;
        if (s.type === 'orchestrated') { this.syncOrchestratedWake(j.id, s.id); continue; }
        if (s.type !== 'action' || s.resumeAt == null) continue;
        if (now >= s.resumeAt) this.resolveWaitStep(j.id, s.id, 'timer');
        else this.scheduleWaitWake(j.id, s.id, s.resumeAt - now);
      }
    }
  }

  // A parked controller has nothing else that would ever tick it: the daemon runs no periodic
  // tick, and an empty inbox is not deliverable. So a `wait` carrying `resumeAt` needs a real
  // armed timer, dropped again the moment the step stops waiting on the clock. The tick it
  // fires reaches orchestratedHandler.decide → deliver-inbox → deliverInbox, which materializes
  // the `timer` item the delivery carries.
  private syncOrchestratedWake(jobId: string, stepId: string): void {
    const s = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
    if (s?.type !== 'orchestrated') return;
    const at = !s.cancelled && !s.failure && s.state === 'waiting' ? s.waitingOn?.resumeAt : undefined;
    if (at == null) { this.clearWaitTimer(jobId, stepId); return; }
    this.scheduleWaitWake(jobId, stepId, at - this.ctx.now());
  }

  // ─────────────────────────────────────────────────────────
  // human_gate — draft → review → commit loop for external writes.
  // The action's draft turn composes the payload and submits it for review
  // (submit_write_draft) WITHOUT posting; the user approves (→ commit turn posts it)
  // or proposes changes (→ redraft turn). The external
  // write is hard-blocked by the hook until gateApproved (see writeGateHeldForSession),
  // so nothing posts before the user's OK — independent of the skill's behaviour.
  // ─────────────────────────────────────────────────────────

  // The draft turn submitted a payload for review. Store it and park the step for the
  // user's approval. Does NOT dispatch — approveGate/rejectGate drive the next turn.
  onWriteDraftReady(jobId: string, stepId: string, draft: string): void {
    let ok = false;
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'action' || (s.state !== 'running' && s.state !== 'gate_pending_approval')) return s;
      ok = true;
      return { ...s, draft, state: 'gate_pending_approval', updatedAt: this.ctx.now() };
    });
    if (!ok) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'session', stepId,
      body: `${this.stepLabel(jobId, stepId)} — draft ready for your approval`,
    }));
  }

  // PWA "Approve & run": the user approved the drafted payload. Flip gateApproved (which
  // lifts the hook's write-block) and resume the same session in its commit turn to post.
  approveGate(jobId: string, stepId: string): void {
    let ok = false;
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'action' || s.state !== 'gate_pending_approval') return s;
      ok = true;
      return { ...s, state: 'running', gateApproved: true, updatedAt: this.ctx.now() };
    });
    if (!ok) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'user', stepId, body: `${this.stepLabel(jobId, stepId)} — approved`,
    }));
    void this.dispatchActionResume(jobId, stepId);
  }

  // PWA "Propose changes": the user wants a different payload. Record the feedback and
  // resume the same session in a redraft turn — it revises and re-submits via
  // submit_write_draft, re-parking for approval. The write never fired (gateApproved is
  // still false, so the hook keeps blocking it).
  rejectGate(jobId: string, stepId: string, feedback: string): void {
    const note = feedback?.trim();
    if (!note) return;
    let ok = false;
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'action' || s.state !== 'gate_pending_approval') return s;
      ok = true;
      return { ...s, state: 'running', gateFeedback: [...(s.gateFeedback ?? []), note], updatedAt: this.ctx.now() };
    });
    if (!ok) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'user', stepId, body: note,
    }));
    void this.dispatchActionResume(jobId, stepId);
  }

  // Resume a human_gate action's persistent session for its next turn (commit after
  // approval, or redraft after feedback). Rebuilds the envelope at the stable path so the
  // resumed session re-reads the current phase/draft/feedback, then sendOrResume's it.
  private async dispatchActionResume(jobId: string, stepId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!j || !s || s.type !== 'action' || !s.sessionId) return;
    const sessionId = s.sessionId;
    const actionName = actionNameForStep(s);
    const envelope = handlerFor(s).buildEnvelope(s, j, this.ctx);
    const envelopePath = writeEnvelope(this.ctx.jobsDir, jobId, stepId, envelope);
    augmentEnvelopeWithLessons(envelopePath, this.opts.journalStore?.recent(actionName) ?? []);
    const cwd = (await this.opts.worktreeManager.provision(stepId, s.workspace)).path ?? this.orchestratorCwd();
    // A resume queued behind an in-flight turn leaves a trailing Stop for the superseded
    // round; record it so the Stop handler drops it rather than failing this live step.
    if (this.opts.sessionManager.isWorking(sessionId)) {
      this.owedStaleStops.set(sessionId, (this.owedStaleStops.get(sessionId) ?? 0) + 1);
    }
    this.submitLaunch({
      key: `${jobId}#${stepId}`, jobId, stepId, sessionId, action: actionName, label: actionName,
      run: () => {
        const cur = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
        if (!cur || cur.type !== 'action' || cur.cancelled || cur.failure) return false;
        this.roleBySession.set(sessionId, { role: 'step', jobId, stepId });
        this.bindAction(sessionId, actionName);
        this.opts.sessionManager.sendOrResume(
          sessionId,
          cwd,
          { type: 'user', message: { role: 'user', content: `/${actionName}` } },
          { OUTPOST_ENVELOPE: envelopePath, JOB_ID: jobId, STEP_ID: stepId, STEP_TYPE: 'action' },
        );
        return true;
      },
    });
  }

  // Hook backstop: true while a human_gate action's session is in its draft/redraft phase
  // (not yet gateApproved). The PreToolUse hook denies external writes for such sessions,
  // so the write cannot fire before the user approves the draft — even if the skill tries.
  writeGateHeldForSession(sessionId: string): boolean {
    const role = this.roleBySession.get(sessionId);
    if (!role || role.role !== 'step') return false;
    const s = this.opts.queue.get(role.jobId)?.steps.find((x) => x.id === role.stepId);
    if (!s || s.type !== 'action' || s.gateApproved) return false;
    return !!this.ctx.actionRegistry?.getAction(s.action)?.frontmatter.outpost.human_gate;
  }

  // `journal: false` for failures the action itself didn't cause — a daemon bounce or a
  // workspace that wouldn't provision say nothing about the skill, and would crowd real
  // lessons out of the bounded per-action journal.
  onStepFailed(jobId: string, stepId: string, reason: string, opts: { journal?: boolean } = {}): void {
    // Same dispatch short-circuit as onStepResolved: a dispatch's failure is the
    // controller's to interpret via the next inbox delivery, not an automatic step failure.
    const parentStepId = this.findDispatchStepId(jobId, stepId);
    if (parentStepId) {
      this.settleDispatch(jobId, parentStepId, stepId, 'failed', { failure: reason });
      return;
    }
    if (opts.journal !== false) this.journalBlocker(jobId, stepId, reason);
    this.mutateStep(jobId, stepId, (s) => {
      const next: Step = { ...s, failure: { reason, at: this.ctx.now() } };
      // action steps reach failure only through `.failure` — this is the sole producer
      // of `state: 'failed'`, and only orchestrated steps go through it. Set both so they
      // agree, rather than leaving `state` frozen at whatever it was mid-round: a step the
      // engine treats as terminal (via `.failure`) still reading 'running'/'waiting' is exactly
      // the inconsistency applyMove/validateNext guard against on both fields.
      if (next.type === 'orchestrated') next.state = 'failed';
      return this.appendStepEvent(next, 'failed', 'session');
    });
    this.settleOrchestratedStep(jobId, stepId, 'keep');
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'step_failed', who: 'session', stepId, body: `${this.stepLabel(jobId, stepId)} — ${reason}`,
    }));
  }

  // A blocker must always reach the action's journal. It's the only signal
  // meta.improve-actions gets that a skill is mis-specified, and the failure modes that
  // matter most — an allowlist gap, a missing envelope field — recur identically on every
  // future run until someone sees them. Actions are instructed to journal their own,
  // better-distilled lesson before failing; this is the backstop for the ones that don't.
  private journalBlocker(jobId: string, stepId: string, reason: string): void {
    const journal = this.opts.journalStore;
    if (!journal) return;
    const s = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
    if (!s) return;
    const action = actionNameForStep(s);
    if (journal.hasEntryForStep(action, jobId, stepId)) return;
    journal.append({ action, jobId, stepId, outcome: 'blocked', lesson: reason });
  }

  // ─────────────────────────────────────────────────────────
  // Orchestrated step control loop — the host binding for orchestrated-runner.ts.
  // ─────────────────────────────────────────────────────────

  private orchestratedHost(): OrchestratedHost {
    return {
      getStep: (jobId, stepId) => {
        const s = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
        return s?.type === 'orchestrated' ? s : undefined;
      },
      mutateStep: (jobId, stepId, fn) => this.opts.queue.mutate(jobId, (j) => ({
        ...j,
        steps: j.steps.map((s) => s.id === stepId && s.type === 'orchestrated' ? fn(s) : s),
      })),
      sessionWorking: (sid) => this.opts.sessionManager.isWorking(sid),
      // Both are fire-and-forget, and only their provision() call is guarded internally. A
      // throw anywhere else (envelope build/write, lesson augmentation, action catalog) is
      // an unhandled rejection that would leave the step hung or the dispatch stuck
      // `queued`, with no failure event and no global unhandledRejection handler to catch it.
      resumeController: (jobId, stepId, action, note) => {
        this.resumeControllerRound(jobId, stepId, action, note).catch((e) =>
          this.onStepFailed(jobId, stepId, `controller resume failed: ${(e as Error).message ?? e}`, { journal: false }));
      },
      spawnDispatch: (jobId, stepId, d) => {
        this.spawnDispatchSession(jobId, stepId, d).catch((e) =>
          this.settleDispatch(jobId, stepId, d.id, 'failed', { failure: `dispatch spawn failed: ${(e as Error).message ?? e}` }));
      },
      resolveStep: (jobId, stepId, output) => this.resolveStepByController(jobId, stepId, output),
      failStep: (jobId, stepId, reason) => this.onStepFailed(jobId, stepId, reason),
      actionInfo: {
        sideEffects: (a) => this.opts.actionRegistry?.getAction(a)?.frontmatter.outpost.side_effects,
        humanGate: (a) => this.opts.actionRegistry?.getAction(a)?.frontmatter.outpost.human_gate ?? false,
      },
      newId: () => this.ctx.newId(),
      now: () => this.ctx.now(),
    };
  }

  // A job the user threw away or closed out is over, but terminateJobResources leaves each
  // step's own state untouched — so every one of these entry points would happily deliver to a
  // step that still reads `waiting`, resume its controller, and have sendOrResume respawn the
  // session the teardown just closed. The routes guard this too, but they are not the only
  // caller: PrWatcher.syncNow walks the whole queue with no state filter, so an abandoned job
  // with an open PR keeps pushing watcher events in here. `failed` is deliberately live — it's
  // a recoverable halt (see tickOne), and `planning` covers a step-review in flight.
  private jobAcceptsStepWork(jobId: string): boolean {
    const state = this.opts.queue.get(jobId)?.state;
    return state !== undefined && state !== 'abandoned' && state !== 'done';
  }

  // Each of these can park the step on a timed wait, or take it off one — re-sync the armed
  // wake after every move rather than trusting each branch to remember.
  onStepProgress(jobId: string, stepId: string, p: ProgressPayload): void {
    if (!this.jobAcceptsStepWork(jobId)) return;
    applyMove(this.orchestratedHost(), jobId, stepId, p);
    this.syncOrchestratedWake(jobId, stepId);
  }

  pushStepInbox(jobId: string, stepId: string, item: NewItem): void {
    if (!this.jobAcceptsStepWork(jobId)) return;
    pushInbox(this.orchestratedHost(), jobId, stepId, item);
    this.syncOrchestratedWake(jobId, stepId);
  }

  resolveStepGate(jobId: string, stepId: string, approved: boolean, feedback?: string): void {
    if (!this.jobAcceptsStepWork(jobId)) return;
    resolveGate(this.orchestratedHost(), jobId, stepId, approved, feedback);
    this.syncOrchestratedWake(jobId, stepId);
  }

  // The cleanup every terminal transition of an orchestrated step owes, whichever route got
  // there — the user's mark-resolved, the controller's resolve or fail move, a policy strike,
  // a crash. Each route used to do its own subset, so a failed step could still spawn a child.
  //
  // A `queued` dispatch's parked launch survives the status flip unless dropped here too —
  // the governor doesn't read Dispatch.status, so a launch parked under token headroom would
  // still fire later, flip the dispatch back to 'running', and spawn a real session for a step
  // that's already over. Scoped to this step (not the job-wide `cancel()` used by abandon/
  // delete/reset) so a sibling step's own parked launch is untouched.
  //
  // A `running` dispatch is left alone — killing its session would discard real work already
  // in flight; its eventual settleDispatch/submit_step_progress just updates a dispatch record
  // nobody reads anymore, because applyMove refuses to act on an already-terminal step.
  //
  // `reap: 'archive'` is for the ONE terminal that means the work landed — the controller's own
  // resolve move, i.e. the PR merged. Archiving runs `git worktree remove --force` + `branch -D`
  // (see WorktreeManager.tearDown), so anywhere else it destroys uncommitted work and a local
  // branch that was never pushed: on a failure that's the only evidence of WHY (and it 404s the
  // diff view), and on a user's mark-resolved it's worse — the PWA recommends that button for a
  // controller whose session died mid-step, so the escape hatch would eat the implementation.
  // A kept worktree still gets reaped by terminateJobResources when the job is abandoned or
  // deleted, so nothing leaks permanently. The session is closed either way: the transcript
  // lives in the event log, so ending the process costs nothing.
  private settleOrchestratedStep(jobId: string, stepId: string, reap: 'archive' | 'keep'): void {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (step?.type !== 'orchestrated') return;
    this.opts.governor?.cancelStep(jobId, stepId);
    // A soak armed by a `wait` outlives the step otherwise. Firing it would only tick a job
    // whose decide() ignores a terminal step, but there is no reason to hold the timer.
    this.clearWaitTimer(jobId, stepId);
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'orchestrated') return s;
      const next: OrchestratedStep = {
        ...s,
        dispatches: s.dispatches.map((d) => d.status === 'queued'
          ? { ...d, status: 'cancelled', finishedAt: this.ctx.now() }
          : d),
      };
      return next;
    });
    const cleanup = reap === 'archive'
      ? this.archiveStepResources(jobId, stepId)
      : this.closeSessions(step.sessionId ? [step.sessionId] : []);
    void cleanup.catch((e) =>
      console.error(`[work] settle ${stepId.slice(0, 8)}: ${(e as Error).message}`));
  }

  // The controller's own `resolve` move — the ONE terminal that means the work landed, and so
  // the only one that archives the worktree. Reached only through the orchestrated host, never
  // from a route or an MCP tool: those cannot prove they are the controller deciding rather
  // than a bound action reporting its own output (see onStepResolved).
  private resolveStepByController(jobId: string, stepId: string, _output: string): void {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (step?.type !== 'orchestrated' || step.state === 'resolved') return;
    this.settleOrchestratedStep(jobId, stepId, 'archive');
    this.mutateStep(jobId, stepId, (s) => this.appendStepEvent(
      { ...s, state: 'resolved', updatedAt: this.ctx.now() }, 'resolved', 'session',
    ));
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'step_resolved', who: 'session', stepId, body: this.stepLabel(jobId, stepId),
    }));
    void this.tickOne(jobId);
  }

  // User force-closes a live orchestrated step rather than waiting for the controller to
  // converge on its own move.
  markStepResolved(jobId: string, stepId: string): void {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (!step || step.type !== 'orchestrated' || step.state === 'resolved') return;
    // 'keep', not 'archive': this is the user closing out a step the controller never finished
    // — often one whose session died mid-implement — so the worktree still holds uncommitted
    // work on an unpushed branch. Only the controller's own resolve move means it landed.
    this.settleOrchestratedStep(jobId, stepId, 'keep');
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'orchestrated') return s;
      const next: OrchestratedStep = {
        ...s,
        state: 'resolved',
        // A step force-resolved after failing shouldn't still render as failed forever
        // after — stateLabel/stateTone (step-card.js) and vm/tracked.js give `.failure`
        // priority over `state`. Matches rerunLatest's retry path.
        failure: undefined,
        updatedAt: this.ctx.now(),
      };
      return this.appendStepEvent(next, 'resolved', 'user');
    });
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'step_resolved', who: 'user', stepId, body: `${this.stepLabel(jobId, stepId)} — marked resolved by user`,
    }));
    void this.tickOne(jobId);
  }

  // Resumes the controller's own session for its next turn — either a fresh self-round
  // (optionally rebound to another action's skill/permissions) or a plain wake-up with
  // whatever the inbox just delivered. Mirrors dispatchActionResume's stale-Stop bookkeeping:
  // a resume fired while the controller's current turn is still open must not race that
  // turn's own Stop hook into failing this (live) step.
  private async resumeControllerRound(
    jobId: string, stepId: string, action: string | undefined, note: string | undefined,
  ): Promise<void> {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    // A resume presupposes a session: the cold spawn is the handler's own `spawn-session`
    // decision (see orchestratedHandler.decide), never this path.
    if (!j || !s || s.type !== 'orchestrated' || !s.sessionId) return;
    const sessionId = s.sessionId;
    const boundAction = action ?? s.controller;
    const envelope = {
      ...orchestratedHandler.buildEnvelope(s, j, this.ctx),
      boundAction,
      ...(note ? { boundNote: note } : {}),
      // Persisted on the step by drainForDelivery, so a cold resume still shows what woke it.
      ...(s.lastDelivered?.length ? { delivered: s.lastDelivered } : {}),
      actionCatalog: this.buildActionCatalog(),
    };
    const envelopePath = writeEnvelope(this.ctx.jobsDir, jobId, stepId, envelope);
    augmentEnvelopeWithLessons(envelopePath, this.opts.journalStore?.recent(boundAction) ?? []);

    // A trailing Stop from the round we're superseding must not fail this live step.
    // Recorded synchronously — a queued launch may only fire once that Stop frees the slot.
    if (this.opts.sessionManager.isWorking(sessionId)) {
      this.owedStaleStops.set(sessionId, (this.owedStaleStops.get(sessionId) ?? 0) + 1);
    }
    let ws: { path: string | null };
    try {
      ws = await this.opts.worktreeManager.provision(stepId, s.workspace, {
        expectRepo: s.type === 'orchestrated' ? expectRepoOf(s.inputs) : undefined,
      });
    } catch (e) {
      const reason = (e as Error).message ?? String(e);
      console.warn(`[work] worktree provision failed for step ${stepId}: ${reason}`);
      this.onStepFailed(jobId, stepId, `workspace provision failed: ${reason}`, { journal: false });
      return;
    }
    const cwd = ws.path ?? this.orchestratorCwd();
    this.submitLaunch({
      key: `${jobId}#${stepId}`, jobId, stepId, sessionId, action: boundAction, label: boundAction,
      run: () => {
        const cur = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
        // `cancelled` alone is not enough: it's the plan-editor flag, never set by a settle. The
        // step can go terminal while this resume is suspended in provision() above (seconds of
        // real git work) or parked in the governor — a mark-resolved landing there would
        // otherwise spawn a fresh turn on a session the settle just closed. Mirrors the
        // status re-read in spawnDispatchSession's run().
        if (!cur || cur.type !== 'orchestrated' || cur.cancelled) return false;
        if (cur.failure || cur.state === 'resolved' || cur.state === 'failed') return false;
        // The job can be abandoned/deleted between the resume and the fire, too.
        if (!this.jobAcceptsStepWork(jobId)) return false;
        this.roleBySession.set(sessionId, { role: 'step', jobId, stepId });
        this.bindAction(sessionId, boundAction);
        this.opts.sessionManager.sendOrResume(
          sessionId,
          cwd,
          { type: 'user', message: { role: 'user', content: `/${boundAction}` } },
          { OUTPOST_ENVELOPE: envelopePath, JOB_ID: jobId, STEP_ID: stepId, STEP_TYPE: 'orchestrated' },
        );
        return true;
      },
    });
  }

  // Fans a dispatch out to a fresh child session. Modeled on spawnEditFixSession, with two
  // differences: the worktree key is `dispatch.id` alone, not the parent step's own key — it
  // comes from `ctx.newId()`, so it's globally unique (not just unique within the step), which
  // is all the worktree store needs to keep a child from colliding with the controller's
  // worktree; a `${stepId}-${dispatch.id}` compound key was tried first but is two 36-char
  // UUIDs joined, which blows SESSION_ID_RE's 64-char cap and made provision() throw for any
  // dispatch with a real (non-`none`) workspace. The parent linkage the compound key was
  // carrying visually is already recorded structurally on the Dispatch record and in
  // roleBySession. The envelope is written at its own path —
  // jobs/<jobId>/steps/<dispatch.id>/envelope.json, never the controller's stable envelope —
  // so a child can't clobber it. The dispatch's own id doubles as its `stepId` for
  // envelope/submit purposes: submit_step_output/failed from this session lands on
  // onStepResolved/onStepFailed with that id, which routes to settleDispatch instead of
  // resolving/failing the parent (see findDispatchStepId). An inherited workspace is
  // downgraded to a detached checkout of the same branch — see readonlyView; a dispatch that
  // asks for a writable one of its own is refused upstream in validateNext.
  private async spawnDispatchSession(jobId: string, stepId: string, dispatch: Dispatch): Promise<void> {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!j || !s || s.type !== 'orchestrated') return;

    const workspace = dispatch.workspace ?? readonlyView(s.workspace);
    let ws: { path: string | null };
    try {
      ws = await this.opts.worktreeManager.provision(dispatch.id, workspace, {
        expectRepo: expectRepoOf(s.inputs),
      });
    } catch (e) {
      // Fail the dispatch, not the parent step — a bad repoCwd or git error on one fan-out
      // child is the controller's to interpret via the next inbox delivery, same as any other
      // dispatch failure (see settleDispatch).
      const reason = (e as Error).message ?? String(e);
      console.warn(`[work] worktree provision failed for dispatch ${dispatch.id}: ${reason}`);
      this.settleDispatch(jobId, stepId, dispatch.id, 'failed', { failure: `workspace provision failed: ${reason}` });
      return;
    }
    const cwd = ws.path ?? this.orchestratorCwd();

    const envelope = {
      kind: 'step',
      jobId,
      stepId: dispatch.id,
      parentStepId: stepId,
      type: 'action',
      title: `${dispatch.action} (dispatch)`,
      description: dispatch.brief,
      action: dispatch.action,
      goal: dispatch.brief,
      ...(dispatch.inputs ? { inputs: dispatch.inputs } : {}),
      job: { source: j.source, title: j.title, description: j.description, externalRef: j.externalRef },
      previousSteps: [],
      workspace,
      typePayload: {},
    };
    const envelopePath = writeEnvelope(this.ctx.jobsDir, jobId, dispatch.id, envelope);
    augmentEnvelopeWithLessons(envelopePath, this.opts.journalStore?.recent(dispatch.action) ?? []);

    const sessionId = this.ctx.newId();
    this.submitLaunch({
      key: `${jobId}#${stepId}#${dispatch.id}`, jobId, stepId, sessionId, action: dispatch.action, label: dispatch.action,
      run: () => {
        const cur = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
        if (!cur || cur.type !== 'orchestrated' || cur.cancelled) return false;
        // The real backstop: re-read the dispatch's own status at fire time, not just the
        // step's. `settleOrchestratedStep`'s governor.cancelStep() is what's supposed to keep
        // this launch from ever firing after it flips a queued dispatch to 'cancelled' — this
        // is the belt to that braces, in case a launch was parked under a key that cancellation
        // missed (or predates it).
        const target = cur.dispatches.find((d) => d.id === dispatch.id);
        if (!target || target.status !== 'queued') return false;
        this.roleBySession.set(sessionId, { role: 'dispatch', jobId, stepId, dispatchId: dispatch.id });
        this.bindAction(sessionId, dispatch.action);
        this.stampActionSession(sessionId, dispatch.action, dispatch.action);
        this.mutateStep(jobId, stepId, (st) => {
          if (st.type !== 'orchestrated') return st;
          return {
            ...st,
            dispatches: st.dispatches.map((d) => d.id === dispatch.id
              ? { ...d, status: 'running', sessionId, startedAt: this.ctx.now() }
              : d),
          };
        });
        this.opts.sessionManager.spawnDetached(sessionId, cwd, {
          OUTPOST_ENVELOPE: envelopePath, JOB_ID: jobId, STEP_ID: dispatch.id, STEP_TYPE: 'action',
        }, 'default');
        this.opts.sessionManager.send(sessionId, {
          type: 'user',
          message: { role: 'user', content: `/${dispatch.action}` },
        });
        return true;
      },
    });
  }

  onStepRetry(jobId: string, stepId: string): void {
    // Retrying re-provisions the same ref, so a step whose workspace can't provision would
    // burn a retry and fail instantly again, forever. Refuse (400 at the route) and say what
    // to fix — editing the step's workspace is the repair, and it re-runs on its own.
    const cur = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    const wsErr = cur ? workspaceError(cur.workspace) : null;
    if (wsErr) throw new Error(`${wsErr}. Edit the step's workspace to repair it — that re-runs it.`);
    this.mutateStep(jobId, stepId, (s) => {
      const h = handlerFor(s);
      return {
        ...s, failure: undefined, sessionId: undefined, state: h.initialState,
        reviewed: undefined, updatedAt: this.ctx.now(),
      } as Step;
    });
    // If the job settled to a terminal state (done/failed) before the retry, restore
    // it to executing — otherwise decide() early-returns and the retried step never
    // gets a fresh session spawned. A step-review gate is dropped for the same reason:
    // the review is now moot (its step is re-running), and leaving it set would gate
    // the re-dispatch on a session that will never answer for this attempt. Also unset
    // the linearStateMarked.done flag so the Linear write can fire again if the retry
    // produces a new done transition.
    this.mutate(jobId, (j) => this.appendEvent({
      ...j,
      state: j.state === 'done' || j.state === 'failed' ? 'executing' : j.state,
      reviewingStepId: undefined,
      linearStateMarked: { ...j.linearStateMarked, done: false },
    }, {
      kind: 'step_retried', who: 'user', stepId, body: this.stepLabel(jobId, stepId),
    }));
    void this.tickOne(jobId);
  }

  // Re-runs the step that halted the job — the failed one — falling back to the
  // last non-cancelled step when nothing has failed (e.g. re-running a done job's
  // final step). A failed step is rarely the last in a multi-step plan, so picking
  // the tail would clear a non-failure and leave the actual halt in place.
  rerunLatest(jobId: string): string | undefined {
    const j = this.opts.queue.get(jobId);
    if (!j) return undefined;
    const target = j.steps.find((s) => !s.cancelled && s.failure)
      ?? [...j.steps].reverse().find((s) => !s.cancelled);
    if (!target) return undefined;
    this.onStepRetry(jobId, target.id);
    return target.id;
  }

  // Wipes the plan back to `planning`. Archives every session + worktree the job
  // owns first — otherwise the wiped steps orphan their worktrees on disk forever.
  async resetJob(jobId: string): Promise<boolean> {
    const j = this.opts.queue.get(jobId);
    if (!j) return false;
    await this.terminateJobResources(j);
    this.mutate(jobId, (jj) => this.appendEvent({
      ...jj,
      state: 'planning',
      steps: [],
      orchestratorSessionId: undefined,
      orchestratorAction: undefined,
      plan: undefined,
      pendingReconciliation: undefined,
      reviewingStepId: undefined,
      linearStateMarked: {},
      failure: undefined,
    }, { kind: 'state_changed', who: 'user', body: 'job reset' }));
    return true;
  }

  addStepManually(jobId: string, proposed: ProposedStep, opts?: { afterStepId?: string }): Step | undefined {
    const j = this.opts.queue.get(jobId);
    if (!j) return undefined;
    const step = this.materialize(proposed);
    this.mutate(jobId, (jj) => {
      const steps = [...jj.steps];
      if (opts?.afterStepId) {
        const i = steps.findIndex((s) => s.id === opts.afterStepId);
        if (i >= 0) steps.splice(i + 1, 0, step);
        else steps.push(step);
      } else {
        steps.push(step);
      }
      return this.appendEvent({ ...jj, steps }, { kind: 'plan_reconciled', who: 'user', body: 'step added manually', stepId: step.id });
    });
    void this.tickOne(jobId);
    return step;
  }

  // Cancels a step that hasn't started or has failed; refuses one that is mid-turn or resolved.
  // Cancelling does NOT reap the worktree: a failed step's checkout is the evidence of why it
  // failed (see settleOrchestratedStep's `keep`), and terminateJobResources still sweeps every
  // step — cancelled included — when the job ends, so nothing leaks.
  cancelStepManually(jobId: string, stepId: string): boolean {
    const j = this.opts.queue.get(jobId);
    if (!j) return false;
    const step = j.steps.find((s) => s.id === stepId);
    if (!step) return false;
    if (step.state === 'resolved') return false;
    if (step.cancelled) return true;
    if (!stepAcceptsEdits(step)) return false;
    this.mutate(jobId, (jj) => this.appendEvent(
      { ...jj, steps: jj.steps.map((s) => s.id === stepId ? { ...s, cancelled: true } : s) },
      { kind: 'plan_reconciled', who: 'user', body: 'step cancelled manually', stepId },
    ));
    void this.tickOne(jobId);
    return true;
  }

  // Reorders the plan; started/terminal steps must keep their original index.
  reorderSteps(jobId: string, ids: string[]): boolean {
    const j = this.opts.queue.get(jobId);
    if (!j) return false;
    if (!Array.isArray(ids) || ids.length !== j.steps.length) return false;
    const set = new Set(ids);
    if (set.size !== ids.length) return false;
    for (const s of j.steps) if (!set.has(s.id)) return false;
    const byId = new Map(j.steps.map((s) => [s.id, s] as const));
    const newOrder = ids.map((id) => byId.get(id)!);
    for (let i = 0; i < newOrder.length; i++) {
      const s = newOrder[i]!;
      const locked = s.sessionId || s.state === 'resolved';
      if (locked && j.steps[i]?.id !== s.id) return false;
    }
    this.mutate(jobId, (jj) => this.appendEvent(
      { ...jj, steps: newOrder },
      { kind: 'plan_reconciled', who: 'user', body: 'plan reordered manually' },
    ));
    void this.tickOne(jobId);
    return true;
  }

  // Patches an existing step's editable fields; refuses a mid-turn session and a
  // terminal/cancelled step — same editability rule cancelStepManually and the PWA's
  // stepIsEditable() enforce. Only fields applicable to the step's own type are applied.
  editStepManually(jobId: string, stepId: string, patch: StepEditPatch): boolean {
    const j = this.opts.queue.get(jobId);
    if (!j) return false;
    const step = j.steps.find((s) => s.id === stepId);
    if (!step) return false;
    if (step.state === 'resolved') return false;
    if (step.cancelled) return false;
    if (!stepAcceptsEdits(step)) return false;

    // Whether a worktree exists for this step is the one fact the workspace rules turn on, and
    // it is exactly what provision() itself keys on: given a stepId it already holds a live
    // record for, it returns THAT worktree and ignores the ref it was passed
    // (WorktreeManager.provision). A step that never provisioned — `kind: 'none'`, or one whose
    // ref wouldn't resolve, both of which return/throw before the record is written — has none.
    const wt = this.opts.worktreeManager.get(stepId);
    const provisioned = !!wt && !wt.archivedAt;

    const fields: Partial<Step> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.description !== undefined) fields.description = patch.description;
    // Before anything provisions, repointing the workspace is the only way to repair a step
    // whose planner-authored ref was wrong — dropping and re-adding loses its position and
    // history. Once a worktree exists the ref is pinned instead of repointed, because neither
    // alternative is safe: leaving it means the re-run silently reuses the OLD tree (provision
    // returns the existing path), and tearing it down to re-provision means
    // `git worktree remove --force` + `branch -D` over the uncommitted work and the only
    // evidence of why the step failed — precisely what settleOrchestratedStep's `keep` exists
    // to protect. Cancel + insert a corrected step is the coherent recovery, and the message
    // says so. An unchanged workspace is not a repoint: the plan editor re-sends every field
    // it renders, so refusing on presence alone would re-lock the step it just unlocked.
    if (patch.workspace !== undefined) {
      const err = workspaceError(patch.workspace);
      if (err) throw new Error(err);
      if (provisioned && !sameWorkspace(step.workspace, patch.workspace)) {
        throw new Error(
          `this step already provisioned a worktree at ${wt!.worktreePath} and would keep it — `
          + 'a re-run reuses that checkout, not the new ref. Cancel this step and insert a '
          + 'corrected one instead.',
        );
      }
      fields.workspace = patch.workspace as Step['workspace'];
    }
    // `inputs.prUrl` and `workspace.ref` describe the same PR. With the workspace pinned above,
    // letting prUrl move on its own would leave a controller reporting on PR N while every lens
    // it fans out reads the tree of PR M — an incoherence with no error anywhere. Only a
    // genuine conflict is refused: a workspace that names no PR may legitimately be the branch
    // the PR was opened from.
    if (patch.inputs !== undefined && provisioned) {
      const pinned = workspacePrNumber(step.workspace);
      const next = typeof patch.inputs.prUrl === 'string' ? parsePrUrl(patch.inputs.prUrl)?.number : undefined;
      if (pinned && next && pinned !== next) {
        throw new Error(
          `this step's worktree is checked out at refs/pull/${pinned}/head, which is pinned once `
          + `provisioned — pointing prUrl at PR #${next} would review the wrong tree. Cancel this `
          + 'step and insert a corrected one instead.',
        );
      }
    }
    if (step.type === 'action') {
      if (patch.action !== undefined) {
        if (this.opts.actionRegistry && !this.opts.actionRegistry.getAction(patch.action)) {
          throw new Error(`unknown action ${JSON.stringify(patch.action)} — not in registry`);
        }
        (fields as Partial<ActionStep>).action = patch.action;
      }
      if (patch.goal !== undefined) (fields as Partial<ActionStep>).goal = patch.goal;
      if (patch.inputs !== undefined) (fields as Partial<ActionStep>).inputs = patch.inputs;
    } else {
      if (patch.goal !== undefined) (fields as Partial<OrchestratedStep>).goal = patch.goal;
      if (patch.inputs !== undefined) (fields as Partial<OrchestratedStep>).inputs = patch.inputs;
    }

    this.mutate(jobId, (jj) => this.appendEvent(
      { ...jj, steps: jj.steps.map((s) => s.id === stepId ? { ...s, ...fields, updatedAt: this.ctx.now() } as Step : s) },
      { kind: 'plan_reconciled', who: 'user', body: 'step edited manually', stepId },
    ));
    // A failure keeps decide() returning null, so an edit that isn't followed by a retry looks
    // like it did nothing — and re-running with the corrected fields is the only reason to edit
    // a failed step. Skipped when the resulting workspace still wouldn't provision: onStepRetry
    // throws on that, which would surface as a 400 for an edit that already landed.
    const nextWorkspace = (fields.workspace ?? step.workspace) as WorkspaceRef | undefined;
    if (step.failure && !workspaceError(nextWorkspace)) this.onStepRetry(jobId, stepId);
    else void this.tickOne(jobId);
    return true;
  }

  markStatusCommentClean(jobId: string): void {
    this.mutate(jobId, (j) => ({ ...j, linearStatusDirty: false }));
  }

  setOrchestratorSessionId(jobId: string, sessionId: string): void {
    this.mutate(jobId, (j) => j.orchestratorSessionId === sessionId ? j : { ...j, orchestratorSessionId: sessionId });
  }

  // The watcher's only write. Facts about the PR — never control state: what they mean is
  // the step's controller's call, and it learns of them from the matching inbox event, not
  // from this. `iterations` is not a fact; it is the watcher pruning a replies round that a
  // restart stranded in_progress, which only the observer of the new comments can know is dead.
  applyPrFacts(jobId: string, stepId: string, facts: Partial<PrFacts>, iterations?: IterationRecord[]): void {
    this.mutateStep(jobId, stepId, (s) => s.type === 'orchestrated'
      ? {
        ...s,
        pr: { ...(s.pr ?? {}), ...facts },
        ...(iterations ? { iterations } : {}),
        updatedAt: this.ctx.now(),
      }
      : s);
    this.mutate(jobId, (j) => ({ ...j, linearStatusDirty: true }));
  }

  // ─────────────────────────────────────────────────────────
  // Session spawn helpers
  // ─────────────────────────────────────────────────────────

  private stepLabel(jobId: string, stepId: string): string {
    const j = this.opts.queue.get(jobId);
    const idx = j ? j.steps.findIndex((s) => s.id === stepId) : -1;
    const step = idx >= 0 ? j!.steps[idx]! : undefined;
    const n = idx >= 0 ? String(idx + 1).padStart(2, '0') : '?';
    return step ? `step ${n} — ${step.title}` : `step ${n}`;
  }

  // After a group settles, re-run the orchestrator so it decides continue-vs-revise
  // given the just-completed step's output. Fresh spawn (no resume) — it reads
  // currentSteps[].output cold, which is enough to decide.
  private spawnStepReviewSession(jobId: string, completedStepId: string): void {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    const actionName = j.orchestratorAction ?? 'meta.orchestrate';
    const env: OrchestratorEnvelope = {
      kind: 'orchestrator',
      mode: 'step-review',
      jobId,
      job: { source: j.source, title: j.title, description: j.description, externalRef: j.externalRef },
      stepTypeCatalog: STEP_TYPE_CATALOG,
      actionCatalog: this.buildActionCatalog(),
      currentSteps: j.steps,
      completedStepId,
      rejectedIterations: j.plan?.iterationsRejected,
      recentLessons: this.opts.journalStore?.recent(actionName) ?? [],
    };
    const envelopePath = writeEnvelope(this.ctx.jobsDir, jobId, null, env);
    this.mutate(jobId, (jj) => this.appendEvent(
      { ...jj, reviewingStepId: completedStepId },
      { kind: 'orchestrator_reviewed', who: 'orchestrator', body: `step-review after ${this.stepLabel(jobId, completedStepId)}` },
    ));
    void this.spawnOrchestratorSession(jobId, 'step-review', envelopePath, actionName);
  }

  // The orchestrator reviewed the settled group and decided the plan still holds.
  // Mark every currently-settled step reviewed (so owesStepReview won't re-fire on
  // them), return to executing, and tick — which advances to the next group or
  // marks the job done when nothing remains.
  onOrchestratorContinue(jobId: string, reason?: string): void {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    this.mutate(jobId, (jj) => this.appendEvent({
      ...jj,
      state: 'executing',
      reviewingStepId: undefined,
      steps: jj.steps.map((s) =>
        !s.cancelled && handlerFor(s).isResolved(s) ? ({ ...s, reviewed: true } as Step) : s),
    }, { kind: 'orchestrator_reviewed', who: 'orchestrator', body: reason ? `continue: ${reason}` : 'continue' }));
    void this.tickOne(jobId);
  }

  private async spawnInitialOrchestrator(j: JobRecord, actionName: string, context?: string, opts?: { userInitiated?: boolean }): Promise<void> {
    const launchContext = context?.trim() || undefined;
    const env: OrchestratorEnvelope = {
      kind: 'orchestrator',
      mode: 'initial',
      jobId: j.id,
      job: { source: j.source, title: j.title, description: j.description, externalRef: j.externalRef },
      stepTypeCatalog: STEP_TYPE_CATALOG,
      actionCatalog: this.buildActionCatalog(),
      ...(launchContext ? { launchContext } : {}),
      recentLessons: this.opts.journalStore?.recent(actionName) ?? [],
    };
    const path = writeEnvelope(this.ctx.jobsDir, j.id, null, env);
    await this.spawnOrchestratorSession(j.id, 'initial', path, actionName, opts);
  }

  private buildActionCatalog(): ActionCatalogEntry[] | undefined {
    return buildActionCatalog(this.opts.actionRegistry);
  }

  // Cwd for orchestrator sessions: the daemon's cwd (Outpost repo) is fine — the
  // orchestrator is read-only and shells into target repos as needed via paths from the envelope.
  private orchestratorCwd(): string { return process.cwd(); }

  private async spawnOrchestratorSession(jobId: string, mode: 'initial' | 'replan' | 'step-review', envelopePath: string, actionName: string, opts?: { userInitiated?: boolean }): Promise<void> {
    const sessionId = this.ctx.newId();
    const cwd = this.orchestratorCwd();
    this.submitLaunch({
      key: `${jobId}#orchestrator`,
      jobId,
      sessionId,
      action: 'meta.orchestrate',
      label: mode,
      ...(opts?.userInitiated ? { userInitiated: true } : {}),
      run: () => {
        const cur = this.opts.queue.get(jobId);
        if (!cur || cur.state === 'abandoned' || cur.state === 'done' || cur.state === 'failed') return false;
        this.opts.sessionManager.spawnDetached(sessionId, cwd, { OUTPOST_ENVELOPE: envelopePath, JOB_ID: jobId }, 'default');
        this.roleBySession.set(sessionId, { role: 'orchestrator', jobId });
        this.bindAction(sessionId, actionName);
        this.stampActionSession(sessionId, actionName, cur.title || 'Job');
        this.mutate(jobId, (j) => this.appendEvent(
          {
            ...j,
            orchestratorSessionId: sessionId,
            orchestratorAction: actionName,
            // A step-review runs on top of an executing plan; only a plan/replan run parks
            // the job in `planning` (its gate is reviewingStepId, set by the caller).
            state: mode === 'step-review' ? j.state : 'planning',
          },
          { kind: 'orchestrator_started', who: 'orchestrator', body: mode === 'replan' ? 'replan' : mode === 'step-review' ? 'step-review' : 'initial' },
        ));
        // spawnDetached only launches the proc — without a user turn, the orchestrator skill
        // never activates and the envelope sits unread. Kick it.
        this.opts.sessionManager.send(sessionId, {
          type: 'user',
          message: { role: 'user', content: `/${actionName} ${jobId}` },
        });
        return true;
      },
    });
  }

  private async spawnStepSession(jobId: string, stepId: string, envelopePath: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    if (!j) return;
    const s = j.steps.find((x) => x.id === stepId);
    if (!s) return;
    let ws: { path: string | null };
    // Pre-flight with the same validator the plan boundary uses: WorktreeManager's own
    // guard would catch this too, but its message is written for the daemon log, not for
    // the user staring at a failed step. This one names the repair.
    const wsErr = workspaceError(s.workspace);
    if (wsErr) {
      console.warn(`[work] unusable workspace on step ${stepId}: ${wsErr}`);
      this.onStepFailed(jobId, stepId, `workspace provision failed: ${wsErr}`, { journal: false });
      return;
    }
    try {
      ws = await this.opts.worktreeManager.provision(stepId, s.workspace, {
        expectRepo: s.type === 'orchestrated' ? expectRepoOf(s.inputs) : undefined,
      });
    } catch (e) {
      const reason = (e as Error).message ?? String(e);
      console.warn(`[work] worktree provision failed for step ${stepId}: ${reason}`);
      this.onStepFailed(jobId, stepId, `workspace provision failed: ${reason}`, { journal: false });
      return;
    }
    const cwd = ws.path ?? this.orchestratorCwd();
    const actionName = actionNameForStep(s);
    // The step handler wrote the envelope; splice in recent lessons for the action
    // about to run. Lessons are bounded (last 10) and authored by the action itself
    // in past sessions — see /work/journal.
    const lessons = this.opts.journalStore?.recent(actionName) ?? [];
    augmentEnvelopeWithLessons(envelopePath, lessons);
    const sessionId = this.ctx.newId();
    this.submitLaunch({
      key: `${jobId}#${stepId}`, jobId, stepId, sessionId, action: actionName, label: actionName,
      run: () => {
        // Re-validate: the step may have been cancelled/retried/started while parked.
        const cur = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
        if (!cur || cur.cancelled || cur.failure || cur.sessionId) return false;
        // Action-bound step sessions always run in `default` permission mode so the
        // PreToolUse hook fires on every call — the hook denies-on-miss for action
        // sessions (no interactive approver attached). Without this, the user's global
        // `acceptEdits` would silently let edits through.
        this.opts.sessionManager.spawnDetached(sessionId, cwd, {
          OUTPOST_ENVELOPE: envelopePath,
          JOB_ID: jobId,
          STEP_ID: stepId,
          STEP_TYPE: s.type,
        }, 'default');
        this.roleBySession.set(sessionId, { role: 'step', jobId, stepId });
        this.bindAction(sessionId, actionName);
        this.stampActionSession(sessionId, actionName, s.title || 'Step');
        this.mutateStep(jobId, stepId, (st) => this.appendStepEvent({ ...st, sessionId } as Step, 'spawned', 'orchestrator'));
        this.mutate(jobId, (j) => this.appendEvent(j, {
          kind: 'step_started', who: 'orchestrator', stepId, body: this.stepLabel(jobId, stepId),
        }));
        this.opts.sessionManager.send(sessionId, {
          type: 'user',
          message: { role: 'user', content: `/${actionName}` },
        });
        return true;
      },
    });
  }

  // ─────────────────────────────────────────────────────────
  // Mutation primitives
  // ─────────────────────────────────────────────────────────

  private mutate(jobId: string, fn: (j: JobRecord) => JobRecord): JobRecord | undefined {
    return this.opts.queue.mutate(jobId, fn);
  }

  private mutateStep(jobId: string, stepId: string, fn: (s: Step) => Step): void {
    this.opts.queue.mutate(jobId, (j) => {
      const steps = j.steps.map((s) => s.id === stepId ? fn(s) : s);
      return { ...j, steps };
    });
  }

  private appendStepEvent(s: Step, kind: StepEventKind, who: StepEvent['who']): Step {
    const events = [...(s.events ?? []), { id: this.ctx.newId(), at: this.ctx.now(), kind, who }];
    while (events.length > MAX_STEP_EVENTS) events.shift();
    return { ...s, events };
  }

  private appendEvent(j: JobRecord, evt: { kind: JobEventKind; who: JobEvent['who']; stepId?: string; body?: string }): JobRecord {
    const event: JobEvent = { id: this.ctx.newId(), at: this.ctx.now(), ...evt };
    appendJobEvent(this.ctx.jobsDir, j.id, event);
    const events = [...(j.events ?? []), event];
    while (events.length > MAX_EVENTS_PER_JOB) events.shift();
    return { ...j, events };
  }

  private materialize(p: ProposedStep): Step {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    const wsErr = workspaceError(p.workspace);
    if (wsErr) throw new Error(wsErr);
    switch (p.type) {
      case 'action': {
        if (this.opts.actionRegistry && !this.opts.actionRegistry.getAction(p.action)) {
          throw new Error(`unknown action ${JSON.stringify(p.action)} — not in registry`);
        }
        const ws = p.workspace ?? { kind: 'none' as const };
        const { keepId: _, ...rest } = p;
        return { ...rest, id, workspace: ws, state: initialStateForType('action'), createdAt: now, updatedAt: now } as Step;
      }
      case 'orchestrated': {
        // Same boundary check the action branch gets: a typo'd controller materializes fine,
        // then binds a session to a name with no allowlist and sends a slash command that
        // activates no skill — the step burns a session and dies on the grace timer.
        if (this.opts.actionRegistry && !this.opts.actionRegistry.getAction(p.controller)) {
          throw new Error(`unknown controller ${JSON.stringify(p.controller)} — not in registry`);
        }
        const { keepId: _, ...rest } = p;
        return {
          ...rest, id, workspace: p.workspace ?? { kind: 'none' as const },
          state: initialStateForType('orchestrated'),
          dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
          createdAt: now, updatedAt: now,
        } as OrchestratedStep;
      }
    }
  }
}

// Human-friendly soak duration for the wait event body ("1h", "90m", "45s").
function formatWait(sec: number): string {
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 3600) return `${Math.round((sec / 3600) * 10) / 10}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  if (sec >= 60) return `${Math.round((sec / 60) * 10) / 10}m`;
  return `${sec}s`;
}

function stepToProposed(s: Step): ProposedStep {
  // Strip runtime fields, retain identity via keepId.
  const base = {
    type: s.type,
    title: s.title,
    description: s.description,
    parallelGroup: s.parallelGroup,
    workspace: s.workspace,
    keepId: s.id,
  } as Record<string, unknown>;
  switch (s.type) {
    case 'action':
      base.action = s.action;
      base.goal = s.goal;
      if (s.inputs !== undefined) base.inputs = s.inputs;
      if (s.forwardOutput !== undefined) base.forwardOutput = s.forwardOutput;
      break;
    case 'orchestrated':
      base.controller = s.controller;
      base.goal = s.goal;
      if (s.inputs !== undefined) base.inputs = s.inputs;
      break;
  }
  return base as unknown as ProposedStep;
}

// Re-exports for consumers (hook server, PWA server) that want the type shapes.
export type { Step, JobRecord, ProposedStep, PrComment } from './work-types.js';
