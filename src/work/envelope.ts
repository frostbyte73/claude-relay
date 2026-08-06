import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dispatch, InboxItem, JobRecord, PlanIteration, PrFacts, Step, WorkspaceRef } from './work-types.js';
import type { JournalEntry } from '../storage/journal-store.js';
import type { ActionRegistry } from '../actions/registry.js';

export interface StepTypeCatalogEntry {
  type: Step['type'];
  description: string;
  required: string[];
  optional: string[];
  workspace?: string;
}

const WORKSPACE_SHAPE =
  'Exactly one of: {"kind":"none"} — no checkout; the session runs in the daemon cwd and can still read anywhere. '
  + '{"kind":"readonly","repoCwd":"/abs/path","ref":"main"} — detached checkout of ONE repo at `ref` (default HEAD); `repoCwd` is mandatory. '
  + '{"kind":"writable","repoCwd":"/abs/path","branch":"fix/x"} — worktree on its own branch; both fields mandatory. '
  + 'Use "none" for investigation that spans several repos or none — a readonly ref without repoCwd is rejected, not defaulted.';

export const STEP_TYPE_CATALOG: StepTypeCatalogEntry[] = [
  {
    type: 'action',
    description: 'Spawn a named action (skill) for one-shot work — investigation, code review, ops, etc. Pick the action from the catalog passed alongside this entry. Set forwardOutput=true (default) when downstream steps should see this step\'s output; false for ops work that doesn\'t produce findings.',
    required: ['title', 'description', 'action', 'goal'],
    optional: ['workspace', 'forwardOutput', 'parallelGroup'],
    workspace: `Defaults to {"kind":"none"} when omitted. ${WORKSPACE_SHAPE}`,
  },
  {
    type: 'orchestrated',
    description:
      'A step owned by a controller action that decides its own next move as events arrive. '
      + 'Use for long-lived, event-driven work: opening a PR and shepherding it to merge, reviewing '
      + "someone else's PR. Pick `controller` from the action catalog entries whose kind is "
      + 'step-orchestrator. The controller composes the other actions itself — do not plan its rounds.',
    required: ['title', 'description', 'controller', 'goal'],
    optional: ['inputs', 'workspace', 'parallelGroup'],
    workspace: `Defaults to {"kind":"none"} when omitted. ${WORKSPACE_SHAPE}`,
  },
];

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeEnvelope(jobsDir: string, jobId: string, stepId: string | null, envelope: object): string {
  const dir = stepId
    ? join(jobsDir, jobId, 'steps', stepId)
    : join(jobsDir, jobId, 'orchestrator');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'envelope.json');
  atomicWrite(path, JSON.stringify(envelope, null, 2));
  return path;
}

// Read an envelope written by a step handler, splice in recentLessons for the
// bound agent, and write it back to the same path. Called from spawn sites.
export function augmentEnvelopeWithLessons(path: string, lessons: JournalEntry[]): void {
  if (!lessons.length) return;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch { return; }
  parsed.recentLessons = lessons;
  atomicWrite(path, JSON.stringify(parsed, null, 2));
}

// Each action's signature as the orchestrator sees it (name + I/O schemas).
export interface ActionCatalogEntry {
  name: string;
  description: string;
  // 'step-orchestrator' entries are the only valid `controller` for an orchestrated step.
  kind: 'action' | 'step-orchestrator';
  category: string;
  runner: 'claude' | 'builtin';
  side_effects: 'none' | 'gated-write' | 'worktree-edit' | 'external-write';
  human_gate: boolean;
  input_schema: unknown;
  output_schema: unknown;
}

// Every envelope that offers a choice of actions — the orchestrator's plan, a controller's
// dispatch — reads the catalog from the same place, so a controller's turn 1 sees exactly what
// the planner saw.
export function buildActionCatalog(reg: ActionRegistry | undefined): ActionCatalogEntry[] | undefined {
  if (!reg) return undefined;
  return reg.listActions().map((a) => ({
    name: a.name,
    description: a.frontmatter.description,
    kind: a.frontmatter.outpost.kind,
    category: a.frontmatter.outpost.category,
    runner: a.frontmatter.outpost.runner,
    side_effects: a.frontmatter.outpost.side_effects,
    human_gate: a.frontmatter.outpost.human_gate ?? false,
    input_schema: a.inputSchema,
    output_schema: a.outputSchema,
  }));
}

export interface OrchestratorEnvelope {
  kind: 'orchestrator';
  mode: 'initial' | 'replan' | 'step-review';
  jobId: string;
  job: { source: JobRecord['source']; title: string; description: string; externalRef?: JobRecord['externalRef'] };
  stepTypeCatalog: StepTypeCatalogEntry[];
  actionCatalog?: ActionCatalogEntry[];
  currentSteps?: Step[];
  completedStepId?: string;   // step-review only: the step whose settling triggered this review
  userFeedback?: string;
  launchContext?: string; // initial only: free-text the user attached when launching
  rejectedIterations?: PlanIteration[];
  recentLessons?: JournalEntry[];
}

export interface StepEnvelopeBase {
  kind: 'step';
  jobId: string;
  stepId: string;
  title: string;
  description: string;
  job: { source: JobRecord['source']; title: string; description: string; externalRef?: JobRecord['externalRef'] };
  previousSteps: Array<{ id: string; title: string; action?: string; output?: string }>;
  recentLessons?: JournalEntry[];
}

export interface ActionEnvelope extends StepEnvelopeBase {
  type: 'action';
  action: string;
  goal: string;
  workspace: { kind: 'none' } | { kind: 'readonly'; repoCwd: string; ref?: string } | { kind: 'writable'; repoCwd: string; branch: string };
  typePayload: Record<string, never>;
}

export interface OrchestratedEnvelope extends StepEnvelopeBase {
  type: 'orchestrated';
  controller: string;
  goal: string;
  inputs?: Record<string, unknown>;
  workspace: WorkspaceRef;
  phase?: string;
  memo?: string;
  artifacts?: Record<string, string>;
  roundsRemaining: number;
  // Present when the daemon is resuming the controller with work it must act on.
  delivered?: InboxItem[];
  dispatches?: Array<Pick<Dispatch, 'id' | 'action' | 'brief' | 'status' | 'output' | 'failure'>>;
  pr?: PrFacts;
  // resolveGate drops the gate-resolved marker before running the deferred move, so an approval
  // leaves no inbox item behind — these flags are the only durable record the controller has
  // that the user said yes (and what they said).
  gateApproved?: boolean;
  gateFeedback?: string[];
  // Set on a work turn: the controller is wearing this action's hat this turn.
  boundAction?: string;
  boundNote?: string;
  actionCatalog?: ActionCatalogEntry[];
}

export type StepEnvelope = ActionEnvelope | OrchestratedEnvelope;
