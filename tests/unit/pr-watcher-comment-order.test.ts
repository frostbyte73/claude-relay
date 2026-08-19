import { describe, it, expect } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

// `gh pr view --json reviews` timestamps a review with `submittedAt`; only `comments` carries
// `createdAt`. Reading the wrong one gave every review body `createdAt: NaN`, and a comparator
// returning NaN is spec'd to sort as "equal" — so the whole list stopped sorting and rendered in
// fetch order (issue comments, then reviews, then inline), putting an answer above its question.

function makeStep() {
  return {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', cancelled: false,
    state: 'waiting',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    pr: { prUrl: 'https://github.com/acme/example/pull/639', prState: 'open', comments: [] },
  };
}

function harness(runGh: (cwd: string, args: string[]) => Promise<string>) {
  const job = { id: 'JOB-1', steps: [makeStep()] };
  const patches: Array<Record<string, unknown>> = [];
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyPrFacts: (_j: string, _s: string, facts: Record<string, unknown>) => patches.push(facts),
    pushStepInbox: () => {},
  } as never;
  return { watcher: new PrWatcher({ queue, engine, runGh }), patches };
}

const VIEW = JSON.stringify({
  number: 639,
  url: 'https://github.com/acme/example/pull/639',
  state: 'OPEN',
  reviews: [
    { id: 'PRR_1', author: { login: 'reviewer' }, body: 'Can you respond to the bot?', submittedAt: '2020-01-01T00:00:00Z', state: 'COMMENTED' },
  ],
  comments: [
    { id: 'IC_1', author: { login: 'author' }, body: '> Can you respond to the bot?\n\nyeah, on it', createdAt: '2020-01-01T01:00:00Z' },
  ],
});

describe('PrWatcher comment ordering', () => {
  it('timestamps a review body from submittedAt and keeps the list chronological', async () => {
    const { watcher, patches } = harness(async (_cwd, args) => (args[0] === 'api' ? '[]' : VIEW));
    await watcher.syncJob('JOB-1');

    const comments = patches.map((p) => p.comments).filter(Boolean).at(-1) as Array<{ id: string; createdAt: number }>;
    const review = comments.find((c) => c.id === 'review:PRR_1');
    expect(review?.createdAt).toBe(Date.parse('2020-01-01T00:00:00Z'));
    // The answer quotes the review, so it must not render above it.
    expect(comments.map((c) => c.id)).toEqual(['review:PRR_1', 'issue:IC_1']);
  });
});
