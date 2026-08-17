import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, runGitDiff, diffBaseFor, baseLabelFor } from '../../src/git/worktree-manager.js';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'init']);
  return dir;
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wt-mgr-'));
}

function projectsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wt-projects-'));
}

describe('WorktreeManager — state + persistence', () => {
  it('starts with an empty index when no file exists', () => {
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    expect(m.get('sess-1')).toBeUndefined();
  });

  it('persists records across instances', () => {
    const root = newRoot();
    const m1 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m1._testSeedRecord({
      sessionId: 'sess-a',
      projectCwd: '/tmp/repoA',
      worktreePath: join(root, 'sess-a'),
      branch: 'outpost/sessa',
      baseBranch: 'main',
      createdAt: 1234567890,
    });
    const m2 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = m2.get('sess-a');
    expect(rec).toBeDefined();
    expect(rec!.projectCwd).toBe('/tmp/repoA');
    expect(rec!.branch).toBe('outpost/sessa');
  });

  it('persists tombstones (archived sessions) and reports them via get', () => {
    const root = newRoot();
    const m1 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m1._testSeedRecord({
      sessionId: 'sess-x',
      projectCwd: '/tmp/repoX',
      worktreePath: '',
      branch: '',
      baseBranch: 'main',
      createdAt: 100,
      archivedAt: 200,
    });
    const m2 = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = m2.get('sess-x');
    expect(rec).toBeDefined();
    expect(rec!.archivedAt).toBe(200);
  });

  it('index file uses 0o600 mode and 0o700 dir mode', () => {
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m._testSeedRecord({
      sessionId: 'sess-perm',
      projectCwd: '/tmp/repoP',
      worktreePath: join(root, 'sess-perm'),
      branch: 'outpost/sessperm',
      baseBranch: 'main',
      createdAt: 1,
    });
    const indexPath = join(root, 'index.json');
    expect(existsSync(indexPath)).toBe(true);
    expect(statSync(indexPath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('list returns all records (including archived tombstones)', () => {
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m._testSeedRecord({ sessionId: 'a', projectCwd: '/a', worktreePath: '/wt/a', branch: 'outpost/a', baseBranch: 'main', createdAt: 1 });
    m._testSeedRecord({ sessionId: 'b', projectCwd: '/b', worktreePath: '', branch: '', baseBranch: 'main', createdAt: 2, archivedAt: 3 });
    const all = m.list();
    expect(all.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
  });
});

describe('WorktreeManager — git operations', () => {
  it('create() invokes git worktree add and records the result', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-c1', projectCwd: repo, baseBranch: 'main' });
    expect(rec.worktreePath).toContain(root);
    expect(rec.branch).toMatch(/^outpost\//);
    expect(rec.baseBranch).toBe('main');
    expect(existsSync(rec.worktreePath)).toBe(true);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString();
    expect(branches).toContain(rec.branch);
  });

  it('create() throws when projectCwd is not a git repo', async () => {
    const root = newRoot();
    const notRepo = mkdtempSync(join(tmpdir(), 'wt-notrepo-'));
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(
      m.create({ sessionId: 'sess-bad', projectCwd: notRepo, baseBranch: 'main' }),
    ).rejects.toThrow();
  });

  it('remove() deletes the worktree, branch, and index entry', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-r1', projectCwd: repo, baseBranch: 'main' });
    expect(existsSync(rec.worktreePath)).toBe(true);
    await m.remove('sess-r1');
    expect(existsSync(rec.worktreePath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString();
    expect(branches).not.toContain(rec.branch);
    expect(m.get('sess-r1')).toBeUndefined();
  });

  it('archive() removes worktree+branch but keeps a tombstone in the index', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-arc', projectCwd: repo, baseBranch: 'main' });
    await m.archive('sess-arc');
    expect(existsSync(rec.worktreePath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString();
    expect(branches).not.toContain(rec.branch);
    const tombstone = m.get('sess-arc');
    expect(tombstone).toBeDefined();
    expect(tombstone!.archivedAt).toBeGreaterThan(0);
    // Tombstones retain their original worktreePath/branch as forensic labels — the dir
    // and branch on disk are gone, and the JSONL has been relocated under the parent
    // project (see the relocation test below), so these fields are no longer load-bearing.
    expect(tombstone!.worktreePath).toBe(rec.worktreePath);
    expect(tombstone!.branch).toBe(rec.branch);
  });

  it('archive() relocates the session JSONL + sidecars into the parent project dir', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const projects = projectsRoot();
    const m = new WorktreeManager({ root, projectsRoot: projects });
    const rec = await m.create({ sessionId: 'sess-relo', projectCwd: repo, baseBranch: 'main' });

    // Simulate claude having written a JSONL + title + subagents dir under the worktree's
    // sanitized project dir, the way `claude --session-id sess-relo` would once it ran.
    const fromDir = join(projects, rec.worktreePath.replace(/\//g, '-'));
    const toDir = join(projects, repo.replace(/\//g, '-'));
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    mkdirSync(join(fromDir, 'sess-relo'), { recursive: true });
    writeFileSync(join(fromDir, 'sess-relo.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(fromDir, 'sess-relo.title'), 'a title');
    writeFileSync(join(fromDir, 'sess-relo', 'marker'), 'subagent goes here');

    await m.archive('sess-relo');

    // All three artifacts landed in the parent project's sanitized dir.
    expect(existsSync(join(toDir, 'sess-relo.jsonl'))).toBe(true);
    expect(existsSync(join(toDir, 'sess-relo.title'))).toBe(true);
    expect(existsSync(join(toDir, 'sess-relo', 'marker'))).toBe(true);
    // …and the now-empty source dir got cleaned up.
    expect(existsSync(fromDir)).toBe(false);
  });

  it('softArchive() transfers the live record to the new id and tombstones the old, keeping the worktree on disk', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-old', projectCwd: repo, baseBranch: 'main' });

    m.softArchive('sess-old', 'sess-new');

    // Worktree dir + branch survive — /clear should not destroy in-flight work.
    expect(existsSync(rec.worktreePath)).toBe(true);
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', rec.branch]).toString()).toContain(rec.branch);

    // Live ownership moved to the new id with the same path/branch.
    const live = m.get('sess-new');
    expect(live).toBeDefined();
    expect(live!.archivedAt).toBeUndefined();
    expect(live!.worktreePath).toBe(rec.worktreePath);
    expect(live!.branch).toBe(rec.branch);

    // Old id becomes a path-less tombstone so listProjects flags its JSONL as archived
    // but the worktreeByCwd lookup uses the live (new-id) record.
    const tomb = m.get('sess-old');
    expect(tomb).toBeDefined();
    expect(tomb!.archivedAt).toBeGreaterThan(0);
    expect(tomb!.worktreePath).toBe('');
    expect(tomb!.branch).toBe('');
  });

  it('softArchive() on a non-worktree session creates an old-id tombstone only', () => {
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m.softArchive('sess-plain-old', 'sess-plain-new', '/tmp/repoP');
    expect(m.get('sess-plain-new')).toBeUndefined();
    const tomb = m.get('sess-plain-old');
    expect(tomb).toBeDefined();
    expect(tomb!.archivedAt).toBeGreaterThan(0);
    expect(tomb!.projectCwd).toBe('/tmp/repoP');
  });

  it('remove()/archive() are idempotent', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await m.create({ sessionId: 'sessid', projectCwd: repo, baseBranch: 'main' });
    await m.remove('sessid');
    await m.remove('sessid'); // no throw
    expect(m.get('sessid')).toBeUndefined();
  });

  it('create() copies allowlisted gitignored files (CLAUDE.md, .claude/, docs/, .env*)', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Pin a gitignore so the repo's ignore rules are deterministic across machines.
    writeFileSync(join(repo, '.gitignore'), [
      'CLAUDE.md',
      'CLAUDE.local.md',
      '.claude/',
      'docs/private/',
      '.env',
      '.env.local',
      'node_modules/',
      'secret.txt',
    ].join('\n') + '\n');
    execFileSync('git', ['-C', repo, 'add', '.gitignore']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'gitignore']);

    // Allowlisted ignored content.
    writeFileSync(join(repo, 'CLAUDE.md'), '# local claude\n');
    writeFileSync(join(repo, 'CLAUDE.local.md'), '# local local\n');
    mkdirSync(join(repo, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'commands', 'foo.md'), 'foo\n');
    mkdirSync(join(repo, 'docs', 'private'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'private', 'notes.md'), 'notes\n');
    writeFileSync(join(repo, '.env'), 'SECRET=x\n');
    writeFileSync(join(repo, '.env.local'), 'SECRET=y\n');

    // NOT allowlisted — should be skipped.
    mkdirSync(join(repo, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'foo', 'index.js'), '// skip me\n');
    writeFileSync(join(repo, 'secret.txt'), 'do not copy\n');

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-copy', projectCwd: repo, baseBranch: 'main' });

    expect(readFileSync(join(rec.worktreePath, 'CLAUDE.md'), 'utf8')).toBe('# local claude\n');
    expect(readFileSync(join(rec.worktreePath, 'CLAUDE.local.md'), 'utf8')).toBe('# local local\n');
    expect(readFileSync(join(rec.worktreePath, '.claude', 'commands', 'foo.md'), 'utf8')).toBe('foo\n');
    expect(readFileSync(join(rec.worktreePath, 'docs', 'private', 'notes.md'), 'utf8')).toBe('notes\n');
    expect(readFileSync(join(rec.worktreePath, '.env'), 'utf8')).toBe('SECRET=x\n');
    expect(readFileSync(join(rec.worktreePath, '.env.local'), 'utf8')).toBe('SECRET=y\n');

    expect(existsSync(join(rec.worktreePath, 'node_modules'))).toBe(false);
    expect(existsSync(join(rec.worktreePath, 'secret.txt'))).toBe(false);
  });

  it('create() checks out an existing local branch instead of failing with -b', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Pre-create the branch off main so `-b` would collide.
    execFileSync('git', ['-C', repo, 'branch', 'feature/preexisting']);
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({
      sessionId: 'sess-existing-branch',
      projectCwd: repo,
      baseBranch: 'main',
      branch: 'feature/preexisting',
    });
    expect(rec.branch).toBe('feature/preexisting');
    expect(existsSync(rec.worktreePath)).toBe(true);
    // No dupe of the branch; just the one we asked for.
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'feature/preexisting']).toString();
    expect(branches).toContain('feature/preexisting');
  });

  it('create() adopts a secondary worktree under outpost root by moving it to the sessionId slot', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Prior outpost session's worktree that was orphaned (state loss / retry) — lives under our root.
    const priorWtPath = join(root, 'prior-session');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'feature/adopted', priorWtPath, 'main']);
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({
      sessionId: 'sess-adopt',
      projectCwd: repo,
      baseBranch: 'main',
      branch: 'feature/adopted',
    });
    // Adopted + moved to our sessionId slot; the prior path no longer exists.
    expect(realpathSync(rec.worktreePath)).toBe(realpathSync(join(root, 'sess-adopt')));
    expect(rec.branch).toBe('feature/adopted');
    expect(existsSync(priorWtPath)).toBe(false);
  });

  it('create() parks a clean primary on baseBranch and adopts the branch into a fresh worktree', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Branch checked out at the primary itself — clean tree, no pending edits.
    execFileSync('git', ['-C', repo, 'checkout', '-b', 'feature/on-primary']);
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({
      sessionId: 'sess-primary-clean',
      projectCwd: repo,
      baseBranch: 'main',
      branch: 'feature/on-primary',
    });
    // Outpost worktree now owns the branch at its sessionId slot.
    expect(realpathSync(rec.worktreePath)).toBe(realpathSync(join(root, 'sess-primary-clean')));
    expect(rec.branch).toBe('feature/on-primary');
    // Primary was parked on baseBranch so nothing else claims the target branch.
    const primaryHead = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
    expect(primaryHead).toBe('main');
  });

  it('create() refuses to adopt a dirty primary working tree', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    execFileSync('git', ['-C', repo, 'checkout', '-b', 'feature/on-primary-dirty']);
    // Uncommitted change on the primary — parking would silently strand it.
    writeFileSync(join(repo, 'dirty.txt'), 'wip\n');
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(m.create({
      sessionId: 'sess-primary-dirty',
      projectCwd: repo,
      baseBranch: 'main',
      branch: 'feature/on-primary-dirty',
    })).rejects.toThrow(/uncommitted changes/);
    // Primary is untouched.
    const primaryHead = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
    expect(primaryHead).toBe('feature/on-primary-dirty');
  });

  it('create() refuses to adopt a secondary outside outpost root', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Secondary lives under a user directory, not our root — could be the user's own worktree.
    const foreignWtPath = join(newRoot(), 'user-managed');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'feature/foreign', foreignWtPath, 'main']);
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(m.create({
      sessionId: 'sess-foreign',
      projectCwd: repo,
      baseBranch: 'main',
      branch: 'feature/foreign',
    })).rejects.toThrow(/outside the outpost worktree root/);
  });

  it('remove() on an adopted worktree cleans up the moved checkout normally', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const priorWtPath = join(root, 'prior-cleanup');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'feature/adopted-cleanup', priorWtPath, 'main']);
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({
      sessionId: 'sess-adopt-cleanup',
      projectCwd: repo,
      baseBranch: 'main',
      branch: 'feature/adopted-cleanup',
    });
    await m.remove('sess-adopt-cleanup');
    expect(existsSync(rec.worktreePath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'feature/adopted-cleanup']).toString();
    expect(branches).not.toContain('feature/adopted-cleanup');
  });

  it('create() rejects malformed sessionId (path traversal / argv injection)', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(
      m.create({ sessionId: '../escape', projectCwd: repo, baseBranch: 'main' }),
    ).rejects.toThrow(/invalid sessionId/);
    await expect(
      m.create({ sessionId: '-flag-shaped', projectCwd: repo, baseBranch: 'main' }),
    ).rejects.toThrow(/invalid sessionId/);
  });

  it('create() rejects malformed baseBranch (argv injection)', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    await expect(
      m.create({ sessionId: 'okid', projectCwd: repo, baseBranch: '-flag-shape' }),
    ).rejects.toThrow(/invalid baseBranch/);
    await expect(
      m.create({ sessionId: 'okid2', projectCwd: repo, baseBranch: 'has spaces' }),
    ).rejects.toThrow(/invalid baseBranch/);
  });
});

