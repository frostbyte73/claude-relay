import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateVapid } from '../../src/push-keys.js';

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'vapid-'));
}

describe('loadOrCreateVapid', () => {
  it('generates a fresh keypair when the file does not exist', () => {
    const path = join(newDir(), 'vapid.json');
    expect(existsSync(path)).toBe(false);
    const keys = loadOrCreateVapid(path);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(keys.subject).toBe('mailto:outpost@localhost');
    expect(existsSync(path)).toBe(true);
  });

  it('persists with 0600 permissions', () => {
    const path = join(newDir(), 'vapid.json');
    loadOrCreateVapid(path);
    const st = statSync(path);
    expect((st.mode & 0o777).toString(8)).toBe('600');
  });

  it('returns the same keys on subsequent calls (no rotation)', () => {
    const path = join(newDir(), 'vapid.json');
    const a = loadOrCreateVapid(path);
    const b = loadOrCreateVapid(path);
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.privateKey).toBe(a.privateKey);
  });

  it('loads an existing file verbatim (does not regenerate)', () => {
    const path = join(newDir(), 'vapid.json');
    const seeded = {
      publicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      privateKey: 'nKWi5fOlH-WbPP-NTGTQ_z71yOnyPELzMpV0Xr0w6ms',
      subject: 'mailto:custom@example.org',
    };
    writeFileSync(path, JSON.stringify(seeded), { mode: 0o600 });
    const loaded = loadOrCreateVapid(path);
    expect(loaded).toEqual(seeded);
  });

  it('throws if file exists but is unreadable JSON', () => {
    const path = join(newDir(), 'vapid.json');
    writeFileSync(path, 'not json{{{', { mode: 0o600 });
    expect(() => loadOrCreateVapid(path)).toThrow();
  });
});
