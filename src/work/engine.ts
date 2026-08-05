import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { JobQueue } from './work-queue.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorktreeManager, WorktreeRecord } from '../git/worktree-manager.js';
import { gitSquashMergeToBase } from '../git/git-ops.js';
import type { LinearWriter } from '../integrations/linear-writer.js';
import type {
  ActionStep,
  Dispatch,
  DraftedReply,
  EditJob,
  Finding,
  IterationRecord,
  JobEvent,
  JobEventKind,
  JobRecord,
  OpenPrStep,
  OrchestratedStep,
  PlanIteration,
  PrComment,
  PrFacts,
  ProposedStep,
  ReviewComment,
  Step,
  StepEvent,
  StepEventKind,
  WorkspaceRef,
} from './work-types.js';
import { augmentEnvelopeWithLessons, writeEnvelope, STEP_TYPE_CATALOG, type OrchestratorEnvelope, type ActionCatalogEntry } from './envelope.js';
import { workspaceError } from './workspace.js';
import type { ActionRegistry } from '../actions/index.js';
import { handlerFor, initialStateForType } from '../steps/index.js';
import { orchestratedHandler } from '../steps/orchestrated.js';
import type { Action, ExternalEvent, HandlerCtx } from '../steps/types.js';
import {
  applyMove, deliverInbox, pushInbox, resolveGate,
  type NewItem, type OrchestratedHost, type ProgressPayload,
} from './orchestrated-runner.js';
import { reconcile, validateDispositions } from './reconcile.js';
import { decideJobTransitions, owesStepReview } from '../jobs/lifecycle.js';
import { shouldAutoFixCi, ciFailureSignature } from '../steps/open-pr.js';
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

// Fields the plan editor may PATCH onto an existing step. `approach`/`risks` only
// apply to open-pr steps; `action`/`inputs` only apply to action steps — editStepManually
// picks the applicable subset by the step's own `type`.
export interface StepEditPatch {
  title?: string;
  description?: string;
  goal?: string;
  approach?: string;
  risks?: string;
  inputs?: Record<string, unknown>;
  action?: string;
  workspace?: WorkspaceRef;
}

// Rounds that continue an already-open PR (CI red, merge conflict, review comment/edit).
// These launch immediately — they resume an in-flight unit of work rather than starting a
// new one, so the token-headroom + concurrency gate that throttles fresh launches doesn't
// apply. (spawnStepSession's plan/implement/spec resumes are NOT here: they route as `queued`
// and self-unblock when the prior turn's Stop frees the slot — see releaseLaunchSlot.)
const REACTIVE_ACTIONS = new Set([
  'code.fix-ci', 'code.resolve-conflicts', 'code.fix-pr-comment', 'code.triage-pr-comments',
]);
export function isReactiveAction(action: string): boolean {
  return REACTIVE_ACTIONS.has(action);
}