describe('runGitDiff', () => {
  it('branch mode returns committed branch-vs-base changes', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    // Seed a tracked file on main so the worktree branch can modify it.
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    execFileSync('git', ['-C', repo, 'add', 'a.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);

    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-diff-b', projectCwd: repo, baseBranch: 'main' });
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'one\nTWO\nthree\n');
    execFileSync('git', ['-C', rec.worktreePath, 'add', 'a.txt']);
    execFileSync('git', ['-C', rec.worktreePath, 'commit', '-q', '-m', 'change']);

    const out = runGitDiff(rec, 'branch');
    expect(out).toContain('diff --git a/a.txt b/a.txt');
    expect(out).toContain('-two');
    expect(out).toContain('+TWO');
  });

  it('worktree mode returns uncommitted changes only', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    execFileSync('git', ['-C', repo, 'add', 'a.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);

    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-diff-w', projectCwd: repo, baseBranch: 'main' });
    // Uncommitted edit in the worktree.
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'one\nTWO\n');

    const out = runGitDiff(rec, 'worktree');
    expect(out).toContain('-two');
    expect(out).toContain('+TWO');
  });

  it('falls back to "main" when baseBranch is empty', async () => {
    const root = newRoot();
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', 'a.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);

    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-diff-f', projectCwd: repo, baseBranch: 'main' });
    writeFileSync(join(rec.worktreePath, 'a.txt'), 'y\n');
    execFileSync('git', ['-C', rec.worktreePath, 'add', 'a.txt']);
    execFileSync('git', ['-C', rec.worktreePath, 'commit', '-q', '-m', 'change']);

    // baseBranch deliberately blanked — runGitDiff should still find `main` and diff.
    const out = runGitDiff({ ...rec, baseBranch: '' }, 'branch');
    expect(out).toContain('-x');
    expect(out).toContain('+y');
  });

  it('rejects a tombstoned record (no worktreePath)', () => {
    expect(() => runGitDiff({
      sessionId: 's', projectCwd: '/repo', worktreePath: '', branch: 'outpost/s',
      baseBranch: 'main', createdAt: 0,
    }, 'worktree')).toThrow(/tombstoned/);
  });

  it('rejects an invalid branch shape (defense in depth)', () => {
    expect(() => runGitDiff({
      sessionId: 's', projectCwd: '/repo', worktreePath: '/wt', branch: '-flag',
      baseBranch: 'main', createdAt: 0,
    }, 'branch')).toThrow(/invalid branch/);
  });
});

