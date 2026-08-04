import { describe, it, expect } from 'vitest';
// @ts-expect-error — PWA modules are plain ES modules with no type declarations.
import { revisionDiffLines, revisionRows } from '../../src/pwa/vm/library.js';

const NOW = 1_700_000_000_000;

function rows(events: unknown[]) {
  return revisionRows(events, NOW);
}

describe('revisionRows', () => {
  it('labels kinds and authors for display', () => {
    const out = rows([
      { id: 'a', kind: 'applied', author: 'improver', at: NOW - 1000, canRevert: true, hasBody: true },
      { id: 'b', kind: 'drifted', author: 'external', at: NOW - 2000, hasBody: true },
      { id: 'c', kind: 'created', author: 'system', at: NOW - 3000 },
    ]);
    expect(out.map((r: { kindLabel: string }) => r.kindLabel)).toEqual(['applied', 'changed on disk', 'first recorded']);
    expect(out.map((r: { tone: string }) => r.tone)).toEqual(['info', 'warn', 'idle']);
    expect(out.map((r: { authorLabel: string }) => r.authorLabel)).toEqual(['improver', 'edited outside Outpost', 'system']);
  });

  it('labels a quiet improver cycle without offering a revert', () => {
    const [row] = rows([{
      id: 'r', kind: 'reviewed', author: 'improver', at: NOW - 500,
      rationale: '47 runs, 91% first-try, nothing worth changing',
    }]);
    expect(row.kindLabel).toBe('reviewed, no change');
    expect(row.tone).toBe('idle');
    expect(row.canRevert).toBe(false);
    expect(row.rationale).toBe('47 runs, 91% first-try, nothing worth changing');
  });

  it('trusts the server on revertability and defaults the rest', () => {
    const [applied, proposed] = rows([
      { id: 'a', kind: 'applied', author: 'user', at: NOW, canRevert: true, hasBody: true, bodyBytes: 2048 },
      { id: 'b', kind: 'proposed', author: 'user', at: NOW },
    ]);
    expect(applied.canRevert).toBe(true);
    expect(applied.bytesText).toBe('2.0 kB');
    expect(proposed.canRevert).toBe(false);
    expect(proposed.hasBody).toBe(false);
    expect(proposed.rationale).toBe('');
    expect(proposed.ruleAdds).toEqual([]);
    expect(proposed.bytesText).toBe('');
  });

  it('carries rationale, feedback and rule changes through', () => {
    const [row] = rows([{
      id: 'a', kind: 'rejected', author: 'user', at: NOW,
      rationale: 'tighten the brief', feedback: 'too aggressive',
      allowlistAdds: [{ kind: 'bash', value: '^curl ' }],
      allowlistRemoved: [{ kind: 'tool', value: 'Write' }],
    }]);
    expect(row.rationale).toBe('tighten the brief');
    expect(row.feedback).toBe('too aggressive');
    expect(row.ruleAdds).toEqual([{ kind: 'bash', value: '^curl ' }]);
    expect(row.ruleRemovals).toEqual([{ kind: 'tool', value: 'Write' }]);
  });

  it('handles an empty or missing list', () => {
    expect(rows([])).toEqual([]);
    expect(revisionRows(undefined, NOW)).toEqual([]);
  });
});

describe('revisionDiffLines', () => {
  it('classifies headers, hunks, adds, deletes and context', () => {
    const diff = [
      'diff --git a/SKILL.md b/SKILL.md',
      '--- a/SKILL.md',
      '+++ b/SKILL.md',
      '@@ -1,2 +1,2 @@',
      ' kept',
      '-gone',
      '+added',
      '',
    ].join('\n');
    expect(revisionDiffLines(diff).map((l: { cls: string }) => l.cls))
      .toEqual(['meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add']);
  });

  it('returns nothing for an absent diff', () => {
    expect(revisionDiffLines('')).toEqual([]);
    expect(revisionDiffLines(undefined)).toEqual([]);
  });
});
