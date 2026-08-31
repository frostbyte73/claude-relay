// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { hasPrBlock, renderPrBlockHtml } from '../../src/pwa/components/work/pr-block.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { worktreeChanges } from '../../src/pwa/state/worktree-changes.js';

const step = (o: Record<string, unknown> = {}) => ({
  id: 's1', title: 'Ship it', sessionId: 'ctrl-sess',
  workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'outpost/abc' },
  prUrl: 'https://github.com/acme/widgets/pull/7',
  ...o,
});

// F1: a review controller's workspace is a `readonly` detached checkout of somebody else's
// PR head. `sessionId` there is the controller's own persistent session id — set from turn 1
// and never unset — and says nothing about whether a diff exists (the checkout stays clean by
// construction). Before the fix, `reviewReady` only checked `!isMerged`, so the diff control
// rendered for the step's entire lifetime even though there is nothing to review.
const DIFF_BTN = 'data-diff-action="review"';

describe('renderPrBlockHtml — diff button gating', () => {
  it('shows the diff button for a writable (owned) branch that is open', () => {
    const html = renderPrBlockHtml({}, step());
    expect(html).toContain(DIFF_BTN);
  });

  // It belongs on the branch row, not in a banner of its own below it — the whole point of
  // the control being one button is that it reads as part of the branch's status line.
  it('puts the diff button on the branch row', () => {
    const stats = renderPrBlockHtml({}, step()).match(/<div class="pr-stats">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(stats).toContain('outpost/abc');
    expect(stats).toContain(DIFF_BTN);
  });

  it('hides the diff button on a readonly (review) workspace even with a live sessionId', () => {
    const html = renderPrBlockHtml({}, step({ workspace: { kind: 'readonly', repoCwd: '/tmp/repo' } }));
    expect(html).not.toContain(DIFF_BTN);
  });

  it('hides the diff button once merged', () => {
    const html = renderPrBlockHtml({}, step({ state: 'merged' }));
    expect(html).not.toContain(DIFF_BTN);
  });

  // A PR that's closed without merging is just as dead as a merged one — the old
  // `!isMerged` check alone missed this and kept showing the control.
  it('hides the diff button once closed without merging', () => {
    const html = renderPrBlockHtml({}, step({ prState: 'closed' }));
    expect(html).not.toContain(DIFF_BTN);
  });

  it('hides the diff button before any session has ever run', () => {
    const html = renderPrBlockHtml({}, step({ sessionId: undefined }));
    expect(html).not.toContain(DIFF_BTN);
  });
});

// The variant is the signal: uncommitted work is the one thing in the card that can't move
// until the user looks at it, so the button carries accent 1 exactly then — and an unknown
// count (nothing fetched yet, or a worktree that couldn't be read) must read as clean rather
// than cry wolf on every first paint.
describe('renderPrBlockHtml — diff button variant', () => {
  const variant = (html: string) => html.match(/class="o-btn (o-btn--\w+) sm pr-diff-btn/)?.[1];

  it('is outlined while the change count is unknown', () => {
    expect(variant(renderPrBlockHtml({}, step({ sessionId: 'unknown-sess' })))).toBe('o-btn--default');
  });

  it('is accented once the worktree has uncommitted changes', () => {
    worktreeChanges.note('dirty-sess', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    const html = renderPrBlockHtml({}, step({ sessionId: 'dirty-sess' }));
    expect(variant(html)).toBe('o-btn--primary');
    expect(html).toContain('2 uncommitted files');
  });

  it('goes back to outlined once the changes are committed', () => {
    worktreeChanges.note('committed-sess', { files: [{ path: 'a.ts' }] });
    expect(variant(renderPrBlockHtml({}, step({ sessionId: 'committed-sess' })))).toBe('o-btn--primary');
    worktreeChanges.note('committed-sess', { files: [] });
    expect(variant(renderPrBlockHtml({}, step({ sessionId: 'committed-sess' })))).toBe('o-btn--default');
  });
});

describe('hasPrBlock', () => {
  it('is true once there is a PR url, branch, or comment to talk about', () => {
    expect(hasPrBlock({ prUrl: 'https://x/pull/1' })).toBe(true);
    expect(hasPrBlock({ workspace: { branch: 'outpost/abc' } })).toBe(true);
    expect(hasPrBlock({ comments: [{ id: 'c1' }] })).toBe(true);
  });

  it('is false with nothing to show yet', () => {
    expect(hasPrBlock({})).toBe(false);
  });
});
