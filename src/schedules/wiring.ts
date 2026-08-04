import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { WorkEngine } from '../work/engine.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ProjectRegistry } from '../storage/project-registry.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import { isKnownCwd, homeOrKnownCwd } from '../git/known-cwd.js';
import type { GuardProviders, UsageSnapshotLike } from './guards.js';
import type { RoutingDeps } from './routing.js';
import type { SchedulerInlineDeps, SchedulerSpawnDeps } from './scheduler.js';
import type { What } from './types.js';
import { runScript } from './script-runner.js';
import type { NativeHandlerRegistry } from './native-handlers.js';

// Daemon-specific implementations of the dependency-injection interfaces schedules/*.ts
// define, kept out of daemon.ts per the "keep wiring thin" rule — daemon.ts just calls
// these factories with its already-constructed engine/sessionManager/env.

const execFileP = promisify(execFile);

export function createGuardProviders(
  getUsageSnapshot: () => UsageSnapshotLike | undefined,
  projectRegistry: ProjectRegistry,
  worktreeManager: WorktreeManager,
): GuardProviders {
  return {
    getUsageSnapshot,
    getRepoLastChange: async (repo) => {
      // Only ever shell out against a path the daemon already knows about — a schedule's
      // `repos` entry is unvalidated user input all the way from POST /api/schedules, so an
      // unknown/nonexistent path must fail closed here rather than reach `git -C <repo>`.
      if (!repo || !existsSync(repo) || !isKnownCwd(repo, projectRegistry, worktreeManager)) return null;
      try {
        // A dirty tree counts as "changed" even without a commit; we don't have a precise
        // per-file mtime story, so approximate with now() rather than under-reporting.
        const { stdout: dirty } = await execFileP('git', ['-C', repo, 'status', '--porcelain'], { timeout: 10_000 });
        if (dirty.trim()) return Date.now();
        const { stdout } = await execFileP('git', ['-C', repo, 'log', '-1', '--format=%ct'], { timeout: 10_000 });
        const sec = Number(stdout.trim());
        return Number.isFinite(sec) ? sec * 1000 : null;
      } catch {
        return null; // not a git repo, no commits yet, or repo path gone — fail open upstream
      }
    },
  };
}

// Only ever dispatch a job into a path the daemon already knows about — a schedule's `cwd` is
// unvalidated user input all the way from POST /api/schedules, so an unknown/nonexistent path
// must fail closed here rather than let the orchestrator worktree the daemon's own checkout.
function assertKnownCwd(cwd: string, projectRegistry: ProjectRegistry, worktreeManager: WorktreeManager): void {
  if (!cwd) throw new Error('Scheduled job has no working directory configured');
  if (!existsSync(cwd) || !isKnownCwd(cwd, projectRegistry, worktreeManager)) {
    throw new Error(`Scheduled job working directory is not a registered project or known worktree: ${cwd}`);
  }
}

// `createJob` has no first-class skill/prompt/cwd fields — the orchestrator picks the plan shape
// from title+description alone, so the `what` is folded into the description. Prompt/script jobs
// carry a trailing `cwd:`/`model:` block (the same convention manual "promote to tracked" jobs
// use) so the orchestrator worktrees against the right repo.
function describeJob(what: What, projectRegistry: ProjectRegistry, worktreeManager: WorktreeManager): string {
  if (what.kind === 'skill') {
    return [
      `Scheduled run of skill ${what.skill}.`,
      what.scope ? `Scope: ${what.scope}` : null,
      what.repos?.length ? `Repos: ${what.repos.join(', ')}` : null,
      what.args ? `Args: ${JSON.stringify(what.args)}` : null,
    ].filter(Boolean).join('\n');
  }
  // Native schedules run an in-daemon handler directly — never dispatched as a job.
  if (what.kind === 'native') throw new Error(`Native schedule "${what.handler}" cannot be dispatched as a job`);
  assertKnownCwd(what.cwd, projectRegistry, worktreeManager);
  const meta = ['', '---', `cwd: ${what.cwd}`, `model: ${what.model || 'default'}`];
  if (what.kind === 'prompt') {
    return [what.prompt, ...meta].join('\n');
  }
  return [
    'Run the following script and report the result:',
    '',
    '```bash',
    what.script,
    '```',
    what.args ? `\nArgs: ${JSON.stringify(what.args)}` : null,
    ...meta,
  ].filter((l) => l !== null).join('\n');
}

