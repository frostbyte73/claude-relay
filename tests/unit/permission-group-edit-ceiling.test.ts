import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import { validateGroupUpdate } from '../../src/routes/meta.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';
import groupsJson from '../../config/permission-groups.default.json' with { type: 'json' };

const groups = groupsJson as unknown as PermissionGroupMap;

// The final whole-branch review of Ship 5 found that `edit`'s git verb rule — untouched by
// every earlier round of this ship — reopened both holes the ship closed through a different
// door: `git rebase --exec`/`-x` is `node -e` with a different spelling, and `git apply
// --unsafe-paths --directory=` writes anywhere with no interpreter at all. `git -C <path>`
// applied every destructive verb to any repo on the machine, not just the session's own. This
// file is the regression net: it pins the whole DENY list exhaustively, not sampled, because a
// sampled net is exactly what let `git rebase --exec` live through the whole ship undetected.
function editGroupChecker(): AllowlistConfig {
  const merged: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const name of ['core', 'read', 'edit'] as const) {
    const g = groups[name] as AllowlistConfig;
    for (const x of g.alwaysAllow) merged.alwaysAllow.push(x);
    for (const x of g.alwaysAllowBashPatterns) merged.alwaysAllowBashPatterns.push(x);
    for (const x of g.alwaysAllowMcpPatterns) merged.alwaysAllowMcpPatterns.push(x);
    for (const x of g.alwaysAllowPathPatterns ?? []) merged.alwaysAllowPathPatterns!.push(x);
  }
  return merged;
}

const al = new Allowlist(editGroupChecker());
const wt = mkdtempSync(join(tmpdir(), 'edit-ceiling-wt-'));
const allows = (command: string) => al.allows('Bash', { command }, undefined, undefined, wt, undefined);

describe('the edit group git rule is an anchored whitelist, not a verb prefix', () => {
  it('denies every rebase/apply/-C/interpreter/file-op shape the whole-branch review found', () => {
    for (const c of [
      // CRITICAL 1 — git rebase --exec / -x is node -e with a different spelling.
      "git rebase --exec 'touch /x' HEAD~1",
      "git rebase -x 'sh -c evil' HEAD~1",
      // CRITICAL 2 — git apply writes anywhere, with no interpreter. Not enumerated at all —
      // no SKILL.md instructs it.
      'git apply --unsafe-paths --directory=/Users/x p.patch',
      // IMPORTANT 3 — the free -C <path> prefix applied every destructive verb to any repo on
      // the machine. Dropped entirely, so every -C form denies regardless of the verb.
      'git -C /Users/x/other clean -xdf',
      'git -C /Users/x/other reset --hard',
      'git -C /Users/x/other rm -r .',
      // Every git verb dropped for lack of evidence in the four edit-inheriting SKILL.mds.
      'git reset --hard',
      'git reset --hard HEAD~1',
      'git restore --staged .',
      'git cherry-pick abc123',
      'git revert HEAD',
      'git clean -xdf',
      'git switch main',
      'git stash',
      'git stash pop',
      'git mv a b',
      'git rm -r .',
      'git rm --cached a',
      // Direct interpreters — Ship 5 closed these; this file re-pins them from the edit side.
      'node -e "x"',
      'tsx -e "x"',
      'go run ./x',
      'npx cowsay',
      'make build',
      'mage t',
      'python3 -c "x"',
      'docker run -v /:/host alpine sh',
      // Unscoped file ops reaching outside the worktree.
      'cp /wt/a /Users/x/.zshrc',
      'rm -rf /Users/x/Documents',
      'chmod 777 /etc/passwd',
      'touch /Users/x/.zshrc',
      'rmdir /Users/x/d',
    ]) expect(allows(c), c).toBe(false);
  });

  it('allows every git invocation the four edit-inheriting SKILL.mds actually instruct', () => {
    for (const c of [
      // code.implement: worktree-drift resync (Failure modes), a bare ref, no flags.
      'git rebase origin/main',
      // code.implement: reverting an off-target file after self-review (Step 3).
      'git checkout -- src/foo.ts',
      'git checkout -- src/foo.ts src/bar.ts',
      // code.fix-ci: staging the fix before drafting the commit (Step 3).
      'git add -A',
      // code.resolve-conflicts: merging the base branch, and aborting an unresolvable one.
      'git merge origin/main',
      'git merge some-other-branch',
      'git merge --abort',
      // code.resolve-conflicts: staging each resolved file (Step 2).
      'git add path/to/resolved-file.go',
    ]) expect(allows(c), c).toBe(true);
  });

  it('allows the rest of the evidenced build/test long tail unaffected by the git rewrite', () => {
    for (const c of [
      'npm test',
      'npx tsc --noEmit',
      `rm -rf ${wt}/build`,
      'mkdir /tmp/x',
    ]) expect(allows(c), c).toBe(true);
  });

  it('validateGroupUpdate still accepts the rewritten edit group', () => {
    const r = validateGroupUpdate('edit', groups.edit!);
    expect(r.ok === false ? r.error : 'ok').toBe('ok');
  });
});
