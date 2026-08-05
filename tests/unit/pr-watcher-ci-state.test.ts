import { describe, it, expect } from 'vitest';
import { PrWatcher } from '../../src/integrations/pr-watcher.js';

// Regression: after a push the badge stayed "CI ok". The rollup either reports
// an in-progress check (should read as pending) or is transiently empty for the
// new head (must clear the stale terminal result, but only if there was one).

function makeStep(prOver: Record<string, unknown> = {}) {
  return {
    id: 's1', type: 'orchestrated', controller: 'code.orchestrate-pr', cancelled: false,
    state: 'waiting',
    workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'feat/x' },
    dispatches: [], inbox: [], roundsSpent: 0, consecutiveSelfRounds: 0,
    pr: {
      prUrl: 'https://github.com/acme/example/pull/639',
      prState: 'open',
      comments: [],
      ...prOver,
    },
  };
}

function harness(step: ReturnType<typeof makeStep>, rollup: unknown[] | undefined, viewOver: Record<string, unknown> = {}) {
  const job = { id: 'JOB-1', steps: [step] };
  const patches: Array<Record<string, unknown>> = [];
  const queue = { get: () => job, list: () => [job] } as never;
  const engine = {
    applyPrFacts: (_j: string, _s: string, facts: Record<string, unknown>) => patches.push(facts),
    pushStepInbox: () => {},
  } as never;
  const view = JSON.stringify({
    number: 639, url: 'x', state: 'OPEN', reviews: [], comments: [],
    ...(rollup === undefined ? {} : { statusCheckRollup: rollup }),
    ...viewOver,
  });
  const runGh = async (_cwd: string, args: string[]) => (args[0] === 'api' ? '[]' : view);
  const watcher = new PrWatcher({ queue, engine, runGh });
  return { watcher, patches };
}

const ciOf = (patches: Array<Record<string, unknown>>) =>
  patches.find((p) => 'ciState' in p)?.ciState;
const checksOf = (patches: Array<Record<string, unknown>>) =>
  patches.find((p) => 'ciChecks' in p)?.ciChecks as
    | Array<{ name: string; state: string; url?: string }> | undefined;

describe('PrWatcher CI state', () => {
  it('reports pending when the rollup has an in-progress check (the mixed rollup)', async () => {
    const rollup = [
      { conclusion: '', status: 'IN_PROGRESS' },   // test (integration), still running
      { conclusion: 'SUCCESS', status: 'COMPLETED' },
      { conclusion: 'SUCCESS', status: 'COMPLETED' },
    ];
    const { watcher, patches } = harness(makeStep({ ciState: 'success' }), rollup);
    await watcher.syncJob('JOB-1');
    expect(ciOf(patches)).toBe('pending');
  });

  it('clears a stale terminal ciState to pending on an empty rollup (fresh push)', async () => {
    const { watcher, patches } = harness(makeStep({ ciState: 'success' }), []);
    await watcher.syncJob('JOB-1');
    expect(ciOf(patches)).toBe('pending');
  });

  it('leaves ciState unset on an empty rollup when the PR never had CI', async () => {
    const { watcher, patches } = harness(makeStep(), []);
    await watcher.syncJob('JOB-1');
    expect(ciOf(patches)).toBeUndefined();
  });

  it('breaks the rollup into a per-workflow list (CheckRun + StatusContext)', async () => {
    const rollup = [
      { workflowName: 'CI', name: 'test (integration)', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://gh/run/1' },
      { workflowName: 'CI', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://gh/run/2' },
      { workflowName: 'CI', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://gh/run/3' },
      { name: 'unit', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'https://gh/status/4' },
    ];
    const { watcher, patches } = harness(makeStep(), rollup);
    await watcher.syncJob('JOB-1');
    expect(ciOf(patches)).toBe('failure'); // any failing check fails the rollup
    expect(checksOf(patches)).toEqual([
      { name: 'CI / test (integration)', state: 'pending', url: 'https://gh/run/1' },
      { name: 'CI / lint', state: 'success', url: 'https://gh/run/2' },
      { name: 'CI / build', state: 'failure', url: 'https://gh/run/3' },
      { name: 'unit', state: 'skipped' },
      { name: 'ci/legacy', state: 'success', url: 'https://gh/status/4' },
    ]);
  });

  it('clears a stale check list to empty on an empty rollup (fresh push)', async () => {
    const { watcher, patches } = harness(
      makeStep({ ciState: 'success', ciChecks: [{ name: 'CI / test', state: 'success' }] }),
      [],
    );
    await watcher.syncJob('JOB-1');
    expect(checksOf(patches)).toEqual([]);
  });
});

// Regression: the PR was blocked by merge conflicts, not CI — its checks
// read as pending, so the badge misrepresented the blocker. `mergeable` captures
// the conflict independently.
const mergeableOf = (patches: Array<Record<string, unknown>>) =>
  patches.find((p) => 'mergeable' in p)?.mergeable;

describe('PrWatcher mergeability', () => {
  it('surfaces a merge conflict as conflicting alongside a still-pending rollup', async () => {
    const rollup = [{ conclusion: '', status: 'IN_PROGRESS' }];
    const { watcher, patches } = harness(makeStep(), rollup, { mergeable: 'CONFLICTING' });
    await watcher.syncJob('JOB-1');
    expect(ciOf(patches)).toBe('pending');
    expect(mergeableOf(patches)).toBe('conflicting');
  });

  it('maps a clean PR to mergeable', async () => {
    const { watcher, patches } = harness(makeStep(), [{ conclusion: 'SUCCESS' }], { mergeable: 'MERGEABLE' });
    await watcher.syncJob('JOB-1');
    expect(mergeableOf(patches)).toBe('mergeable');
  });

  it('maps GitHub\'s still-computing UNKNOWN through rather than dropping it', async () => {
    const { watcher, patches } = harness(makeStep(), [], { mergeable: 'UNKNOWN' });
    await watcher.syncJob('JOB-1');
    expect(mergeableOf(patches)).toBe('unknown');
  });
});
