import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Guard, Routing, RunOutcome, ScheduleRecord, ScheduleRun, Trigger, What } from './types.js';
import { normalizeWhat } from './types.js';

// Bounded per-schedule retention for the run log — recent runs are what the UI ("Recent runs"
// card, Runs history) needs; unbounded growth would make the index.json grow forever.
const MAX_RUNS_PER_SCHEDULE = 200;

interface Persisted {
  schedules?: ScheduleRecord[];
  runs?: ScheduleRun[];
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface CreateScheduleInput {
  id?: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  what: What;
  guards: Guard[];
  routing: Routing;
}

export type ScheduleUpdate = Partial<Pick<ScheduleRecord, 'name' | 'enabled' | 'trigger' | 'what' | 'guards' | 'routing'>>;

export interface StartRunInput {
  id?: string;
  outcome: RunOutcome;
  skipReason?: string;
  refs?: ScheduleRun['refs'];
  startedAt?: number;
}

export type RunUpdate = Partial<Omit<ScheduleRun, 'id' | 'scheduleId' | 'startedAt'>>;

export class SchedulesStore {
  private schedules = new Map<string, ScheduleRecord>();
  private runs = new Map<string, ScheduleRun>();
  // Insertion-ordered run ids per schedule, oldest first — drives MAX_RUNS_PER_SCHEDULE trim.
  private runOrder = new Map<string, string[]>();

  constructor(
    private readonly path: string,
    private readonly newId: () => string = () => randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!existsSync(path)) return;
    let parsed: Persisted;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Persisted; }
    catch { return; }
    for (const s of parsed.schedules ?? []) this.schedules.set(s.id, { ...s, what: normalizeWhat(s.what) });
    for (const r of parsed.runs ?? []) {
      this.runs.set(r.id, r);
      const order = this.runOrder.get(r.scheduleId) ?? [];
      order.push(r.id);
      this.runOrder.set(r.scheduleId, order);
    }
  }

  // ── Schedules ──────────────────────────────────────────────

  list(): ScheduleRecord[] {
    return [...this.schedules.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ScheduleRecord | undefined {
    return this.schedules.get(id);
  }

  create(input: CreateScheduleInput): ScheduleRecord {
    const now = this.now();
    const record: ScheduleRecord = {
      id: input.id ?? this.newId(),
      name: input.name,
      enabled: input.enabled,
      trigger: input.trigger,
      what: normalizeWhat(input.what),
      guards: input.guards,
      routing: input.routing,
      createdAt: now,
      updatedAt: now,
    };
    this.schedules.set(record.id, record);
    this.persist();
    return record;
  }

  // Seeds a builtin schedule at daemon startup. Idempotent on `record.id` so re-seeding on
  // every boot never clobbers a user's edits to timing/enabled state.
  ensureBuiltin(record: { id: string; name: string; trigger: Trigger; what: What; enabled?: boolean }): ScheduleRecord {
    const existing = this.get(record.id);
    if (existing) return existing;
    const now = this.now();
    const full: ScheduleRecord = {
      id: record.id,
      name: record.name,
      enabled: record.enabled ?? true,
      trigger: record.trigger,
      what: normalizeWhat(record.what),
      guards: [],
      routing: {},
      builtin: true,
      createdAt: now,
      updatedAt: now,
    };
    this.schedules.set(full.id, full);
    this.persist();
    return full;
  }

  update(id: string, patch: ScheduleUpdate): ScheduleRecord | null {
    const cur = this.schedules.get(id);
    if (!cur) return null;
    const next: ScheduleRecord = { ...cur, ...patch, updatedAt: this.now() };
    if (patch.what) next.what = normalizeWhat(patch.what);
    this.schedules.set(id, next);
    this.persist();
    return next;
  }

  setEnabled(id: string, enabled: boolean): ScheduleRecord | null {
    return this.update(id, { enabled });
  }

  duplicate(id: string): ScheduleRecord | null {
    const cur = this.schedules.get(id);
    if (!cur) return null;
    // Duplicated schedules start paused — two active copies of the same automation firing
    // in parallel is very likely a mistake, not intent.
    return this.create({
      name: `${cur.name} copy`,
      enabled: false,
      trigger: cur.trigger,
      what: cur.what,
      guards: cur.guards,
      routing: cur.routing,
    });
  }

  remove(id: string): boolean {
    if (!this.schedules.delete(id)) return false;
    for (const runId of this.runOrder.get(id) ?? []) this.runs.delete(runId);
    this.runOrder.delete(id);
    this.persist();
    return true;
  }

  // ── Runs ───────────────────────────────────────────────────

  startRun(scheduleId: string, input: StartRunInput): ScheduleRun | null {
    if (!this.schedules.has(scheduleId)) return null;
    const run: ScheduleRun = {
      id: input.id ?? this.newId(),
      scheduleId,
      startedAt: input.startedAt ?? this.now(),
      outcome: input.outcome,
      skipReason: input.skipReason,
      refs: input.refs,
      finishedAt: input.outcome === 'skipped' ? (input.startedAt ?? this.now()) : undefined,
    };
    this.runs.set(run.id, run);
    const order = this.runOrder.get(scheduleId) ?? [];
    order.push(run.id);
    while (order.length > MAX_RUNS_PER_SCHEDULE) {
      const evicted = order.shift();
      if (evicted) this.runs.delete(evicted);
    }
    this.runOrder.set(scheduleId, order);
    this.persist();
    return run;
  }

  updateRun(runId: string, patch: RunUpdate): ScheduleRun | null {
    const cur = this.runs.get(runId);
    if (!cur) return null;
    const next: ScheduleRun = { ...cur, ...patch };
    this.runs.set(runId, next);
    this.persist();
    return next;
  }

  getRun(runId: string): ScheduleRun | undefined {
    return this.runs.get(runId);
  }

  findRunByRef(ref: { jobId?: string; sessionId?: string }): ScheduleRun | undefined {
    if (!ref.jobId && !ref.sessionId) return undefined;
    for (const run of this.runs.values()) {
      if (ref.jobId && run.refs?.jobId === ref.jobId) return run;
      if (ref.sessionId && run.refs?.sessionId === ref.sessionId) return run;
    }
    return undefined;
  }

  listRuns(scheduleId: string, limit?: number): ScheduleRun[] {
    const ids = this.runOrder.get(scheduleId) ?? [];
    const runs = ids.map((id) => this.runs.get(id)).filter((r): r is ScheduleRun => !!r);
    runs.sort((a, b) => b.startedAt - a.startedAt);
    return limit ? runs.slice(0, limit) : runs;
  }

  lastRun(scheduleId: string, opts?: { excludeSkipped?: boolean }): ScheduleRun | undefined {
    const runs = this.listRuns(scheduleId);
    if (!opts?.excludeSkipped) return runs[0];
    return runs.find((r) => r.outcome !== 'skipped');
  }

  private persist(): void {
    const out: Persisted = {
      schedules: this.list(),
      runs: [...this.runs.values()],
    };
    atomicWrite(this.path, JSON.stringify(out, null, 2) + '\n');
  }
}
