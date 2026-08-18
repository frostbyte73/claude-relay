import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRevisionsStore } from '../../src/storage/action-revisions-store.js';
import { ActionsStore } from '../../src/storage/actions-store.js';
import { buildRevisionHistory, RevertError, revertToEvent } from '../../src/routes/action-revisions.js';

let root: string;
let actionDir: string;
let store: ActionRevisionsStore;
let actionsStore: ActionsStore;
let seq: number;

const ACTION = 'read.investigate';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'action-revert-'));
  actionDir = join(root, 'actions', 'read', 'investigate');
  mkdirSync(actionDir, { recursive: true });
  seq = 0;
  let clock = 1_700_000_000_000;
  store = new ActionRevisionsStore(join(root, 'action-revisions'), () => `e${++seq}`, () => (clock += 1));
  actionsStore = new ActionsStore(join(root, 'actions.json'));
});

function revert(eventId: string) {
  return revertToEvent({ store, actionsStore, action: ACTION, dir: actionDir, eventId, author: 'user' });
}

function skillMd(): string {
  return readFileSync(join(actionDir, 'SKILL.md'), 'utf8');
}

describe('revertToEvent', () => {
  it('restores the original bytes and records the revert forward', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'original\n');
    store.applyWrite({ action: ACTION, dir: actionDir, body: 'rewritten\n', author: 'improver' });
    const genesis = store.listByAction(ACTION).find((e) => e.kind === 'created')!;

    const { event } = revert(genesis.id);

    expect(skillMd()).toBe('original\n');
    expect(event.kind).toBe('reverted');
    expect(event.revertOf).toBe(genesis.id);
    expect(store.listByAction(ACTION).map((e) => e.kind)).toEqual(['reverted', 'applied', 'created']);
  });

  // The rules here are stand-ins for "a rule this revision added" — read-shaped ones, since a
  // whole-tool `Write` (what these used to carry) is refused at addRule by the write lint.
  it('removes only the rules the reverted revision added', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'v1\n');
    // Added out-of-band, the way the denials "Allow" button does — must survive.
    actionsStore.addRule(ACTION, 'tool', 'WebFetch');

    const applied = store.applyWrite({
      action: ACTION, dir: actionDir, body: 'v2\n', author: 'improver',
      allowlistAdds: [{ kind: 'bash', value: '^sed ' }, { kind: 'tool', value: 'Glob' }],
    });
    actionsStore.addRule(ACTION, 'bash', '^sed ');
    actionsStore.addRule(ACTION, 'tool', 'Glob');
    // A later revision re-adds one of them, so that one is still earned.
    store.applyWrite({
      action: ACTION, dir: actionDir, body: 'v3\n', author: 'user',
      allowlistAdds: [{ kind: 'tool', value: 'Glob' }],
    });

    const { removed } = revert(applied.id);

    expect(removed).toEqual([{ kind: 'bash', value: '^sed ' }]);
    const al = actionsStore.get(ACTION).allowlist;
    expect(al.alwaysAllowBashPatterns).toEqual([]);
    expect(al.alwaysAllow).toEqual(['WebFetch', 'Glob']);
  });

  it('does not credit a proposal with rules that never landed', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'v1\n');
    const applied = store.applyWrite({
      action: ACTION, dir: actionDir, body: 'v2\n', author: 'improver',
      allowlistAdds: [{ kind: 'tool', value: 'Glob' }],
    });
    actionsStore.addRule(ACTION, 'tool', 'Glob');
    // The same rule was also *suggested* by a draft that was rejected. Suggesting is not
    // landing, so it must not protect the rule from removal.
    store.record({
      action: ACTION, kind: 'rejected', author: 'user', body: 'draft\n',
      allowlistAdds: [{ kind: 'tool', value: 'Glob' }],
    });

    expect(revert(applied.id).removed).toEqual([{ kind: 'tool', value: 'Glob' }]);
    expect(actionsStore.get(ACTION).allowlist.alwaysAllow).toEqual([]);
  });

  it('rejects unknown, non-applied and unretained revisions', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'v1\n');
    store.applyWrite({ action: ACTION, dir: actionDir, body: 'v2\n', author: 'user' });
    const rejected = store.record({ action: ACTION, kind: 'rejected', author: 'user', body: 'draft\n' });

    expect(() => revert('nope')).toThrow(RevertError);
    expect(() => revert('nope')).toThrow(/no such revision/);
    expect(() => revert(rejected.id)).toThrow(/no applied body/);

    const pruned = new ActionRevisionsStore(join(root, 'action-revisions'), () => `p${++seq}`, () => 1, 200, 1);
    const genesis = pruned.listByAction(ACTION).find((e) => e.kind === 'created')!;
    expect(() => revertToEvent({
      store: pruned, actionsStore, action: ACTION, dir: actionDir, eventId: genesis.id, author: 'user',
    })).toThrow(/no longer retained/);
  });
});

