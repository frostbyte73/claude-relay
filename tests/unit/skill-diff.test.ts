import { describe, it, expect } from 'vitest';
import { unifiedSkillDiff } from '../../src/actions/skill-diff.js';
import { parseUnifiedDiff } from '../../src/git/diff-parser.js';

function lines(text: string, n: number, prefix = 'l'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}${text}`).join('\n') + '\n';
}

function hunks(diff: string) {
  const files = parseUnifiedDiff(diff);
  expect(files).toHaveLength(1);
  expect(files[0]!.path).toBe('SKILL.md');
  return files[0]!.hunks;
}

describe('unifiedSkillDiff', () => {
  it('returns empty for identical texts', () => {
    expect(unifiedSkillDiff('a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedSkillDiff('', '')).toBe('');
  });

  it('emits an insertion anchored on the preceding line', () => {
    const diff = unifiedSkillDiff('a\nb\n', 'a\nnew\nb\n');
    const h = hunks(diff);
    expect(h).toHaveLength(1);
    expect(h[0]!.oldStart).toBe(1);
    expect(h[0]!.oldLines).toBe(2);
    expect(h[0]!.newLines).toBe(3);
    expect(h[0]!.rows.filter((r) => r.op === '+').map((r) => r.content)).toEqual(['new']);
  });

  it('emits a deletion', () => {
    const h = hunks(unifiedSkillDiff('a\ngone\nb\n', 'a\nb\n'));
    expect(h[0]!.rows.filter((r) => r.op === '-').map((r) => r.content)).toEqual(['gone']);
    expect(h[0]!.oldLines).toBe(3);
    expect(h[0]!.newLines).toBe(2);
  });

  it('emits a replacement as a delete plus an add', () => {
    const h = hunks(unifiedSkillDiff('a\nold\nb\n', 'a\nnew\nb\n'));
    expect(h[0]!.rows.filter((r) => r.op === '-').map((r) => r.content)).toEqual(['old']);
    expect(h[0]!.rows.filter((r) => r.op === '+').map((r) => r.content)).toEqual(['new']);
  });

  it('renders a whole-file add as -0,0', () => {
    const h = hunks(unifiedSkillDiff('', 'x\ny\n'));
    expect(h[0]!.oldStart).toBe(0);
    expect(h[0]!.oldLines).toBe(0);
    expect(h[0]!.newStart).toBe(1);
    expect(h[0]!.newLines).toBe(2);
  });

  it('renders a whole-file delete as +0,0', () => {
    const h = hunks(unifiedSkillDiff('x\ny\n', ''));
    expect(h[0]!.newStart).toBe(0);
    expect(h[0]!.newLines).toBe(0);
    expect(h[0]!.oldLines).toBe(2);
  });

  it('splits distant changes into separate hunks and merges near ones', () => {
    const before = lines('', 30);
    const far = before.replace('l0\n', 'CHANGED0\n').replace('l25\n', 'CHANGED25\n');
    expect(hunks(unifiedSkillDiff(before, far))).toHaveLength(2);

    const near = before.replace('l10\n', 'CHANGED10\n').replace('l13\n', 'CHANGED13\n');
    expect(hunks(unifiedSkillDiff(before, near))).toHaveLength(1);
  });

  it('falls back to a wholesale replace above maxLines', () => {
    const before = lines('', 12, 'a');
    const after = lines('', 12, 'b');
    const h = hunks(unifiedSkillDiff(before, after, { maxLines: 10 }));
    expect(h).toHaveLength(1);
    expect(h[0]!.rows.filter((r) => r.op === '-')).toHaveLength(12);
    expect(h[0]!.rows.filter((r) => r.op === '+')).toHaveLength(12);
    expect(h[0]!.rows.some((r) => r.op === ' ')).toBe(false);
  });

  it('treats a trailing-newline-only difference as no visible change', () => {
    expect(unifiedSkillDiff('a', 'a\n')).toBe('');
  });
});
