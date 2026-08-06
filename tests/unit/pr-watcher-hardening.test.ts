import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

const PR_URL = 'https://github.com/acme/example/pull/15282';

const VIEW = JSON.stringify({
  number: 15282, url: PR_URL, state: 'OPEN', reviews: [], comments: [],
});

function reviewStep(over: { inputsPrUrl?: string; pr?: Record<string, unknown> } = {}) {
  return {
    id: 'rev-1', type: 'orchestrated', controller: 'code.orchestrate-review',
    title: 'review it', description: '', goal: 'review it',
    state: 'waiting', sessionId: 'sess1', cancelled: false,
    workspace: { kind: 'readonly', repoCwd: '/tmp/repo-ro', ref: 'refs/pull/7/head' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    iterations: [] as Array<Record<string, unknown>>,
    ...(over.inputsPrUrl ? { inputs: { prUrl: over.inputsPrUrl } } : {}),
    ...(over.pr ? { pr: over.pr } : {}),
    createdAt: 0, updatedAt: 0,
  };
}

function harness(step: Record<string, unknown>) {
  const job = { id: 'j1', steps: [step] };
  const queue = { get: (id: string) => (id === 'j1' ? job : undefined), list: () => [job] } as never;
  const engine = { applyPrFacts: vi.fn(), pushStepInbox: vi.fn() };
  const ghCalls: string[][] = [];
  const runGh = async (_cwd: string, args: string[]) => {
    ghCalls.push(args);
    return args[0] === 'api' ? '[]' : VIEW;
  };
  const watcher = new PrWatcher({ queue, engine: engine as never, runGh });
  return { watcher, engine, ghCalls };
}

// F3: knownPrUrl() validated at entry, but syncStep then preferred the UNVALIDATED
// prev.prUrl. s.pr is settable from outside — POST /api/work/jobs/:id/steps spreads
// `...rest` into the step verbatim and server.ts has no auth beyond the tailnet.
describe('PrWatcher — prUrl is validated where it reaches gh, not only where it enters', () => {
  const HOSTILE = [
    '--version',                                   // argv-flag smuggling into `gh`
    'https://github.com/../../../users/foo/pull/1', // path traversal into `gh api repos/<o>/<r>/…`
    'https://github.com/acme/example/pull/1?x=y',   // unanchored tail
    'https://evil.example/acme/example/pull/1',
  ];

  it('never hands a stored prUrl that fails the anchored check to gh', async () => {
    for (const hostile of HOSTILE) {
      const { watcher, ghCalls } = harness(reviewStep({ pr: { prUrl: hostile, prState: 'open' } }));
      await watcher.syncJob('j1');
      expect(ghCalls.flat(), hostile).not.toContain(hostile);
      expect(ghCalls.flat().join(' '), hostile).not.toContain('users/foo');
    }
  });

  it('falls back to the validated inputs.prUrl when the stored one is malformed', async () => {
    const { watcher, ghCalls } = harness(
      reviewStep({ inputsPrUrl: PR_URL, pr: { prUrl: '--version', prState: 'open' } }),
    );
    await watcher.syncJob('j1');
    expect(ghCalls.flat()).not.toContain('--version');
    expect(ghCalls.flat()).toContain(PR_URL);
  });

  it('a writable step with a poisoned stored prUrl re-discovers instead of polling it', async () => {
    const step = {
      ...reviewStep(),
      workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
      pr: { prUrl: '--version', prState: 'open' },
    };
    const { watcher, ghCalls } = harness(step);
    await watcher.syncJob('j1');
    expect(ghCalls.flat()).not.toContain('--version');
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'list')).toBe(true);
  });
});

// F8a: the anchored check permitted `.` and `..` as an owner/repo segment, and
// parsePrUrl feeds those straight into `gh api repos/<owner>/<repo>/pulls/<n>/comments`.
describe('PrWatcher — owner/repo segments cannot be . or ..', () => {
  it('rejects a dot-segment owner or repo', async () => {
    for (const url of [
      'https://github.com/../example/pull/1',
      'https://github.com/acme/../pull/1',
      'https://github.com/./example/pull/1',
      'https://github.com/acme/./pull/1',
    ]) {
      const { watcher, ghCalls } = harness(reviewStep({ inputsPrUrl: url }));
      await watcher.syncJob('j1');
      expect(ghCalls, url).toHaveLength(0);
    }
  });

  it('still accepts dots inside a segment', async () => {
    const { watcher, ghCalls } = harness(
      reviewStep({ inputsPrUrl: 'https://github.com/acme/my.repo.js/pull/1' }),
    );
    await watcher.syncJob('j1');
    expect(ghCalls.length).toBeGreaterThan(0);
  });
});

// F4: the controller supplied the URL itself, so echoing it back as a moved signal
// wakes it — and a wake costs a round against MAX_ROUNDS.
describe('PrWatcher — the known-URL path is not its own signal', () => {
  it('does not report pr-state purely because it recorded the URL it was given', async () => {
    const { watcher, engine } = harness(
      reviewStep({ inputsPrUrl: PR_URL, pr: { prState: 'open' } }),
    );
    await watcher.syncJob('j1');
    expect(engine.applyPrFacts).toHaveBeenCalledWith('j1', 'rev-1', expect.objectContaining({ prUrl: PR_URL }));
    expect(engine.pushStepInbox).not.toHaveBeenCalled();
  });

  it('still reports a state the controller could not have known', async () => {
    const { watcher, engine } = harness(reviewStep({ inputsPrUrl: PR_URL }));
    await watcher.syncJob('j1');
    // prState was genuinely unknown before this poll — that wake is load-bearing.
    const [, , item] = engine.pushStepInbox.mock.calls[0]!;
    expect(item.events).toEqual(['pr-state']);
  });
});

// F8d: entries were replaced by a later noteChanged but never removed, leaving one dead
// array per job for the daemon's lifetime.
describe('PrWatcher — the escalation ladder does not accumulate', () => {
  afterEach(() => vi.useRealTimers());

  it('drops the job entry once the last rung has fired', async () => {
    vi.useFakeTimers();
    const { watcher } = harness(reviewStep({ inputsPrUrl: PR_URL }));
    const timers = (watcher as unknown as { escalationTimers: Map<string, unknown> }).escalationTimers;

    watcher.noteChanged('j-done');
    expect(timers.size).toBe(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(timers.size).toBe(0);
  });

  it('a re-arm before the ladder finishes keeps exactly one entry', async () => {
    vi.useFakeTimers();
    const { watcher } = harness(reviewStep({ inputsPrUrl: PR_URL }));
    const timers = (watcher as unknown as { escalationTimers: Map<string, unknown> }).escalationTimers;

    watcher.noteChanged('j-live');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    watcher.noteChanged('j-live');
    expect(timers.size).toBe(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(timers.size).toBe(0);
  });
});
