import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFinalizeAppendToBranch, gitRemoteBranchExists } from '../../src/git/git-ops.js';

// A bare `origin` with branch `pr` already pushed (base + one commit), and a worktree
// clone sitting on that pushed head — the shape of a follow-up round on an open PR.
function makeOpenPrClone() {
  const root = mkdtempSync(join(tmpdir(), 'append-'));
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'pr', remote]);
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work]);
  const g = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 't@e'); g('config', 'user.name', 'T');
  writeFileSync(join(work, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-q', '-m', 'base');
  writeFileSync(join(work, 'f.txt'), 'pr head\n');
  g('add', '.'); g('commit', '-q', '-m', 'r1 feature');
  g('push', '-q', '-u', 'origin', 'pr');
  const remoteHead = () => g('ls-remote', 'origin', 'refs/heads/pr').split('\t')[0]!.trim();
  return { root, remote, work, g, remoteHead };
}

describe('gitRemoteBranchExists', () => {
  it('is true for a branch on origin and false otherwise', async () => {
    const { work } = makeOpenPrClone();
    expect(await gitRemoteBranchExists(work, 'pr')).toBe(true);
    expect(await gitRemoteBranchExists(work, 'nope')).toBe(false);
  });
});

describe('gitFinalizeAppendToBranch', () => {
  it('fast-forward pushes a commit stacked on the PR head', async () => {
    const { work, g, remoteHead } = makeOpenPrClone();
    // Round 2: a new commit on top of the pushed head (what the git view commits).
    writeFileSync(join(work, 'f.txt'), 'round two edit\n');
    g('add', '.'); g('commit', '-q', '-m', 'address comment');
    const head = g('rev-parse', 'HEAD').trim();
    const r = await gitFinalizeAppendToBranch({ worktreePath: work, branch: 'pr', baseBranch: 'pr' });
    expect(r.ok).toBe(true);
    expect(remoteHead()).toBe(head); // origin advanced to our commit — no rewrite
  });

  it('refuses (never forces) when the branch diverged from origin', async () => {
    const { work, g, remoteHead } = makeOpenPrClone();
    const pushed = remoteHead();
    // Re-squash to base: rewinds past the pushed head → not a fast-forward.
    g('reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(work, 'f.txt'), 'divergent\n');
    g('add', '.'); g('commit', '-q', '-m', 'resquash');
    const r = await gitFinalizeAppendToBranch({ worktreePath: work, branch: 'pr', baseBranch: 'pr' });
    expect(r.ok).toBe(false);
    expect(remoteHead()).toBe(pushed); // origin untouched — no force-push
  });

  it('refuses when the worktree has uncommitted changes', async () => {
    const { work } = makeOpenPrClone();
    writeFileSync(join(work, 'f.txt'), 'unstaged edit\n');
    const r = await gitFinalizeAppendToBranch({ worktreePath: work, branch: 'pr', baseBranch: 'pr' });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('uncommitted changes');
  });
});
