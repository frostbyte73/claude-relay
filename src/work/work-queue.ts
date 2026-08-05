import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobRecord } from './work-types.js';
import { deleteJobEventLog } from '../storage/job-event-log.js';
import { migrateJob } from '../storage/jobs-migrate.js';

export type QueueEvent =
  | { kind: 'upsert'; jobId: string; job: JobRecord }
  | { kind: 'delete'; jobId: string };

const EVENT_KIND_RENAMES: Record<string, string> = {
  planner_started: 'orchestrator_started',
  planner_reopened: 'orchestrator_reopened',
};

// One-time migration of legacy planner-named fields to their orchestrator
// equivalents. Idempotent — already-migrated records are returned unchanged
// with `changed: false` so callers can skip the re-persist/re-index work.
export function migrateJobRecord(raw: any): { job: JobRecord; changed: boolean } {
  let changed = false;
  const job = { ...raw };

  if (job.plannerSessionId !== undefined) {
    changed = true;
    if (job.orchestratorSessionId === undefined) job.orchestratorSessionId = job.plannerSessionId;
    delete job.plannerSessionId;
  }

  if (job.plannerAction !== undefined) {
    changed = true;
    if (job.orchestratorAction === undefined) job.orchestratorAction = job.plannerAction;
    delete job.plannerAction;
  }
  if (job.orchestratorAction === 'meta.plan-job') {
    job.orchestratorAction = 'meta.orchestrate';
    changed = true;
  }

  if (job.autoReplanCount !== undefined) {
    delete job.autoReplanCount;
    changed = true;
  }

  // Pre-spec-flow open-pr steps were materialized with initialState 'implementing';
  // the spec→plan→implement rounds were added later, moving the initial state to
  // 'speccing'. A step still sitting in 'implementing'/'planning' with no session, no
  // PR, and no spec/plan artifacts was never actually dispatched — those states are
  // only reachable via a transition that also sets a sessionId, so this shape exists
  // only on legacy records. decide() cold-starts an open-pr step solely from 'speccing',
  // so such a step strands forever (e.g. the untouched siblings of a parallel group
  // whose first member dispatched under the old parallel-first-only bug). Reset them to
  // the current initial state so they cold-start through the normal flow.
  if (Array.isArray(job.steps)) {
    job.steps = job.steps.map((s: any) => {
      if (
        s?.type === 'open-pr'
        && (s.state === 'implementing' || s.state === 'planning')
        && !s.sessionId && !s.prUrl && !s.spec && !s.implPlan && !s.cancelled
      ) {
        changed = true;
        return { ...s, state: 'speccing' };
      }
      return s;
    });
  }

  if (Array.isArray(job.events)) {
    const migratedEvents = job.events.map((ev: any) => {
      const renamedKind = EVENT_KIND_RENAMES[ev?.kind];
      const renamedWho = ev?.who === 'planner' ? 'orchestrator' : ev?.who;
      if (renamedKind === undefined && renamedWho === ev?.who) return ev;
      changed = true;
      return { ...ev, ...(renamedKind !== undefined ? { kind: renamedKind } : {}), who: renamedWho };
    });
    job.events = migratedEvents;
  }

  return { job: job as JobRecord, changed };
}

export class JobQueue {
  private readonly dir: string;
  private readonly index = new Map<string, JobRecord>();
  private readonly subscribers = new Set<(ev: QueueEvent) => void>();
  private _lastLinearSyncAt: number | undefined;

  constructor(rootDir: string) {
    this.dir = join(rootDir, 'jobs');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.loadAll();
    this.loadMeta();
  }

  private jobFile(id: string) { return join(this.dir, `${id}.json`); }
  private metaFile() { return join(this.dir, 'meta.json'); }

  private loadAll() {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f === 'meta.json') continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
        const { job, changed } = migrateJobRecord(raw);
        if (!job?.id) continue;
        if (changed) this.writeJobFile(job);
        this.migrateEnvelopeDir(job.id);
        // Runs on every boot, in memory only, until a normal write naturally
        // rewrites the record — never persisted directly by the migration itself.
        this.index.set(job.id, migrateJob(job));
      } catch { /* corrupted — skip */ }
    }
  }

  // Shared atomic write. Migration callers pass the record through untouched
  // (no updatedAt bump) — this is a migration, not an edit, and must not
  // perturb ordering/sync semantics.
  private writeJobFile(job: JobRecord): void {
    const path = this.jobFile(job.id);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  // Legacy on-disk envelope dirs were named `planner/`; best-effort rename to
  // `orchestrator/` so new spawns and this record agree on the layout.
  private migrateEnvelopeDir(jobId: string): void {
    const legacy = join(this.dir, jobId, 'planner');
    const current = join(this.dir, jobId, 'orchestrator');
    if (!existsSync(legacy) || existsSync(current)) return;
    try {
      renameSync(legacy, current);
    } catch (e) {
      console.warn(`[work] could not migrate envelope dir for job ${jobId}: ${(e as Error).message}`);
    }
  }

  private loadMeta() {
    const path = this.metaFile();
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { lastLinearSyncAt?: number };
      if (typeof parsed?.lastLinearSyncAt === 'number') this._lastLinearSyncAt = parsed.lastLinearSyncAt;
    } catch { /* ignore */ }
  }

  private persistMeta() {
    const path = this.metaFile();
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ lastLinearSyncAt: this._lastLinearSyncAt }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  get(id: string): JobRecord | undefined { return this.index.get(id); }

  list(): JobRecord[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  upsert(job: JobRecord): JobRecord {
    this.writeJobFile(job);
    this.index.set(job.id, job);
    for (const cb of this.subscribers) cb({ kind: 'upsert', jobId: job.id, job });
    return job;
  }

  // Atomic read-modify-write. Returns the new job (or undefined if not found).
  // Bumps updatedAt automatically; the mutator may override it explicitly.
  mutate(jobId: string, fn: (j: JobRecord) => JobRecord): JobRecord | undefined {
    const cur = this.index.get(jobId);
    if (!cur) return undefined;
    const next = fn(cur);
    return this.upsert({ ...next, updatedAt: next.updatedAt === cur.updatedAt ? Date.now() : next.updatedAt });
  }

  delete(id: string): void {
    if (!this.index.has(id)) return;
    const path = this.jobFile(id);
    if (existsSync(path)) rmSync(path);
    deleteJobEventLog(this.dir, id);
    this.index.delete(id);
    for (const cb of this.subscribers) cb({ kind: 'delete', jobId: id });
  }

  subscribe(cb: (ev: QueueEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  get lastLinearSyncAt(): number | undefined { return this._lastLinearSyncAt; }

  recordLinearSync(at: number = Date.now()): void {
    this._lastLinearSyncAt = at;
    this.persistMeta();
  }
}
