import { describe, it, expect } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';
import type { InboxItem, PrFacts } from '../../src/work/work-types.js';

// Before a PR exists there is nothing for `gh pr view` to read, so the watcher used to report
// nothing at all between "the step has a branch" and "a PR appeared on it". That gap is what
// made code.orchestrate-pr's row 5 arm an hourly `resumeAt` and poll for the user's push —
// two rounds per hour spent learning nothing. origin's head for the step's own branch closes
// it: the branch landing IS the event, and the daemon is what reports it.

function harness(head: string | undefined, pr: PrFacts = {}) {
  const step = {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', cancelled: false,
    state: 'waiting',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    pr,
  };
  const job = { id: 'JOB-1', steps: [step] };
  const patches: PrFacts[] = [];
  const pushed: InboxItem[] = [];
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyPrFacts: (_j: string, _s: string, facts: PrFacts) => patches.push(facts),
    pushStepInbox: (_j: string, _s: string, item: InboxItem) => pushed.push(item),
  } as never;
  // No PR on the branch — discovery misses, which is the whole case under test.
  const runGh = async () => '[]';
  return {
    watcher: new PrWatcher({ queue, engine, runGh, remoteHead: async () => head }),
    patches, pushed,
  };
}

describe('PrWatcher pre-PR branch head', () => {
  it('reports the branch landing on origin as head-moved', async () => {
    const { watcher, patches, pushed } = harness('a'.repeat(40));
    await watcher.syncJob('JOB-1');

    expect(patches).toEqual([{ branchHeadOid: 'a'.repeat(40) }]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: 'external', events: ['head-moved'] });
  });

  it('says nothing while the branch is still unpushed', async () => {
    const { watcher, patches, pushed } = harness(undefined);
    await watcher.syncJob('JOB-1');

    expect(patches).toEqual([]);
    expect(pushed).toEqual([]);
  });

  // Every sweep re-reads the same sha. Reporting it each time would wake the controller on a
  // loop — the exact cost the self-armed timer had, just paid by the daemon instead.
  it('says nothing when the head is unchanged since the last sweep', async () => {
    const { watcher, patches, pushed } = harness('a'.repeat(40), { branchHeadOid: 'a'.repeat(40) });
    await watcher.syncJob('JOB-1');

    expect(patches).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('reports a further push on the same still-PR-less branch', async () => {
    const { watcher, pushed } = harness('b'.repeat(40), { branchHeadOid: 'a'.repeat(40) });
    await watcher.syncJob('JOB-1');

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ events: ['head-moved'] });
  });
});
