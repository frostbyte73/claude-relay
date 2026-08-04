import { homedir } from 'node:os';
import type { ProjectRegistry } from '../storage/project-registry.js';
import type { WorktreeManager } from './worktree-manager.js';

// Shared gate for any operation that shells out or spawns a session against a caller-supplied
// path (schedules, /api/files, ...): true only if `cwd` is a path the daemon already knows
// about — a registered project or a tracked worktree (current or archived project dir).
export function isKnownCwd(cwd: string, projectRegistry: ProjectRegistry, worktreeManager: WorktreeManager): boolean {
  if (projectRegistry.list().some((p) => p.cwd === cwd)) return true;
  for (const rec of worktreeManager.list()) {
    if (rec.worktreePath === cwd || rec.projectCwd === cwd) return true;
  }
  return false;
}

// Same gate as isKnownCwd, but also admits the user's home directory — the default cwd
// meta.build-schedule recommends for a directly-executed script (which never gets worktreed,
// so it doesn't need to resolve to a project/worktree). Both the /test preflight and the real
// inline-run guard share this so the two can't drift and pass-then-fail a home-cwd script.
export function homeOrKnownCwd(cwd: string, projectRegistry: ProjectRegistry, worktreeManager: WorktreeManager): boolean {
  return cwd === homedir() || isKnownCwd(cwd, projectRegistry, worktreeManager);
}
