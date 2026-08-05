import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
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

const LEGACY_ACTION_JOURNAL = 'meta.plan-job.jsonl';
const RENAMED_ACTION_JOURNAL = 'meta.orchestrate.jsonl';

export class JournalStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    this.migrateLegacyActionJournal();
  }

  // One-time migration: `meta.plan-job`'s journal moved to `meta.orchestrate`
  // when the action was renamed. Merge rather than drop lessons if both
  // somehow exist (e.g. a run landed under the new name before this migrated).
  private migrateLegacyActionJournal(): void {
    const legacy = join(this.rootDir, LEGACY_ACTION_JOURNAL);
    const current = join(this.rootDir, RENAMED_ACTION_JOURNAL);
    if (!existsSync(legacy)) return;
    try {
      if (!existsSync(current)) {
        renameSync(legacy, current);
      } else {
        appendFileSync(current, readFileSync(legacy, 'utf8'), { mode: 0o600 });
        rmSync(legacy);
      }
      console.log('[journal] migrated meta.plan-job.jsonl -> meta.orchestrate.jsonl');
    } catch (e) {
      console.warn(`[journal] could not migrate legacy journal: ${(e as Error).message}`);
    }
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

  // True when this step already wrote a lesson. Lets the engine's failure backstop
  // defer to a session-authored lesson rather than duplicate it. An entry from the
  // same job with no stepId counts — nothing else in a job shares its jobId.
  hasEntryForStep(action: string, jobId: string, stepId?: string): boolean {
    return this.recent(action, DEDUPE_SCAN).some(
      (e) => e.jobId === jobId && (!e.stepId || !stepId || e.stepId === stepId),
    );
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
