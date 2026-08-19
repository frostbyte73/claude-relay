// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS
import { renderThreadCard } from '../../src/pwa/components/work/thread-card.js';

const FILE = 'pkg/thing.go';

// An added file: one hunk from line 1. This is the shape that dumped a whole file into the card.
function addedFile(lines: number) {
  return ['@@ -0,0 +1,' + lines + ' @@', ...Array.from({ length: lines }, (_, i) => `+line ${i + 1}`)].join('\n');
}

function comment(line: number, diffHunk: string) {
  return [{ id: `review:C${line}`, author: 'octocat', body: 'why?', createdAt: 0, file: FILE, line, diffHunk }];
}

const rowsIn = (html: string) => (html.match(/class="hunk-(add|del|ctx)/g) ?? []).length;

describe('renderThreadCard hunk excerpt', () => {
  it('does not render the whole file for a comment deep in an added file', () => {
    // The reported bug: diff_hunk on a comment at line 302 of a new file carries 302 rows,
    // and the card rendered every one of them.
    const html = renderThreadCard(comment(302, addedFile(302)));
    expect(rowsIn(html)).toBeLessThan(30);
    expect(html).toContain('line 302'); // the commented line is still there
    expect(html).not.toContain('line 100');
  });

  it('keeps the collapsed expander bounded, and says what it is hiding', () => {
    // A collapsed <details> still costs its markup in every repaint's innerHTML, so the
    // remainder must NOT be rendered just in case — a past timeline stutter was exactly this.
    const html = renderThreadCard(comment(500, addedFile(500)), undefined, undefined, {
      [FILE]: addedFile(900),
    });
    expect(rowsIn(html)).toBeLessThanOrEqual(51); // 11-row window + 20 each side
    expect(html).toContain('20 more lines above (of 494)');
    expect(html).toContain('20 more lines below (of 395)');
  });

  it('shows lines after the comment once the file patch is in hand', () => {
    const patch = addedFile(900);
    const withPatch = renderThreadCard(comment(500, addedFile(500)), undefined, undefined, { [FILE]: patch });
    const withoutPatch = renderThreadCard(comment(500, addedFile(500)));
    // diff_hunk stops at the commented line, so the fallback can only ever look backwards.
    expect(withPatch).toContain('line 505');
    expect(withoutPatch).not.toContain('line 505');
  });

  it('gives each thread its own repaint key so one expander does not open them all', () => {
    const a = renderThreadCard(comment(302, addedFile(302)));
    const b = renderThreadCard(comment(280, addedFile(280)));
    expect(a).toContain('data-details-key="hunk-above-review:C302"');
    expect(b).toContain('data-details-key="hunk-above-review:C280"');
  });

  it('renders nothing where there is no hunk at all (a PR-level comment)', () => {
    const html = renderThreadCard([{ id: 'issue:1', author: 'o', body: 'lgtm', createdAt: 0 }]);
    expect(html).not.toContain('thread-hunk');
    expect(html).toContain('PR conversation');
  });
});
