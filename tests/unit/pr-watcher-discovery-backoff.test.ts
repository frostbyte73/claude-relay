import { describe, it, expect, vi } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';
import type { InboxItem, PrFacts } from '../../src/work/work-types.js';

// A step whose `origin` names a repo that does not resolve on GitHub fails `gh pr list`
// identically forever. Discovery is deliberately unbounded for a *miss* (see syncStep), and
// that read of "keep trying" was applied to errors too: one such step polled every 5 minutes
// for ~20 days and wrote 5,981 identical stderr lines. Errors back off; misses do not.

function harness(discover: () => Promise<string>, state = 'waiting') {
  const step = {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', cancelled: false,
    state,
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    pr: {},
  };
  const job = { id: 'JOB-1', steps: [step] };
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyPrFacts: (_j: string, _s: string, _f: PrFacts) => {},
    pushStepInbox: (_j: string, _s: string, _i: InboxItem) => {},
  } as never;
  const runGh = vi.fn(discover);
  const remoteHead = vi.fn(async () => undefined);
  return { watcher: new PrWatcher({ queue, engine, runGh, remoteHead }), runGh, remoteHead, step };
}

async function sweep(watcher: PrWatcher, times: number) {
  for (let i = 0; i < times; i++) await watcher.syncJob('JOB-1');
}

describe('PrWatcher discovery backoff', () => {
  it('backs off a repo that never resolves instead of polling it every sweep', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { watcher, runGh } = harness(async () => {
      throw new Error("Could not resolve to a Repository with the name 'livekit/nope'.");
    });

    await sweep(watcher, 20);

    // Attempts land on the doubling curve — sweeps 1, 3, 6, 11, 20.
    expect(runGh).toHaveBeenCalledTimes(5);
    // ...and only the first failure of the streak is logged, not all five.
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('leaves a clean miss on the full cadence — that is the normal pre-PR state', async () => {
    const { watcher, runGh } = harness(async () => '[]');

    await sweep(watcher, 20);

    expect(runGh).toHaveBeenCalledTimes(20);
  });

  // The one signal a controller parked on "waiting for you to push" has. It talks to the SSH
  // remote rather than the API, so it can still answer when the token cannot — backing it off
  // alongside discovery would strand exactly the step this is meant to keep cheap.
  it('keeps polling the branch head every sweep while discovery is backed off', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { watcher, remoteHead } = harness(async () => { throw new Error('boom'); });

    await sweep(watcher, 20);

    expect(remoteHead).toHaveBeenCalledTimes(20);
    err.mockRestore();
  });

  it('resets the streak once discovery answers again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const { watcher, runGh } = harness(async () => {
      if (fail) throw new Error('boom');
      return '[]';
    });

    await sweep(watcher, 3);           // attempts on sweeps 1 and 3, both failing
    expect(runGh).toHaveBeenCalledTimes(2);
    fail = false;
    await sweep(watcher, 3);           // sweeps 4-5 are skipped, sweep 6 recovers
    expect(runGh).toHaveBeenCalledTimes(3);
    await sweep(watcher, 3);           // back on the full cadence
    expect(runGh).toHaveBeenCalledTimes(6);
    err.mockRestore();
  });
});
