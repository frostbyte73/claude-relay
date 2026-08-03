import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobRecord, PlanIteration, Step } from './work-types.js';
import type { JournalEntry } from '../storage/journal-store.js';

export interface StepTypeCatalogEntry {
  type: Step['type'];
  description: string;
  required: string[];
  optional: string[];
}

export const STEP_TYPE_CATALOG: StepTypeCatalogEntry[] = [
  {
    type: 'open-pr',
    description: 'Implement code changes in one repo and open a PR. Implementer + PR comment handling are handled by Outpost; you provide goal/approach/risks/branch.',
    required: ['title', 'description', 'goal', 'approach', 'workspace.repoCwd', 'workspace.branch'],
    optional: ['risks', 'parallelGroup'],
  },
  {
    type: 'action',
    description: 'Spawn a named action (skill) for one-shot work — investigation, code review, ops, etc. Pick the action from the catalog passed alongside this entry. Set forwardOutput=true (default) when downstream steps should see this step\'s output; false for ops work that doesn\'t produce findings.',
    required: ['title', 'description', 'action', 'goal'],
    optional: ['workspace', 'forwardOutput', 'parallelGroup'],
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
  category: string;
  runner: 'claude' | 'builtin';
  side_effects: 'none' | 'gated-write' | 'worktree-edit' | 'external-write';
  human_gate: boolean;
  input_schema: unknown;
  output_schema: unknown;
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

export interface OpenPrEnvelope extends StepEnvelopeBase {
  type: 'open-pr';
  goal: string;
  approach: string;
  risks?: string;
  spec?: string;      // present from the plan round onward
  implPlan?: string;  // present in the implement round
  workspace: { kind: 'writable'; repoCwd: string; branch: string };
  typePayload: {
    branch: string;
    round:
      | 'initial'
      | { kind: 'spec'; feedback?: string[] }
      | { kind: 'plan' }
      | { kind: 'pr-comments'; comments: unknown[] }
      | { kind: 'conflict'; base?: string; push?: boolean; postAction?: 'squash-to-base' }
      | { kind: 'ci-fix'; checks: { name: string; url?: string }[] };
  };
}

export interface ActionEnvelope extends StepEnvelopeBase {
  type: 'action';
  action: string;
  goal: string;
  workspace: { kind: 'none' } | { kind: 'readonly'; repoCwd: string; ref?: string } | { kind: 'writable'; repoCwd: string; branch: string };
  typePayload: Record<string, never>;
}

export type StepEnvelope = OpenPrEnvelope | ActionEnvelope;
