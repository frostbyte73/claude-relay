import { describe, it, expect, vi } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

const PR_URL = 'https://github.com/acme/example/pull/15282';

const ROLLUP: Record<string, Record<string, string>> = {
  pending: { name: 'test', status: 'IN_PROGRESS', conclusion: '' },
  success: { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  failure: { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
};
const REVIEW: Record<string, string> = {
  approved: 'APPROVED', changes_requested: 'CHANGES_REQUESTED', review_required: 'REVIEW_REQUIRED',
};
const PR_STATE: Record<string, string> = { open: 'OPEN', merged: 'MERGED', closed: 'CLOSED' };

interface Facts {
  ciState?: string;
  reviewState?: string;
  prState?: string;
  mergeable?: string;
  comments?: Array<{ id: string; body: string }>;
}

function orchestratedStepWithPr(pr: Facts) {
  return {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr',
    title: 'ship it', description: '', goal: 'ship it',
    state: 'waiting', sessionId: 'sess1', cancelled: false,
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    iterations: [] as Array<Record<string, unknown>>,
    pr: { prUrl: PR_URL, prState: 'open', ...pr },
    createdAt: 0, updatedAt: 0,
  };
}

// Wraps the `gh pr view` fixture with `over` merged in, spelled the way GitHub spells it.
function stubGh(over: Facts = {}) {
  const view = JSON.stringify({
    number: 15282, url: PR_URL, state: PR_STATE[over.prState ?? 'open'],
    reviews: [],
    comments: (over.comments ?? []).map((c) => ({
      id: c.id, author: { login: 'devin' }, body: c.body, createdAt: '2026-01-01T00:00:00Z',
    })),
    ...(over.ciState ? { statusCheckRollup: [ROLLUP[over.ciState]] } : {}),
    ...(over.reviewState ? { reviewDecision: REVIEW[over.reviewState] } : {}),
    ...(over.mergeable ? { mergeable: over.mergeable.toUpperCase() } : {}),
  });
  return async (_cwd: string, args: string[]) => (args[0] === 'api' ? '[]' : view);
}

function harness(step: ReturnType<typeof orchestratedStepWithPr>, gh: Facts = {}) {
  const job = { id: 'j1', steps: [step] };
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
  const watcher = new PrWatcher({ queue, engine: engine as never, runGh: stubGh(gh) });
  return { watcher, engine };
}

describe('PrWatcher over an orchestrated step', () => {
  it('writes facts under pr and pushes one event naming only what changed', async () => {
    const { watcher, engine } = harness(
      orchestratedStepWithPr({ ciState: 'pending', reviewState: 'review_required' }),
      { ciState: 'failure', reviewState: 'review_required' },
    );
    await watcher.syncJob('j1');

    expect(engine.applyPrFacts).toHaveBeenCalledWith('j1', 's1', expect.objectContaining({ ciState: 'failure' }));
    expect(engine.pushStepInbox).toHaveBeenCalledTimes(1);
    const [, , item] = engine.pushStepInbox.mock.calls[0]!;
    expect(item.kind).toBe('external');
    expect(item.events).toEqual(['ci']);
  });

  it('never writes control state', async () => {
    const { watcher, engine } = harness(orchestratedStepWithPr({}), { prState: 'open' });
    await watcher.syncJob('j1');
    expect(engine.applyPrFacts).toHaveBeenCalled();
    for (const call of engine.applyPrFacts.mock.calls) {
      expect(call[2]).not.toHaveProperty('state');
      expect(call[2]).not.toHaveProperty('phase');
      expect(call[2]).not.toHaveProperty('waitingOn');
    }
  });

  it('pushes nothing when a poll returns identical data', async () => {
    const facts: Facts = { ciState: 'success', reviewState: 'approved', prState: 'open' };
    const { watcher, engine } = harness(orchestratedStepWithPr(facts), facts);
    await watcher.syncJob('j1');
    expect(engine.pushStepInbox).not.toHaveBeenCalled();
  });

  it('reports every changed signal in one event', async () => {
    const { watcher, engine } = harness(
      orchestratedStepWithPr({ ciState: 'pending', reviewState: 'review_required' }),
      { ciState: 'success', reviewState: 'approved', prState: 'merged' },
    );
    await watcher.syncJob('j1');
    const [, , item] = engine.pushStepInbox.mock.calls[0]!;
    expect(new Set(item.events)).toEqual(new Set(['ci', 'review-state', 'pr-state']));
  });

  it('reports a fresh conflict as pr-state — it has no signal of its own', async () => {
    const { watcher, engine } = harness(orchestratedStepWithPr({}), { mergeable: 'conflicting' });
    await watcher.syncJob('j1');
    const [, , item] = engine.pushStepInbox.mock.calls[0]!;
    expect(item.events).toEqual(['pr-state']);
    expect(engine.applyPrFacts.mock.calls[0]![2]).toMatchObject({ mergeable: 'conflicting' });
  });

  it('drops an in-flight iteration when new comments arrive', async () => {
    const step = orchestratedStepWithPr({});
    step.iterations = [{ id: 'it1', kind: 'replies', status: 'in_progress', startedAt: 1 }];
    const { watcher, engine } = harness(step, { comments: [{ id: 'c9', body: 'new' }] });
    await watcher.syncJob('j1');

    const [, , item] = engine.pushStepInbox.mock.calls[0]!;
    expect(item.events).toContain('pr-comments');
    const last = engine.applyPrFacts.mock.calls.at(-1)!;
    expect(last[2]).toHaveProperty('comments');
    expect(last[3]).toEqual([]);
  });

  it('discovers the PR by branch and reports it as pr-state', async () => {
    const step = orchestratedStepWithPr({});
    step.pr = { prUrl: undefined as unknown as string, prState: undefined as unknown as string };
    const job = { id: 'j1', steps: [step] };
    const queue = { get: () => job, list: () => [job] } as never;
    const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
    const view = stubGh();
    const runGh = async (cwd: string, args: string[]) => (
      args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([{ url: PR_URL }]) : view(cwd, args)
    );
    await new PrWatcher({ queue, engine: engine as never, runGh }).syncJob('j1');

    expect(engine.applyPrFacts.mock.calls[0]![2]).toMatchObject({ prUrl: PR_URL, prState: 'open' });
    expect(engine.pushStepInbox.mock.calls[0]![2].events).toEqual(['pr-state']);
  });

  it('ignores steps the controller has already settled', async () => {
    const step = { ...orchestratedStepWithPr({}), state: 'resolved' };
    const { watcher, engine } = harness(step, { ciState: 'failure' });
    await watcher.syncJob('j1');
    expect(engine.applyPrFacts).not.toHaveBeenCalled();
    expect(engine.pushStepInbox).not.toHaveBeenCalled();
  });

  describe('discovery for a step with no PR', () => {
    function harnessWithoutPr() {
      const step = orchestratedStepWithPr({});
      step.pr = { prUrl: undefined as unknown as string, prState: undefined as unknown as string };
      const job = { id: 'j1', steps: [step] };
      const queue = { get: () => job, list: () => [job] } as never;
      const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
      let listCalls = 0;
      const runGh = async (cwd: string, args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'list') { listCalls++; return '[]'; }
        return stubGh()(cwd, args);
      };
      const watcher = new PrWatcher({ queue, engine: engine as never, runGh });
      return { watcher, step, calls: () => listCalls };
    }

    it('gives up after a bounded run of misses instead of paying a subprocess every sweep forever', async () => {
      const { watcher, calls } = harnessWithoutPr();
      for (let i = 0; i < 10; i++) await watcher.syncJob('j1');
      const boundedAt = calls();
      expect(boundedAt).toBeGreaterThan(0);
      expect(boundedAt).toBeLessThan(10);

      // N+1th sweep beyond the bound issues no further gh pr list calls.
      await watcher.syncJob('j1');
      expect(calls()).toBe(boundedAt);
    });

    it('re-arms discovery when the controller reports a new round', async () => {
      const { watcher, step, calls } = harnessWithoutPr();
      for (let i = 0; i < 20; i++) await watcher.syncJob('j1');
      const boundedAt = calls();

      await watcher.syncJob('j1');
      expect(calls()).toBe(boundedAt); // still exhausted, no new round yet

      step.roundsSpent += 1; // controller took a move — something could have opened a PR
      await watcher.syncJob('j1');
      expect(calls()).toBe(boundedAt + 1);
    });
  });
});
