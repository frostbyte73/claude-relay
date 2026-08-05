import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeManager, WorktreeRecord, DiffMode } from './worktree-manager.js';
import { diffBaseFor, runGitDiff, runGitDiffInCwd } from './worktree-manager.js';
import { parseUnifiedDiff, type DiffFile } from './diff-parser.js';

const MAX_FILES = 50;

// Minimal duck-typed shape; SessionStore satisfies it but tests can pass a stub.
export interface SessionLookup {
  findSession(id: string): { cwd: string } | null;
}

// Minimal duck-typed shape satisfied by WorkEngine. Step sessions key their
// worktree by stepId, so a direct wm.get(sessionId) misses it — and a
// session-keyed archived tombstone (left by DELETE /api/sessions on the step's
// reused session) can shadow the live worktree. This resolves session→stepId→record.
export interface StepWorktreeLookup {
  worktreeRecordForSession(sessionId: string): WorktreeRecord | undefined;
}

export type DiffResponse =
  | { status: 200; body: {
      mode: DiffMode;
      baseRef: string;
      headRef: string;
      files: DiffFile[];
      truncated?: { hiddenFiles: number };
      // Present when HEAD == base branch. The PWA hides the branch-vs-base toggle in
      // that case — branch mode is meaningless and worktree mode is the only useful view.
      onBaseBranch?: boolean;
    } }
  | { status: 400 | 404; body: { error: string } };

export function handleDiffRoute(
  wm: WorktreeManager,
  sessionLookup: SessionLookup,
  sessionId: string,
  mode: string,
  stepLookup?: StepWorktreeLookup,
): DiffResponse {
  if (mode !== 'branch' && mode !== 'worktree') {
    return { status: 400, body: { error: 'invalid mode' } };
  }
  const m: DiffMode = mode;

  // Path 1: outpost-managed worktree session. Keep the existing semantics —
  // branch mode diffs against the stored baseBranch on the parent repo's checkout,
  // worktree mode diffs uncommitted changes inside the worktree itself.
  // Resolve step sessions through the engine's session→stepId→record mapping first
  // so the live step worktree wins over a shadowing session-keyed tombstone.
  const rec = stepLookup?.worktreeRecordForSession(sessionId) ?? wm.get(sessionId);
  if (rec && rec.archivedAt) {
    return { status: 404, body: { error: 'session is archived' } };
  }
  if (rec && rec.worktreePath) {
    const text = runGitDiff(rec, m);
    const allFiles = parseUnifiedDiff(text);
    if (m === 'worktree') {
      mergeUntrackedFiles(allFiles, rec.worktreePath);
    }
    return buildResponse(m, allFiles, {
      baseRef: m === 'branch' ? diffBaseFor(rec) : 'HEAD',
      headRef: m === 'branch' ? rec.branch : 'WORKTREE',
    });
  }

  // Path 2: session running directly in a user repo, no worktree. Resolve the cwd
  // from the session store; the current branch + base are detected at call time.
  const found = sessionLookup.findSession(sessionId);
  if (!found) return { status: 404, body: { error: 'no such session' } };
  if (!isGitRepoSync(found.cwd)) {
    return { status: 404, body: { error: 'session cwd is not a git repo' } };
  }
  const result = runGitDiffInCwd(found.cwd, m);
  const allFiles = parseUnifiedDiff(result.text);
  if (m === 'worktree') {
    mergeUntrackedFiles(allFiles, found.cwd);
  }
  return buildResponse(m, allFiles, {
    baseRef: result.baseRef,
    headRef: result.headRef,
    onBaseBranch: result.onBaseBranch,
  });
}

// Append untracked-file entries to the worktree-mode diff payload. `git diff HEAD`
// excludes untracked files, so without this a new file a session created can't be
// reviewed or staged. Each entry carries `untracked: true` (so the PWA can label it
// and offer the Stage checkbox) plus real content hunks so the reviewer can actually
// read the file before approving a PR — critical when the change *is* a new file.
function mergeUntrackedFiles(files: DiffFile[], cwd: string): void {
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    return;
  }
  const seen = new Set(files.map((f) => f.path));
  const paths = out.split('\0').filter((raw) => raw && !seen.has(raw));
  // Bound the per-file `git diff` spawns: buildResponse truncates the combined list
  // to MAX_FILES anyway, so content beyond that budget would never be shown. Extras
  // still get a hunkless entry so the file-count / truncation accounting stays right.
  paths.forEach((path, i) => {
    files.push(i < MAX_FILES ? buildUntrackedEntry(cwd, path) : hunklessUntracked(path));
  });
}

// `git diff --no-index -- /dev/null <path>` renders an untracked file as an
// all-additions diff we can parse for content. It exits 1 when a diff exists, which
// execFileSync throws on — the payload is on the error's `stdout`. Binary files come
// back as a `Binary files … differ` line, which parseUnifiedDiff flags for us.
function buildUntrackedEntry(cwd: string, path: string): DiffFile {
  let text = '';
  try {
    const buf = execFileSync(
      'git',
      ['-C', cwd, 'diff', '--no-color', '--no-index', '--', '/dev/null', path],
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 },
    );
    text = buf.toString('utf8');
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    if (e.stdout === undefined) return hunklessUntracked(path);
    text = e.stdout.toString();
  }
  const parsed = parseUnifiedDiff(text)[0];
  if (!parsed) return hunklessUntracked(path);
  // Force the ls-files path: --no-index headers repeat the real path on both sides,
  // which parseGitHeader can mis-split if the name itself contains " b/".
  return { ...parsed, path, status: 'added', untracked: true };
}

function hunklessUntracked(path: string): DiffFile {
  return { path, status: 'added', binary: false, truncated: false, hunks: [], untracked: true };
}

function buildResponse(
  mode: DiffMode,
  allFiles: DiffFile[],
  extra: { baseRef: string; headRef: string; onBaseBranch?: boolean },
): DiffResponse {
  const files = allFiles.slice(0, MAX_FILES);
  const body = {
    mode,
    baseRef: extra.baseRef,
    headRef: extra.headRef,
    files,
    ...(allFiles.length > MAX_FILES ? { truncated: { hiddenFiles: allFiles.length - MAX_FILES } } : {}),
    ...(extra.onBaseBranch ? { onBaseBranch: true } : {}),
  };
  return { status: 200, body };
}

// `.git` is a directory in normal checkouts and a file in git worktrees / submodules —
// accept either.
function isGitRepoSync(cwd: string): boolean {
  try {
    const st = statSync(join(cwd, '.git'));
    return st.isDirectory() || st.isFile();
  } catch { return false; }
}
