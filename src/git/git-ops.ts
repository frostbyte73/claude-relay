import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeManager } from './worktree-manager.js';

const execFileP = promisify(execFile);

export interface SessionLookup {
  findSession(id: string): { cwd: string } | null;
}

const MAX_BUFFER = 8 * 1024 * 1024;

// Defense-in-depth: mirrors BRANCH_NAME_RE in worktree-manager. No leading dash blocks
// argv-flag smuggling; length cap prevents unbounded refspecs.
const BRANCH_NAME_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./-]{0,128}$/;

// `index`/`worktree` are the two single-char status codes from `git status --porcelain`.
export interface GitStatusFile {
  index: string;
  worktree: string;
  path: string;
  oldPath?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitStatusFile[];
  clean: boolean;
  prUrl: string | null;
  // Resolves `refs/remotes/origin/HEAD`; falls back to main/master probe. null when neither found.
  defaultBranch: string | null;
  // `https://github.com/<owner>/<repo>` or null for non-GitHub remotes.
  commitUrlBase: string | null;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: number;
  subject: string;
}

export type GitResolution =
  | { kind: 'ok'; cwd: string }
  | { kind: 'error'; status: 400 | 404; message: string };

// Archived worktree sessions → 404 (dir + branch already torn down).
export function resolveSessionGitCwd(
  wm: WorktreeManager,
  sessionLookup: SessionLookup,
  sessionId: string,
): GitResolution {
  const rec = wm.get(sessionId);
  if (rec?.archivedAt) {
    return { kind: 'error', status: 404, message: 'session is archived' };
  }
  if (rec?.worktreePath) {
    return { kind: 'ok', cwd: rec.worktreePath };
  }
  const found = sessionLookup.findSession(sessionId);
  if (!found) return { kind: 'error', status: 404, message: 'no such session' };
  if (!isGitRepoSync(found.cwd)) {
    return { kind: 'error', status: 400, message: 'session cwd is not a git repo' };
  }
  return { kind: 'ok', cwd: found.cwd };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  // -z NUL terminators disambiguate rename target/source pairs with whitespace in paths.
  const { stdout } = await execFileP(
    'git',
    ['-C', cwd, 'status', '--porcelain=v2', '--branch', '-z'],
    { maxBuffer: MAX_BUFFER },
  );
  const parsed = parsePorcelainV2(stdout);
  const branch = parsed.branch;
  const [prUrl, defaultBranch, commitUrlBase] = await Promise.all([
    branch ? detectPrUrl(cwd, branch) : Promise.resolve(null),
    detectDefaultBranch(cwd),
    detectCommitUrlBase(cwd),
  ]);
  return { ...parsed, prUrl, defaultBranch, commitUrlBase };
}

export async function gitLog(cwd: string, limit: number): Promise<GitLogEntry[]> {
  const cappedLimit = Math.max(1, Math.min(200, limit));
  // %x1f unit / %x1e record separators survive subjects containing newlines or whitespace.
  const FMT = ['%H', '%h', '%an', '%ae', '%at', '%s'].join('%x1f');
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', cwd, 'log', `-n`, String(cappedLimit), `--pretty=format:${FMT}%x1e`],
      { maxBuffer: MAX_BUFFER },
    );
    return parseLogOutput(stdout);
  } catch (err) {
    const msg = (err as { stderr?: Buffer | string }).stderr?.toString() ?? '';
    // Fresh repo with no commits: `git log` exits non-zero — not actionable.
    if (/does not have any commits yet|bad default revision|unknown revision/i.test(msg)) {
      return [];
    }
    throw err;
  }
}

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Re-`git add` staged paths so the commit captures working-tree state at commit time —
// without this, edits made after staging are silently dropped (user sees latest diff,
// commits older index).
export async function gitCommit(cwd: string, message: string): Promise<GitCommandResult> {
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, stdout: '', stderr: 'commit message required', exitCode: 1 };
  }
  const stagedList = await runGit(cwd, ['diff', '--name-only', '--cached', '-z']);
  if (stagedList.ok && stagedList.stdout.length > 0) {
    const paths = stagedList.stdout.split('\0').filter((p) => p.length > 0);
    if (paths.length > 0) {
      const readd = await runGit(cwd, ['add', '--', ...paths]);
      if (!readd.ok) return readd;
    }
  }
  return runGit(cwd, ['commit', '-m', message]);
}

