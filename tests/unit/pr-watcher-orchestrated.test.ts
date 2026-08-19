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
  headRefOid?: string;
  comments?: Array<{ id: string; body: string; author?: string }>;
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
function stubGh(over: Facts = {}, viewer = 'dc') {
  const view = JSON.stringify({
    number: 15282, url: PR_URL, state: PR_STATE[over.prState ?? 'open'],
    reviews: [],
    comments: (over.comments ?? []).map((c) => ({
      id: c.id, author: { login: c.author ?? 'devin' }, body: c.body, createdAt: '2026-01-01T00:00:00Z',
    })),
    ...(over.ciState ? { statusCheckRollup: [ROLLUP[over.ciState]] } : {}),
    ...(over.reviewState ? { reviewDecision: REVIEW[over.reviewState] } : {}),
    ...(over.mergeable ? { mergeable: over.mergeable.toUpperCase() } : {}),
    ...(over.headRefOid ? { headRefOid: over.headRefOid } : {}),
  });
  return async (_cwd: string, args: string[]) => {
    if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: viewer });
    return args[0] === 'api' ? '[]' : view;
  };
}

function harness(step: ReturnType<typeof orchestratedStepWithPr>, gh: Facts = {}, viewer = 'dc') {
  const job = { id: 'j1', steps: [step] };
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
  const watcher = new PrWatcher({ queue, engine: engine as never, runGh: stubGh(gh, viewer) });
  return { watcher, engine };
}

