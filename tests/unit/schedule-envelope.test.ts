import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EnvelopeEnricherRegistry, writeScheduleEnvelope } from '../../src/schedules/schedule-envelope.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sched-env-'));
});

describe('writeScheduleEnvelope', () => {
  it('writes the envelope where the session will read it, leaving no tmp residue', () => {
    const path = writeScheduleEnvelope(root, 'sess-1', { kind: 'schedule', skill: 'meta.improve-actions' });

    expect(path).toBe(join(root, 'schedule-runs', 'sess-1', 'envelope.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ kind: 'schedule', skill: 'meta.improve-actions' });
    // Atomic rename is the persistence contract for every store under ~/.outpost.
    expect(readdirSync(dirname(path))).toEqual(['envelope.json']);
  });

  it('overwrites a re-spawned session\'s envelope in place', () => {
    writeScheduleEnvelope(root, 'sess-1', { round: 1 });
    const path = writeScheduleEnvelope(root, 'sess-1', { round: 2 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ round: 2 });
  });
});

describe('EnvelopeEnricherRegistry', () => {
  it('resolves a registered skill and nothing else', () => {
    const reg = new EnvelopeEnricherRegistry();
    reg.register('meta.improve-actions', () => ({ envelope: { ok: true } }));
    expect(reg.get('meta.improve-actions')?.({ skill: 'meta.improve-actions' })).toEqual({ envelope: { ok: true } });
    expect(reg.get('read.investigate')).toBeUndefined();
  });
});