// Defense-in-depth: reject leading-dash paths (argv-flag smuggling) and absolutes;
// `--` separator is the second layer.
export async function gitStage(
  cwd: string,
  paths: string[],
  action: 'stage' | 'unstage',
): Promise<GitCommandResult> {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  }
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096) {
      return { ok: false, stdout: '', stderr: `invalid path: ${JSON.stringify(p)}`, exitCode: 1 };
    }
    if (p.startsWith('-') || p.startsWith('/') || p.includes('\0')) {
      return { ok: false, stdout: '', stderr: `invalid path: ${JSON.stringify(p)}`, exitCode: 1 };
    }
  }
  const args = action === 'stage'
    ? ['add', '--', ...paths]
    : ['reset', 'HEAD', '--', ...paths];
  return runGit(cwd, args);
}

// Discards uncommitted changes: staged + unstaged restored to HEAD, untracked removed.
// `paths` narrows to specific files; omitted means the whole worktree. Callers are
// responsible for restricting `cwd` to a managed worktree — this never runs against
// a primary checkout (see the /git/discard route).
export async function gitDiscard(cwd: string, paths?: string[]): Promise<GitCommandResult> {
  if (paths === undefined) {
    const reset = await runGit(cwd, ['reset', '--hard']);
    if (!reset.ok) return reset;
    const clean = await runGit(cwd, ['clean', '-fd']);
    return {
      ...clean,
      stdout: [reset.stdout, clean.stdout].filter(Boolean).join(''),
      stderr: [reset.stderr, clean.stderr].filter(Boolean).join(''),
    };
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  }
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096) {
      return { ok: false, stdout: '', stderr: `invalid path: ${JSON.stringify(p)}`, exitCode: 1 };
    }
    if (p.startsWith('-') || p.startsWith('/') || p.includes('\0')) {
      return { ok: false, stdout: '', stderr: `invalid path: ${JSON.stringify(p)}`, exitCode: 1 };
    }
  }
  // Split by status first: `git checkout --` fails on paths git doesn't know, and
  // staged-new/renamed files have no HEAD version to restore — after unstaging they
  // become untracked and must be `clean`ed instead.
  const st = await runGit(cwd, ['status', '--porcelain=v2', '-z', '--', ...paths]);
  if (!st.ok) return st;
  const files = parsePorcelainV2(st.stdout).files;
  const removePaths: string[] = [];
  const restorePaths: string[] = [];
  const unstagePaths: string[] = [];
  for (const f of files) {
    if (f.index === '!') continue;
    if (f.index === '?') { removePaths.push(f.path); continue; }
    unstagePaths.push(f.path);
    if (f.index === 'A') { removePaths.push(f.path); continue; }
    if (f.oldPath) {
      unstagePaths.push(f.oldPath);
      restorePaths.push(f.oldPath);
      removePaths.push(f.path);
      continue;
    }
    restorePaths.push(f.path);
  }
  if (unstagePaths.length > 0) {
    const reset = await runGit(cwd, ['reset', '-q', 'HEAD', '--', ...unstagePaths]);
    if (!reset.ok) return reset;
  }
  if (restorePaths.length > 0) {
    const co = await runGit(cwd, ['checkout', '-q', '--', ...restorePaths]);
    if (!co.ok) return co;
  }
  if (removePaths.length > 0) {
    const clean = await runGit(cwd, ['clean', '-fd', '-q', '--', ...removePaths]);
    if (!clean.ok) return clean;
  }
  return { ok: true, stdout: '', stderr: '', exitCode: 0 };
}

export async function gitPush(cwd: string): Promise<GitCommandResult> {
  const branch = readCurrentBranch(cwd);
  if (!branch) return { ok: false, stdout: '', stderr: 'detached HEAD — nothing to push', exitCode: 1 };
  if (!BRANCH_NAME_RE.test(branch)) {
    return { ok: false, stdout: '', stderr: `invalid branch name: ${branch}`, exitCode: 1 };
  }
  // --set-upstream is a no-op when already configured; wires tracking on first push.
  const res = await runGit(cwd, ['push', '--set-upstream', 'origin', branch]);
  // A bare `git push` gives an opaque wall of stderr on a non-fast-forward reject
  // (common after a merge/conflict round advanced the remote branch), and a plain
  // `git pull --ff-only` can't reconcile a diverged branch — so spell out the fix
  // rather than leaving the user staring at "Updates were rejected".
  if (!res.ok && /(non-fast-forward|fetch first|\[rejected\])/i.test(res.stderr)) {
    return {
      ...res,
      stderr: `${res.stderr.trim()}\n\norigin/${branch} has commits this worktree doesn't (the branch diverged — likely a merge/conflict round pushed to it). Rebase or merge origin/${branch} in and resolve before pushing; a plain --ff-only pull can't reconcile a diverged branch.`,
    };
  }
  return res;
}

