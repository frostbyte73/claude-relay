import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../../src/git/worktree-manager.js';
import { handleDiffRoute, type SessionLookup, type StepWorktreeLookup } from '../../src/git/diff-endpoint.js';

const NO_SESSIONS: SessionLookup = { findSession: () => null };

function stubLookup(byId: Record<string, string>): SessionLookup {
  return { findSession: (id) => (byId[id] ? { cwd: byId[id]! } : null) };
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-ep-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
  return dir;
}

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'diff-ep-root-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'diff-ep-projects-'));
  const repo = makeGitRepo();
  const wm = new WorktreeManager({ root, projectsRoot });
  return { root, projectsRoot, repo, wm };
}

describe('handleDiffRoute (worktree-backed sessions)', () => {
  it('branch mode returns the branch-vs-base diff', async () => {
    const ctx = fresh();
    const rec = await ctx.wm.create({ sessionId: 'aaaa1111', projectCwd: ctx.repo, baseBranch: 'main' });
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'one\nTWO\nthree\n');
    execFileSync('git', ['-C', rec.worktreePath, 'add', 'a.txt']);
    execFileSync('git', ['-C', rec.worktreePath, 'commit', '-q', '-m', 'change']);

    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'aaaa1111', 'branch');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.mode).toBe('branch');
    expect(result.body.baseRef).toBe('main');
    expect(result.body.headRef).toBe(rec.branch);
    expect(result.body.files).toHaveLength(1);
    expect(result.body.files[0]!.path).toBe('a.txt');
    expect(result.body.files[0]!.hunks[0]!.rows.some((r) => r.op === '+' && r.content === 'TWO')).toBe(true);
  });

  it('worktree mode returns uncommitted changes', async () => {
    const ctx = fresh();
    const rec = await ctx.wm.create({ sessionId: 'bbbb2222', projectCwd: ctx.repo, baseBranch: 'main' });
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'one\ntwo\nTHREE\n');

    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'bbbb2222', 'worktree');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.mode).toBe('worktree');
    expect(result.body.headRef).toBe('WORKTREE');
    expect(result.body.files[0]!.hunks[0]!.rows.some((r) => r.op === '+' && r.content === 'THREE')).toBe(true);
  });

  it('worktree mode returns untracked new files with readable content', async () => {
    const ctx = fresh();
    const rec = await ctx.wm.create({ sessionId: 'eeee5555', projectCwd: ctx.repo, baseBranch: 'main' });
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'one\ntwo\nCHANGED\n');
    writeFileSync(join(rec.worktreePath, 'newfile.go'), 'package x\n\nfunc egress() {}\n');

    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'eeee5555', 'worktree');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const newFile = result.body.files.find((f) => f.path === 'newfile.go');
    expect(newFile).toBeDefined();
    expect(newFile!.untracked).toBe(true);
    expect(newFile!.status).toBe('added');
    // The whole point of the fix: the file's contents are viewable, not an empty placeholder.
    expect(newFile!.hunks.length).toBeGreaterThan(0);
    expect(newFile!.hunks[0]!.rows.some((r) => r.op === '+' && r.content === 'func egress() {}')).toBe(true);
  });

  it('returns 404 for an archived (tombstoned) session', async () => {
    const ctx = fresh();
    await ctx.wm.create({ sessionId: 'cccc3333', projectCwd: ctx.repo, baseBranch: 'main' });
    await ctx.wm.archive('cccc3333');
    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'cccc3333', 'branch');
    expect(result.status).toBe(404);
  });

  it('returns 400 for an invalid mode', async () => {
    const ctx = fresh();
    await ctx.wm.create({ sessionId: 'dddd4444', projectCwd: ctx.repo, baseBranch: 'main' });
    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'dddd4444', 'bogus');
    expect(result.status).toBe(400);
  });

  // Regression: open-pr steps key their worktree by stepId, and DELETE /api/sessions
  // on the step's reused session leaves a session-keyed archived tombstone. A direct
  // wm.get(sessionId) hits that tombstone and 404s ("session is archived") even though
  // the step worktree is still live — so the diff for reply_pending_review /
  // comment_pending_response steps was unreachable. The engine's session→stepId→record
  // lookup is authoritative and must win over the shadowing tombstone.
  it('resolves a step session to its live stepId-keyed worktree, ignoring a session tombstone', async () => {
    const ctx = fresh();
    const rec = await ctx.wm.create({ sessionId: 'step-9a53', projectCwd: ctx.repo, baseBranch: 'main' });
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'one\ntwo\nSTEP\n');
    // Shadowing session-keyed tombstone (no on-disk worktree of its own).
    await ctx.wm.archive('sess-41c7');
    const stepLookup: StepWorktreeLookup = {
      worktreeRecordForSession: (id) => (id === 'sess-41c7' ? ctx.wm.get('step-9a53') : undefined),
    };

    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'sess-41c7', 'worktree', stepLookup);
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.headRef).toBe('WORKTREE');
    expect(result.body.files[0]!.hunks[0]!.rows.some((r) => r.op === '+' && r.content === 'STEP')).toBe(true);
  });

  it('still 404s a step session whose own stepId-keyed worktree is archived (merged)', async () => {
    const ctx = fresh();
    await ctx.wm.create({ sessionId: 'step-1177', projectCwd: ctx.repo, baseBranch: 'main' });
    await ctx.wm.archive('step-1177');
    const stepLookup: StepWorktreeLookup = {
      worktreeRecordForSession: (id) => (id === 'sess-a9d4' ? ctx.wm.get('step-1177') : undefined),
    };

    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'sess-a9d4', 'worktree', stepLookup);
    expect(result.status).toBe(404);
  });
});