export function actionNameForStep(s: Step): string {
  if (s.type === 'open-pr') {
    // Push-capable binding must survive the transient `conflictResolving` flag:
    // a failed merge clears it and drops the step to `conflict_unresolved`, and a
    // daemon bounce clears it mid-round while state is still `conflicting`. Binding
    // on the durable state (not just the flag) keeps a reopened session able to
    // finish/push the merge instead of reverting to push-forbidden code.implement.
    if (s.conflictResolving || s.state === 'conflicting' || s.state === 'conflict_unresolved') return 'code.resolve-conflicts';
    if (s.ciFixing) return 'code.fix-ci';
    if (s.state === 'comment_pending_response' || s.state === 'reply_pending_review') {
      return 'code.triage-pr-comments';
    }
    if (s.state === 'speccing') return 'code.spec';
    if (s.state === 'planning') return 'code.plan';
    return 'code.implement';
  }
  if (s.type === 'orchestrated') return s.controller;
  return s.action;
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
    // code.implement and the triage/conflict rounds legitimately end their turn
    // without a submit_* call (they resolve via PR merge / gate approval). The spec
    // and plan rounds MUST submit — if their turn ends without submit_spec /
    // submit_impl_plan, fail the step rather than hang the job.
    if (step.type === 'open-pr' && step.state !== 'speccing' && step.state !== 'planning') return undefined;
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

  // Called once at daemon startup. Any editQueue entry left in a running state
  // is orphaned — its session died with the previous process. Mark it failed so
  // the queue unblocks and the thread's edit composer re-opens.
  reconcileInterruptedEdits(): void {
    for (const j of this.opts.queue.list()) {
      for (const s of j.steps) {
        if (s.type !== 'open-pr') continue;
        if (s.conflictResolving) {
          // A re-surfaced conflict gate resolves via the PR flow, so the owed
          // squash must not silently re-fire once the daemon restarts.
          this.mutateOpenPrStep(j.id, s.id, (st) => ({ ...st, conflictResolving: false, conflictPostAction: undefined, updatedAt: this.ctx.now() }));
        }
        if (s.ciFixing) {
          this.mutateOpenPrStep(j.id, s.id, (st) => ({ ...st, ciFixing: false, updatedAt: this.ctx.now() }));
        }
        for (const e of s.editQueue ?? []) {
          if (e.status !== 'running') continue;
          this.markEditDone(j.id, s.id, e.id, { status: 'failed', failure: 'interrupted by daemon restart' });
        }
        // A triage round left in_progress (never posted) is orphaned — its session died
        // with the previous process. dropOrphanIterations clears it so the `busy` guard
        // in the open-pr handler's decide() stops blocking a fresh triage round; without
        // this the thread hangs on "Claude is deciding…" forever with no way to retry.
        if ((s.iterations ?? []).some((it) => it.kind === 'replies' && it.status === 'in_progress' && !it.postedAt)) {
          this.dropOrphanIterations(j.id, s.id, 'replies');
        }
      }
    }
  }

  // Called once at daemon startup, alongside reconcileInterruptedEdits. A step still
  // in its in-flight state with a sessionId set is orphaned — the previous daemon died
  // with its child session mid-turn (a routine `kickstart -k` bounce kills every spawned
  // Claude process). Without this, decide() keeps returning null for such a step
  // (state is in-flight, but sessionId is already set) and the job hangs forever.
  // Recovery differs by step type:
  //   - action steps are read-only and single-turn: clear the sessionId so decide()
  //     re-spawns a fresh session on the next tick, reusing the stepId-keyed worktree.
  //     The bounce becomes non-destructive to the investigation.
  //   - open-pr `implementing` steps have partial uncommitted edits in the worktree that
  //     can't be cleanly resumed, so mark them failed (mirroring reconcileInterruptedEdits)
  //     and let the user retry / inspect the diff.
  reconcileInterruptedSteps(): void {
    for (const j of this.opts.queue.list()) {
      for (const s of j.steps) {
        if (s.cancelled || s.failure || !s.sessionId) continue;
        if (s.type === 'action' && s.state === 'running') {
          const label = this.stepLabel(j.id, s.id);
          this.mutateStep(j.id, s.id, (st) => ({ ...st, sessionId: undefined, updatedAt: this.ctx.now() }));
          this.mutate(j.id, (jj) => this.appendEvent(jj, {
            kind: 'step_retried', who: 'system', stepId: s.id,
            body: `${label} — session interrupted by daemon restart; re-running`,
          }));
        } else if (s.type === 'open-pr' && s.state === 'implementing') {
          this.onStepFailed(j.id, s.id, 'implement session interrupted by daemon restart', { journal: false });
        } else if (s.type === 'open-pr' && (s.state === 'speccing' || s.state === 'planning') && s.sessionId) {
          // Spec/plan rounds have no uncommitted edits — the shared session was reaped
          // by the bounce; re-dispatch to resume the round rather than hang (decide()
          // returns null for planning, and speccing's cold-spawn guard sees the stale
          // sessionId, so neither self-heals without this).
          const label = this.stepLabel(j.id, s.id);
          this.mutate(j.id, (jj) => this.appendEvent(jj, {
            kind: 'step_retried', who: 'system', stepId: s.id,
            body: `${label} — session interrupted by daemon restart; resuming round`,
          }));
          void this.dispatchRound(j.id, s.id);
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
        if (!s.sessionId) continue;
        this.roleBySession.set(s.sessionId, { role: 'step', jobId: j.id, stepId: s.id });
        this.bindAction(s.sessionId, actionNameForStep(s));
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

    // Edit-job dispatch: any open-pr step with a queued edit and no other running edit
    // gets its head edit pumped through code.fix-pr-comment. Skipped for a settled job —
    // its worktrees are archived, so the session would have nowhere to run. (`done` still
    // falls through to the transition pass below, which may owe Linear its done-write.)
    // Kept inline, and only awaited when there is work: callers rely on tickOne reaching
    // the transition pass synchronously, which an unconditional await would break.
    if (j.state !== 'done' && j.state !== 'abandoned') {
      for (const s of j.steps) {
        if (s.type !== 'open-pr' || s.cancelled) continue;
        const queue = s.editQueue ?? [];
        const running = queue.some((e) => e.status === 'running');
        if (running) continue;
        // One session per step: hold an edit round while a triage turn is mid-flight
        // (dispatched but not yet posted). Once posted, the turn is done and edits proceed.
        if ((s.iterations ?? []).some((it) => it.status === 'in_progress' && !it.postedAt)) continue;
        const head = queue.find((e) => e.status === 'queued');
        if (!head) continue;
        await this.spawnEditFixSession(j, s, head.id);
      }
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
        break;
      case 'request-merge-approval':
        // The UI inspects step state to surface the approve-merge gate. No-op here.
        break;
      case 'request-conflict-approval':
        // The UI inspects step state to surface the resolve-conflicts gate. No-op here.
        break;
      case 'start-ci-fix':
        await this.fixCi(a.jobId, a.stepId);
        break;
      case 'note-ci-fix-exhausted':
        this.markCiFixExhausted(a.jobId, a.stepId);
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
    // original orphan source; archiveStepWorktree no-ops when a step has none.
    for (const s of j.steps) await this.archiveStepWorktree(s);
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

  private async archiveStepWorktree(step: Step): Promise<void> {
    const rec = this.opts.worktreeManager.get(step.id);
    if (!rec || rec.archivedAt) return;
    try { await this.opts.worktreeManager.archive(step.id, rec.projectCwd); }
    catch (e) { console.error(`[work] archive worktree ${step.id.slice(0,8)}: ${(e as Error).message}`); }
  }

  // A step reaching a terminal PR state (merged) no longer needs its implementor
  // session or worktree; archive both so they don't linger until job teardown.
  private async archiveMergedStep(jobId: string, stepId: string): Promise<void> {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (!step) return;
    await this.closeSessions(step.sessionId ? [step.sessionId] : []);
    await this.archiveStepWorktree(step);
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

  // User clicks "Resolve" on a step from the UI, or a session POSTs /work/step-resolved.
  // `payload.output` is captured as the step's stored output; agent steps with
  // `forwardOutput` will then thread it into downstream steps' `previousSteps`.
  onStepResolved(jobId: string, stepId: string, payload?: { output?: string }): void {
    // A dispatch child submits through the same tool as any other action step, using its
    // own dispatch id as `stepId` (see spawnDispatchSession's envelope). Route it to the
    // dispatch record — its parent orchestrated step resolves only via a NextMove.resolve.
    const parentStepId = this.findDispatchStepId(jobId, stepId);
    if (parentStepId) {
      this.settleDispatch(jobId, parentStepId, stepId, 'done', { output: payload?.output });
      return;
    }
    let didResolve = false;
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type === 'open-pr') return s;  // open-pr resolves via PR merge, not user action
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
  // stay parked until the user resumes.
  reconcileWaits(): void {
    const now = this.ctx.now();
    for (const j of this.opts.queue.list()) {
      if (j.state !== 'executing' && j.state !== 'failed') continue;
      for (const s of j.steps) {
        if (s.type !== 'action' || s.cancelled || s.failure || s.state !== 'waiting') continue;
        if (s.resumeAt == null) continue;
        if (now >= s.resumeAt) this.resolveWaitStep(j.id, s.id, 'timer');
        else this.scheduleWaitWake(j.id, s.id, s.resumeAt - now);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // human_gate — draft → review → commit loop for external writes.
  // Mirrors the open-pr spec_pending_review gate: the action's draft turn composes the
  // payload and submits it for review (submit_write_draft) WITHOUT posting; the user
  // approves (→ commit turn posts it) or proposes changes (→ redraft turn). The external
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

  // code.spec finished a spec round. Store the spec and pause on the user gate —
  // do NOT dispatch; approveSpec/rejectSpec drive the next round.
  onSpecReady(jobId: string, stepId: string, spec: string): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => ({
      ...s, spec, state: 'spec_pending_review', updatedAt: this.ctx.now(),
    }));
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'session', stepId, body: 'spec ready for review',
    }));
  }

  // code.plan finished. Store the plan and advance to implement (no gate). We do NOT
  // dispatch code.implement here: this call runs inside the submit_impl_plan MCP handler
  // while code.plan's turn is still open (between the tool call and its Stop). Sending
  // /code.implement now would race the ending plan turn (and briefly rebind the session's
  // allowlist to code.implement while code.plan is still executing). Instead the dispatch
  // fires from the Stop hook (onSessionTurnEnded) once the shared session is idle — the
  // same resume-when-idle invariant every other round transition already relies on.
  onImplPlanReady(jobId: string, stepId: string, plan: string): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => ({
      ...s, implPlan: plan, state: 'implementing', updatedAt: this.ctx.now(),
    }));
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'session', stepId, body: 'implementation plan ready',
    }));
  }

  // Called from the Stop hook when a spawned step session ends its turn. Handles the one
  // round hand-off with no user gate: code.plan submits (onImplPlanReady flips the step to
  // 'implementing') and ends its turn; now that the shared session is idle we dispatch the
  // implement round. Guarded on the bound action still being code.plan so it fires exactly
  // once — after code.implement is dispatched the binding is code.implement, and every
  // other turn-end (spec gate, implement awaiting PR, triage) fails these conditions.
  onSessionTurnEnded(sessionId: string): void {
    const role = this.roleBySession.get(sessionId);
    if (!role || role.role !== 'step') return;
    const j = this.opts.queue.get(role.jobId);
    const s = j?.steps.find((x) => x.id === role.stepId);
    if (!s || s.type !== 'open-pr' || s.cancelled || s.failure) return;
    if (s.state === 'implementing' && this.actionForSession(sessionId) === 'code.plan') {
      void this.dispatchRound(role.jobId, role.stepId);
    }
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
      // open-pr/action steps use `.failure` alone as their terminal marker (their `state`
      // enum has no `failed` member). orchestrated does have one — set it here so the two
      // agree, rather than leaving `state` frozen at whatever it was mid-round. Without this,
      // a step the engine treats as terminal (via `.failure`) still reads 'running'/'waiting',
      // which is exactly the inconsistency applyMove/validateNext now guard against on both
      // fields.
      if (next.type === 'orchestrated') next.state = 'failed';
      return this.appendStepEvent(next, 'failed', 'session');
    });
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
      resumeController: (jobId, stepId, action, note) => void this.resumeControllerRound(jobId, stepId, action, note),
      spawnDispatch: (jobId, stepId, d) => void this.spawnDispatchSession(jobId, stepId, d),
      resolveStep: (jobId, stepId, output) => this.onStepResolved(jobId, stepId, { output }),
      failStep: (jobId, stepId, reason) => this.onStepFailed(jobId, stepId, reason),
      actionInfo: {
        sideEffects: (a) => this.opts.actionRegistry?.getAction(a)?.frontmatter.outpost.side_effects,
        humanGate: (a) => this.opts.actionRegistry?.getAction(a)?.frontmatter.outpost.human_gate ?? false,
      },
      newId: () => this.ctx.newId(),
      now: () => this.ctx.now(),
    };
  }

  onStepProgress(jobId: string, stepId: string, p: ProgressPayload): void {
    applyMove(this.orchestratedHost(), jobId, stepId, p);
  }

  pushStepInbox(jobId: string, stepId: string, item: NewItem): void {
    pushInbox(this.orchestratedHost(), jobId, stepId, item);
  }

  resolveStepGate(jobId: string, stepId: string, approved: boolean, feedback?: string): void {
    resolveGate(this.orchestratedHost(), jobId, stepId, approved, feedback);
  }

  // User force-closes a live orchestrated step rather than waiting for the controller to
  // converge on its own move. A `queued` dispatch is cancelled outright — it never started.
  // A `running` one is left alone (killing its session would discard real work already
  // in flight); its eventual settleDispatch/submit_step_progress just updates a dispatch
  // record nobody reads anymore, because applyMove now refuses to act on an already-resolved
  // step — see the guard at the top of applyMove.
  markStepResolved(jobId: string, stepId: string): void {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (!step || step.type !== 'orchestrated' || step.state === 'resolved') return;
    // A `queued` dispatch's parked launch survives the status flip below unless dropped here
    // too — the governor doesn't read Dispatch.status, so a launch parked under token headroom
    // would still fire later, flip the dispatch back to 'running', and spawn a real session for
    // work the user just cancelled. Scoped to this step (not the job-wide `cancel()` used by
    // abandon/delete/reset) so a sibling step's own parked launch is untouched.
    this.opts.governor?.cancelStep(jobId, stepId);
    this.mutateStep(jobId, stepId, (s) => {
      if (s.type !== 'orchestrated') return s;
      const next: OrchestratedStep = {
        ...s,
        state: 'resolved',
        // A step force-resolved after failing shouldn't still render as failed forever
        // after — stateLabel/stateTone (step-card.js) and vm/tracked.js give `.failure`
        // priority over `state`. Matches rerunLatest's retry path and the open-pr merge path.
        failure: undefined,
        dispatches: s.dispatches.map((d) => d.status === 'queued'
          ? { ...d, status: 'cancelled', finishedAt: this.ctx.now() }
          : d),
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
    if (!j || !s || s.type !== 'orchestrated') return;
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

    if (!s.sessionId) {
      await this.spawnStepSession(jobId, stepId, envelopePath);
      return;
    }
    const sessionId = s.sessionId;
    // A trailing Stop from the round we're superseding must not fail this live step.
    // Recorded synchronously — a queued launch may only fire once that Stop frees the slot.
    if (this.opts.sessionManager.isWorking(sessionId)) {
      this.owedStaleStops.set(sessionId, (this.owedStaleStops.get(sessionId) ?? 0) + 1);
    }
    let ws: { path: string | null };
    try {
      ws = await this.opts.worktreeManager.provision(stepId, s.workspace);
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
        if (!cur || cur.type !== 'orchestrated' || cur.cancelled) return false;
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
  // resolving/failing the parent (see findDispatchStepId).
  private async spawnDispatchSession(jobId: string, stepId: string, dispatch: Dispatch): Promise<void> {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!j || !s || s.type !== 'orchestrated') return;

    const workspace = dispatch.workspace ?? s.workspace;
    let ws: { path: string | null };
    try {
      ws = await this.opts.worktreeManager.provision(dispatch.id, workspace);
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
        // step's. `markStepResolved`'s governor.cancelStep() is what's supposed to keep this
        // launch from ever firing after it flips a queued dispatch to 'cancelled' — this is
        // the belt to that braces, in case a launch was parked under a key that cancellation
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
        // open-pr-only artifacts from a prior spec/plan round — clear so a
        // retried step restarts clean instead of rendering stale spec/plan
        // markdown or carrying old feedback into the fresh spec envelope.
        spec: undefined, implPlan: undefined, specFeedback: undefined,
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

  onMergeApproved(jobId: string, stepId: string): void {
    this.mutateStep(jobId, stepId, (s) => s.type === 'open-pr'
      ? this.appendStepEvent({ ...s, state: 'merged', prState: 'merged', failure: undefined, updatedAt: this.ctx.now() } as OpenPrStep, 'merged', 'user')
      : s);
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'step_merged', who: 'user', stepId, body: this.stepLabel(jobId, stepId),
    }));
    void this.archiveMergedStep(jobId, stepId);
    void this.tickOne(jobId);
  }

  onExternalEvent(jobId: string, stepId: string, ev: ExternalEvent): void {
    const before = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    this.mutateStep(jobId, stepId, (s) => {
      const h = handlerFor(s);
      return h.onExternalEvent ? (h.onExternalEvent(s, ev) as Step) : s;
    });
    const after = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    // Emit a step_merged event when the watcher transitions an open-pr step into merged.
    if (before && after && before.state !== 'merged' && after.state === 'merged') {
      this.mutateStep(jobId, stepId, (s) => this.appendStepEvent(s, 'merged', 'pr-watcher'));
      this.mutate(jobId, (j) => this.appendEvent(j, {
        kind: 'step_merged', who: 'pr-watcher', stepId, body: this.stepLabel(jobId, stepId),
      }));
      void this.archiveMergedStep(jobId, stepId);
    }
    const j = this.opts.queue.get(jobId);
    if (j) {
      this.mutate(jobId, (jj) => ({ ...jj, linearStatusDirty: true }));
    }
    void this.tickOne(jobId);
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

  // Cancels a not-yet-started step; refuses once a session exists or the step is terminal.
  cancelStepManually(jobId: string, stepId: string): boolean {
    const j = this.opts.queue.get(jobId);
    if (!j) return false;
    const step = j.steps.find((s) => s.id === stepId);
    if (!step) return false;
    if (step.sessionId) return false;
    if (step.state === 'resolved' || step.state === 'merged') return false;
    if (step.cancelled) return true;
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
      const locked = s.sessionId || s.state === 'resolved' || s.state === 'merged';
      if (locked && j.steps[i]?.id !== s.id) return false;
    }
    this.mutate(jobId, (jj) => this.appendEvent(
      { ...jj, steps: newOrder },
      { kind: 'plan_reconciled', who: 'user', body: 'plan reordered manually' },
    ));
    void this.tickOne(jobId);
    return true;
  }

  // Patches an existing step's editable fields; refuses once a session exists or the
  // step is terminal/cancelled — same editability rule cancelStepManually and the PWA's
  // stepIsEditable() enforce. Only fields applicable to the step's own type are applied.
  editStepManually(jobId: string, stepId: string, patch: StepEditPatch): boolean {
    const j = this.opts.queue.get(jobId);
    if (!j) return false;
    const step = j.steps.find((s) => s.id === stepId);
    if (!step) return false;
    if (step.sessionId) return false;
    if (step.state === 'resolved' || step.state === 'merged') return false;
    if (step.cancelled) return false;

    // A step that failed because its ref couldn't provision is only repairable through this
    // patch — and the failure keeps decide() returning null, so clearing the ref without
    // clearing the failure would look like the repair did nothing. Retry after the mutate.
    const wasUnprovisionable = !!step.failure && !!workspaceError(step.workspace);

    const fields: Partial<Step> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.description !== undefined) fields.description = patch.description;
    // Safe only because of the no-sessionId guard above: nothing has provisioned against the
    // old ref yet. This is also the only way to repair a step whose planner-authored workspace
    // was wrong — dropping and re-adding loses the step's position and history.
    if (patch.workspace !== undefined) {
      const err = workspaceError(patch.workspace);
      if (err) throw new Error(err);
      if (step.type === 'open-pr' && patch.workspace.kind !== 'writable') {
        throw new Error('open-pr step requires writable workspace');
      }
      fields.workspace = patch.workspace as Step['workspace'];
    }
    if (step.type === 'open-pr') {
      if (patch.goal !== undefined) (fields as Partial<OpenPrStep>).goal = patch.goal;
      if (patch.approach !== undefined) (fields as Partial<OpenPrStep>).approach = patch.approach;
      if (patch.risks !== undefined) (fields as Partial<OpenPrStep>).risks = patch.risks;
    } else if (step.type === 'action') {
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
    if (wasUnprovisionable && patch.workspace !== undefined) this.onStepRetry(jobId, stepId);
    else void this.tickOne(jobId);
    return true;
  }

  // High-level reply/merge ops — ported from the old orchestrator. Per open-pr step.
  rejectReplies(jobId: string, stepId: string, feedback: string): void {
    this.resolveIteration(jobId, stepId, 'replies', 'rejected', feedback);
    this.mutateOpenPrStep(jobId, stepId, (s) => ({
      ...s, state: 'comment_pending_response', updatedAt: this.ctx.now(),
    }));
    this.mutate(jobId, (j) => this.appendEvent(j, { kind: 'state_changed', who: 'user', stepId, body: feedback }));
  }

  approveReplies(jobId: string, stepId: string): void {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!s || s.type !== 'open-pr' || !s.sessionId) return;
    this.resolveIteration(jobId, stepId, 'replies', 'approved');
    this.opts.sessionManager.send(s.sessionId, {
      type: 'user',
      message: { role: 'user', content: 'Replies approved — post each reply with `gh pr comment` and push any fix diff.' },
    });
  }

  approveSpec(jobId: string, stepId: string): void {
    let ok = false;
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      if (s.state !== 'spec_pending_review') return s;
      ok = true;
      return { ...s, state: 'planning', updatedAt: this.ctx.now() };
    });
    if (!ok) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'user', stepId, body: 'spec approved',
    }));
    void this.dispatchRound(jobId, stepId);
  }

  rejectSpec(jobId: string, stepId: string, feedback: string): void {
    let ok = false;
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      if (s.state !== 'spec_pending_review') return s;
      ok = true;
      return { ...s, state: 'speccing', specFeedback: [...(s.specFeedback ?? []), feedback], updatedAt: this.ctx.now() };
    });
    if (!ok) return;
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed', who: 'user', stepId, body: feedback,
    }));
    void this.dispatchRound(jobId, stepId);
  }

  mergePr(jobId: string, stepId: string): void {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!s || s.type !== 'open-pr' || !s.prUrl || s.prState === 'merged') return;
    // Merge only — NOT `--delete-branch`. gh's branch deletion also removes the
    // *local* branch, which fails ("cannot delete branch … used by worktree")
    // because this step's branch is still checked out in its worktree. That made
    // gh exit non-zero even though the PR merged on GitHub, so this catch swallowed
    // it and the step never advanced past the merge gate — the PWA showed no change
    // until the pr-watcher reconciled the merge minutes later. Branch cleanup is
    // best-effort and decoupled: the local branch is reaped by the worktree teardown
    // (applyOpenPrPatch → archiveMergedStep → tearDown's `branch -D`), and the remote
    // branch is deleted below without gating the state transition.
    try {
      execFileSync('gh', ['pr', 'merge', s.prUrl, '--squash'], { cwd: s.workspace.repoCwd, stdio: 'pipe' });
    } catch (e) {
      console.error(`[orchestrator] merge failed ${jobId}/${stepId}:`, (e as Error).message);
      return;
    }
    this.applyOpenPrPatch(jobId, stepId, { state: 'merged', prState: 'merged' }, 'user');
    try {
      execFileSync('git', ['-C', s.workspace.repoCwd, 'push', 'origin', '--delete', '--', s.workspace.branch], { stdio: 'pipe' });
    } catch (e) {
      // Remote branch may already be gone (GitHub "auto-delete head branches") — best-effort.
      console.error(`[orchestrator] remote branch delete failed ${jobId}/${stepId}:`, (e as Error).message);
    }
  }

  // Resolve-reply-comment unified dispatcher (approve/ignore/reject for a single drafted reply).
  resolveReplyComment(jobId: string, stepId: string, commentId: string, action: 'approve' | 'ignore' | 'reject', feedback?: string, body?: string): void {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!s || s.type !== 'open-pr') return;
    if (action === 'reject') {
      this.rejectReplies(jobId, stepId, feedback ?? 'rejected');
      return;
    }
    const draft = (s.draftedReplies ?? []).find((d) => d.commentId === commentId);
    if (action === 'approve' && draft && s.sessionId) {
      const text = body ?? draft.draftReply;
      try {
        execFileSync('gh', ['pr', 'comment', s.prUrl ?? '', '--body', text], { cwd: s.workspace.repoCwd, stdio: 'pipe' });
      } catch (e) {
        console.error(`[orchestrator] gh comment failed ${jobId}/${stepId}/${commentId}:`, (e as Error).message);
      }
    }
    this.markCommentResponded(jobId, stepId, commentId);
    const remaining = this.dropDraftedReply(jobId, stepId, commentId);
    if (remaining === 0) {
      this.resolveIteration(jobId, stepId, 'replies', 'approved');
    }
  }

  // Re-draft one comment's reply: drop the current draft (user-edited included —
  // regenerate is an explicit request to start over) and reopen the comment so
  // the normal triage round picks it up as undrafted on the next tick.
  regenerateReply(jobId: string, stepId: string, commentId: string): boolean {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!s || s.type !== 'open-pr' || s.state === 'merged' || s.prState === 'merged') return false;
    const comment = (s.comments ?? []).find((c) => c.id === commentId);
    if (!comment) return false;
    this.dropDraftedReply(jobId, stepId, commentId);
    if (comment.respondedAt) this.markCommentReopened(jobId, stepId, commentId);
    if (s.state !== 'comment_pending_response' && s.state !== 'reply_pending_review') {
      this.mutateOpenPrStep(jobId, stepId, (st) => ({
        ...st, state: 'comment_pending_response', updatedAt: this.ctx.now(),
      }));
    }
    void this.tickOne(jobId);
    return true;
  }

  reactToComment(jobId: string, stepId: string, commentId: string, content: string): void {
    this.addUserReaction(jobId, stepId, commentId, content);
  }

  enqueueEdit(jobId: string, stepId: string, commentId: string, userNote?: string): void {
    this.enqueueEditJob(jobId, stepId, commentId, userNote);
  }

  // Git-view "Send review" routing. Called by the /git/review HTTP handler.
  // If the session belongs to an open-pr step whose last edit round finished
  // (status 'done'/'failed') with no follow-up already queued, we treat the
  // submitted review as "this last edit isn't quite right" and enqueue a fresh
  // fix session for the same PR comment — reusing the existing editQueue
  // machinery so the user's expected "edit → review → edit again" loop closes.
  // Every other case (no editJob context, an edit still running, non-PR steps)
  // falls back to `chat` so the caller can send the text as a plain session
  // message and preserve pre-existing behavior.
  handleGitReview(sessionId: string, text: string): { handled: 'requeued' | 'chat'; editJobId?: string } {
    const role = this.roleBySession.get(sessionId);
    if (!role || role.role !== 'step') return { handled: 'chat' };
    const j = this.opts.queue.get(role.jobId);
    const step = j?.steps.find((s) => s.id === role.stepId);
    if (!step || step.type !== 'open-pr') return { handled: 'chat' };
    if (step.state === 'merged' || step.prState === 'merged') return { handled: 'chat' };
    const queue = step.editQueue ?? [];
    const last = queue[queue.length - 1];
    if (!last || (last.status !== 'done' && last.status !== 'failed')) {
      return { handled: 'chat' };
    }
    const job = this.enqueueEditJob(role.jobId, role.stepId, last.commentId, text);
    if (!job) return { handled: 'chat' };
    return { handled: 'requeued', editJobId: job.id };
  }

  // Looks up which open-pr step (if any) a spawned session belongs to. Returns
  // undefined for orchestrator sessions, unknown sessions, or step sessions whose
  // step is not `open-pr`.
  openPrStepForSession(sessionId: string): { jobId: string; stepId: string } | undefined {
    const role = this.roleBySession.get(sessionId);
    if (!role || role.role !== 'step') return undefined;
    const j = this.opts.queue.get(role.jobId);
    const step = j?.steps.find((s) => s.id === role.stepId);
    if (!step || step.type !== 'open-pr') return undefined;
    return { jobId: role.jobId, stepId: role.stepId };
  }

  // Called after a successful git push targeting an open-pr step's worktree.
  // Any drafted reply whose recommendation is `edit` and whose corresponding
  // edit-job has completed is considered addressed by the push — the fix landed
  // on the remote branch, so the comment gets marked responded and its draft
  // dropped. Idempotent: a re-push with nothing new to resolve is a no-op.
  resolveCompletedEditDrafts(jobId: string, stepId: string): number {
    const j = this.opts.queue.get(jobId);
    const step = j?.steps.find((s) => s.id === stepId);
    if (!step || step.type !== 'open-pr') return 0;
    const done = new Set((step.editQueue ?? [])
      .filter((e) => e.status === 'done')
      .map((e) => e.commentId));
    const targets = (step.draftedReplies ?? [])
      .filter((d) => d.recommendation === 'edit' && done.has(d.commentId))
      .map((d) => d.commentId);
    for (const commentId of targets) {
      this.markCommentResponded(jobId, stepId, commentId);
      this.dropDraftedReply(jobId, stepId, commentId);
    }
    return targets.length;
  }

  markStatusCommentClean(jobId: string): void {
    this.mutate(jobId, (j) => ({ ...j, linearStatusDirty: false }));
  }

  setOrchestratorSessionId(jobId: string, sessionId: string): void {
    this.mutate(jobId, (j) => j.orchestratorSessionId === sessionId ? j : { ...j, orchestratorSessionId: sessionId });
  }

  // ─────────────────────────────────────────────────────────
  // Open-PR step ops (iterations, drafted replies, edit-jobs,
  // comments, review comments). Called by hook server, PWA, and
  // pr-watcher. Each operates on a specific open-pr step.
  // ─────────────────────────────────────────────────────────

  markCommentResponded(jobId: string, stepId: string, commentId: string, at: number = this.ctx.now()): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const comments = (s.comments ?? []).map((c) => c.id === commentId ? { ...c, respondedAt: at } : c);
      return { ...s, comments, updatedAt: at };
    });
  }

  // Upsert drafts by commentId. User-edited drafts are never clobbered, so a
  // top-up triage that fires while the user is reviewing prior drafts can only
  // add — not overwrite what the user is actively editing.
  mergeDraftedReplies(
    jobId: string,
    stepId: string,
    drafts: DraftedReply[],
    threadHash?: string,
  ): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const byId = new Map((s.draftedReplies ?? []).map((d) => [d.commentId, d] as const));
      for (const d of drafts) {
        const prior = byId.get(d.commentId);
        if (prior?.userEdited) continue;
        byId.set(d.commentId, d);
      }
      return {
        ...s,
        state: 'reply_pending_review',
        draftedReplies: [...byId.values()],
        ...(threadHash ? { threadHash } : {}),
        updatedAt: this.ctx.now(),
      };
    });
  }

  dropDraftedReply(jobId: string, stepId: string, commentId: string): number {
    let count = 0;
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const draftedReplies = (s.draftedReplies ?? []).filter((d) => d.commentId !== commentId);
      count = draftedReplies.length;
      return { ...s, draftedReplies, updatedAt: this.ctx.now() };
    });
    return count;
  }

  dropOrphanIterations(jobId: string, stepId: string, kind: 'replies' = 'replies'): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const iterations = (s.iterations ?? []).filter((i) => !(i.kind === kind && i.status === 'in_progress' && !i.postedAt));
      return { ...s, iterations, updatedAt: this.ctx.now() };
    });
  }

  startIteration(jobId: string, stepId: string, kind: 'replies' = 'replies'): IterationRecord | undefined {
    let iter: IterationRecord | undefined;
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      iter = { id: this.ctx.newId(), kind, status: 'in_progress', startedAt: this.ctx.now() };
      const iterations = [...(s.iterations ?? []), iter];
      return { ...s, iterations, updatedAt: this.ctx.now() };
    });
    return iter;
  }

  markIterationPosted(jobId: string, stepId: string, kind: 'replies' = 'replies'): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const iterations = (s.iterations ?? []).slice();
      for (let i = iterations.length - 1; i >= 0; i--) {
        const it = iterations[i]!;
        if (it.kind === kind && it.status === 'in_progress' && !it.postedAt) {
          iterations[i] = { ...it, postedAt: this.ctx.now() };
          break;
        }
      }
      return { ...s, iterations, updatedAt: this.ctx.now() };
    });
  }

  resolveIteration(jobId: string, stepId: string, kind: 'replies' = 'replies', status: 'approved' | 'rejected', feedback?: string): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const iterations = (s.iterations ?? []).slice();
      for (let i = iterations.length - 1; i >= 0; i--) {
        const it = iterations[i]!;
        if (it.kind === kind && it.status === 'in_progress') {
          iterations[i] = { ...it, status, resolvedAt: this.ctx.now(), ...(feedback ? { feedback } : {}) };
          break;
        }
      }
      return { ...s, iterations, updatedAt: this.ctx.now() };
    });
  }

  enqueueEditJob(jobId: string, stepId: string, commentId: string, userNote?: string): EditJob | undefined {
    let job: EditJob | undefined;
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      job = { id: this.ctx.newId(), commentId, status: 'queued', ...(userNote ? { userNote } : {}) };
      const editQueue = [...(s.editQueue ?? []), job];
      return { ...s, editQueue, updatedAt: this.ctx.now() };
    });
    void this.tickOne(jobId);
    return job;
  }

  markEditRunning(jobId: string, stepId: string, editId: string, sessionId: string): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const editQueue = (s.editQueue ?? []).map((e) => e.id === editId
        ? { ...e, status: 'running' as const, startedAt: this.ctx.now(), sessionId }
        : e);
      return { ...s, editQueue, updatedAt: this.ctx.now() };
    });
  }

  markEditDone(jobId: string, stepId: string, editId: string, result: { status: 'done' | 'failed'; failure?: string }): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const editQueue = (s.editQueue ?? []).map((e) => e.id === editId
        ? { ...e, status: result.status, finishedAt: this.ctx.now(), ...(result.failure ? { failure: result.failure } : {}) }
        : e);
      return { ...s, editQueue, updatedAt: this.ctx.now() };
    });
  }

  async resolveConflicts(jobId: string, stepId: string, opts?: { base?: string; push?: boolean; postAction?: 'squash-to-base' }): Promise<void> {
    const job = this.opts.queue.get(jobId);
    const step = job?.steps.find((x) => x.id === stepId);
    if (!job || !step || step.type !== 'open-pr') return;
    if (step.state !== 'conflicting' || step.conflictResolving) return;

    const ws = await this.opts.worktreeManager.provision(step.id, step.workspace);
    const envelope = {
      kind: 'step',
      jobId: job.id,
      stepId: step.id,
      type: 'open-pr',
      title: step.title,
      description: step.description,
      goal: step.goal,
      approach: step.approach,
      risks: step.risks,
      job: { source: job.source, title: job.title, description: job.description, externalRef: job.externalRef },
      previousSteps: job.steps
        .filter((st) => st.id !== step.id && st.type === 'action' && st.forwardOutput !== false && st.output)
        .map((st) => ({ id: st.id, title: st.title, action: (st as { action?: string }).action, output: (st as { output?: string }).output })),
      workspace: step.workspace,
      typePayload: {
        branch: step.workspace.branch,
        round: opts
          ? { kind: 'conflict', ...(opts.base ? { base: opts.base } : {}), ...(opts.push !== undefined ? { push: opts.push } : {}), ...(opts.postAction ? { postAction: opts.postAction } : {}) }
          : { kind: 'conflict' },
      },
    };
    const envelopePath = writeEnvelope(this.ctx.jobsDir, job.id, step.id, envelope);
    augmentEnvelopeWithLessons(envelopePath, this.opts.journalStore?.recent('code.resolve-conflicts') ?? []);

    const sessionId = step.sessionId ?? this.ctx.newId();
    const cwd = ws.path ?? this.orchestratorCwd();
    // code.resolve-conflicts is reactive → immediate: run fires synchronously. The top-of-method
    // `state !== 'conflicting' || conflictResolving` check is the double-spawn guard; the flag
    // itself is claimed in run alongside the send.
    this.submitLaunch({
      key: `${jobId}#${stepId}`, jobId, stepId, sessionId, action: 'code.resolve-conflicts', label: 'conflict',
      run: () => {
        this.mutateOpenPrStep(jobId, stepId, (s) => ({ ...s, conflictResolving: true, sessionId, conflictPostAction: opts?.postAction, updatedAt: this.ctx.now() }));
        this.roleBySession.set(sessionId, { role: 'step', jobId: job.id, stepId: step.id });
        this.bindAction(sessionId, 'code.resolve-conflicts');
        this.mutate(jobId, (j) => this.appendEvent(j, {
          kind: 'step_started',
          who: 'orchestrator',
          stepId,
          body: `${this.stepLabel(jobId, stepId)} — resolving merge conflicts`,
        }));
        this.opts.sessionManager.sendOrResume(
          sessionId,
          cwd,
          { type: 'user', message: { role: 'user', content: '/code.resolve-conflicts' } },
          { OUTPOST_ENVELOPE: envelopePath, JOB_ID: job.id, STEP_ID: step.id, STEP_TYPE: 'open-pr' },
        );
        return true;
      },
    });
  }

  async fixCi(jobId: string, stepId: string): Promise<void> {
    const job = this.opts.queue.get(jobId);
    const step = job?.steps.find((x) => x.id === stepId);
    if (!job || !step || step.type !== 'open-pr') return;
    if (!shouldAutoFixCi(step)) return;

    // Claim the round synchronously before any await. fixCi runs on the autonomous
    // tick loop with no per-job mutex, so a second tick during `provision` would
    // otherwise re-enter decide() with ciFixing still false and double-spawn.
    const sessionId = step.sessionId ?? this.ctx.newId();
    this.mutateOpenPrStep(jobId, stepId, (s) => ({
      ...s,
      ciFixing: true,
      ciFixAttempts: (s.ciFixAttempts ?? 0) + 1,
      ciFixLastSignature: ciFailureSignature(s.ciChecks),
      ciFixGaveUp: false,
      sessionId,
      updatedAt: this.ctx.now(),
    }));

    let ws;
    try {
      ws = await this.opts.worktreeManager.provision(step.id, step.workspace);
    } catch (e) {
      // Provision failed after we claimed the round — restore the pre-claim values
      // so a later tick can retry instead of the step wedging on ciFixing.
      this.mutateOpenPrStep(jobId, stepId, (s) => ({
        ...s,
        ciFixing: false,
        ciFixAttempts: step.ciFixAttempts,
        ciFixLastSignature: step.ciFixLastSignature,
        ciFixGaveUp: step.ciFixGaveUp,
        updatedAt: this.ctx.now(),
      }));
      throw e;
    }
    const checks = (step.ciChecks ?? [])
      .filter((c) => c.state === 'failure')
      .map((c) => ({ name: c.name, url: c.url }));
    const envelope = {
      kind: 'step',
      jobId: job.id,
      stepId: step.id,
      type: 'open-pr',
      title: step.title,
      description: step.description,
      goal: step.goal,
      approach: step.approach,
      risks: step.risks,
      spec: step.spec,
      implPlan: step.implPlan,
      job: { source: job.source, title: job.title, description: job.description, externalRef: job.externalRef },
      previousSteps: job.steps
        .filter((st) => st.id !== step.id && st.type === 'action' && st.forwardOutput !== false && st.output)
        .map((st) => ({ id: st.id, title: st.title, action: (st as { action?: string }).action, output: (st as { output?: string }).output })),
      workspace: step.workspace,
      typePayload: { branch: step.workspace.branch, round: { kind: 'ci-fix', checks } },
    };
    const envelopePath = writeEnvelope(this.ctx.jobsDir, job.id, step.id, envelope);
    augmentEnvelopeWithLessons(envelopePath, this.opts.journalStore?.recent('code.fix-ci') ?? []);

    const cwd = ws.path ?? this.orchestratorCwd();
    // code.fix-ci is reactive → immediate: `run` fires synchronously here. The ciFixing
    // claim stays above (before the provision await) so the synchronous double-spawn guard
    // is unchanged; only the session send moves into run.
    this.submitLaunch({
      key: `${jobId}#${stepId}`, jobId, stepId, sessionId, action: 'code.fix-ci', label: 'ci-fix',
      run: () => {
        this.roleBySession.set(sessionId, { role: 'step', jobId: job.id, stepId: step.id });
        this.bindAction(sessionId, 'code.fix-ci');
        this.mutate(jobId, (j) => this.appendEvent(j, {
          kind: 'step_started',
          who: 'orchestrator',
          stepId,
          body: `${this.stepLabel(jobId, stepId)} — fixing failing CI`,
        }));
        this.opts.sessionManager.sendOrResume(
          sessionId,
          cwd,
          { type: 'user', message: { role: 'user', content: '/code.fix-ci' } },
          { OUTPOST_ENVELOPE: envelopePath, JOB_ID: job.id, STEP_ID: step.id, STEP_TYPE: 'open-pr' },
        );
        return true;
      },
    });
  }

  // Squash the step's branch onto its base branch locally (no push), then complete
  // the step as if the PR had merged (applyOpenPrPatch → merged → worktree archived).
  // On conflict, hand off to the resolve-conflicts round (merge base into the branch,
  // no push) and re-run this once it reports resolved.
  async squashMergeToBase(jobId: string, stepId: string): Promise<'merged' | 'resolving-conflicts' | 'error'> {
    const job = this.opts.queue.get(jobId);
    const step = job?.steps.find((x) => x.id === stepId);
    if (!job || !step || step.type !== 'open-pr') return 'error';

    await this.opts.worktreeManager.provision(step.id, step.workspace);
    const rec = this.opts.worktreeManager.get(step.id);
    if (!rec?.projectCwd || !rec.branch || !rec.worktreePath) return 'error';
    const baseBranch = rec.baseBranch && rec.baseBranch.length > 0 ? rec.baseBranch : 'main';

    const result = await gitSquashMergeToBase({
      parentCwd: rec.projectCwd,
      worktreePath: rec.worktreePath,
      worktreeBranch: rec.branch,
      baseBranch,
      message: job.title || step.title,
    });

    if (result.ok) {
      this.applyOpenPrPatch(jobId, stepId, { state: 'merged' }, 'user');
      return 'merged';
    }
    if (result.reason === 'conflict') {
      this.mutateOpenPrStep(jobId, stepId, (s) => ({ ...s, state: 'conflicting', mergeable: 'conflicting', updatedAt: this.ctx.now() }));
      await this.resolveConflicts(jobId, stepId, { base: baseBranch, push: false, postAction: 'squash-to-base' });
      return 'resolving-conflicts';
    }
    return 'error';
  }

  markConflictResolved(jobId: string, stepId: string, result: { status: 'resolved' | 'unresolvable'; failure?: string }): void {
    const prev = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId) as OpenPrStep | undefined;
    const owesSquash = result.status === 'resolved' && prev?.conflictPostAction === 'squash-to-base';
    this.mutateOpenPrStep(jobId, stepId, (s) => ({
      ...s,
      conflictResolving: false,
      conflictPostAction: undefined,
      state: result.status === 'resolved' ? 'pr_open' : 'conflict_unresolved',
      ...(result.status === 'resolved' ? { mergeable: 'unknown' as const } : {}),
      updatedAt: this.ctx.now(),
    }));
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed',
      who: 'orchestrator',
      stepId,
      body: result.status === 'resolved'
        ? `${this.stepLabel(jobId, stepId)} — conflicts resolved`
        : `${this.stepLabel(jobId, stepId)} — could not auto-resolve conflicts: ${result.failure ?? 'unknown'}`,
    }));
    if (owesSquash) {
      void this.squashMergeToBase(jobId, stepId).then((outcome) => {
        if (outcome === 'error') {
          this.mutate(jobId, (j) => this.appendEvent(j, {
            kind: 'state_changed', who: 'orchestrator', stepId,
            body: `${this.stepLabel(jobId, stepId)} — squash-to-base retry failed; retry from the git view`,
          }));
        }
      }).catch((e) => console.error(`[work] squash retry ${stepId.slice(0, 8)}: ${(e as Error).message}`));
    }
  }

  markCiFixed(jobId: string, stepId: string, result: { status: 'fixed' | 'unfixable'; failure?: string }): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => ({
      ...s,
      ciFixing: false,
      // 'fixed' pushed a commit — the watcher will re-run CI. 'unfixable' left it
      // red, so flag give-up to stop decide() re-emitting an exhausted note.
      ...(result.status === 'unfixable' ? { ciFixGaveUp: true } : {}),
      updatedAt: this.ctx.now(),
    }));
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed',
      who: 'orchestrator',
      stepId,
      body: result.status === 'fixed'
        ? `${this.stepLabel(jobId, stepId)} — CI fix pushed`
        : `${this.stepLabel(jobId, stepId)} — CI auto-fix could not fix it: ${result.failure ?? 'unknown'}`,
    }));
  }

  markCiFixExhausted(jobId: string, stepId: string): void {
    const step = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId) as OpenPrStep | undefined;
    if (!step || step.type !== 'open-pr' || step.ciFixGaveUp) return;
    this.mutateOpenPrStep(jobId, stepId, (s) => ({ ...s, ciFixGaveUp: true, updatedAt: this.ctx.now() }));
    this.mutate(jobId, (j) => this.appendEvent(j, {
      kind: 'state_changed',
      who: 'orchestrator',
      stepId,
      body: `${this.stepLabel(jobId, stepId)} — CI still failing; auto-fix stopped (needs a human)`,
    }));
  }

  addUserReaction(jobId: string, stepId: string, commentId: string, content: string): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const comments = (s.comments ?? []).map((c) => {
        if (c.id !== commentId) return c;
        const userReactions = c.userReactions ?? [];
        return userReactions.includes(content) ? c : { ...c, userReactions: [...userReactions, content] };
      });
      return { ...s, comments, updatedAt: this.ctx.now() };
    });
  }

  markCommentReopened(jobId: string, stepId: string, commentId: string, at: number = this.ctx.now()): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const comments = (s.comments ?? []).map((c) => c.id === commentId
        ? { ...c, respondedAt: undefined, reopenedAt: at }
        : c);
      return { ...s, comments, updatedAt: at };
    });
  }

  setDraftUserEdited(jobId: string, stepId: string, commentId: string, edited: boolean): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const draftedReplies = (s.draftedReplies ?? []).map((d) => {
        if (d.commentId !== commentId) return d;
        if (edited) return { ...d, userEdited: true } satisfies DraftedReply;
        const { userEdited: _, ...rest } = d;
        return rest as DraftedReply;
      });
      return { ...s, draftedReplies, updatedAt: this.ctx.now() };
    });
  }

  addReviewComment(jobId: string, stepId: string, partial: {
    kind: 'replies';
    author: 'user' | 'claude';
    body: string;
    file?: string;
    line?: number;
    iterationId?: string;
  }): ReviewComment | undefined {
    let added: ReviewComment | undefined;
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      let iterationId = partial.iterationId;
      if (!iterationId) {
        const current = (s.iterations ?? []).filter((i) => i.kind === partial.kind && i.status === 'in_progress').at(-1);
        const fallback = (s.iterations ?? []).filter((i) => i.kind === partial.kind).at(-1);
        iterationId = current?.id ?? fallback?.id;
      }
      if (!iterationId) return s;
      added = {
        id: this.ctx.newId(),
        iterationId,
        kind: partial.kind,
        author: partial.author,
        body: partial.body,
        createdAt: this.ctx.now(),
        ...(partial.file ? { file: partial.file } : {}),
        ...(partial.line !== undefined ? { line: partial.line } : {}),
      };
      const reviewComments = [...(s.reviewComments ?? []), added];
      return { ...s, reviewComments, updatedAt: this.ctx.now() };
    });
    return added;
  }

  resolveReviewComment(jobId: string, stepId: string, commentId: string): void {
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const reviewComments = (s.reviewComments ?? []).map((c) => c.id === commentId
        ? { ...c, resolvedAt: this.ctx.now() }
        : c);
      return { ...s, reviewComments, updatedAt: this.ctx.now() };
    });
  }

  currentIteration(s: OpenPrStep, kind: 'replies' = 'replies'): IterationRecord | undefined {
    const arr = s.iterations ?? [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i]!;
      if (it.kind === kind && it.status === 'in_progress') return it;
    }
    return undefined;
  }

  // Bulk update — pr-watcher uses this when it diffs the live PR state and wants
  // to push multiple field updates atomically per tick. This is the single choke
  // point every out-of-band observer (pr-watcher poll, git-route push/merge) goes
  // through, so it also drives the plan forward: a patch that resolves the open-pr
  // step (→merged) unblocks the next step, and a patch that flips it to
  // comment_pending_response opens a triage round — without waiting on the next
  // hourly sweep or a PWA nudge. `who` attributes the merge event to whoever
  // observed it (default the watcher; the PWA merge button passes 'user').
  applyOpenPrPatch(jobId: string, stepId: string, patch: Partial<OpenPrStep>, who: JobEvent['who'] = 'pr-watcher'): void {
    const before = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    this.mutateOpenPrStep(jobId, stepId, (s) => {
      const next = { ...s, ...patch, updatedAt: this.ctx.now() };
      // A merged step, or one with a live open PR, is proof the implement round
      // succeeded: the edits merged or produced a real, reviewable diff. Drop any stale
      // step failure, namely the spurious "interrupted by daemon restart"
      // reconcileInterruptedSteps stamps on a step caught mid-`implementing` by a daemon
      // bounce. Once the user opens the PR from those worktree edits the step advances to
      // pr_open / comment_pending_response, but the failure survives — and left in place
      // it permanently halts the whole job (decideJobTransitions), which also strands the
      // parallel-group siblings and the comment-triage round, even though the work landed.
      // Clearing only on `merged` missed that pre-merge recovery window; clearing on
      // `merged` too still covers squash-to-base, which merges with no PR. (The other
      // step-level failures — spec/plan interrupt, provision failure — happen before any
      // PR exists, so a live PR never masks a real one.)
      if (next.failure && (next.state === 'merged' || (next.prUrl && next.prState !== 'closed'))) {
        next.failure = undefined;
      }
      return next;
    });
    const after = this.opts.queue.get(jobId)?.steps.find((s) => s.id === stepId);
    if (before && after && before.state !== 'merged' && after.state === 'merged') {
      this.mutate(jobId, (j) => this.appendEvent(j, {
        kind: 'step_merged', who, stepId, body: this.stepLabel(jobId, stepId),
      }));
      // A merged step no longer needs its implementor session or worktree. This is
      // the shared choke point (pr-watcher, mergePr, squash-to-base) so all of them
      // reap here rather than waiting on whole-job teardown.
      void this.archiveMergedStep(jobId, stepId).catch((e) =>
        console.error(`[work] archive merged ${stepId.slice(0, 8)}: ${(e as Error).message}`));
    }
    if (after) this.mutate(jobId, (jj) => ({ ...jj, linearStatusDirty: true }));
    void this.tickOne(jobId);
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
    const reg = this.opts.actionRegistry;
    if (!reg) return undefined;
    return reg.listActions().map((a) => ({
      name: a.name,
      description: a.frontmatter.description,
      category: a.frontmatter.outpost.category,
      runner: a.frontmatter.outpost.runner,
      side_effects: a.frontmatter.outpost.side_effects,
      human_gate: a.frontmatter.outpost.human_gate ?? false,
      input_schema: a.inputSchema,
      output_schema: a.outputSchema,
    }));
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

  private async spawnEditFixSession(job: JobRecord, step: OpenPrStep, editId: string): Promise<void> {
    const editJob = (step.editQueue ?? []).find((e) => e.id === editId);
    if (!editJob) return;
    const comment = (step.comments ?? []).find((c) => c.id === editJob.commentId);
    if (!comment) return;

    const ws = await this.opts.worktreeManager.provision(step.id, step.workspace);
    const envelope = {
      kind: 'step',
      jobId: job.id,
      stepId: step.id,
      type: 'open-pr',
      title: step.title,
      description: step.description,
      goal: step.goal,
      approach: step.approach,
      risks: step.risks,
      job: { source: job.source, title: job.title, description: job.description, externalRef: job.externalRef },
      previousSteps: job.steps
        .filter((st) => st.id !== step.id && st.type === 'action' && st.forwardOutput !== false && st.output)
        .map((st) => ({ id: st.id, title: st.title, action: (st as { action?: string }).action, output: (st as { output?: string }).output })),
      workspace: step.workspace,
      typePayload: {
        branch: step.workspace.branch,
        round: { kind: 'edit', editJobId: editJob.id },
        editJob: { id: editJob.id, comment, userNote: editJob.userNote },
      },
    };
    // Stable envelope path (not a per-round file): the resumed session re-reads its
    // original $OUTPOST_ENVELOPE, so the current round must land at that same path.
    const envelopePath = writeEnvelope(this.ctx.jobsDir, job.id, step.id, envelope);
    augmentEnvelopeWithLessons(envelopePath, this.opts.journalStore?.recent('code.fix-pr-comment') ?? []);

    // One resumable session per step: fall back to a fresh id only if the implement
    // round never recorded one (degrades to today's cold start rather than failing).
    const sessionId = step.sessionId ?? this.ctx.newId();
    const cwd = ws.path ?? this.orchestratorCwd();
    const env = {
      OUTPOST_ENVELOPE: envelopePath,
      JOB_ID: job.id,
      STEP_ID: step.id,
      STEP_TYPE: 'open-pr',
      EDIT_JOB_ID: editId,
    };
    // code.fix-pr-comment is reactive → immediate. The one-running-edit-per-step guard stays
    // in tickOne; markEditRunning (which flips the head edit to `running`) moves into run so it
    // fires exactly when the round actually starts.
    this.submitLaunch({
      key: `${job.id}#${step.id}`, jobId: job.id, stepId: step.id, sessionId, action: 'code.fix-pr-comment', label: 'edit',
      run: () => {
        this.markEditRunning(job.id, step.id, editId, sessionId);
        this.roleBySession.set(sessionId, { role: 'step', jobId: job.id, stepId: step.id });
        this.bindAction(sessionId, 'code.fix-pr-comment');
        this.opts.sessionManager.sendOrResume(
          sessionId,
          cwd,
          { type: 'user', message: { role: 'user', content: '/code.fix-pr-comment' } },
          env,
        );
        return true;
      },
    });
  }

  // Single-shot resume of the shared open-pr session for a state that decide() does
  // not self-dispatch (planning / implementing / spec revision). Rebuilds the envelope
  // for the current state (so the round + spec/plan artifacts are current) and resumes.
  // spawnStepSession's `s.sessionId` branch handles the resume; worktree provision is
  // idempotent.
  private async dispatchRound(jobId: string, stepId: string): Promise<void> {
    const j = this.opts.queue.get(jobId);
    const s = j?.steps.find((x) => x.id === stepId);
    if (!j || !s || s.type !== 'open-pr') return;
    const envelope = handlerFor(s).buildEnvelope(s, j, this.ctx);
    const path = writeEnvelope(this.ctx.jobsDir, jobId, stepId, envelope);
    await this.spawnStepSession(jobId, stepId, path);
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
      ws = await this.opts.worktreeManager.provision(stepId, s.workspace);
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
    // Open-pr steps own one resumable session for their whole life. The initial
    // implement round spawns it (no sessionId yet); triage rounds resume the same
    // conversation so the agent keeps full context (why the code looks as it does,
    // sibling comments for "same thing here", etc.).
    if (s.type === 'open-pr' && s.sessionId) {
      const sessionId = s.sessionId;
      // If the shared session is still mid-turn, its previous round's Stop hook hasn't
      // landed yet. That trailing Stop belongs to the round we're superseding here, not
      // to the one we're about to dispatch — record it so the Stop handler drops it
      // rather than failing this (live) step for "ended without submitting output".
      // Recorded SYNCHRONOUSLY (not inside run): a `queued` plan/spec resume may only fire
      // once that trailing Stop's releaseLaunchSlot frees the slot, so the owed stop must be
      // on the books before the Stop lands.
      if (this.opts.sessionManager.isWorking(sessionId)) {
        this.owedStaleStops.set(sessionId, (this.owedStaleStops.get(sessionId) ?? 0) + 1);
      }
      this.submitLaunch({
        key: `${jobId}#${stepId}`, jobId, stepId, sessionId, action: actionName, label: actionName,
        run: () => {
          const cur = this.opts.queue.get(jobId)?.steps.find((x) => x.id === stepId);
          if (!cur || cur.type !== 'open-pr' || cur.cancelled) return false;
          this.roleBySession.set(sessionId, { role: 'step', jobId, stepId });
          this.bindAction(sessionId, actionName);
          this.mutate(jobId, (j) => this.appendEvent(j, {
            kind: 'step_started', who: 'orchestrator', stepId, body: this.stepLabel(jobId, stepId),
          }));
          // A triage round runs a turn on the shared session; mark it in-flight so an edit
          // round can't overwrite the envelope mid-turn. markIterationPosted (on submit_replies),
          // dropOrphanIterations (pr-watcher, on new comments), and resolveIteration
          // (approve/reject) already drive it to a terminal state.
          if (actionName === 'code.triage-pr-comments') this.startIteration(jobId, stepId, 'replies');
          // Stable envelope path + sendOrResume: whether the proc is still alive (reads
          // the overwritten envelope.json) or was idle-reaped (respawn picks up extraEnv),
          // it re-reads the current round.
          this.opts.sessionManager.sendOrResume(
            sessionId,
            cwd,
            { type: 'user', message: { role: 'user', content: `/${actionName}` } },
            { OUTPOST_ENVELOPE: envelopePath, JOB_ID: jobId, STEP_ID: stepId, STEP_TYPE: 'open-pr' },
          );
          return true;
        },
      });
      return;
    }
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

  private mutateOpenPrStep(jobId: string, stepId: string, fn: (s: OpenPrStep) => OpenPrStep): void {
    this.opts.queue.mutate(jobId, (j) => {
      const steps = j.steps.map((s) => s.id === stepId && s.type === 'open-pr' ? fn(s) : s);
      return { ...j, steps };
    });
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
      case 'open-pr': {
        const ws = p.workspace;
        if (!ws) throw new Error('open-pr step requires workspace.repoCwd + workspace.branch');
        if (ws.kind !== 'writable') throw new Error('open-pr step requires writable workspace');
        const { keepId: _, ...rest } = p;
        return { ...rest, id, workspace: ws, state: initialStateForType('open-pr'), createdAt: now, updatedAt: now } as OpenPrStep;
      }
      case 'action': {
        if (this.opts.actionRegistry && !this.opts.actionRegistry.getAction(p.action)) {
          throw new Error(`unknown action ${JSON.stringify(p.action)} — not in registry`);
        }
        const ws = p.workspace ?? { kind: 'none' as const };
        const { keepId: _, ...rest } = p;
        return { ...rest, id, workspace: ws, state: initialStateForType('action'), createdAt: now, updatedAt: now } as Step;
      }
      case 'orchestrated': {
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
    case 'open-pr':
      base.goal = s.goal;
      base.approach = s.approach;
      base.risks = s.risks;
      break;
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
export type { ExternalEvent } from '../steps/types.js';
export type { Step, JobRecord, OpenPrStep, ProposedStep, PrComment } from './work-types.js';