export async function gitPull(cwd: string): Promise<GitCommandResult> {
  return runGit(cwd, ['pull', '--ff-only']);
}

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, ...args], { maxBuffer: MAX_BUFFER });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

// Carries uncommitted changes onto the new branch — "I'm on main, want this on a feature branch".
export async function gitCreateBranch(cwd: string, newBranch: string): Promise<GitCommandResult> {
  if (typeof newBranch !== 'string' || !BRANCH_NAME_RE.test(newBranch)) {
    return { ok: false, stdout: '', stderr: `invalid branch name: ${JSON.stringify(newBranch)}`, exitCode: 1 };
  }
  return runGit(cwd, ['checkout', '-b', newBranch]);
}

// Pushes with --set-upstream first so a brand-new branch exists on origin before gh reads it.
// On success, `url` holds the PR URL.
export async function gitOpenPr(cwd: string, opts?: { base?: string; title?: string; body?: string }): Promise<GitCommandResult & { url?: string }> {
  const branch = readCurrentBranch(cwd);
  if (!branch) {
    return { ok: false, stdout: '', stderr: 'detached HEAD — cannot open PR', exitCode: 1 };
  }
  if (!BRANCH_NAME_RE.test(branch)) {
    return { ok: false, stdout: '', stderr: `invalid branch: ${branch}`, exitCode: 1 };
  }
  const pushResult = await runGit(cwd, ['push', '--set-upstream', 'origin', branch]);
  if (!pushResult.ok) return pushResult;
  // --fill autopopulates title/body from commit messages.
  const args = ['pr', 'create', '--head', branch];
  if (opts?.base) {
    if (!BRANCH_NAME_RE.test(opts.base)) {
      return { ok: false, stdout: '', stderr: `invalid base branch: ${opts.base}`, exitCode: 1 };
    }
    args.push('--base', opts.base);
  }
  if (opts?.title) args.push('--title', opts.title); else args.push('--fill');
  if (opts?.body) args.push('--body', opts.body);
  try {
    const { stdout, stderr } = await execFileP('gh', args, { cwd, maxBuffer: MAX_BUFFER, timeout: 30_000 });
    const url = stdout.toString().trim().split('\n').reverse().find((l) => l.startsWith('http')) ?? '';
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0, url };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export interface FinalizeSquashMergeOpts {
  parentCwd: string;
  worktreeBranch: string;
  baseBranch: string;
  message: string;
  push: boolean;
}

// Refuses dirty parent: a mid-stream merge failure would leave the user in a confusing state.
export async function gitFinalizeSquashMerge(opts: FinalizeSquashMergeOpts): Promise<GitCommandResult> {
  if (typeof opts.message !== 'string' || opts.message.trim().length === 0) {
    return { ok: false, stdout: '', stderr: 'commit message required', exitCode: 1 };
  }
  if (!BRANCH_NAME_RE.test(opts.baseBranch) || !BRANCH_NAME_RE.test(opts.worktreeBranch)) {
    return { ok: false, stdout: '', stderr: 'invalid branch name', exitCode: 1 };
  }
  const dirty = await runGit(opts.parentCwd, ['status', '--porcelain']);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    return { ok: false, stdout: '', stderr: `parent repo has uncommitted changes:\n${dirty.stdout}`, exitCode: 1 };
  }
  const co = await runGit(opts.parentCwd, ['checkout', opts.baseBranch]);
  if (!co.ok) return co;
  const merge = await runGit(opts.parentCwd, ['merge', '--squash', '--', opts.worktreeBranch]);
  if (!merge.ok) return merge;
  const commit = await runGit(opts.parentCwd, ['commit', '-m', opts.message]);
  if (!commit.ok) return commit;
  if (opts.push) {
    const push = await runGit(opts.parentCwd, ['push']);
    if (!push.ok) return { ...push, stdout: `${commit.stdout}\n${push.stdout}`, stderr: `${commit.stderr}\n${push.stderr}` };
  }
  return commit;
}

export type SquashMergeResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'error'; message: string };

export interface SquashMergeToBaseOpts {
  parentCwd: string;
  worktreePath: string;
  worktreeBranch: string;
  baseBranch: string;
  message: string;
}

