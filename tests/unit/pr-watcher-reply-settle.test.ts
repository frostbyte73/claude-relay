import { describe, it, expect } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

// A single already-answered comment, styled like commentsFrom's `issue:<id>` output.
const RESPONDED_COMMENT = {
  id: 'issue:1', author: 'devin', body: 'fix this',
  createdAt: Date.parse('2026-01-01T00:00:00Z'), respondedAt: Date.parse('2026-01-02T00:00:00Z'),
};
const VIEW_COMMENT = { id: 1, author: { login: 'devin' }, body: 'fix this', createdAt: '2026-01-01T00:00:00Z' };

function makeStep(over: Record<string, unknown> = {}) {
  return {
    id: 's1', type: 'open-pr', cancelled: false,
    state: 'reply_pending_review', prState: 'open', reviewState: 'review_required',
    prUrl: 'https://github.com/acme/example/pull/15282',
    workspace: { repoCwd: '/tmp/repo', branch: 'feat/x' },
    comments: [RESPONDED_COMMENT],
    draftedReplies: [],
    editQueue: [{ id: 'e1', commentId: 'issue:1', status: 'done' }],
    iterations: [{ id: 'it1', kind: 'replies', status: 'approved', postedAt: 1, resolvedAt: 2 }],
    ...over,
  };
}

function harness(step: ReturnType<typeof makeStep>, viewOver: Record<string, unknown> = {}) {
  const job = { id: 'JOB-1', steps: [step] };
  const patches: Array<Record<string, unknown>> = [];
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyOpenPrPatch: (_j: string, _s: string, patch: Record<string, unknown>) => patches.push(patch),
    dropOrphanIterations: () => {},
  } as never;
  const view = JSON.stringify({
    number: 15282, url: 'x', state: 'OPEN', reviews: [], comments: [VIEW_COMMENT],
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
    ...viewOver,
  });
  const runGh = async (_cwd: string, args: string[]) => (args[0] === 'api' ? '[]' : view);
  const watcher = new PrWatcher({ queue, engine, runGh });
  return { watcher, patches };
}

const stateOf = (patches: Array<Record<string, unknown>>) =>
  patches.find((p) => 'state' in p)?.state;

describe('PrWatcher reply settle', () => {
  it('returns reply_pending_review → pr_open once every comment is answered', async () => {
    const { watcher, patches } = harness(makeStep());
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBe('pr_open');
  });

  it('also settles comment_pending_response with no work left', async () => {
    const { watcher, patches } = harness(makeStep({ state: 'comment_pending_response' }));
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBe('pr_open');
  });

  it('stays put while a drafted reply still awaits the user', async () => {
    const { watcher, patches } = harness(makeStep({
      draftedReplies: [{ commentId: 'issue:1', draftReply: 'thanks' }],
      comments: [{ ...RESPONDED_COMMENT, respondedAt: undefined }],
    }));
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBeUndefined();
  });

  it('stays put while an edit round is still running', async () => {
    const { watcher, patches } = harness(makeStep({
      editQueue: [{ id: 'e1', commentId: 'issue:1', status: 'running' }],
      comments: [{ ...RESPONDED_COMMENT, respondedAt: undefined }],
    }));
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBeUndefined();
  });

  it('stays put while a triage round is mid-flight', async () => {
    // Comment already answered (pending is empty), so the in-progress replies
    // iteration is the only thing holding the settle back.
    const { watcher, patches } = harness(makeStep({
      iterations: [{ id: 'it1', kind: 'replies', status: 'in_progress' }],
    }));
    await watcher.syncJob('JOB-1');
    expect(stateOf(patches)).toBeUndefined();
  });
});
