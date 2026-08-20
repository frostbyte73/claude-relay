import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-action journal: append-only JSONL at <runtimeDir>/journal/<action>.jsonl.
// Each line is one session's takeaway — what happened and one short lesson the
// next run should know. Bounded by READ_LIMIT (recent lines surfaced to the next
// session); the file grows linearly but stays small in practice (KB per action).

export interface JournalEntry {
  at: number;
  jobId: string;
  stepId?: string;
  action: string;
  outcome: string;
  lesson: string;
}

const READ_LIMIT = 10;
// Tail scanned by hasEntryForStep. Wider than READ_LIMIT so a busy action's
// dedupe still sees this step's own entry; the file is KB-sized either way.
const DEDUPE_SCAN = 50;
const MAX_LESSON_LEN = 400;
const MAX_OUTCOME_LEN = 80;

function sanitizeAction(name: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return null;
  return name;
}

export class JournalStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }

  private fileFor(action: string): string | null {
    const safe = sanitizeAction(action);
    if (!safe) return null;
    return join(this.rootDir, `${safe}.jsonl`);
  }

  append(entry: Omit<JournalEntry, 'at'> & { at?: number }): JournalEntry | null {
    const path = this.fileFor(entry.action);
    if (!path) return null;
    const lesson = entry.lesson.trim().slice(0, MAX_LESSON_LEN);
    const outcome = entry.outcome.trim().slice(0, MAX_OUTCOME_LEN);
    if (!lesson || !outcome) return null;
    const row: JournalEntry = {
      at: entry.at ?? Date.now(),
      jobId: entry.jobId,
      stepId: entry.stepId,
      action: entry.action,
      outcome,
      lesson,
    };
    appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 });
    return row;
  }

  // True when this step already wrote a lesson. Lets the engine's failure backstop defer to
  // a session-authored lesson (any outcome word — 'blocked', an action-specific one like
  // 'unfixable', or anything else self-journaled via submit_journal) rather than duplicate
  // it. An entry from the same job with no stepId counts — nothing else in a job shares its
  // jobId.
  //
  // `opts.outcome` restricts the check to entries of exactly that outcome — used by a
  // denial's own repeat-suppression, which only cares whether IT already fired.
  // `opts.excludeOutcome` restricts it to entries NOT of that outcome — used by the failure
  // backstop, which must defer to any self-authored lesson but not to a mechanical
  // 'gated_denied' hook entry, which represents no such self-explanation and must not
  // suppress the step's real failure reason. At most one of the two is meaningful per call.
  hasEntryForStep(
    action: string, jobId: string, stepId?: string,
    opts: { outcome?: string; excludeOutcome?: string } = {},
  ): boolean {
    return this.recent(action, DEDUPE_SCAN).some((e) => {
      if (e.jobId !== jobId) return false;
      if (e.stepId && stepId && e.stepId !== stepId) return false;
      if (opts.outcome !== undefined && e.outcome !== opts.outcome) return false;
      if (opts.excludeOutcome !== undefined && e.outcome === opts.excludeOutcome) return false;
      return true;
    });
  }

  recent(action: string, limit: number = READ_LIMIT): JournalEntry[] {
    const path = this.fileFor(action);
    if (!path || !existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out: JournalEntry[] = [];
    for (const line of tail) {
      try { out.push(JSON.parse(line) as JournalEntry); } catch { /* skip */ }
    }
    return out;
  }
}
