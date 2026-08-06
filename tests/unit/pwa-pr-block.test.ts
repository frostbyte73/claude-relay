// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { hasPrBlock, renderPrBlockHtml } from '../../src/pwa/components/work/pr-block.js';

const step = (o: Record<string, unknown> = {}) => ({
  id: 's1', title: 'Ship it', sessionId: 'ctrl-sess',
  workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'outpost/abc' },
  prUrl: 'https://github.com/acme/widgets/pull/7',
  ...o,
});

// F1: a review controller's workspace is a `readonly` detached checkout of somebody else's
// PR head. `sessionId` there is the controller's own persistent session id — set from turn 1
// and never unset — and says nothing about whether a diff exists (the checkout stays clean by
// construction). Before the fix, `reviewReady` only checked `!isMerged`, so the CTA ("Review
// the branch diff" / Discard) rendered for the step's entire lifetime even though there is
// nothing to review and nothing to discard.
describe('renderPrBlockHtml — review CTA gating', () => {
  it('shows the CTA for a writable (owned) branch that is open', () => {
    const html = renderPrBlockHtml({}, step());
    expect(html).toContain('Review the branch diff');
    expect(html).toContain('data-pr-action="discard"');
  });

  it('hides the CTA on a readonly (review) workspace even with a live sessionId', () => {
    const html = renderPrBlockHtml({}, step({ workspace: { kind: 'readonly', repoCwd: '/tmp/repo' } }));
    expect(html).not.toContain('Review the branch diff');
    expect(html).not.toContain('data-pr-action="discard"');
  });

  it('hides the CTA once merged', () => {
    const html = renderPrBlockHtml({}, step({ state: 'merged' }));
    expect(html).not.toContain('data-pr-action="discard"');
  });

  // A PR that's closed without merging is just as dead as a merged one — the old
  // `!isMerged` check alone missed this and kept showing the CTA.
  it('hides the CTA once closed without merging', () => {
    const html = renderPrBlockHtml({}, step({ prState: 'closed' }));
    expect(html).not.toContain('Review the branch diff');
    expect(html).not.toContain('data-pr-action="discard"');
  });

  it('hides the CTA before any session has ever run', () => {
    const html = renderPrBlockHtml({}, step({ sessionId: undefined }));
    expect(html).not.toContain('data-pr-action="discard"');
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