// origin-backed fixture: `local` is a clone whose main is behind origin by one commit, with a
// stale remote-tracking ref (never fetched since origin moved) — the shape that had steps
// branching 62 commits behind main.
function makeClonePair(): { local: string; originTip: string; localTip: string } {
  const bare = mkdtempSync(join(tmpdir(), 'wt-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = makeGitRepo();
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main']);

  const local = mkdtempSync(join(tmpdir(), 'wt-clone-'));
  execFileSync('git', ['clone', '-q', bare, local]);
  execFileSync('git', ['-C', local, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', local, 'config', 'user.name', 'Test']);
  const localTip = execFileSync('git', ['-C', local, 'rev-parse', 'main']).toString().trim();

  // Advance origin from a different clone; `local` learns nothing until something fetches.
  execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-q', '-m', 'upstream work']);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
  const originTip = execFileSync('git', ['-C', seed, 'rev-parse', 'main']).toString().trim();

  return { local, originTip, localTip };
}

function headOf(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD']).toString().trim();
}

describe('WorktreeManager — base ref freshness', () => {
  it('fast-forwards a stale local base and branches from it when the base is not checked out', async () => {
    const { local, originTip, localTip } = makeClonePair();
    execFileSync('git', ['-C', local, 'checkout', '-q', '-b', 'some-feature']);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-ff', projectCwd: local, baseBranch: 'main' });

    expect(headOf(rec.worktreePath)).toBe(originTip);
    expect(headOf(rec.worktreePath)).not.toBe(localTip);
    // Local main caught up, so it stays an honest diff/PR base.
    expect(execFileSync('git', ['-C', local, 'rev-parse', 'main']).toString().trim()).toBe(originTip);
    expect(rec.baseRef).toBe('main');
  });

  it('branches from origin/<base> when the stale base is checked out and cannot be moved', async () => {
    const { local, originTip, localTip } = makeClonePair(); // clone leaves main checked out

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-remote-base', projectCwd: local, baseBranch: 'main' });

    expect(headOf(rec.worktreePath)).toBe(originTip);
    // git refuses to move a checked-out ref, so the user's tree is untouched...
    expect(execFileSync('git', ['-C', local, 'rev-parse', 'main']).toString().trim()).toBe(localTip);
    // ...and the diff/squash base must follow what we actually branched from, not stale main.
    expect(rec.baseRef).toBe('origin/main');
    expect(runGitDiff(rec, 'branch')).toBe('');
  });

  it('keeps the local base when it is strictly ahead of origin (unpushed work to build on)', async () => {
    const { local } = makeClonePair();
    execFileSync('git', ['-C', local, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', local, 'merge', '-q', '--ff-only', 'origin/main']);
    execFileSync('git', ['-C', local, 'commit', '--allow-empty', '-q', '-m', 'unpushed local work']);
    const ahead = execFileSync('git', ['-C', local, 'rev-parse', 'main']).toString().trim();

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-ahead', projectCwd: local, baseBranch: 'main' });

    expect(headOf(rec.worktreePath)).toBe(ahead);
    expect(rec.baseRef).toBe('main');
  });

  it('prefers origin when the local base has diverged (unpushed commits but also behind)', async () => {
    const { local, originTip } = makeClonePair();
    execFileSync('git', ['-C', local, 'commit', '--allow-empty', '-q', '-m', 'local commit on a stale base']);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-diverged', projectCwd: local, baseBranch: 'main' });

    expect(headOf(rec.worktreePath)).toBe(originTip);
    expect(rec.baseRef).toBe('origin/main');
  });

  it('falls back to the local base in a repo with no origin', async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-no-origin', projectCwd: repo, baseBranch: 'main' });

    expect(rec.baseRef).toBe('main');
    expect(headOf(rec.worktreePath)).toBe(execFileSync('git', ['-C', repo, 'rev-parse', 'main']).toString().trim());
  });

  it('provisions a readonly workspace at the fresh base, not the primary checkout HEAD', async () => {
    const { local, originTip } = makeClonePair();
    // Primary parked on an unrelated feature branch — what investigations used to read.
    execFileSync('git', ['-C', local, 'checkout', '-q', '-b', 'unrelated']);
    execFileSync('git', ['-C', local, 'commit', '--allow-empty', '-q', '-m', 'unrelated work']);
    const primaryHead = headOf(local);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-ro', { kind: 'readonly', repoCwd: local });

    expect(path).toBeTruthy();
    expect(headOf(path!)).toBe(originTip);
    expect(headOf(path!)).not.toBe(primaryHead);
  });

  it('honors an explicit readonly ref instead of resolving the base', async () => {
    const { local, localTip } = makeClonePair();
    execFileSync('git', ['-C', local, 'branch', 'pinned', localTip]);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-pinned', { kind: 'readonly', repoCwd: local, ref: 'pinned' });

    expect(headOf(path!)).toBe(localTip);
  });
});

// cloud-config#16434: the branch was cut from origin/main, the step committed 29 minutes later,
// and the squash rewound to `origin/main` — which had moved. The re-parented commit kept the old
// tree, so the PR diff reverted the two upstream PRs that had landed in the gap.
describe('WorktreeManager — base is pinned to a commit, not a moving ref', () => {
  it('keeps the squash base on the cut commit after origin/main moves', async () => {
    const { local, originTip } = makeClonePair(); // clone leaves main checked out -> baseRef is origin/main
    const bare = originOf(local);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-pin', projectCwd: local, baseBranch: 'main' });
    expect(rec.baseRef).toBe('origin/main');
    expect(headOf(rec.worktreePath)).toBe(originTip);

    // Upstream lands two PRs while the step is still working.
    const moved = advanceOrigin(bare, 2);
    execFileSync('git', ['-C', local, 'fetch', '-q', 'origin']);
    expect(execFileSync('git', ['-C', local, 'rev-parse', 'origin/main']).toString().trim()).toBe(moved);

    // What gitFinalizeSquashToBranch rewinds to must still be the commit we branched from.
    expect(diffBaseFor(rec)).toBe(originTip);
    expect(diffBaseFor(rec)).not.toBe(moved);
    // ...while the reader still sees a branch name, not a sha.
    expect(baseLabelFor(rec)).toBe('origin/main');
  });

  it('pins the base even when the local base ref is what got fast-forwarded', async () => {
    const { local, originTip } = makeClonePair();
    execFileSync('git', ['-C', local, 'checkout', '-q', '-b', 'parked']); // frees main to be moved
    const bare = originOf(local);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-pin-local', projectCwd: local, baseBranch: 'main' });
    expect(rec.baseRef).toBe('main');

    advanceOrigin(bare, 3);
    execFileSync('git', ['-C', local, 'fetch', '-q', 'origin', 'main:main']);

    expect(diffBaseFor(rec)).toBe(originTip);
    expect(baseLabelFor(rec)).toBe('main');
  });

  it('falls back to the spelling for records written before baseSha existed', () => {
    expect(diffBaseFor({ baseRef: 'origin/main', baseBranch: 'main' })).toBe('origin/main');
    expect(diffBaseFor({ baseBranch: 'master' })).toBe('master');
    expect(diffBaseFor({ baseBranch: '' })).toBe('main');
  });
});

// Advance origin's main by `n` commits from the seed clone, so `local` is behind until it fetches.
function advanceOrigin(bare: string, n: number): string {
  const seed = mkdtempSync(join(tmpdir(), 'wt-seed-'));
  execFileSync('git', ['clone', '-q', bare, seed]);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'Test']);
  for (let i = 0; i < n; i++) {
    execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-q', '-m', `upstream ${i}`]);
  }
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
  return execFileSync('git', ['-C', seed, 'rev-parse', 'main']).toString().trim();
}

function originOf(local: string): string {
  return execFileSync('git', ['-C', local, 'remote', 'get-url', 'origin']).toString().trim();
}

// The REL-17 shape: a step branches correctly from a fresh origin/main, then sits for days while
// the controller re-spawns it once per round. provision() used to hand the day-one tree straight
// back, so the work landed on a base that was hundreds of commits stale.
describe('WorktreeManager — base freshness on re-provision', () => {
  it('fast-forwards an untouched branch to the fresh base on the next dispatch', async () => {
    const { local } = makeClonePair();
    const bare = originOf(local);
    const ws = { kind: 'writable' as const, repoCwd: local, branch: 'feat/idle' };

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-idle', ws);
    const dayOne = headOf(path!);

    const moved = advanceOrigin(bare, 3);
    expect(moved).not.toBe(dayOne);

    // Round two: same stepId, same live record — the path that used to short-circuit.
    const again = await m.provision('step-idle', ws);
    expect(again.path).toBe(path);
    expect(headOf(path!)).toBe(moved);
    expect(m.get('step-idle')!.baseDrift).toBe(0);
  });

  it('never moves a branch that has commits of its own, and records the drift instead', async () => {
    const { local } = makeClonePair();
    const bare = originOf(local);
    const ws = { kind: 'writable' as const, repoCwd: local, branch: 'feat/committed' };

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-committed', ws);
    execFileSync('git', ['-C', path!, 'commit', '--allow-empty', '-q', '-m', 'step work']);
    const ownWork = headOf(path!);

    advanceOrigin(bare, 4);
    await m.provision('step-committed', ws);

    // A pushed branch under an open PR: moving it would be a force-push.
    expect(headOf(path!)).toBe(ownWork);
    const rec = m.get('step-committed')!;
    expect(rec.baseDrift).toBe(4);
    // baseRef must name the real branch point, not the ref that has since moved past it —
    // gitFinalizeSquashToBranch does `reset --soft` onto it.
    expect(rec.baseRef).toMatch(/^[0-9a-f]{7,40}$/);
    const branchPoint = execFileSync('git', ['-C', local, 'merge-base', 'origin/main', 'feat/committed']).toString().trim();
    expect(rec.baseRef).toBe(branchPoint);
    // The step's own commit is the whole diff — no upstream commits folded in.
    expect(execFileSync('git', ['-C', local, 'rev-list', '--count', `${rec.baseRef}..feat/committed`]).toString().trim()).toBe('1');
  });

  it('leaves a dirty worktree alone even when the branch has no commits', async () => {
    const { local } = makeClonePair();
    const bare = originOf(local);
    const ws = { kind: 'writable' as const, repoCwd: local, branch: 'feat/dirty' };

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-dirty', ws);
    const dayOne = headOf(path!);
    writeFileSync(join(path!, 'wip.txt'), 'uncommitted work\n');

    advanceOrigin(bare, 2);
    await m.provision('step-dirty', ws);

    expect(headOf(path!)).toBe(dayOne);
    expect(m.get('step-dirty')!.baseDrift).toBe(2);
    expect(existsSync(join(path!, 'wip.txt'))).toBe(true);
  });

  it('keeps a readonly worktree pinned across re-provision', async () => {
    const { local } = makeClonePair();
    const bare = originOf(local);
    const ws = { kind: 'readonly' as const, repoCwd: local };

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const { path } = await m.provision('step-ro-pin', ws);
    const at = headOf(path!);

    advanceOrigin(bare, 2);
    await m.provision('step-ro-pin', ws);

    expect(headOf(path!)).toBe(at);
  });

  it('aligns an adopted branch instead of claiming a base it was never cut from', async () => {
    const { local } = makeClonePair();
    const bare = originOf(local);
    execFileSync('git', ['-C', local, 'fetch', '-q', 'origin']);
    // A stale local branch left over from an earlier run, cut from the base as it was then.
    execFileSync('git', ['-C', local, 'branch', 'feat/adopted', 'origin/main']);
    const staleTip = execFileSync('git', ['-C', local, 'rev-parse', 'feat/adopted']).toString().trim();
    const moved = advanceOrigin(bare, 5);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-adopt', projectCwd: local, baseBranch: 'main', branch: 'feat/adopted' });

    // Adopted with nothing on it, so it fast-forwards rather than starting 5 commits behind.
    expect(staleTip).not.toBe(moved);
    expect(headOf(rec.worktreePath)).toBe(moved);
    expect(rec.baseDrift).toBe(0);
  });

  it('records the real branch point when an adopted branch already carries commits', async () => {
    const { local } = makeClonePair();
    const bare = originOf(local);
    execFileSync('git', ['-C', local, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', local, 'branch', 'feat/adopted-work', 'origin/main']);
    const branchPoint = execFileSync('git', ['-C', local, 'rev-parse', 'feat/adopted-work']).toString().trim();
    // Commit onto the stale branch without checking it out anywhere.
    const tree = execFileSync('git', ['-C', local, 'rev-parse', 'feat/adopted-work^{tree}']).toString().trim();
    const commit = execFileSync(
      'git',
      ['-C', local, 'commit-tree', tree, '-p', branchPoint, '-m', 'earlier round'],
      { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' } },
    ).toString().trim();
    execFileSync('git', ['-C', local, 'update-ref', 'refs/heads/feat/adopted-work', commit]);
    advanceOrigin(bare, 6);

    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-adopt-work', projectCwd: local, baseBranch: 'main', branch: 'feat/adopted-work' });

    expect(headOf(rec.worktreePath)).toBe(commit);
    expect(rec.baseRef).toBe(branchPoint);
    expect(rec.baseDrift).toBe(6);
    // The pre-existing commit is the entire diff; without the fix baseRef named the moved
    // origin/main, so a squash would have rewound past 6 upstream commits and swallowed them.
    expect(runGitDiff(rec, 'branch')).toBe('');
  });
});

describe('WorktreeManager — sweepOrphaned', () => {
  it('archives a record no owner claims', async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-orphan', projectCwd: repo, baseBranch: 'main' });

    const reaped = await m.sweepOrphaned(() => false, 0);

    expect(reaped).toEqual(['sess-orphan']);
    expect(existsSync(rec.worktreePath)).toBe(false);
    expect(m.get('sess-orphan')!.archivedAt).toBeDefined();
  });

  it('leaves a record its owner still claims', async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-owned', projectCwd: repo, baseBranch: 'main' });

    const reaped = await m.sweepOrphaned((key) => key === 'sess-owned', 0);

    expect(reaped).toEqual([]);
    expect(existsSync(rec.worktreePath)).toBe(true);
    expect(m.get('sess-owned')!.archivedAt).toBeUndefined();
  });

  // A worktree provisioned moments ago may not have bound to its step or session yet, so
  // an ownerless verdict on a fresh record is meaningless — a real orphan is days old.
  it('leaves an ownerless record younger than minAge', async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    const rec = await m.create({ sessionId: 'sess-fresh', projectCwd: repo, baseBranch: 'main' });

    const reaped = await m.sweepOrphaned(() => false, 60_000);

    expect(reaped).toEqual([]);
    expect(existsSync(rec.worktreePath)).toBe(true);
  });

  it('skips tombstones so an already-archived record is never swept twice', async () => {
    const root = newRoot();
    const m = new WorktreeManager({ root, projectsRoot: projectsRoot() });
    m._testSeedRecord({
      sessionId: 'sess-tomb',
      projectCwd: '/tmp/repoT',
      worktreePath: '',
      branch: '',
      baseBranch: 'main',
      createdAt: 100,
      archivedAt: 200,
    });

    expect(await m.sweepOrphaned(() => false, 0)).toEqual([]);
  });
});

describe('WorktreeManager — sweepOrphaned refuses malformed records', () => {
  // A record naming the project checkout itself (worktreePath === projectCwd) has existed in
  // the wild. tearDown's `worktree remove` fails harmlessly there, but the `branch -D` that
  // follows lands on the user's real repo — so the automatic sweep must never touch one.
  it('skips a record whose worktreePath is outside the manager root', async () => {
    const repo = makeGitRepo();
    execFileSync('git', ['-C', repo, 'branch', 'keep-me']);
    const m = new WorktreeManager({ root: newRoot(), projectsRoot: projectsRoot() });
    m._testSeedRecord({
      sessionId: 'sess-selfpath',
      projectCwd: repo,
      worktreePath: repo,
      branch: 'keep-me',
      baseBranch: 'main',
      createdAt: 100,
    });

    expect(await m.sweepOrphaned(() => false, 0)).toEqual([]);
    expect(m.get('sess-selfpath')!.archivedAt).toBeUndefined();
    expect(
      execFileSync('git', ['-C', repo, 'branch', '--list', 'keep-me']).toString().trim(),
    ).toContain('keep-me');
  });
});
