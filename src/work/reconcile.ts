import type { ProposedStep, Step } from './work-types.js';

export interface Reconciliation {
  kept: Array<{ stepId: string; patch: Record<string, unknown> }>;
  added: ProposedStep[];
  cancelled: string[];
}

const MUTABLE_FIELDS = ['title', 'description', 'goal', 'approach', 'risks', 'parallelGroup', 'action', 'forwardOutput', 'inputs'] as const;

// Structural, not by reference: `inputs` (and any other object- or array-valued field) arrives
// fresh off the planner's JSON every time, so `!==` reports a change for a step restated
// verbatim. That made every restatement a patch — harmless on a live step, but it's what
// validateDispositions reads to decide whether a completed step is being rewritten.
function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
    && JSON.stringify(a) === JSON.stringify(b));
}

function buildPatch(current: Step, proposed: ProposedStep): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const cur = current as unknown as Record<string, unknown>;
  const pro = proposed as unknown as Record<string, unknown>;
  for (const f of MUTABLE_FIELDS) {
    const next = pro[f];
    const prev = cur[f];
    if (next !== undefined && !same(next, prev)) patch[f] = next;
  }
  return patch;
}

export type DispositionCheck =
  | { ok: true }
  | { ok: false; error: string };

// A step that finished successfully is history, not plan: its session ran, its output is
// recorded, its PR exists. Rewording its goal or swapping its action would rewrite the record
// of what actually happened, and dropping it would erase it from the timeline the user reads to
// see what's already done. `failed` and `declined` steps stay fully mutable — replanning around
// those is the whole point of an amendment.
function isCompleted(s: Step): boolean {
  return s.state === 'resolved';
}

// Every non-cancelled step in `current` must appear exactly once: either as a
// `keepId` on some proposed step or as an entry in `drops`. Overlap, unknown
// ids, and missing dispositions are all rejected — implicit cancellation is
// gone, so an omission is a bug the orchestrator should hear about.
export function validateDispositions(current: Step[], proposed: ProposedStep[], drops: string[]): DispositionCheck {
  const currentIds = new Set(current.map((s) => s.id));
  const byId = new Map(current.map((s) => [s.id, s]));

  const keepIds = new Set<string>();
  for (const p of proposed) {
    if (!p.keepId) continue;
    if (!currentIds.has(p.keepId)) {
      return { ok: false, error: `keepId "${p.keepId}" does not match any step in currentSteps` };
    }
    if (keepIds.has(p.keepId)) {
      return { ok: false, error: `keepId "${p.keepId}" is referenced by more than one proposed step` };
    }
    keepIds.add(p.keepId);
    const cur = byId.get(p.keepId)!;
    if (isCompleted(cur)) {
      const changed = Object.keys(buildPatch(cur, p));
      if (changed.length > 0) {
        return {
          ok: false,
          error: `step "${p.keepId}" ("${cur.title}") already completed — restate it verbatim (keepId plus its current fields) instead of changing ${changed.join(', ')}. Completed work is a record of what happened; propose a NEW step for the follow-up you have in mind.`,
        };
      }
      if (p.type !== cur.type) {
        return { ok: false, error: `step "${p.keepId}" ("${cur.title}") already completed — its type cannot change from ${cur.type} to ${p.type}` };
      }
    }
  }

  const dropSet = new Set<string>();
  for (const id of drops) {
    if (!currentIds.has(id)) {
      return { ok: false, error: `drop id "${id}" does not match any step in currentSteps` };
    }
    if (dropSet.has(id)) {
      return { ok: false, error: `drop id "${id}" listed more than once` };
    }
    const cur = byId.get(id)!;
    if (isCompleted(cur)) {
      return {
        ok: false,
        error: `step "${id}" ("${cur.title}") already completed and cannot be dropped — keep it (keepId, unchanged). Dropping it would erase work that already ran from the plan.`,
      };
    }
    dropSet.add(id);
  }

  const overlap = [...keepIds].filter((id) => dropSet.has(id));
  if (overlap.length > 0) {
    return { ok: false, error: `step id(s) both kept and dropped: ${overlap.join(', ')}` };
  }

  const missing = current
    .filter((s) => !s.cancelled && !keepIds.has(s.id) && !dropSet.has(s.id))
    .map((s) => `${s.id} ("${s.title}")`);
  if (missing.length > 0) {
    return { ok: false, error: `every non-cancelled step in currentSteps needs a disposition (keepId or drops). Missing: ${missing.join('; ')}` };
  }

  return { ok: true };
}

export function reconcile(current: Step[], proposed: ProposedStep[], drops: string[]): Reconciliation {
  const byId = new Map(current.map((s) => [s.id, s]));
  const kept: Reconciliation['kept'] = [];
  const added: ProposedStep[] = [];

  for (const p of proposed) {
    const match = p.keepId ? byId.get(p.keepId) : undefined;
    if (match) {
      kept.push({ stepId: match.id, patch: buildPatch(match, p) });
    } else {
      added.push(p);
    }
  }

  return { kept, added, cancelled: [...drops] };
}
