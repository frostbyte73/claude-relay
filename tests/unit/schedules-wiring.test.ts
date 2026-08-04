import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { homeOrKnownCwd } from '../../src/git/known-cwd.js';
import { createInlineDeps } from '../../src/schedules/wiring.js';
import type { ProjectRegistry } from '../../src/storage/project-registry.js';
import type { WorktreeManager } from '../../src/git/worktree-manager.js';
import type { NativeHandlerRegistry } from '../../src/schedules/native-handlers.js';

// An empty registry + worktree list — so isKnownCwd() is always false and the only
// thing that can admit home is the home branch of homeOrKnownCwd.
const emptyRegistry = { list: () => [] } as unknown as ProjectRegistry;
const emptyWorktrees = { list: () => [] } as unknown as WorktreeManager;
const noNativeHandlers = { get: () => undefined } as unknown as NativeHandlerRegistry;

function inlineDeps() {
  return createInlineDeps(() => ({}), noNativeHandlers, emptyRegistry, emptyWorktrees);
}

describe('homeOrKnownCwd', () => {
  it('admits the home directory even when it is neither a project nor a worktree', () => {
    expect(homeOrKnownCwd(homedir(), emptyRegistry, emptyWorktrees)).toBe(true);
  });

  it('rejects a path that is neither home nor a known cwd', () => {
    expect(homeOrKnownCwd('/nope/not/a/known/path', emptyRegistry, emptyWorktrees)).toBe(false);
  });
});

describe('createInlineDeps.runScript', () => {
  it('runs a non-builtin script whose cwd is home (the real gate now matches /test)', async () => {
    // With no registered project or worktree, only the home branch lets this through —
    // proving a home-cwd script no longer throws the known-cwd error on a real cron fire.
    const { runScript } = inlineDeps();
    const r = await runScript!({ kind: 'script', script: 'true', cwd: homedir() }, { builtin: false });
    expect(r.outcome).toBe('ok');
  });

  it('rejects a non-builtin script whose cwd is neither home nor a known cwd', async () => {
    const { runScript } = inlineDeps();
    await expect(
      runScript!({ kind: 'script', script: 'true', cwd: '/nope/not/a/known/path' }, { builtin: false }),
    ).rejects.toThrow(/not your home directory/);
  });
});