// Squash-merges worktreeBranch into baseBranch inside the parent checkout, no push.
// On conflict it restores the parent to a clean base (reset --hard, since --squash
// leaves no MERGE_HEAD to abort) and reports the conflicted files instead of leaving
// a half-merged tree — the caller hands those off to the resolve-conflicts flow.
export async function gitSquashMergeToBase(opts: SquashMergeToBaseOpts): Promise<SquashMergeResult> {
  if (typeof opts.message !== 'string' || opts.message.trim().length === 0) {
    return { ok: false, reason: 'error', message: 'commit message required' };
  }
  if (!BRANCH_NAME_RE.test(opts.baseBranch) || !BRANCH_NAME_RE.test(opts.worktreeBranch)) {
    return { ok: false, reason: 'error', message: 'invalid branch name' };
  }
  // The merge takes only what's committed on the branch. If the worktree has
  // uncommitted or untracked files (the open-pr flow's edits often start that way),
  // squashing would silently drop them from the base commit — mirror the commit-clean
  // requirement gitFinalizeSquashToBranch enforces and make the caller commit first.
  const wtDirty = await runGit(opts.worktreePath, ['status', '--porcelain']);
  if (wtDirty.ok && wtDirty.stdout.trim().length > 0) {
    return { ok: false, reason: 'error', message: `worktree has uncommitted changes — commit them onto the branch first:\n${wtDirty.stdout}` };
  }
  const dirty = await runGit(opts.parentCwd, ['status', '--porcelain']);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    return { ok: false, reason: 'error', message: `parent repo has uncommitted changes:\n${dirty.stdout}` };
  }
  const co = await runGit(opts.parentCwd, ['checkout', opts.baseBranch]);
  if (!co.ok) return { ok: false, reason: 'error', message: co.stderr || co.stdout };

  const merge = await runGit(opts.parentCwd, ['merge', '--squash', '--', opts.worktreeBranch]);
  if (!merge.ok) {
    const conflicted = await runGit(opts.parentCwd, ['diff', '--name-only', '--diff-filter=U']);
    const files = conflicted.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    await runGit(opts.parentCwd, ['reset', '--hard', 'HEAD']);
    if (files.length > 0) return { ok: false, reason: 'conflict', files };
    return { ok: false, reason: 'error', message: merge.stderr || merge.stdout };
  }

  const commit = await runGit(opts.parentCwd, ['commit', '-m', opts.message]);
  if (!commit.ok) {
    await runGit(opts.parentCwd, ['reset', '--hard', 'HEAD']);
    return { ok: false, reason: 'error', message: commit.stderr || commit.stdout };
  }
  return { ok: true, stdout: commit.stdout };
}

export interface FinalizeSquashToBranchOpts {
  worktreePath: string;
  baseBranch: string;
  newBranch: string;
  message: string;
}

// Collapses commits since baseBranch, pushes to origin under newBranch, opens a PR.
// On success, `url` holds the PR URL.
export async function gitFinalizeSquashToBranch(opts: FinalizeSquashToBranchOpts): Promise<GitCommandResult & { url?: string }> {
  if (typeof opts.message !== 'string' || opts.message.trim().length === 0) {
    return { ok: false, stdout: '', stderr: 'commit message required', exitCode: 1 };
  }
  if (!BRANCH_NAME_RE.test(opts.baseBranch) || !BRANCH_NAME_RE.test(opts.newBranch)) {
    return { ok: false, stdout: '', stderr: 'invalid branch name', exitCode: 1 };
  }
  // Require commit-clean: intent is "wrap up commits I already made", not snarf working tree.
  const dirty = await runGit(opts.worktreePath, ['status', '--porcelain']);
  if (dirty.ok && dirty.stdout.trim().length > 0) {
    return { ok: false, stdout: '', stderr: `worktree has uncommitted changes:\n${dirty.stdout}`, exitCode: 1 };
  }
  // reset --soft rewinds HEAD to base leaving every diff staged; one commit collapses it.
  const reset = await runGit(opts.worktreePath, ['reset', '--soft', opts.baseBranch, '--']);
  if (!reset.ok) return reset;
  const commit = await runGit(opts.worktreePath, ['commit', '-m', opts.message]);
  if (!commit.ok) return commit;
  const push = await runGit(opts.worktreePath, ['push', '-u', 'origin', `HEAD:refs/heads/${opts.newBranch}`]);
  if (!push.ok) return push;
  try {
    const { stdout, stderr } = await execFileP(
      'gh',
      ['pr', 'create', '--head', opts.newBranch, '--base', opts.baseBranch, '--fill'],
      { cwd: opts.worktreePath, maxBuffer: MAX_BUFFER, timeout: 30_000 },
    );
    const url = stdout.toString().trim().split('\n').reverse().find((l) => l.startsWith('http')) ?? '';
    return { ok: true, stdout: `${commit.stdout}\n${push.stdout}\n${stdout}`, stderr: `${commit.stderr}\n${push.stderr}\n${stderr}`, exitCode: 0, url };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number };
    return {
      ok: false,
      stdout: `${commit.stdout}\n${push.stdout}\n${e.stdout?.toString() ?? ''}`,
      stderr: e.stderr?.toString() ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

async function detectDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      { maxBuffer: 1024 * 1024 },
    );
    const m = stdout.toString().trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1] ?? null;
  } catch { /* fall through to probe */ }
  for (const ref of ['main', 'master']) {
    try {
      await execFileP('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], { maxBuffer: 1024 * 1024 });
      return ref;
    } catch { /* not present */ }
  }
  return null;
}

