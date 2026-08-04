import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreferencesStore } from '../../src/storage/preferences-store.js';

function newPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'prefs-test-')), 'preferences.json');
}

describe('PreferencesStore', () => {
  it('empty object when no file exists', () => {
    expect(new PreferencesStore(newPath()).get()).toEqual({});
  });

  it('merge shallow-merges and persists across instances', () => {
    const path = newPath();
    const a = new PreferencesStore(path);
    a.merge({ theme: 'ink', mode: 'dark' });
    a.merge({ theme: 'almanac' }); // overrides theme, keeps mode
    expect(a.get()).toEqual({ theme: 'almanac', mode: 'dark' });
    // reloads from disk in a fresh instance
    expect(new PreferencesStore(path).get()).toEqual({ theme: 'almanac', mode: 'dark' });
  });

  it('merge returns the merged blob', () => {
    const s = new PreferencesStore(newPath());
    expect(s.merge({ a: 1 })).toEqual({ a: 1 });
    expect(s.merge({ b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('get returns a copy — callers cannot mutate internal state', () => {
    const s = new PreferencesStore(newPath());
    s.merge({ theme: 'ink' });
    s.get().theme = 'tampered';
    expect(s.get().theme).toBe('ink');
  });

  it('malformed file is treated as empty', () => {
    const path = newPath();
    writeFileSync(path, '{ not json');
    expect(new PreferencesStore(path).get()).toEqual({});
  });

  it('a JSON array on disk is rejected (not a plain object)', () => {
    const path = newPath();
    writeFileSync(path, '[1,2,3]');
    expect(new PreferencesStore(path).get()).toEqual({});
  });

  it('persists via a tmp file + rename (final file exists, tmp does not)', () => {
    const path = newPath();
    new PreferencesStore(path).merge({ theme: 'ink' });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'ink' });
  });

  describe('getLaunchConcurrency', () => {
    it('defaults to 1 when absent', () => {
      expect(new PreferencesStore(newPath()).getLaunchConcurrency()).toBe(1);
    });

    it.each([0, -1, 2.5, 'x', null, {}])('defaults to 1 for invalid value %p', (bad) => {
      const s = new PreferencesStore(newPath());
      s.merge({ launchConcurrency: bad });
      expect(s.getLaunchConcurrency()).toBe(1);
    });

    it('passes through a valid integer', () => {
      const s = new PreferencesStore(newPath());
      s.merge({ launchConcurrency: 4 });
      expect(s.getLaunchConcurrency()).toBe(4);
    });

    it('reflects a prior merge across instances (reloaded from disk)', () => {
      const path = newPath();
      new PreferencesStore(path).merge({ launchConcurrency: 3 });
      expect(new PreferencesStore(path).getLaunchConcurrency()).toBe(3);
    });
  });
});