// The events pushed by a single sync, or [] if the watcher stayed quiet.
function eventsFrom(engine: { pushStepInbox: { mock: { calls: unknown[][] } } }): string[] {
  const call = engine.pushStepInbox.mock.calls[0];
  return call ? ((call[2] as { events: string[] }).events) : [];
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

  // GitHub answers UNKNOWN intermittently on an idle PR. Storing it flipped
  // mergeable→unknown→mergeable on alternating sweeps and reported each flip as pr-state — one
  // step collected 76 identical "PR open" wakes that way.
  it('holds the last known mergeability instead of recording an UNKNOWN over it', async () => {
    const { watcher, engine } = harness(
      orchestratedStepWithPr({ mergeable: 'mergeable' }), { mergeable: 'unknown' },
    );
    await watcher.syncJob('j1');
    expect(engine.pushStepInbox).not.toHaveBeenCalled();
    expect(engine.applyPrFacts.mock.calls[0]![2]).not.toHaveProperty('mergeable');
  });

  // The flip side: holding the known value must not swallow a real verdict arriving after it.
  it('still reports a conflict that lands while mergeability was unknown', async () => {
    const { watcher, engine } = harness(
      orchestratedStepWithPr({ mergeable: 'mergeable' }), { mergeable: 'conflicting' },
    );
    await watcher.syncJob('j1');
    const [, , item] = engine.pushStepInbox.mock.calls[0]!;
    expect(item.events).toEqual(['pr-state']);
  });

  // Nothing known yet — an UNKNOWN is the only thing there is to record.
  it('records UNKNOWN when there is no prior verdict to hold', async () => {
    const step = orchestratedStepWithPr({});
    delete (step.pr as Record<string, unknown>).mergeable;
    const { watcher, engine } = harness(step, { mergeable: 'unknown' });
    await watcher.syncJob('j1');
    expect(engine.applyPrFacts.mock.calls[0]![2]).toMatchObject({ mergeable: 'unknown' });
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

  describe('the head sha', () => {
    it('records the PR head as a fact', async () => {
      const { watcher, engine } = harness(orchestratedStepWithPr({}), { headRefOid: 'abc1234' });
      await watcher.syncJob('j1');
      expect(engine.applyPrFacts.mock.calls[0]![2]).toMatchObject({ headRefOid: 'abc1234' });
    });

    it('reports a moved head as head-moved, and nothing else', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ headRefOid: 'abc1234' }), { headRefOid: 'def4567' },
      );
      await watcher.syncJob('j1');
      const [, , item] = engine.pushStepInbox.mock.calls[0]!;
      expect(item.events).toEqual(['head-moved']);
      expect(item.summary).toContain('def4567');
    });

    it('stays quiet when the head is unchanged', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ headRefOid: 'abc1234' }), { headRefOid: 'abc1234' },
      );
      await watcher.syncJob('j1');
      expect(engine.pushStepInbox).not.toHaveBeenCalled();
    });

    // PrFacts persisted before headRefOid existed carry none, so the first poll after a
    // daemon bounce has nothing to compare against. Recording it is right; calling it a
    // move would send a live controller off to re-verify a head that never moved.
    it('does not call the first sha it ever sees a move', async () => {
      const { watcher, engine } = harness(orchestratedStepWithPr({}), { headRefOid: 'abc1234' });
      await watcher.syncJob('j1');
      expect(engine.applyPrFacts.mock.calls[0]![2]).toMatchObject({ headRefOid: 'abc1234' });
      expect(engine.pushStepInbox).not.toHaveBeenCalled();
    });

    // code.orchestrate-pr is live in production waiting on these four. A push that also
    // moves one of them must still report exactly that one alongside head-moved — never
    // fold them together, never drop one.
    it('leaves the other four signals exactly as they were', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'pending', headRefOid: 'abc1234' }),
        { ciState: 'failure', headRefOid: 'def4567' },
      );
      await watcher.syncJob('j1');
      const [, , item] = engine.pushStepInbox.mock.calls[0]!;
      expect(new Set(item.events)).toEqual(new Set(['ci', 'head-moved']));
    });

    // The same push with CI merely restarting: head-moved still stands on its own, and the
    // `pending` rung is dropped rather than riding along on the back of a real signal.
    it('reports the head move alone when the push only restarted CI', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'success', headRefOid: 'abc1234' }),
        { ciState: 'pending', headRefOid: 'def4567' },
      );
      await watcher.syncJob('j1');
      const [, , item] = engine.pushStepInbox.mock.calls[0]!;
      expect(new Set(item.events)).toEqual(new Set(['head-moved']));
    });

    it('reports only ci when the head held still', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'pending', headRefOid: 'abc1234' }),
        { ciState: 'failure', headRefOid: 'abc1234' },
      );
      await watcher.syncJob('j1');
      expect(engine.pushStepInbox.mock.calls[0]![2].events).toEqual(['ci']);
    });

    it('asks gh for headRefOid in the same pr view call', async () => {
      const ghCalls: string[][] = [];
      const job = { id: 'j1', steps: [orchestratedStepWithPr({})] };
      const queue = { get: () => job, list: () => [job] } as never;
      const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
      const stub = stubGh({ headRefOid: 'abc1234' });
      const runGh = async (cwd: string, args: string[]) => { ghCalls.push(args); return stub(cwd, args); };
      await new PrWatcher({ queue, engine: engine as never, runGh }).syncJob('j1');

      const views = ghCalls.filter((c) => c[0] === 'pr' && c[1] === 'view');
      expect(views).toHaveLength(1);
      expect(views[0]![views[0]!.indexOf('--json') + 1]).toContain('headRefOid');
    });
  });

  it('ignores steps the controller has already settled', async () => {
    const step = { ...orchestratedStepWithPr({}), state: 'resolved' };
    const { watcher, engine } = harness(step, { ciState: 'failure' });
    await watcher.syncJob('j1');
    expect(engine.applyPrFacts).not.toHaveBeenCalled();
    expect(engine.pushStepInbox).not.toHaveBeenCalled();
  });

  describe('a readonly review step', () => {
    function reviewStep(over: { inputsPrUrl?: string; storedPrUrl?: string } = {}) {
      return {
        id: 'rev-1', type: 'orchestrated', controller: 'code.orchestrate-review',
        title: 'review it', description: '', goal: 'review it',
        state: 'waiting', sessionId: 'sess1', cancelled: false,
        workspace: { kind: 'readonly', repoCwd: '/tmp/repo-ro', ref: 'refs/pull/7/head' },
        dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
        iterations: [] as Array<Record<string, unknown>>,
        ...(over.inputsPrUrl ? { inputs: { prUrl: over.inputsPrUrl } } : {}),
        ...(over.storedPrUrl ? { pr: { prUrl: over.storedPrUrl, prState: 'open' } } : {}),
        createdAt: 0, updatedAt: 0,
      };
    }

    function harnessFor(step: ReturnType<typeof reviewStep>, gh: Facts = {}) {
      const job = { id: 'j1', steps: [step] };
      const queue = { get: () => job, list: () => [job] } as never;
      const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
      const ghCalls: string[][] = [];
      const stub = stubGh(gh);
      const runGh = async (cwd: string, args: string[]) => { ghCalls.push(args); return stub(cwd, args); };
      const watcher = new PrWatcher({ queue, engine: engine as never, runGh });
      return { watcher, engine, ghCalls };
    }

    it('tracks a readonly orchestrated step by its inputs.prUrl', async () => {
      const step = reviewStep({ inputsPrUrl: PR_URL });
      const { watcher, engine } = harnessFor(step, { ciState: 'success' });
      await watcher.syncJob('j1');
      expect(engine.applyPrFacts).toHaveBeenCalledWith(
        'j1', 'rev-1', expect.objectContaining({ prUrl: PR_URL }),
      );
    });

    it('polls a readonly step by its already-stored pr.prUrl too', async () => {
      const step = reviewStep({ storedPrUrl: PR_URL });
      const { watcher, engine } = harnessFor(step, { ciState: 'failure' });
      await watcher.syncJob('j1');
      expect(engine.applyPrFacts).toHaveBeenCalledWith(
        'j1', 'rev-1', expect.objectContaining({ ciState: 'failure' }),
      );
    });

    it('never runs PR discovery for a readonly step', async () => {
      const step = reviewStep(); // no inputs.prUrl, no stored pr — nothing to poll by
      const { watcher, engine, ghCalls } = harnessFor(step);
      await watcher.syncJob('j1');
      expect(ghCalls.filter((c) => c[0] === 'pr' && c[1] === 'list')).toHaveLength(0);
      expect(ghCalls).toHaveLength(0);
      expect(engine.applyPrFacts).not.toHaveBeenCalled();
    });

    it('ignores a readonly step whose inputs.prUrl fails the anchored allowlist', async () => {
      const step = reviewStep({ inputsPrUrl: 'https://github.com/acme/example/pull/15282; rm -rf /' });
      const { watcher, engine, ghCalls } = harnessFor(step);
      await watcher.syncJob('j1');
      expect(ghCalls).toHaveLength(0);
      expect(engine.applyPrFacts).not.toHaveBeenCalled();
    });

    it('skips a step with no workspace at all even if it carries a prUrl', async () => {
      const step = {
        ...reviewStep({ inputsPrUrl: PR_URL }),
        workspace: { kind: 'none' },
      } as unknown as ReturnType<typeof reviewStep>;
      const { watcher, engine, ghCalls } = harnessFor(step);
      await watcher.syncJob('j1');
      expect(ghCalls).toHaveLength(0);
      expect(engine.applyPrFacts).not.toHaveBeenCalled();
    });
  });
});

