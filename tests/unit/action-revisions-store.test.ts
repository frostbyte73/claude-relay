import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRevisionsStore } from '../../src/storage/action-revisions-store.js';

const NOW = 1_700_000_000_000;

let root: string;
let storeDir: string;
let actionDir: string;
let seq: number;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'action-rev-'));
  storeDir = join(root, 'action-revisions');
  actionDir = join(root, 'actions', 'read', 'investigate');
  mkdirSync(actionDir, { recursive: true });
  seq = 0;
  clock = NOW;
});

function store(maxEvents?: number, maxBodies?: number): ActionRevisionsStore {
  return new ActionRevisionsStore(storeDir, () => `e${++seq}`, () => (clock += 1), maxEvents, maxBodies);
}

function skillMd(): string {
  return readFileSync(join(actionDir, 'SKILL.md'), 'utf8');
}

function bodyFiles(): string[] {
  return readdirSync(join(storeDir, 'bodies'));
}

function indexLines(): string[] {
  return readFileSync(join(storeDir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
}

describe('applyWrite genesis', () => {
  it('snapshots a pre-existing SKILL.md before the first apply', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'original\n');
    const s = store();
    s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'revised\n', author: 'user' });

    const events = s.listByAction('read.investigate');
    expect(events.map((e) => [e.kind, e.author])).toEqual([['applied', 'user'], ['created', 'system']]);
    expect(s.bodyFor(events[1]!.bodySha)).toBe('original\n');
    expect(s.bodyFor(events[0]!.bodySha)).toBe('revised\n');
    expect(skillMd()).toBe('revised\n');
  });

  it('records a lone created event when the action has no file yet', () => {
    const s = store();
    s.applyWrite({ action: 'meta.new', dir: join(root, 'actions', 'meta', 'new'), body: 'fresh\n', author: 'user' });

    const events = s.listByAction('meta.new');
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('created');
    expect(readFileSync(join(root, 'actions', 'meta', 'new', 'SKILL.md'), 'utf8')).toBe('fresh\n');
  });
});

describe('applyWrite drift', () => {
  it('records an out-of-band edit and keeps the chain contiguous', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'v1\n');
    const s = store();
    s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'v2\n', author: 'user' });

    writeFileSync(join(actionDir, 'SKILL.md'), 'hand-edited\n');
    const applied = s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'v3\n', author: 'improver' });

    const kinds = s.listByAction('read.investigate').map((e) => e.kind);
    expect(kinds).toEqual(['applied', 'drifted', 'applied', 'created']);

    const drift = s.listByAction('read.investigate')[1]!;
    expect(drift.author).toBe('external');
    expect(s.bodyFor(drift.bodySha)).toBe('hand-edited\n');
    // The applied event's "before" is the drift snapshot, not the v2 the daemon last wrote.
    expect(s.previousBodyOf('read.investigate', applied.id)).toBe('hand-edited\n');
  });

  it('does not record drift when the daemon owns every write', () => {
    const s = store();
    s.applyWrite({ action: 'meta.new', dir: actionDir, body: 'a\n', author: 'user' });
    s.applyWrite({ action: 'meta.new', dir: actionDir, body: 'b\n', author: 'user' });
    expect(s.listByAction('meta.new').map((e) => e.kind)).toEqual(['applied', 'created']);
  });
});

describe('revert', () => {
  it('appends a forward event and reuses the existing body blob', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'v1\n');
    const s = store();
    s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'v2\n', author: 'user' });
    const genesis = s.listByAction('read.investigate').find((e) => e.kind === 'created')!;
    const blobsBefore = bodyFiles().length;

    const reverted = s.applyWrite({
      action: 'read.investigate', dir: actionDir, body: s.bodyFor(genesis.bodySha)!,
      author: 'user', kind: 'reverted', revertOf: genesis.id,
    });

    expect(skillMd()).toBe('v1\n');
    expect(reverted.revertOf).toBe(genesis.id);
    expect(bodyFiles()).toHaveLength(blobsBefore);
    // History grows forward; nothing prior is rewritten.
    expect(s.listByAction('read.investigate').map((e) => e.kind)).toEqual(['reverted', 'applied', 'created']);
  });
});

describe('retention', () => {
  it('trims events, compacts the index and gcs only unreferenced bodies', () => {
    const s = store();
    for (const body of ['a\n', 'b\n', 'c\n', 'd\n', 'e\n']) {
      s.applyWrite({ action: 'read.investigate', dir: actionDir, body, author: 'user' });
    }
    expect(s.listByAction('read.investigate')).toHaveLength(5);
    expect(bodyFiles()).toHaveLength(5);

    const reopened = new ActionRevisionsStore(storeDir, () => `x${++seq}`, () => clock, 3, 2);
    const kept = reopened.listByAction('read.investigate');
    expect(kept).toHaveLength(3);
    expect(indexLines()).toHaveLength(3);
    // Newest-first: the two most recent bodies survive, older ones are metadata-only.
    expect(reopened.bodyFor(kept[0]!.bodySha)).toBe('e\n');
    expect(reopened.bodyFor(kept[1]!.bodySha)).toBe('d\n');
    expect(reopened.bodyFor(kept[2]!.bodySha)).toBeUndefined();
    expect(bodyFiles()).toHaveLength(2);
  });

  it('keeps the chain head even when proposals fill the body quota', () => {
    const s = store();
    s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'head\n', author: 'user' });
    for (const draft of ['d1', 'd2', 'd3']) {
      s.record({ action: 'read.investigate', kind: 'proposed', author: 'user', body: `${draft}\n` });
    }

    const reopened = new ActionRevisionsStore(storeDir, () => `y${++seq}`, () => clock, 200, 2);
    const head = reopened.listByAction('read.investigate').find((e) => e.kind === 'created')!;
    expect(reopened.bodyFor(head.bodySha)).toBe('head\n');
  });

  it('skips corrupt lines without losing the rest', () => {
    const s = store();
    s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'ok\n', author: 'user' });
    writeFileSync(join(storeDir, 'index.jsonl'), `${indexLines()[0]}\nnot json\n`);

    const reopened = new ActionRevisionsStore(storeDir, () => `z${++seq}`, () => clock);
    expect(reopened.listByAction('read.investigate')).toHaveLength(1);
  });
});

describe('noteDeleted', () => {
  it('retains the final body and starts a fresh chain on recreate', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'final\n');
    const s = store();
    const deleted = s.noteDeleted('read.investigate', actionDir)!;
    expect(s.bodyFor(deleted.bodySha)).toBe('final\n');
    rmSync(actionDir, { recursive: true });

    s.applyWrite({ action: 'read.investigate', dir: actionDir, body: 'reborn\n', author: 'user' });
    expect(s.listByAction('read.investigate').map((e) => e.kind)).toEqual(['created', 'deleted']);
  });

  it('returns undefined when there is no file to snapshot', () => {
    const s = store();
    expect(s.noteDeleted('read.investigate', join(root, 'nope'))).toBeUndefined();
  });
});
