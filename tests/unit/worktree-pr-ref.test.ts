import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, repoFromRemoteUrl } from '../../src/git/worktree-manager.js';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-pr-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'init']);
  return dir;
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wt-pr-mgr-'));
}

function projectsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wt-pr-projects-'));
}

function headOf(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function outpostRefs(cwd: string): string[] {
  const out = execFileSync('git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', 'refs/outpost'], {
    encoding: 'utf8',
  }).trim();
  return out ? out.split('\n') : [];
}

// origin: bare repo with a commit on main; a second commit published only under
// refs/pull/7/head (never a refs/heads branch, so a normal clone never learns of it).
// clone: `git clone` of origin — has fetched main only, exactly what provision() sees
// on a step's first ever "review this PR" request.
function makePrFixture(): { origin: string; clone: string; prHeadSha: string } {
  const origin = mkdtempSync(join(tmpdir(), 'wt-pr-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  const seed = makeGitRepo();
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main']);

  execFileSync('git', ['-C', seed, 'checkout', '-q', '-b', 'pr-7-work']);
  execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-q', '-m', 'pr-7 head']);
  const prHeadSha = headOf(seed);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'pr-7-work:refs/pull/7/head']);

  const clone = mkdtempSync(join(tmpdir(), 'wt-pr-clone-'));
  execFileSync('git', ['clone', '-q', origin, clone]);
  execFileSync('git', ['-C', clone, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', clone, 'config', 'user.name', 'Test']);

  return { origin, clone, prHeadSha };
}

// Same fixture, but the clone is configured the way `gh`-adjacent setups and CI mirrors
// commonly are: `remote.origin.fetch += +refs/pull/*/head:refs/pull/*/head`. The clone
// therefore holds its OWN copy of refs/pull/7/head, which goes stale the moment the PR
// author force-pushes. This is the fixture that discriminates a freshness guard probing
// the ref it writes from one probing the ref the caller named.
function makeMirroredPrFixture(): { origin: string; clone: string; v1: string } {
  const { origin, clone, prHeadSha } = makePrFixture();
  execFileSync('git', ['-C', clone, 'config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/pull/*/head']);
  execFileSync('git', ['-C', clone, 'fetch', '-q', 'origin']);
  expect(
    execFileSync('git', ['-C', clone, 'rev-parse', 'refs/pull/7/head'], { encoding: 'utf8' }).trim(),
  ).toBe(prHeadSha);
  return { origin, clone, v1: prHeadSha };
}

// Force-push a new commit onto refs/pull/7/head from a throwaway clone of the same origin.
function forcePushNewPrHead(origin: string): string {
  const author = mkdtempSync(join(tmpdir(), 'wt-pr-author-'));
  execFileSync('git', ['clone', '-q', origin, author]);
  execFileSync('git', ['-C', author, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', author, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', author, 'fetch', '-q', 'origin', 'refs/pull/7/head:pr-7-local']);
  execFileSync('git', ['-C', author, 'checkout', '-q', 'pr-7-local']);
  execFileSync('git', ['-C', author, 'commit', '--allow-empty', '-q', '-m', 'new push']);
  const sha = headOf(author);
  execFileSync('git', ['-C', author, 'push', '-q', '-f', 'origin', 'pr-7-local:refs/pull/7/head']);
  return sha;
}

describe('WorktreeManager — readonly provision at a PR head', () => {
  it('provisions a readonly worktree at a PR head that was never fetched', async () => {
    const { clone, prHeadSha } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-pr', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(path).toBeTruthy();
    expect(headOf(path!)).toBe(prHeadSha);
  });

  it('checks out the ref it fetched, never the caller-supplied refs/pull ref', async () => {
    const { clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await m.provision('step-pr', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(m.get('step-pr')!.baseRef).toBe('refs/outpost/pr-7');
  });

  it('re-provisioning picks up a new push to the same PR', async () => {
    const { origin, clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await m.provision('step-pr-1', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    const newPrHeadSha = forcePushNewPrHead(origin);

    const { path } = await m.provision('step-pr-2', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(headOf(path!)).toBe(newPrHeadSha);
  });

  // F1: the freshness fast path used to probe `refs/pull/<N>/head` while the fetch wrote
  // `refs/outpost/pr-<N>`. On a clone that mirrors refs/pull the probe hit a ref that always
  // resolves, the fetch was skipped, and `worktree add` checked out the pre-force-push commit.
  it('ignores a locally mirrored refs/pull ref and still fetches the current PR head', async () => {
    const { origin, clone, v1 } = makeMirroredPrFixture();
    const v2 = forcePushNewPrHead(origin);
    expect(v2).not.toBe(v1);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-mirror', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(headOf(path!)).toBe(v2);
  });

  it('refuses rather than checking out a stale mirrored ref when the fetch cannot run', async () => {
    const { clone } = makeMirroredPrFixture();
    execFileSync('git', ['-C', clone, 'remote', 'set-url', 'origin', join(tmpdir(), 'wt-pr-nonexistent-origin')]);
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await expect(
      m.provision('step-stale', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' }),
    ).rejects.toThrow();
  });

  it('still provisions at an ordinary local ref with no fetch', async () => {
    const { clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-main', { kind: 'readonly', repoCwd: clone, ref: 'main' });
    expect(path).toBeTruthy();
  });

  it('rejects instead of hanging when the remote is unreachable and the PR head was never fetched', async () => {
    const { clone } = makePrFixture();
    // Point origin at a path that doesn't exist — fetch fails immediately, not a network timeout.
    execFileSync('git', ['-C', clone, 'remote', 'set-url', 'origin', join(tmpdir(), 'wt-pr-nonexistent-origin')]);
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    // engine.ts (resumeControllerRound, ~line 1463-1471) wraps provision() in try/catch and
    // reports the rejection via onStepFailed({ journal: false }) — mirror that contract rather
    // than inventing a `{ path: null }` result for this case.
    await expect(
      m.provision('step-unreachable', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/9/head' }),
    ).rejects.toThrow();
  });

  // F2: three review lenses provision the same PR concurrently; the fetch must be shared,
  // not run once per child.
  it('coalesces concurrent provisions of the same PR into one fetch', async () => {
    const { clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const fetches: string[][] = [];
    const spied = m as unknown as { runGitFetch: (cwd: string, args: string[]) => Promise<void> };
    const original = spied.runGitFetch.bind(m);
    spied.runGitFetch = async (cwd, args) => { fetches.push(args); return original(cwd, args); };

    await Promise.all([
      m.provision('lens-a', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' }),
      m.provision('lens-b', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' }),
      m.provision('lens-c', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' }),
    ]);
    expect(fetches.filter((a) => a.some((x) => x.includes('refs/pull/7/head')))).toHaveLength(1);
  });
});

describe('WorktreeManager — refs/outpost/pr-* lifetime', () => {
  it('deletes the local PR ref when the readonly worktree is torn down', async () => {
    const { clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await m.provision('step-pr', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(outpostRefs(clone)).toEqual(['refs/outpost/pr-7']);

    await m.remove('step-pr');
    expect(outpostRefs(clone)).toEqual([]);
  });

  it('archive() drops the PR ref too', async () => {
    const { clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await m.provision('step-pr', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    await m.archive('step-pr');
    expect(outpostRefs(clone)).toEqual([]);
  });

  it('sweeps PR refs no live record still points at', async () => {
    const { clone } = makePrFixture();
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await m.provision('step-pr', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    // A ref an earlier daemon left behind — no record references it.
    execFileSync('git', ['-C', clone, 'update-ref', 'refs/outpost/pr-99', 'HEAD']);
    expect(outpostRefs(clone).sort()).toEqual(['refs/outpost/pr-7', 'refs/outpost/pr-99']);

    // Same runtime root: a fresh daemon reading the same index.json.
    const restarted = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await restarted.sweepStalePrRefs();
    expect(outpostRefs(clone)).toEqual(['refs/outpost/pr-7']);
  });
});

// F7: the planner picks repoCwd; nothing today proves it is the PR's repo. `expectRepo`
// is the receiving half of that check — see the engine wiring proposed in the report.
describe('WorktreeManager — repo identity', () => {
  it('parses owner/repo out of every remote-url spelling git uses', () => {
    expect(repoFromRemoteUrl('https://github.com/acme/example.git')).toBe('acme/example');
    expect(repoFromRemoteUrl('https://github.com/acme/example')).toBe('acme/example');
    expect(repoFromRemoteUrl('git@github.com:acme/example.git')).toBe('acme/example');
    expect(repoFromRemoteUrl('ssh://git@github.com/acme/example.git')).toBe('acme/example');
    expect(repoFromRemoteUrl('https://github.com/acme/example/')).toBe('acme/example');
  });

  it('returns null for a remote that is not github', () => {
    expect(repoFromRemoteUrl('/tmp/some/local/origin')).toBeNull();
    expect(repoFromRemoteUrl('https://gitlab.com/acme/example.git')).toBeNull();
    expect(repoFromRemoteUrl('')).toBeNull();
  });

  it('refuses to provision when repoCwd points at a different GitHub repo', async () => {
    const { clone } = makePrFixture();
    execFileSync('git', ['-C', clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/other.git']);
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await expect(
      m.provision(
        'step-wrong-repo',
        { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' },
        { expectRepo: 'acme/example' },
      ),
    ).rejects.toThrow(/acme\/other/);
  });

  it('provisions when the origin does match', async () => {
    const { clone } = makePrFixture();
    const localOrigin = execFileSync('git', ['-C', clone, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/example.git']);
    // Keep fetches working against the on-disk bare repo while the recorded URL is the
    // GitHub one the check reads.
    execFileSync('git', ['-C', clone, 'config', 'url.' + localOrigin + '.insteadOf', 'https://github.com/acme/example.git']);
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision(
      'step-right-repo',
      { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' },
      { expectRepo: 'acme/example' },
    );
    expect(path).toBeTruthy();
  });

  it('does not block a clone whose origin is not a GitHub URL at all', async () => {
    const { clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision(
      'step-local-origin',
      { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' },
      { expectRepo: 'acme/example' },
    );
    expect(path).toBeTruthy();
  });
});