export function createSpawnDeps(
  engine: WorkEngine,
  sessionManager: SessionManager,
  projectRegistry: ProjectRegistry,
  worktreeManager: WorktreeManager,
): SchedulerSpawnDeps {
  return {
    createJob: (input) => {
      const job = engine.createJob({
        source: 'manual',
        title: input.title,
        description: describeJob(input.what, projectRegistry, worktreeManager),
        autoPlan: true,
      });
      return { jobId: job.id };
    },
    spawnSkillSession: (input) => {
      // Unlike createJob (routed through the orchestrator's own worktree-isolated path), this
      // spawns a session directly with `repos[0]` as cwd — never fall back to process.cwd()
      // (the daemon's own source checkout when launchd-started) and never spawn into a path
      // the daemon doesn't already recognize as a registered project or worktree.
      const repo = input.repos?.[0];
      if (!repo) {
        throw new Error(`Scheduled skill "${input.skill}" has no repo configured — refusing to run in the daemon's own working directory`);
      }
      if (!existsSync(repo) || !isKnownCwd(repo, projectRegistry, worktreeManager)) {
        throw new Error(`Scheduled skill "${input.skill}" repo is not a registered project or known worktree: ${repo}`);
      }
      const sessionId = randomUUID();
      sessionManager.spawnDetached(sessionId, repo, {}, 'default');
      const argsSuffix = input.args ? ` ${JSON.stringify(input.args)}` : '';
      sessionManager.send(sessionId, {
        type: 'user',
        message: { role: 'user', content: `/${input.skill}${argsSuffix}` },
      });
      return { sessionId };
    },
  };
}

// script/native schedules never go through the orchestrator — `runScript` shells out directly
// and `runNative` invokes the daemon-registered handler fn, both driving `fire()`'s run straight
// to a terminal outcome instead of leaving it `running` for a job/session to finish later.
export function createInlineDeps(
  scriptEnv: () => Record<string, string>,
  nativeHandlers: NativeHandlerRegistry,
  projectRegistry: ProjectRegistry,
  worktreeManager: WorktreeManager,
): SchedulerInlineDeps {
  return {
    runScript: async (what, opts) => {
      // A builtin script schedule is daemon-seeded and trusted (its `cwd` is the daemon's own
      // home dir, not a registered project); a user script schedule may run in home OR a known
      // cwd — a direct script is never worktreed, so it doesn't need to resolve to a project.
      // Shares homeOrKnownCwd with the /test preflight so the two gates can't drift.
      if (!opts.builtin && !homeOrKnownCwd(what.cwd, projectRegistry, worktreeManager)) {
        throw new Error(`Scheduled script working directory is not your home directory, a registered project, or a known worktree: ${what.cwd}`);
      }
      const r = await runScript({ script: what.script, cwd: what.cwd, env: scriptEnv() });
      return { outcome: r.outcome, verdict: { summary: r.output.slice(-4000) } };
    },
    runNative: async (handler) => {
      const fn = nativeHandlers.get(handler);
      if (!fn) throw new Error(`unknown native handler: ${handler}`);
      return fn();
    },
  };
}

// `repo` is treated the same as elsewhere in the schedules data model: a local checkout path
// (matches getRepoLastChange above), not an "owner/repo" slug — `gh` infers the target repo
// from cwd's git remote. There's no existing "post a standalone finding" gh call in this repo
// to reuse, so this opens a new issue; posting to a specific open PR isn't well-defined for an
// arbitrary scheduled finding.
export function createRoutingDeps(
  getSlackWebhook: () => string | undefined,
  projectRegistry: ProjectRegistry,
  worktreeManager: WorktreeManager,
): RoutingDeps {
  return {
    getSlackWebhook,
    postGithubComment: async ({ repo, body }) => {
      if (!existsSync(repo) || !isKnownCwd(repo, projectRegistry, worktreeManager)) {
        throw new Error(`Repo is not a registered project or known worktree: ${repo}`);
      }
      const { stdout } = await execFileP(
        'gh', ['issue', 'create', '--title', 'Outpost scheduled finding', '--body', body],
        { cwd: repo, timeout: 20_000 },
      );
      const url = stdout.trim().split('\n').filter(Boolean).pop();
      return { url };
    },
  };
}
