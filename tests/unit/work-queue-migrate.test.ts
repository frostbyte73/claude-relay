import { describe, it, expect } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue, migrateJobRecord } from '../../src/work/work-queue.js';

function tempRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), 'outpost-jobqueue-'));
}

function writeLegacyJob(runtimeDir: string, id: string, updatedAt: number): void {
  const jobsDir = join(runtimeDir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const record = {
    id,
    source: 'manual',
    title: 'legacy job',
    description: 'desc',
    state: 'executing',
    steps: [],
    plannerSessionId: 'sess-legacy-1',
    plannerAction: 'meta.plan-job',
    autoReplanCount: 2,
    events: [{ id: 'ev1', at: 1, kind: 'planner_started', who: 'planner' }],
    createdAt: 1,
    updatedAt,
  };
  writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify(record, null, 2));
  mkdirSync(join(jobsDir, id, 'planner'), { recursive: true });
  writeFileSync(join(jobsDir, id, 'planner', 'envelope.json'), JSON.stringify({ kind: 'orchestrator' }));
}

describe('JobQueue legacy planner migration', () => {
  it('migrates fields, events, on-disk record, and envelope dir without bumping updatedAt', () => {
    const runtimeDir = tempRuntimeDir();
    const updatedAt = 12345;
    writeLegacyJob(runtimeDir, 'job-1', updatedAt);

    const queue = new JobQueue(runtimeDir);
    const job = queue.get('job-1');

    expect(job).toBeDefined();
    expect((job as any).orchestratorSessionId).toBe('sess-legacy-1');
    expect(job!.orchestratorAction).toBe('meta.orchestrate');
    expect((job as any).plannerSessionId).toBeUndefined();
    expect((job as any).plannerAction).toBeUndefined();
    expect((job as any).autoReplanCount).toBeUndefined();
    expect(job!.events).toEqual([{ id: 'ev1', at: 1, kind: 'orchestrator_started', who: 'orchestrator' }]);
    expect(job!.updatedAt).toBe(updatedAt);

    const onDisk = JSON.parse(readFileSync(join(runtimeDir, 'jobs', 'job-1.json'), 'utf8'));
    expect(onDisk.orchestratorSessionId).toBe('sess-legacy-1');
    expect(onDisk.orchestratorAction).toBe('meta.orchestrate');
    expect(onDisk.plannerSessionId).toBeUndefined();
    expect(onDisk.plannerAction).toBeUndefined();
    expect(onDisk.autoReplanCount).toBeUndefined();
    expect(onDisk.events).toEqual([{ id: 'ev1', at: 1, kind: 'orchestrator_started', who: 'orchestrator' }]);
    expect(onDisk.updatedAt).toBe(updatedAt);

    expect(existsSync(join(runtimeDir, 'jobs', 'job-1', 'planner'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'jobs', 'job-1', 'orchestrator', 'envelope.json'))).toBe(true);
  });

  it('resets never-dispatched legacy open-pr steps (implementing/planning, no session/PR) to speccing', () => {
    const raw = {
      id: 'job-3', source: 'manual', title: 't', description: 'd', state: 'executing',
      createdAt: 1, updatedAt: 1,
      steps: [
        // Legacy orphan: materialized as 'implementing' pre-spec-flow, never dispatched.
        { id: 'a', type: 'open-pr', title: 'a', state: 'implementing', workspace: { kind: 'writable', repoCwd: '/x', branch: 'b' } },
        // Same, but 'planning'.
        { id: 'b', type: 'open-pr', title: 'b', state: 'planning', workspace: { kind: 'writable', repoCwd: '/x', branch: 'b' } },
        // Live implementing step with a session — must NOT be touched.
        { id: 'c', type: 'open-pr', title: 'c', state: 'implementing', sessionId: 's', workspace: { kind: 'writable', repoCwd: '/x', branch: 'b' } },
        // Recovered step with a PR — must NOT be touched.
        { id: 'd', type: 'open-pr', title: 'd', state: 'implementing', prUrl: 'http://x', workspace: { kind: 'writable', repoCwd: '/x', branch: 'b' } },
        // Cancelled — must NOT be touched.
        { id: 'e', type: 'open-pr', title: 'e', state: 'implementing', cancelled: true, workspace: { kind: 'writable', repoCwd: '/x', branch: 'b' } },
      ],
      events: [],
    };
    const { job, changed } = migrateJobRecord(raw);
    expect(changed).toBe(true);
    const byId = Object.fromEntries(job.steps.map((s: any) => [s.id, s.state]));
    expect(byId).toEqual({ a: 'speccing', b: 'speccing', c: 'implementing', d: 'implementing', e: 'implementing' });
  });

  it('is a no-op for an already-migrated record (idempotent, no rewrite)', () => {
    const runtimeDir = tempRuntimeDir();
    const jobsDir = join(runtimeDir, 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    const updatedAt = 999;
    const record = {
      id: 'job-2',
      source: 'manual',
      title: 'migrated job',
      description: 'desc',
      state: 'executing',
      steps: [],
      orchestratorSessionId: 'sess-2',
      orchestratorAction: 'meta.orchestrate',
      events: [{ id: 'ev1', at: 1, kind: 'orchestrator_started', who: 'orchestrator' }],
      createdAt: 1,
      updatedAt,
    };
    const path = join(jobsDir, 'job-2.json');
    writeFileSync(path, JSON.stringify(record, null, 2));
    const before = readFileSync(path, 'utf8');

    const queue = new JobQueue(runtimeDir);
    const job = queue.get('job-2');

    expect(job!.orchestratorSessionId).toBe('sess-2');
    expect(job!.orchestratorAction).toBe('meta.orchestrate');
    expect(job!.updatedAt).toBe(updatedAt);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
