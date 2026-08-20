import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/storage/project-registry.js';

function newPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pr-test-')), 'projects.json');
}

describe('ProjectRegistry', () => {
  it('empty list when no file exists', () => {
    const r = new ProjectRegistry(newPath());
    expect(r.list()).toEqual([]);
  });

  it('add returns true the first time, false on duplicate', () => {
    const r = new ProjectRegistry(newPath());
    expect(r.add('/tmp/a')).toBe(true);
    expect(r.add('/tmp/a')).toBe(false);
    expect(r.list().map((p) => p.cwd)).toEqual(['/tmp/a']);
  });

  it('stores addedAt as a timestamp', () => {
    const r = new ProjectRegistry(newPath());
    const before = Date.now();
    r.add('/tmp/b');
    const after = Date.now();
    const entry = r.list()[0]!;
    expect(entry.addedAt).toBeGreaterThanOrEqual(before);
    expect(entry.addedAt).toBeLessThanOrEqual(after);
  });

  it('remove returns true if present, false if absent', () => {
    const r = new ProjectRegistry(newPath());
    r.add('/tmp/c');
    expect(r.remove('/tmp/c')).toBe(true);
    expect(r.remove('/tmp/c')).toBe(false);
    expect(r.list()).toEqual([]);
  });

  it('persists across instances (round-trip)', () => {
    const path = newPath();
    const r1 = new ProjectRegistry(path);
    r1.add('/tmp/d');
    r1.add('/tmp/e');
    const r2 = new ProjectRegistry(path);
    expect(r2.list().map((p) => p.cwd).sort()).toEqual(['/tmp/d', '/tmp/e']);
  });

  it('survives a malformed file (treats it as empty)', () => {
    const path = newPath();
    writeFileSync(path, 'not json at all');
    const r = new ProjectRegistry(path);
    expect(r.list()).toEqual([]);
    expect(r.add('/tmp/x')).toBe(true);
  });

  it('persists with 0o600 file mode', () => {
    const path = newPath();
    const r = new ProjectRegistry(path);
    r.add('/tmp/y');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('list returns a copy (caller mutation does not affect internal state)', () => {
    const r = new ProjectRegistry(newPath());
    r.add('/tmp/z');
    const copy = r.list();
    copy.pop();
    expect(r.list()).toHaveLength(1);
  });
});