describe('handleDiffRoute (non-worktree sessions)', () => {
  it('returns 404 when no worktree record and the session lookup misses', () => {
    const ctx = fresh();
    const result = handleDiffRoute(ctx.wm, NO_SESSIONS, 'no-such-session', 'branch');
    expect(result.status).toBe(404);
  });

  it('returns 404 when the session cwd is not a git repo', () => {
    const ctx = fresh();
    const nonRepo = mkdtempSync(join(tmpdir(), 'diff-ep-nonrepo-'));
    const result = handleDiffRoute(ctx.wm, stubLookup({ 'sess-x': nonRepo }), 'sess-x', 'worktree');
    expect(result.status).toBe(404);
  });

  it('worktree mode returns uncommitted changes against the session cwd', () => {
    const ctx = fresh();
    writeFileSync(join(ctx.repo, 'a.txt'), 'one\ntwo\nTHREE\n');
    const result = handleDiffRoute(ctx.wm, stubLookup({ 'sess-1': ctx.repo }), 'sess-1', 'worktree');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.mode).toBe('worktree');
    expect(result.body.headRef).toBe('WORKTREE');
    expect(result.body.files[0]!.hunks[0]!.rows.some((r) => r.op === '+' && r.content === 'THREE')).toBe(true);
  });

  it('branch mode reports onBaseBranch=true and no files when HEAD is on main', () => {
    const ctx = fresh();
    const result = handleDiffRoute(ctx.wm, stubLookup({ 'sess-main': ctx.repo }), 'sess-main', 'branch');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.onBaseBranch).toBe(true);
    expect(result.body.files).toHaveLength(0);
  });

  it('branch mode diffs feature branch against main when HEAD is on a feature branch', () => {
    const ctx = fresh();
    execFileSync('git', ['-C', ctx.repo, 'checkout', '-q', '-b', 'feat/x']);
    writeFileSync(join(ctx.repo, 'a.txt'), 'one\nTWO\nthree\n');
    execFileSync('git', ['-C', ctx.repo, 'add', 'a.txt']);
    execFileSync('git', ['-C', ctx.repo, 'commit', '-q', '-m', 'feat']);

    const result = handleDiffRoute(ctx.wm, stubLookup({ 'sess-feat': ctx.repo }), 'sess-feat', 'branch');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.onBaseBranch).toBeUndefined();
    expect(result.body.baseRef).toBe('main');
    expect(result.body.headRef).toBe('feat/x');
    expect(result.body.files[0]!.hunks[0]!.rows.some((r) => r.op === '+' && r.content === 'TWO')).toBe(true);
  });

  it('falls back to master when main does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-ep-master-'));
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'a.txt'), 'hi\n');
    execFileSync('git', ['-C', dir, 'add', 'a.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'feat/y']);
    writeFileSync(join(dir, 'a.txt'), 'HI\n');
    execFileSync('git', ['-C', dir, 'add', 'a.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'feat']);

    const ctx = fresh();
    const result = handleDiffRoute(ctx.wm, stubLookup({ 'sess-master': dir }), 'sess-master', 'branch');
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.baseRef).toBe('master');
    expect(result.body.headRef).toBe('feat/y');
  });
});
