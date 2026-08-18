import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DenialsStore, type DenialVerdict } from '../../src/storage/denials-store.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'denials-store-'));
  path = join(dir, 'denials.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function verdict(overrides: Partial<DenialVerdict> = {}): DenialVerdict {
  return {
    disposition: 'never',
    reason: 'not a real permission gap',
    decidedAt: 1_700_000_000_000,
    decidedBy: 'user',
    ...overrides,
  };
}

describe('DenialsStore', () => {
  it('persists a verdict across a store reopen', () => {
    const store = new DenialsStore(path);
    const denial = store.record({
      actionName: 'read.investigate', sessionId: 's1', toolName: 'Bash', toolInput: {},
      suggested: { kind: 'bash', value: '^sed ' },
    });
    expect(store.setVerdict('read.investigate', denial.id, verdict())).toBe(true);

    const reopened = new DenialsStore(path);
    expect(reopened.list('read.investigate')[0]?.verdict).toEqual(verdict());
  });

  it('returns false for setVerdict on an unknown id', () => {
    const store = new DenialsStore(path);
    store.record({
      actionName: 'read.investigate', sessionId: 's1', toolName: 'Bash', toolInput: {},
      suggested: { kind: 'bash', value: '^sed ' },
    });
    expect(store.setVerdict('read.investigate', 'nope', verdict())).toBe(false);
  });

  it('excludes anything carrying a verdict from unresolved()', () => {
    const store = new DenialsStore(path);
    const a = store.record({
      actionName: 'read.investigate', sessionId: 's1', toolName: 'Bash', toolInput: {},
      suggested: { kind: 'bash', value: '^sed ' },
    });
    store.record({
      actionName: 'read.investigate', sessionId: 's1', toolName: 'Bash', toolInput: {},
      suggested: { kind: 'bash', value: '^protoc ' },
    });
    store.setVerdict('read.investigate', a.id, verdict());

    const unresolved = store.unresolved('read.investigate');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.suggested.value).toBe('^protoc ');
  });

  it('loads a record persisted without a verdict field (migration tolerance)', () => {
    // ~/.outpost/denials.json is live state full of pre-Ship-6 records with no `verdict` key.
    writeFileSync(path, JSON.stringify({
      byAction: {
        'read.investigate': [{
          id: 'legacy1', actionName: 'read.investigate', sessionId: 's1', toolName: 'Bash',
          toolInput: {}, suggested: { kind: 'bash', value: '^sed ' }, at: Date.now(), count: 2,
        }],
      },
    }));
    const store = new DenialsStore(path);
    const list = store.list('read.investigate');
    expect(list).toHaveLength(1);
    expect(list[0]?.verdict).toBeUndefined();
    expect(store.unresolved('read.investigate')).toHaveLength(1);
  });

  it('record() on a verdicted denial bumps count without clobbering the verdict', () => {
    const store = new DenialsStore(path);
    const denial = store.record({
      actionName: 'read.investigate', sessionId: 's1', toolName: 'Bash', toolInput: {},
      suggested: { kind: 'bash', value: '^sed ' },
    });
    store.setVerdict('read.investigate', denial.id, verdict());

    const again = store.record({
      actionName: 'read.investigate', sessionId: 's2', toolName: 'Bash', toolInput: {},
      suggested: { kind: 'bash', value: '^sed ' },
    });

    expect(again.id).toBe(denial.id);
    expect(again.count).toBe(2);
    expect(again.verdict).toEqual(verdict());
  });
});
