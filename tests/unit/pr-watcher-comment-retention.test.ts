import { describe, it, expect } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

// Regression: a transient GitHub failure on the inline-comments call must not
// wipe s.comments (which would orphan the drafts / edit jobs keyed to them).
// Reproduces the case where a 503 emptied the comment list.

function makeStep(over: Record<string, unknown> = {}) {
  return {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', cancelled: false,
    state: 'waiting',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    draftedReplies: [{ commentId: 'review:PRRC_a', recommendation: 'edit', draftReply: 'ok' }],
    pr: {
      prUrl: 'https://github.com/acme/example/pull/639',
      prState: 'open',
      comments: [
        { id: 'review:PRRC_a', author: 'rev', body: 'log all nodes', createdAt: 1000 },
      ],
    },
    ...over,
  };
}

function harness(step: ReturnType<typeof makeStep>, runGh: (cwd: string, args: string[]) => Promise<string>) {
  const job = { id: 'JOB-1', steps: [step] };
  const patches: Array<Record<string, unknown>> = [];
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyPrFacts: (_j: string, _s: string, facts: Record<string, unknown>) => patches.push(facts),
    pushStepInbox: () => {},
  } as never;
  const watcher = new PrWatcher({ queue, engine, runGh });
  return { watcher, patches };
}

const PR_VIEW = JSON.stringify({ number: 639, url: 'x', state: 'OPEN', reviews: [], comments: [] });

describe('PrWatcher inline-comment fetch failure', () => {
  it('does not overwrite comments when the inline fetch fails', async () => {
    const runGh = async (_cwd: string, args: string[]) => {
      if (args[0] === 'api') throw new Error('HTTP 503: No server currently available');
      return PR_VIEW; // pr view succeeds
    };
    const { watcher, patches } = harness(makeStep(), runGh);
    await watcher.syncJob('JOB-1');

    // A patch may still land (prState/ci/review), but it must not carry comments.
    expect(patches.length).toBeGreaterThan(0);
    for (const p of patches) expect(p).not.toHaveProperty('comments');
  });

  it('still updates comments when the inline fetch succeeds', async () => {
    const inline = JSON.stringify([
      { id: 1, node_id: 'PRRC_a', user: { login: 'rev' }, body: 'log all nodes', created_at: '2020-01-01T00:00:00Z' },
      { id: 2, node_id: 'PRRC_b', user: { login: 'rev' }, body: 'and regions', created_at: '2020-01-01T00:01:00Z' },
    ]);
    const runGh = async (_cwd: string, args: string[]) => (args[0] === 'api' ? inline : PR_VIEW);
    const { watcher, patches } = harness(makeStep(), runGh);
    await watcher.syncJob('JOB-1');

    const withComments = patches.find((p) => 'comments' in p);
    expect(withComments).toBeDefined();
    expect((withComments!.comments as unknown[]).length).toBe(2);
  });
});