describe('buildRevisionHistory', () => {
  it('returns newest-first with derived diffs', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'a\n');
    store.applyWrite({
      action: ACTION, dir: actionDir, body: 'b\n', author: 'improver', rationale: 'tighten the brief',
    });

    const rows = buildRevisionHistory(store, ACTION);
    expect(rows.map((r) => r.kind)).toEqual(['applied', 'created']);
    expect(rows[0]!.rationale).toBe('tighten the brief');
    expect(rows[0]!.canRevert).toBe(true);
    expect(rows[0]!.diff).toContain('-a');
    expect(rows[0]!.diff).toContain('+b');
    // The genesis has nothing before it, so it reads as a whole-file add.
    expect(rows[1]!.diff).toContain('+a');
  });

  it('diffs a proposal against what was installed when it was posted', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'installed\n');
    store.applyWrite({ action: ACTION, dir: actionDir, body: 'installed\n', author: 'user' });
    store.record({ action: ACTION, kind: 'proposed', author: 'user', body: 'suggested\n' });

    const proposed = buildRevisionHistory(store, ACTION)[0]!;
    expect(proposed.kind).toBe('proposed');
    expect(proposed.canRevert).toBe(false);
    expect(proposed.diff).toContain('-installed');
    expect(proposed.diff).toContain('+suggested');
  });

  it('marks an unretained revision as body-less and unrevertable', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'a\n');
    store.applyWrite({ action: ACTION, dir: actionDir, body: 'b\n', author: 'user' });

    const pruned = new ActionRevisionsStore(join(root, 'action-revisions'), () => `p${++seq}`, () => 1, 200, 1);
    const rows = buildRevisionHistory(pruned, ACTION);
    const genesis = rows.find((r) => r.kind === 'created')!;
    expect(genesis.hasBody).toBe(false);
    expect(genesis.canRevert).toBe(false);
    expect(genesis.diff).toBeUndefined();
  });

  it('renders a delete as the file going away', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'bye\n');
    store.noteDeleted(ACTION, actionDir);
    const row = buildRevisionHistory(store, ACTION)[0]!;
    expect(row.kind).toBe('deleted');
    expect(row.canRevert).toBe(false);
    expect(row.diff).toContain('-bye');
  });

  it('renders a quiet improver cycle as a body-less, unrevertable row', () => {
    writeFileSync(join(actionDir, 'SKILL.md'), 'unchanged\n');
    store.applyWrite({ action: ACTION, dir: actionDir, body: 'unchanged\n', author: 'user' });
    const reviewed = store.record({
      action: ACTION, kind: 'reviewed', author: 'improver', rationale: '47 runs, nothing worth changing',
    });

    const row = buildRevisionHistory(store, ACTION)[0]!;
    expect(row.kind).toBe('reviewed');
    expect(row.hasBody).toBe(false);
    expect(row.canRevert).toBe(false);
    expect(row.diff).toBeUndefined();
    expect(row.rationale).toBe('47 runs, nothing worth changing');
    expect(() => revert(reviewed.id)).toThrow(/no applied body/);
  });
});
