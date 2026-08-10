import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceRef } from '../work/work-types.js';

const execFileP = promisify(execFile);

export interface WorktreeRecord {
  sessionId: string;
  projectCwd: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  // Exact start point the branch was cut from — `baseBranch` when the local ref was current
  // (or ahead), else `origin/<baseBranch>`. Diff + squash bases read this, not baseBranch,
  // so a stale local base can't fold upstream commits into the step's diff. An adopted or
  // drifted branch records the merge-base sha instead: a ref spelling would name a commit the
  // branch was never cut from, and `gitFinalizeSquashToBranch` rewinds to this.
  baseRef?: string;
  // Commits `baseRef`'s branch has gained since this branch diverged, as of the last provision.
  // Non-zero means the step is knowingly on a stale base we declined to move because it already
  // has commits of its own — merging the base in is the controller's call, not ours.
  baseDrift?: number;
  createdAt: number;
  // Tombstone when archived: path/branch fields cleared; SessionStore reads this to mark `archived: true`.
  archivedAt?: number;
}

interface PersistedShape {
  records: WorktreeRecord[];
}

export interface WorktreeManagerOpts {
  root: string;
  // archive() relocates the session JSONL from the worktree-derived project dir back here, so `claude --resume` finds it.
  projectsRoot: string;
}

// Defense in depth against path traversal + argv-flag smuggling: sessionId must not start with `-` (else git treats it as a flag).
const SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// git-check-ref-format shape; leading dash would be parsed as a git flag.
const BRANCH_NAME_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./-]{0,128}$/;
const FETCH_TIMEOUT_MS = 20_000;
// GitHub serves refs/pull/<N>/head but a normal clone never fetches it — `N` is digits-only
// from this capture, so it can never be argv-flag-shaped.
const PR_REF_RE = /^refs\/pull\/(\d+)\/head$/;
// The namespace fetchPrHead writes into. Exclusively the daemon's, which is what makes it
// safe to delete on teardown and to sweep at start-up.
const OUTPOST_PR_REF_RE = /^refs\/outpost\/pr-\d+$/;

export class WorktreeManager {
  private records = new Map<string, WorktreeRecord>();
  private readonly indexPath: string;
  protected readonly root: string;
  protected readonly projectsRoot: string;
  // In-flight PR-head fetches keyed by repo+PR number. A review step fans out to several
  // lenses that provision the same PR at once; without this each child spawns its own
  // `git fetch` of the identical refspec against the same repo.
  private readonly prFetches = new Map<string, Promise<void>>();
  // Ordered before any PR fetch so the sweep can't delete a ref a concurrent provision
  // just wrote. Nothing awaits the manager's construction, so this is the handle.
  private readonly startupSweep: Promise<void>;

  constructor(opts: WorktreeManagerOpts) {
    this.root = opts.root;
    this.projectsRoot = opts.projectsRoot;
    this.indexPath = join(this.root, 'index.json');
    this.load();
    this.startupSweep = this.sweepStalePrRefs().catch(() => { /* best-effort */ });
  }

  get(sessionId: string): WorktreeRecord | undefined {
    return this.records.get(sessionId);
  }

  list(): WorktreeRecord[] {
    return [...this.records.values()];
  }

