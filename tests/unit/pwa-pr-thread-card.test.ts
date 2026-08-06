// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderThreadCard } from '../../src/pwa/components/work/thread-card.js';

const comment = (over = {}) => ({
  id: 'c1', author: 'octocat', body: 'please rename this', file: 'a.ts', line: 3,
  createdAt: 1000, ...over,
});

const resolvedChain = [comment({ respondedAt: 2000 })];
const openChain = [comment()];

describe('renderThreadCard', () => {
  it('renders the comment record — author, body, location', () => {
    const html = renderThreadCard(openChain, undefined);
    expect(html).toContain('octocat');
    expect(html).toContain('please rename this');
    expect(html).toContain('a.ts:3');
  });

  it('renders a migrated draft as a record — recommendation and rationale, no reply box', () => {
    const draft = { commentId: 'c1', recommendation: 'reply', draftReply: 'draft body', rationale: 'because', confidence: 'high' };
    const html = renderThreadCard(openChain, draft);
    expect(html).toContain('thread-rec-reply');
    expect(html).toContain('because');
    expect(html).not.toContain('draft body');
    expect(html).not.toContain('<textarea');
  });

  // The reply/react/edit routes went away with the open-pr step type, so any
  // surviving control would 404 rather than do what it says.
  it.each([['open', openChain], ['resolved', resolvedChain]])('renders no action controls on a %s thread', (_label, chain) => {
    const html = renderThreadCard(chain, undefined);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-thread-action');
    expect(html).not.toContain('data-composer');
    expect(html).not.toContain('data-react');
  });

  it('shows reactions already on the comment, without an add control', () => {
    const html = renderThreadCard([comment({ userReactions: ['THUMBS_UP'] })], undefined);
    expect(html).toContain('👍');
    expect(html).not.toContain('thread-reaction-add');
  });
});
