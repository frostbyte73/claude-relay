// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS
import { parseHunks, windowForComment } from '../../src/pwa/utils/diff-window.js';

// A real-shaped `patch` from `pulls/:n/files`: one hunk, new-side lines 249..259.
const PATCH = [
  '@@ -256,6 +249,11 @@ func (s *SDKSource) updatePreInitStateLocked(op Operation) {',
  ' \tctx := context.Background()',
  ' \tdefer cancel()',
  '-\told := s.state',
  '+\told, ok := s.state[trackID]',
  '+\tif !ok {',
  '+\t\treturn errNoTrack',
  '+\t}',
  ' \ts.mu.Lock()',
  ' \tdefer s.mu.Unlock()',
  ' \treturn nil',
  ' }',
].join('\n');

describe('parseHunks', () => {
  it('numbers both sides across add/del/context rows', () => {
    const [h] = parseHunks(PATCH);
    expect(h.oldStart).toBe(256);
    expect(h.newStart).toBe(249);
    expect(h.section).toBe('func (s *SDKSource) updatePreInitStateLocked(op Operation) {');
    // ' ' rows advance both sides, '-' only old, '+' only new.
    expect(h.rows[0]).toMatchObject({ op: ' ', oldLine: 256, newLine: 249 });
    expect(h.rows[2]).toMatchObject({ op: '-', oldLine: 258 });
    expect(h.rows[2].newLine).toBeUndefined();
    expect(h.rows[3]).toMatchObject({ op: '+', newLine: 251 });
    expect(h.rows[3].oldLine).toBeUndefined();
    expect(h.rows[7]).toMatchObject({ op: ' ', oldLine: 259, newLine: 255 });
  });

  it('ignores the no-newline marker and a bare @@ that will not parse', () => {
    const rows = parseHunks('@@ nonsense @@\n@@ -1 +1 @@\n+x\n\\ No newline at end of file')[0].rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: '+', content: 'x', newLine: 1 });
  });
});

describe('windowForComment', () => {
  it('shows lines on BOTH sides of the comment when the patch is available', () => {
    const w = windowForComment({ patch: PATCH, line: 251, side: 'RIGHT' });
    expect(w.source).toBe('patch');
    // Anchor is the '+\t\treturn errNoTrack' row (new line 251).
    expect(w.rows[w.anchor]).toMatchObject({ op: '+', newLine: 251 });
    // The point of the whole change: the window extends PAST the anchor, which diff_hunk
    // alone can never do — 5 trailing rows here, where diff_hunk would have stopped dead.
    expect(w.end - 1 - w.anchor).toBe(5);
    expect(w.rows.slice(w.anchor + 1, w.end).map((r: { content: string }) => r.content))
      .toEqual(['\tif !ok {', '\t\treturn errNoTrack', '\t}', '\ts.mu.Lock()', '\tdefer s.mu.Unlock()']);
  });

  it('anchors a deletion comment on the old side', () => {
    const w = windowForComment({ patch: PATCH, line: 258, side: 'LEFT' });
    expect(w.rows[w.anchor]).toMatchObject({ op: '-', oldLine: 258 });
  });

  it('bounds a huge new-file hunk instead of rendering the whole file', () => {
    // The reported bug: an added file is one hunk from line 1, so diff_hunk on a comment at
    // line 302 carries 302 rows.
    const rows = Array.from({ length: 302 }, (_, i) => `+line ${i + 1}`);
    const diffHunk = ['@@ -0,0 +1,581 @@', ...rows].join('\n');
    const w = windowForComment({ diffHunk, line: 302, side: 'RIGHT' });
    expect(w.source).toBe('hunk');
    expect(w.rows).toHaveLength(302);
    expect(w.end - w.start).toBeLessThanOrEqual(6);
    expect(w.start).toBeGreaterThan(0); // there IS a hidden remainder to offer behind an expander
    expect(w.rows[w.anchor]).toMatchObject({ content: 'line 302' });
  });

  it('falls back to the hunk tail when the comment line is not in the patch', () => {
    // Outdated comment: GitHub reports line: null and the patch has moved on.
    const diffHunk = '@@ -256,6 +249,11 @@ ctx\n a\n b\n+c';
    const w = windowForComment({ patch: PATCH, line: null, diffHunk });
    expect(w.source).toBe('hunk');
    expect(w.anchor).toBe(w.rows.length - 1);
  });

  it('keeps the whole commented range for a multi-line comment', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ` line ${i + 1}`);
    const patch = ['@@ -1,60 +1,60 @@', ...rows].join('\n');
    const w = windowForComment({ patch, line: 50, startLine: 30, side: 'RIGHT' });
    // Without startLine the window would begin at 45 and crop off the span's own beginning.
    expect(w.rows[w.start]).toMatchObject({ newLine: 30 });
    expect(w.rows[w.anchor]).toMatchObject({ newLine: 50 });
  });

  it('returns null when there is nothing to render', () => {
    expect(windowForComment({})).toBeNull();
    expect(windowForComment({ diffHunk: '@@ -1,0 +1,0 @@' })).toBeNull();
  });
});