  // Test-only seam: production callers go through create()/archive().
  _testSeedRecord(rec: WorktreeRecord): void {
    this.records.set(rec.sessionId, rec);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const raw = readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (Array.isArray(parsed?.records)) {
        for (const r of parsed.records) {
          if (typeof r?.sessionId === 'string') this.records.set(r.sessionId, r);
        }
      }
    } catch { /* malformed — start empty, next persist() overwrites */ }
  }

  protected persist(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexPath}.tmp`;
    const payload: PersistedShape = { records: [...this.records.values()] };
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  async create(opts: { sessionId: string; projectCwd: string; baseBranch: string; branch?: string }): Promise<WorktreeRecord> {
    // sessionId becomes a path component, baseBranch a git positional — reject path traversal + argv-flag smuggling.
    if (!SESSION_ID_RE.test(opts.sessionId)) {
      throw new Error(`invalid sessionId: ${JSON.stringify(opts.sessionId)}`);
    }
    if (!BRANCH_NAME_RE.test(opts.baseBranch)) {
      throw new Error(`invalid baseBranch: ${JSON.stringify(opts.baseBranch)}`);
    }
    if (opts.branch !== undefined && !BRANCH_NAME_RE.test(opts.branch)) {
      throw new Error(`invalid branch: ${JSON.stringify(opts.branch)}`);
    }
    if (this.records.has(opts.sessionId)) {
      throw new Error(`session ${opts.sessionId} already has a worktree`);
    }
    const shortId = opts.sessionId.replace(/-/g, '').slice(0, 8);
    const branch = opts.branch ?? `outpost/${shortId}`;
    const worktreePath = join(this.root, opts.sessionId);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const startRef = await this.resolveStartRef(opts.projectCwd, opts.baseBranch);

    // If this branch is already checked out somewhere, decide whether to adopt it.
    // Primary working tree: park it on baseBranch if clean (so we can move the branch into
    // our own worktree); refuse if dirty (teardown does `branch -D` — uncommitted work
    // would be lost). Adopting an existing PR in-place is the point.
    // Secondary under our root: an earlier outpost step that lost its record (state loss,
    // retry with a new stepId, dual daemons); move it to our sessionId slot so all outpost
    // worktrees live in a predictable place.
    // Secondary outside our root: refuse — that's a user-managed worktree, not ours.
    const existingCheckout = findWorktreeForBranch(opts.projectCwd, branch);
    if (existingCheckout) {
      if (isPrimaryWorktree(opts.projectCwd, existingCheckout)) {
        if (!isCleanCheckout(opts.projectCwd)) {
          throw new Error(
            `branch ${JSON.stringify(branch)} is checked out at the primary working tree ${JSON.stringify(existingCheckout)} with uncommitted changes; ` +
            `commit or stash them and retry`,
          );
        }
        // Park the primary on baseBranch so nothing holds the target branch. The
        // subsequent `git worktree add -- <path> <branch>` will succeed on the
        // branchExistsLocally path below.
        execFileSync('git', ['-C', opts.projectCwd, 'checkout', '--quiet', opts.baseBranch], { stdio: 'pipe' });
      } else if (!isUnder(existingCheckout, this.root)) {
        throw new Error(
          `branch ${JSON.stringify(branch)} is checked out at ${JSON.stringify(existingCheckout)}, outside the outpost worktree root; ` +
          `remove that checkout (\`git -C ${opts.projectCwd} worktree remove ${existingCheckout}\`) and retry`,
        );
      } else {
        if (existingCheckout !== worktreePath) {
          execFileSync(
            'git',
            ['-C', opts.projectCwd, 'worktree', 'move', '--', existingCheckout, worktreePath],
            { stdio: 'pipe' },
          );
        }
        const rec: WorktreeRecord = {
          sessionId: opts.sessionId,
          projectCwd: opts.projectCwd,
          worktreePath,
          branch,
          baseBranch: opts.baseBranch,
          baseRef: startRef,
          createdAt: Date.now(),
        };
        // Adopted, not cut: the branch points wherever it already pointed, so `startRef` is what
        // we wanted and not what we got. Align (or record the drift) before claiming a base.
        await this.alignToBase(rec);
        this.records.set(opts.sessionId, rec);
        this.persist();
        return rec;
      }
    }

    // If the branch exists as a local ref but nothing has it checked out, drop `-b` so git
    // checks the existing branch into our new worktree instead of trying to re-create it.
    const branchExistsLocally = doesBranchExist(opts.projectCwd, branch);
    // `--` separator: belt-and-suspenders with the regexes above — git won't parse a leading-`-` path/branch as a flag.
    const args = branchExistsLocally
      ? ['-C', opts.projectCwd, 'worktree', 'add', '--', worktreePath, branch]
      : ['-C', opts.projectCwd, 'worktree', 'add', '-b', branch, '--', worktreePath, startRef];
    execFileSync('git', args, { stdio: 'pipe' });
    copyAllowlistedIgnored(opts.projectCwd, worktreePath);
    const rec: WorktreeRecord = {
      sessionId: opts.sessionId,
      projectCwd: opts.projectCwd,
      worktreePath,
      branch,
      baseBranch: opts.baseBranch,
      baseRef: startRef,
      createdAt: Date.now(),
    };
    // The `-b` path cut from startRef exactly, so it already holds. The adopted path took whatever
    // the pre-existing ref pointed at — days old in the case this exists for.
    if (branchExistsLocally) await this.alignToBase(rec);
    this.records.set(opts.sessionId, rec);
    this.persist();
    return rec;
  }

  // Job-step entry point: dispatches on workspace kind. Worktree-bound steps
  // share the same per-id worktree store; readonly variants are created in detached
  // mode (no branch). `none` is a no-op for steps that don't need a checkout.
  // `expectRepo` ("owner/repo") cross-checks the caller's independent knowledge of which
  // GitHub repo the work belongs to against `repoCwd`'s own origin. The planner picks
  // repoCwd; a wrong pick still holds refs/pull/<N>/head for its own PR #N, so the fetch
  // succeeds and the step reviews an unrelated diff with no error anywhere.
  async provision(
    stepId: string,
    ref: WorkspaceRef,
    opts: { expectRepo?: string } = {},
  ): Promise<{ path: string | null }> {
    if (ref.kind === 'none') return { path: null };
    if (!SESSION_ID_RE.test(stepId)) {
      throw new Error(`invalid stepId: ${JSON.stringify(stepId)}`);
    }
    if (!ref.repoCwd || typeof ref.repoCwd !== 'string') {
      throw new Error(`workspace.${ref.kind} requires repoCwd (got ${JSON.stringify(ref.repoCwd)})`);
    }
    if (this.records.has(stepId)) {
      const rec = this.records.get(stepId)!;
      if (!rec.archivedAt) {
        // The tree survives across rounds; its base must not. Readonly stays pinned on purpose —
        // it is a detached snapshot, and moving it under a step that already reported findings
        // against those line numbers is worse than reading a slightly older tree.
        if (ref.kind === 'writable') {
          await this.alignToBase(rec);
          this.persist();
        }
        return { path: rec.worktreePath };
      }
    }
    if (opts.expectRepo) await assertOriginRepo(ref.repoCwd, opts.expectRepo);
    if (ref.kind === 'writable') {
      const baseBranch = resolveBaseBranch(ref.repoCwd);
      const rec = await this.create({ sessionId: stepId, projectCwd: ref.repoCwd, baseBranch, branch: ref.branch });
      return { path: rec.worktreePath };
    }
    // readonly: detached worktree at an explicit `ref.ref`, else the freshly-resolved base.
    // NOT `HEAD` — that's whatever branch the user's primary checkout happens to sit on
    // (often an unrelated feature branch), so investigations would read a tree that answers
    // a different question than "what does main do today".
    let at = ref.ref ?? await this.resolveStartRef(ref.repoCwd, resolveBaseBranch(ref.repoCwd));
    if (!BRANCH_NAME_RE.test(at)) throw new Error(`invalid ref: ${JSON.stringify(at)}`);
    // A PR head is fetched into our own `refs/outpost/pr-<N>` and the worktree is cut from
    // THAT ref, never from the caller's `refs/pull/<N>/head`: a clone configured with
    // `remote.origin.fetch = +refs/pull/*/head:refs/pull/*/head` keeps its own copy of the
    // caller's spelling, which goes stale the instant the PR author force-pushes. So there
    // is no local ref whose presence proves freshness, and the fetch is unconditional —
    // concurrent provisions of one PR share it (prFetches), which is the case the skip was
    // really written for. If it can't land, fail: silently reviewing the pre-force-push
    // tree is worse than a step that reports it couldn't reach origin.
    const prMatch = ref.ref ? PR_REF_RE.exec(at) : null;
    if (prMatch) {
      await this.startupSweep;
      const local = `refs/outpost/pr-${prMatch[1]}`;
      await this.fetchPrHead(ref.repoCwd, prMatch[1]!);
      if (!await refExists(ref.repoCwd, `${local}^{commit}`)) {
        throw new Error(`could not fetch ${at} from origin in ${ref.repoCwd}`);
      }
      at = local;
    }
    const worktreePath = join(this.root, stepId);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    execFileSync(
      'git',
      ['-C', ref.repoCwd, 'worktree', 'add', '--detach', '--', worktreePath, at],
      { stdio: 'pipe' },
    );
    const rec: WorktreeRecord = {
      sessionId: stepId,
      projectCwd: ref.repoCwd,
      worktreePath,
      branch: '',
      baseBranch: '',
      baseRef: at,
      createdAt: Date.now(),
    };
    this.records.set(stepId, rec);
    this.persist();
    return { path: worktreePath };
  }

  async remove(sessionId: string): Promise<void> {
    const rec = this.records.get(sessionId);
    if (rec) {
      await this.tearDown(rec);
      this.records.delete(sessionId);
      this.persist();
      return;
    }
    // Dual-daemon case: another instance created the worktree, so probe disk to avoid leaking branch + dir.
    if (!SESSION_ID_RE.test(sessionId)) return;
    const orphanPath = join(this.root, sessionId);
    const projectCwd = readParentRepoFromGitFile(orphanPath);
    if (!projectCwd) return;
    const shortId = sessionId.replace(/-/g, '').slice(0, 8);
    await this.tearDown({
      sessionId,
      projectCwd,
      worktreePath: orphanPath,
      branch: `outpost/${shortId}`,
      baseBranch: '',
      createdAt: 0,
    });
  }

  // /clear in Claude SDK spawns a fresh internal session_id while the proc keeps running.
  // Transfer the live worktree to the new id and tombstone the old one — JSONL, branch, and
  // worktree all stay on disk so the user can still diff/finalize the work from the new session.
  softArchive(oldId: string, newId: string, projectCwd?: string): void {
    if (!SESSION_ID_RE.test(oldId) || !SESSION_ID_RE.test(newId)) return;
    const rec = this.records.get(oldId);
    if (rec?.archivedAt) return;
    if (rec && rec.worktreePath) {
      this.records.set(newId, { ...rec, sessionId: newId });
      this.records.set(oldId, {
        sessionId: oldId,
        projectCwd: rec.projectCwd,
        worktreePath: '',
        branch: '',
        baseBranch: '',
        createdAt: rec.createdAt,
        archivedAt: Date.now(),
      });
    } else if (!rec) {
      // Non-worktree session: tombstone-only so listProjects flags the old JSONL as archived.
      this.records.set(oldId, {
        sessionId: oldId,
        projectCwd: projectCwd ?? '',
        worktreePath: '',
        branch: '',
        baseBranch: '',
        createdAt: Date.now(),
        archivedAt: Date.now(),
      });
    }
    this.persist();
  }

  async archive(sessionId: string, projectCwd?: string): Promise<void> {
    const rec = this.records.get(sessionId);
    if (rec?.archivedAt) return;
    if (!rec) {
      // Tombstone-only entry so SessionStore can mark the row archived; nothing on disk to clean.
      if (!SESSION_ID_RE.test(sessionId)) return;
      this.records.set(sessionId, {
        sessionId,
        projectCwd: projectCwd ?? '',
        worktreePath: '',
        branch: '',
        baseBranch: '',
        createdAt: Date.now(),
        archivedAt: Date.now(),
      });
      this.persist();
      return;
    }
    // Relocate JSONL + sidecars BEFORE teardown — otherwise `claude --resume <id>` (which looks under sanitize(projectCwd)) orphans.
    this.relocateSessionFiles(rec);
    await this.tearDown(rec);
    this.records.set(sessionId, {
      ...rec,
      archivedAt: Date.now(),
    });
    this.persist();
  }

  private relocateSessionFiles(rec: WorktreeRecord): void {
    if (!rec.worktreePath) return;
    const fromDir = join(this.projectsRoot, rec.worktreePath.replace(/\//g, '-'));
    const toDir = join(this.projectsRoot, rec.projectCwd.replace(/\//g, '-'));
    if (!existsSync(fromDir)) return;
    mkdirSync(toDir, { recursive: true });
    for (const name of [`${rec.sessionId}.jsonl`, `${rec.sessionId}.title`, rec.sessionId]) {
      const src = join(fromDir, name);
      const dst = join(toDir, name);
      if (!existsSync(src)) continue;
      try { renameSync(src, dst); } catch { /* best-effort */ }
    }
    // Only remove the source dir if empty — unknown leftover files might belong to another session.
    try { if (readdirSync(fromDir).length === 0) rmdirSync(fromDir); } catch { /* leave it */ }
  }

  private async tearDown(rec: WorktreeRecord): Promise<void> {
    if (!rec.worktreePath) return; // already torn down (tombstone)
    try {
      execFileSync(
        'git',
        ['-C', rec.projectCwd, 'worktree', 'remove', '--force', '--', rec.worktreePath],
        { stdio: 'pipe' },
      );
    } catch { /* path may already be gone */ }
    // Without prune, a stale .git/worktrees/<id> entry makes branch -D fail with "branch is checked out at …" and leak the branch.
    try {
      execFileSync('git', ['-C', rec.projectCwd, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch { /* best-effort */ }
    if (rec.branch) {
      try {
        execFileSync(
          'git',
          ['-C', rec.projectCwd, 'branch', '-D', '--', rec.branch],
          { stdio: 'pipe' },
        );
      } catch { /* branch may already be gone */ }
    }
    // A readonly PR checkout carries no branch, so the `branch -D` above never applied to it
    // and its `refs/outpost/pr-<N>` outlived every worktree that used it — permanently pinning
    // that PR's object graph against `git gc` in a repo the daemon doesn't own. Deleting it
    // while another lens is still detached at the same commit is safe: that worktree's own
    // HEAD keeps the objects reachable.
    if (rec.baseRef && OUTPOST_PR_REF_RE.test(rec.baseRef)) {
      deleteRef(rec.projectCwd, rec.baseRef);
    }
  }

  // Refs a previous daemon left behind — it died between `worktree add` and teardown, or ran a
  // build that never deleted them at all. Bounded to repos we hold a record for; the
  // refs/outpost namespace is exclusively ours, so anything in it with no live record is dead.
  async sweepStalePrRefs(): Promise<void> {
    const repos = new Set<string>();
    const live = new Set<string>();
    for (const r of this.records.values()) {
      if (!r.projectCwd) continue;
      repos.add(r.projectCwd);
      if (!r.archivedAt && r.baseRef && OUTPOST_PR_REF_RE.test(r.baseRef)) {
        live.add(`${r.projectCwd}\0${r.baseRef}`);
      }
    }
    for (const cwd of repos) {
      let listed: string;
      try {
        const { stdout } = await execFileP('git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', 'refs/outpost/']);
        listed = stdout;
      } catch { continue; }
      for (const line of listed.split('\n')) {
        const ref = line.trim();
        if (!ref || !OUTPOST_PR_REF_RE.test(ref)) continue;
        if (live.has(`${cwd}\0${ref}`)) continue;
        deleteRef(cwd, ref);
      }
    }
  }

  // The only network-touching subprocess on the provision path. Overridable so a test can
  // count fetches without a remote.
  protected async runGitFetch(cwd: string, args: string[]): Promise<void> {
    await execFileP('git', ['-C', cwd, 'fetch', ...args], { timeout: FETCH_TIMEOUT_MS });
  }

  // Fetch `origin/<base>` and decide what to actually branch from. Local wins only when it holds
  // commits origin doesn't (unpushed work you want to build on); otherwise origin wins, because a
  // checkout that hasn't been pulled in days would silently cut branches from a stale tree.
  // Prefer fast-forwarding the local ref so baseBranch stays an honest diff/PR base; when the base
  // is checked out somewhere git refuses that, and we hand back `origin/<base>` as the start point.
  private async resolveStartRef(cwd: string, baseBranch: string): Promise<string> {
    await this.fetchBase(cwd, baseBranch);
    const remote = `origin/${baseBranch}`;
    if (!await refExists(cwd, remote)) return baseBranch;
    if (!await refExists(cwd, baseBranch)) return remote;
    if (await isAncestor(cwd, remote, baseBranch)) return baseBranch; // local ahead of (or equal to) origin
    try {
      // Moves the ref only — no working tree touched. Refused when baseBranch is checked out.
      await this.runGitFetch(cwd, ['--quiet', 'origin', `${baseBranch}:${baseBranch}`]);
      return baseBranch;
    } catch {
      return remote;
    }
  }

  // Freshness at creation is not freshness at dispatch. An orchestrated step re-spawns once per
  // round, so one branched on Monday and dispatched on Friday used to be handed Monday's base
  // straight back — provision() returned the existing record without touching git, and
  // resolveStartRef was only ever reachable through create(). Same hole on an adopted branch,
  // where create() computes a start ref and then checks out a ref that ignores it.
  //
  // Only ever fast-forwards a branch with no commits of its own into a clean worktree. Anything
  // the step already committed stays exactly where it is: the branch may be pushed under an open
  // PR, and moving it means a force-push. Those record their real branch point instead — as a sha,
  // so no later ref movement can shift what a squash rewinds to — plus the drift, leaving the
  // decision to merge the base in with the controller (code.resolve-conflicts).
  private async alignToBase(rec: WorktreeRecord): Promise<void> {
    if (!rec.branch || !rec.baseBranch || !rec.worktreePath) return;
    if (!BRANCH_NAME_RE.test(rec.branch) || !BRANCH_NAME_RE.test(rec.baseBranch)) return;
    if (!existsSync(rec.worktreePath)) return;

    const startRef = await this.resolveStartRef(rec.projectCwd, rec.baseBranch);
    if (!await refExists(rec.projectCwd, startRef)) return;

    // Nothing beyond the base means the branch is either already there or purely behind it.
    if (await countCommits(rec.projectCwd, `${startRef}..${rec.branch}`) === 0) {
      if (await isAncestor(rec.projectCwd, startRef, rec.branch)) {
        rec.baseRef = startRef;
        rec.baseDrift = 0;
        return;
      }
      if (isCleanCheckout(rec.worktreePath)) {
        try {
          await execFileP('git', ['-C', rec.worktreePath, 'merge', '--ff-only', '--quiet', startRef]);
          rec.baseRef = startRef;
          rec.baseDrift = 0;
          return;
        } catch { /* raced, or a hook refused it — fall through and just record the drift */ }
      }
    }
    const branchPoint = await mergeBase(rec.projectCwd, startRef, rec.branch);
    if (branchPoint) rec.baseRef = branchPoint;
    rec.baseDrift = await countCommits(rec.projectCwd, `${rec.branch}..${startRef}`);
  }

  // Best-effort: an offline machine or a repo with no `origin` must not block provisioning.
  private async fetchBase(cwd: string, baseBranch: string): Promise<void> {
    try {
      await this.runGitFetch(cwd, ['--quiet', 'origin', baseBranch]);
    } catch { /* stale remote-tracking ref is better than a failed step */ }
  }

  // --force so a re-provision after the PR author pushes again moves the local ref forward.
  // Failures are swallowed here and diagnosed by the caller's refExists check, which can name
  // the ref the step actually asked for.
  private fetchPrHead(cwd: string, prNumber: string): Promise<void> {
    const key = `${cwd}\0${prNumber}`;
    const inflight = this.prFetches.get(key);
    if (inflight) return inflight;
    const p = this.runGitFetch(cwd, [
      '--quiet', '--force', 'origin', `refs/pull/${prNumber}/head:refs/outpost/pr-${prNumber}`,
    ])
      .catch(() => { /* offline / no origin */ })
      .finally(() => { this.prFetches.delete(key); });
    this.prFetches.set(key, p);
    return p;
  }
}

// `--` so a ref name that somehow reached here leading-dash-first can't be read as a flag;
// OUTPOST_PR_REF_RE is the first layer, same discipline as the branch/session regexes.
function deleteRef(cwd: string, ref: string): void {
  try {
    execFileSync('git', ['-C', cwd, 'update-ref', '-d', '--', ref], { stdio: 'pipe' });
  } catch { /* already gone */ }
}

// "owner/repo" out of any spelling git records for a GitHub remote, else null (a local-path
// or non-GitHub origin can't be cross-checked, so it isn't treated as a mismatch).
export function repoFromRemoteUrl(url: string): string | null {
  const m = url.trim().match(
    /^(?:(?:https?|ssh|git\+ssh|git):\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

async function assertOriginRepo(cwd: string, expectRepo: string): Promise<void> {
  let actual: string | null = null;
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    actual = repoFromRemoteUrl(stdout);
  } catch { return; }
  if (!actual) return;
  if (actual.toLowerCase() === expectRepo.toLowerCase()) return;
  throw new Error(
    `repoCwd ${cwd} has origin ${actual}, but this step's work belongs to ${expectRepo}`,
  );
}

export type DiffMode = 'branch' | 'worktree';

// The ref the branch was actually cut from. Records written before baseRef existed fall back to
// baseBranch, which is what they were branched from anyway.
export function diffBaseFor(rec: Pick<WorktreeRecord, 'baseRef' | 'baseBranch'>): string {
  if (rec.baseRef && rec.baseRef.length > 0) return rec.baseRef;
  return rec.baseBranch && rec.baseBranch.length > 0 ? rec.baseBranch : 'main';
}

// Argv-only, no shell — branch regex + trailing `--` block argv-flag smuggling on refs/paths.
export function runGitDiff(rec: WorktreeRecord, mode: DiffMode): string {
  if (!rec.worktreePath) throw new Error('cannot diff a tombstoned worktree record');
  const baseBranch = diffBaseFor(rec);
  if (!BRANCH_NAME_RE.test(baseBranch)) throw new Error(`invalid baseBranch: ${JSON.stringify(baseBranch)}`);
  if (!BRANCH_NAME_RE.test(rec.branch)) throw new Error(`invalid branch: ${JSON.stringify(rec.branch)}`);

  const args = mode === 'branch'
    ? ['-C', rec.projectCwd, 'diff', '--no-color', '--find-renames', '-U3', `${baseBranch}...${rec.branch}`, '--']
    : ['-C', rec.worktreePath, 'diff', '--no-color', '--find-renames', '-U3', 'HEAD', '--'];

  const buf = execFileSync('git', args, { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
  return buf.toString('utf8');
}

export interface CwdDiffResult {
  text: string;
  baseRef: string;
  headRef: string;
  // Signals the diff endpoint to hide the branch/worktree toggle (branch-vs-base would be empty).
  onBaseBranch: boolean;
}

// Diff for sessions launched directly in the user's repo (no outpost worktree record); resolves branch + base at call time.
export function runGitDiffInCwd(cwd: string, mode: DiffMode): CwdDiffResult {
  const currentBranch = readCurrentBranch(cwd);
  const baseBranch = resolveBaseBranch(cwd);
  const onBaseBranch = !!currentBranch && currentBranch === baseBranch;

  if (mode === 'worktree') {
    const buf = execFileSync(
      'git',
      ['-C', cwd, 'diff', '--no-color', '--find-renames', '-U3', 'HEAD', '--'],
      { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
    );
    return { text: buf.toString('utf8'), baseRef: 'HEAD', headRef: 'WORKTREE', onBaseBranch };
  }

  if (!currentBranch || onBaseBranch) {
    return { text: '', baseRef: baseBranch, headRef: currentBranch ?? '', onBaseBranch: true };
  }
  if (!BRANCH_NAME_RE.test(currentBranch)) throw new Error(`invalid branch: ${JSON.stringify(currentBranch)}`);
  if (!BRANCH_NAME_RE.test(baseBranch)) throw new Error(`invalid baseBranch: ${JSON.stringify(baseBranch)}`);
  const buf = execFileSync(
    'git',
    ['-C', cwd, 'diff', '--no-color', '--find-renames', '-U3', `${baseBranch}...${currentBranch}`, '--'],
    { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
  );
  return { text: buf.toString('utf8'), baseRef: baseBranch, headRef: currentBranch, onBaseBranch: false };
}

function readCurrentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out && out !== 'HEAD' ? out : null; // 'HEAD' == detached

  } catch { return null; }
}

// Local object-db lookups, but on the same provision path as the fetches above — kept async so
// nothing on it re-blocks the event loop.
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileP('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch { return false; }
}

async function isAncestor(cwd: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileP('git', ['-C', cwd, 'merge-base', '--is-ancestor', maybeAncestor, descendant]);
    return true;
  } catch { return false; }
}

// 0 on any failure: a drift number we couldn't measure must not read as "wildly stale".
async function countCommits(cwd: string, range: string): Promise<number> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'rev-list', '--count', range, '--']);
    const n = Number.parseInt(stdout.toString().trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'merge-base', a, b]);
    const sha = stdout.toString().trim();
    // Must satisfy BRANCH_NAME_RE downstream (it lands in baseRef, which git-ops re-validates).
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

function resolveBaseBranch(cwd: string): string {
  for (const ref of ['main', 'master']) {
    try {
      execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return ref;
    } catch { /* not present */ }
  }
  return 'main';
}

// Allowlist (not deny-list) of gitignored files copied into a fresh worktree, to avoid dragging in node_modules/build dirs.
function isAllowlisted(rel: string): boolean {
  if (rel === 'CLAUDE.md' || rel === 'CLAUDE.local.md') return true;
  if (rel === '.claude' || rel.startsWith('.claude/')) return true;
  if (rel === 'docs' || rel.startsWith('docs/')) return true;
  if (/^\.env(\.[^/]+)?$/.test(rel)) return true; // root .env* only, not nested
  return false;
}

function copyAllowlistedIgnored(projectCwd: string, worktreePath: string): void {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['-C', projectCwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return;
  }
  for (const raw of output.split('\0')) {
    if (!raw) continue;
    // `--directory` appends a trailing slash for entirely-ignored dirs; strip for allowlist match.
    const rel = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!isAllowlisted(rel)) continue;
    const src = join(projectCwd, rel);
    const dst = join(worktreePath, rel);
    if (!existsSync(src)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
    } catch { /* best-effort — a missing file or perm error shouldn't fail worktree creation */ }
  }
}

// Returns the checkout path for `branch` if any worktree of `projectCwd` has it, else null.
// Detached checkouts (no branch line) are skipped.
function findWorktreeForBranch(projectCwd: string, branch: string): string | null {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['-C', projectCwd, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch { return null; }
  const target = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
    else if (line === '') currentPath = null;
    else if (line.startsWith('branch ') && line.slice('branch '.length) === target && currentPath) {
      return currentPath;
    }
  }
  return null;
}

// True if `path` matches `projectCwd`'s primary working tree. Uses realpathSync-like
// resolution via git itself (show-toplevel returns the canonical primary path).
function isPrimaryWorktree(projectCwd: string, path: string): boolean {
  try {
    const primary = execFileSync('git', ['-C', projectCwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!primary) return false;
    return samePath(primary, path);
  } catch { return false; }
}

// Path-prefix check that treats `${prefix}/foo` as inside `prefix` but `${prefix}foo` as outside.
// Uses realpath for both sides to survive symlink differences (macOS `/tmp` → `/private/tmp`).
function isUnder(path: string, prefix: string): boolean {
  try {
    const p = realpathSync(path);
    const pref = realpathSync(prefix);
    if (p === pref) return true;
    return p.startsWith(pref.endsWith('/') ? pref : `${pref}/`);
  } catch {
    if (path === prefix) return true;
    return path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  }
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

function isCleanCheckout(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === '';
  } catch { return false; }
}

function doesBranchExist(projectCwd: string, branch: string): boolean {
  try {
    execFileSync(
      'git',
      ['-C', projectCwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch { return false; }
}

// Parse "gitdir: /repo/.git/worktrees/<id>" to recover the parent repo's working dir.
function readParentRepoFromGitFile(worktreePath: string): string | null {
  try {
    const contents = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    const m = contents.match(/^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/]+\/?$/);
    return m ? m[1]! : null;
  } catch { return null; }
}