// Returns null for non-GitHub remotes — other hosts use different commit-URL shapes.
async function detectCommitUrlBase(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      { maxBuffer: 1024 * 1024 },
    );
    const url = stdout.toString().trim();
    if (!url) return null;
    // Covers ssh `git@github.com:o/r(.git)?`, https `https://[user@]github.com/o/r(.git)?`,
    // and ssh:// `ssh://git@github.com/o/r(.git)?`.
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) return null;
    return `https://github.com/${m[1]}/${m[2]}`;
  } catch { return null; }
}

function readCurrentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch { return null; }
}

// 4s timeout caps a hung gh from blocking the status response.
async function detectPrUrl(cwd: string, branch: string): Promise<string | null> {
  if (!BRANCH_NAME_RE.test(branch)) return null;
  try {
    const { stdout } = await execFileP(
      'gh',
      ['pr', 'view', branch, '--json', 'url', '-q', '.url'],
      { cwd, maxBuffer: 1024 * 1024, timeout: 4000 },
    );
    const url = stdout.toString().trim();
    if (!url.startsWith('http')) return null;
    return url;
  } catch (err) {
    const e = err as { code?: number | string; stderr?: Buffer | string; signal?: string };
    console.log(
      `[git-ops] detectPrUrl(${branch}) failed in ${cwd}:`,
      `code=${e.code} signal=${e.signal} stderr=${(e.stderr ?? '').toString().slice(0, 200)}`,
    );
    return null;
  }
}

function parsePorcelainV2(out: string): Omit<GitStatus, 'prUrl' | 'defaultBranch' | 'commitUrlBase'> {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const files: GitStatusFile[] = [];
  // NUL-separated; rename entries (`2 …`) consume the next record as their source path,
  // hence the manual index walker.
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length);
      if (v === '(detached)') { detached = true; branch = null; } else { branch = v; }
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length);
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      continue;
    }
    if (line.startsWith('# ')) continue;
    if (line.startsWith('1 ')) {
      // `1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>` — XY is two chars.
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(8).join(' ');
      files.push({ index: xy[0] ?? ' ', worktree: xy[1] ?? ' ', path });
      continue;
    }
    if (line.startsWith('2 ')) {
      // `2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` followed by NUL <oldPath>.
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(9).join(' ');
      const oldPath = tokens[++i] ?? '';
      files.push({ index: xy[0] ?? ' ', worktree: xy[1] ?? ' ', path, oldPath });
      continue;
    }
    if (line.startsWith('? ')) {
      files.push({ index: '?', worktree: '?', path: line.slice(2) });
      continue;
    }
    if (line.startsWith('! ')) {
      files.push({ index: '!', worktree: '!', path: line.slice(2) });
      continue;
    }
    if (line.startsWith('u ')) {
      // Unmerged. `u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(10).join(' ');
      files.push({ index: xy[0] ?? 'U', worktree: xy[1] ?? 'U', path });
      continue;
    }
  }
  return { branch, upstream, ahead, behind, detached, files, clean: files.length === 0 };
}

function parseLogOutput(out: string): GitLogEntry[] {
  if (!out) return [];
  const records = out.split('\x1e').map((r) => r.trim()).filter(Boolean);
  const entries: GitLogEntry[] = [];
  for (const r of records) {
    const parts = r.split('\x1f');
    if (parts.length < 6) continue;
    entries.push({
      hash: parts[0]!,
      shortHash: parts[1]!,
      author: parts[2]!,
      email: parts[3]!,
      date: Number(parts[4]) * 1000,
      subject: parts[5]!,
    });
  }
  return entries;
}

function isGitRepoSync(cwd: string): boolean {
  try {
    const st = statSync(join(cwd, '.git'));
    return st.isDirectory() || st.isFile();
  } catch { return false; }
}
