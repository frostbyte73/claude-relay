import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../../src/git/worktree-manager.js';

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

describe('WorktreeManager — readonly provision at a PR head', () => {
  it('provisions a readonly worktree at a PR head that was never fetched', async () => {
    const { clone, prHeadSha } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-pr', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(path).toBeTruthy();
    expect(headOf(path!)).toBe(prHeadSha);
  });

  it('re-provisioning picks up a new push to the same PR', async () => {
    const { origin, clone } = makePrFixture();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    await m.provision('step-pr-1', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });

    // The PR author pushes a new commit; simulate from a second clone of the same origin.
    const author = mkdtempSync(join(tmpdir(), 'wt-pr-author-'));
    execFileSync('git', ['clone', '-q', origin, author]);
    execFileSync('git', ['-C', author, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', author, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', author, 'fetch', '-q', 'origin', 'refs/pull/7/head:pr-7-local']);
    execFileSync('git', ['-C', author, 'checkout', '-q', 'pr-7-local']);
    execFileSync('git', ['-C', author, 'commit', '--allow-empty', '-q', '-m', 'new push']);
    const newPrHeadSha = headOf(author);
    execFileSync('git', ['-C', author, 'push', '-q', '-f', 'origin', 'pr-7-local:refs/pull/7/head']);

    const { path } = await m.provision('step-pr-2', { kind: 'readonly', repoCwd: clone, ref: 'refs/pull/7/head' });
    expect(headOf(path!)).toBe(newPrHeadSha);
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
});