// The watcher's job is to wake a controller when a signal reaches a value its ladder can act
// on — not whenever a signal moves. Every wake costs a round, and one that lands on a rung the
// ladder has no row for is spent re-arming the same wait. See `orchestrate-pr/SKILL.md`.
describe('PrWatcher — waking only on what the ladder can act on', () => {
  describe('CI', () => {
    // Row 9 needs a SETTLED failure; row 13 needs success. `pending` is neither, so the
    // controller can do nothing but wait again — and it is the controller's own fix-ci push
    // that puts CI back into it.
    it('stays quiet when CI goes back to pending on a fresh push', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'success' }), { ciState: 'pending' },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).not.toContain('ci');
    });

    it('wakes on a CI failure — that is row 9', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'pending' }), { ciState: 'failure' },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toContain('ci');
    });

    // Green with nothing to merge into is the expected case, and row 13 needs the approval too.
    it('stays quiet when CI goes green but review has not approved yet', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'pending', reviewState: 'review_required' }),
        { ciState: 'success', reviewState: 'review_required' },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toEqual([]);
    });

    // ...but green on an already-approved PR IS row 13 firing. Suppressing this one strands the
    // step: nothing else moves afterwards, so no later wake would ever carry the news.
    it('wakes when CI goes green on an already-approved PR', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'pending', reviewState: 'approved' }),
        { ciState: 'success', reviewState: 'approved' },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toContain('ci');
    });

    it('wakes when the approval and the green land in the same poll', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'pending', reviewState: 'review_required' }),
        { ciState: 'success', reviewState: 'approved' },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toContain('ci');
    });

    // Suppressing the wake must not suppress the fact — the controller reads ciState off its
    // envelope on whatever wakes it next, and the badge in the PWA reads the same field.
    it('still records a suppressed CI state', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ ciState: 'success' }), { ciState: 'pending' },
      );
      await watcher.syncJob('j1');
      expect(engine.applyPrFacts).toHaveBeenCalledWith('j1', 's1', expect.objectContaining({ ciState: 'pending' }));
    });
  });

  describe('comments', () => {
    it('stays quiet when the only new comment is one we posted ourselves', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ comments: [] }),
        { comments: [{ id: '1', body: 'replying to the review', author: 'dc' }] },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).not.toContain('pr-comments');
    });

    it('wakes on a comment from anybody else', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ comments: [] }),
        { comments: [{ id: '1', body: 'this looks wrong', author: 'milos' }] },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toContain('pr-comments');
    });

    it('wakes when our own reply arrives alongside somebody elses', async () => {
      const { watcher, engine } = harness(
        orchestratedStepWithPr({ comments: [] }),
        { comments: [
          { id: '1', body: 'replying', author: 'dc' },
          { id: '2', body: 'one more thing', author: 'milos' },
        ] },
      );
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toContain('pr-comments');
    });

    // Fail open: an identity we could not resolve must never silence a real comment.
    it('wakes on every comment when the viewer login cannot be resolved', async () => {
      const job = { id: 'j1', steps: [orchestratedStepWithPr({ comments: [] })] };
      const queue = { get: () => job, list: () => [job] } as never;
      const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
      const inner = stubGh({ comments: [{ id: '1', body: 'mine', author: 'dc' }] });
      const watcher = new PrWatcher({
        queue, engine: engine as never,
        runGh: async (cwd: string, args: string[]) => {
          if (args[0] === 'api' && args[1] === 'user') throw new Error('gh: not authenticated');
          return inner(cwd, args);
        },
      });
      await watcher.syncJob('j1');
      expect(eventsFrom(engine)).toContain('pr-comments');
    });
  });
});
