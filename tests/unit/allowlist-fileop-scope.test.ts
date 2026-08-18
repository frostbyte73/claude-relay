import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';

// Build the effective config of an action that inherits the named groups, exactly the way the
// registry does (core is implicit for runner: claude). Reading the shipped defaults rather
// than inlining patterns keeps these cases pinned to what actually ships — same harness as
// allowlist-confinement.test.ts / allowlist-redirect.test.ts.
const GROUPS = JSON.parse(
  readFileSync(join(process.cwd(), 'config/permission-groups.default.json'), 'utf8'),
) as Record<string, AllowlistConfig>;

function forGroups(...names: string[]): Allowlist {
  const cfg: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const g of ['core', ...names]) {
    const src = GROUPS[g]!;
    cfg.alwaysAllow.push(...src.alwaysAllow);
    cfg.alwaysAllowBashPatterns.push(...src.alwaysAllowBashPatterns);
    cfg.alwaysAllowMcpPatterns.push(...src.alwaysAllowMcpPatterns);
    cfg.alwaysAllowPathPatterns!.push(...(src.alwaysAllowPathPatterns ?? []));
  }
  return new Allowlist(cfg);
}

const bash = (a: Allowlist, command: string, worktree?: string) =>
  a.allows('Bash', { command }, undefined, undefined, worktree, undefined);

describe('edit-group file ops are scoped to the session worktree', () => {
  const a = forGroups('edit');
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));

  it('allows an op confined to the worktree', () => {
    expect(bash(a, `rm -rf ${wt}/build`, wt)).toBe(true);
    expect(bash(a, `cp ${wt}/a ${wt}/b`, wt)).toBe(true);
    expect(bash(a, `ln -s ${wt}/a ${wt}/b`, wt)).toBe(true);
  });

  it('denies an op that reaches outside the worktree', () => {
    expect(bash(a, 'rm -rf /Users/x/Documents', wt)).toBe(false);
    expect(bash(a, `cp ${wt}/a /Users/x/.zshrc`, wt)).toBe(false);
    expect(bash(a, `mv ${wt}/a /Users/x/.zshrc`, wt)).toBe(false);
  });

  it('checks every path argument, not just the first — a source out of scope denies too', () => {
    expect(bash(a, `ln -s /etc/passwd ${wt}/x`, wt)).toBe(false);
  });

  it('allows a destination covered by the /tmp/ path rule the group actually grants', () => {
    expect(bash(a, 'mkdir /tmp/x', wt)).toBe(true);
    expect(bash(a, 'mkdir -p /tmp/x/y', wt)).toBe(true);
  });

  it('the /tmp/ carve-out comes from the resolved path rule, not a hardcoded literal', () => {
    // Same bash-pattern grant as `edit` (so the clause still matches), but no
    // `Write:^/tmp/` path rule — the destination must have nothing else to fall back on.
    const editBashOnly = new Allowlist({
      alwaysAllow: [],
      alwaysAllowBashPatterns: GROUPS['edit']!.alwaysAllowBashPatterns,
      alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: [],
    });
    expect(editBashOnly.allows('Bash', { command: 'mkdir /tmp/x' })).toBe(false);
  });

  it("recognises chmod's mode argument as a mode, not a path, but still scopes its target", () => {
    expect(bash(a, `chmod 755 ${wt}/script.sh`, wt)).toBe(true);
    expect(bash(a, `chmod +x ${wt}/script.sh`, wt)).toBe(true);
    expect(bash(a, 'chmod 777 /etc/passwd', wt)).toBe(false);
  });

  it('denies a relative path — the daemon cannot know the shell cwd it resolves against', () => {
    expect(bash(a, 'rm build', wt)).toBe(false);
    expect(bash(a, 'mkdir sub/dir', wt)).toBe(false);
  });

  it('denies an escape normalised away by resolve()', () => {
    expect(bash(a, `rm -rf ${wt}/../../etc`, wt)).toBe(false);
  });

  it('denies a target it cannot resolve statically', () => {
    expect(bash(a, 'rm -rf $TARGET', wt)).toBe(false);
    expect(bash(a, 'rm -rf "$(echo /tmp/x)"', wt)).toBe(false);
    expect(bash(a, 'cp ~/.ssh/id_rsa /tmp/x', wt)).toBe(false);
    expect(bash(a, 'rm -rf /tmp/*.log', wt)).toBe(false);
  });

  it('does not let a --flag=value smuggle a path past the classifier', () => {
    expect(bash(a, `cp --target-directory=/etc ${wt}/file`, wt)).toBe(false);
    expect(bash(a, `cp --target-directory=${wt} ${wt}/file`, wt)).toBe(true);
  });

  it('leaves an unrelated command untouched', () => {
    expect(bash(a, 'npx vitest run', wt)).toBe(true);
  });

  // A bare `<`/`<(` mid-clause used to empty out `readWordAt` and the scanner treated that
  // exactly like reaching the end of the command — silently stopping instead of denying, which
  // let every argument after the redirect through unscoped. These pin the fix: an operand after
  // an input redirect, or one that follows a redirect this scan has to step over first, still
  // gets checked; a process substitution standing in for a path is never trusted at all.
  describe('a redirect or process substitution never truncates the scan', () => {
    it('still checks the operand after an input redirect', () => {
      expect(bash(a, `rm -rf ${wt}/a < /dev/null /Users/x/secret`, wt)).toBe(false);
    });

    it('never trusts a process substitution as a resolvable path', () => {
      expect(bash(a, `cp <(cat /etc/passwd) /Users/x/exfil`, wt)).toBe(false);
    });

    it('an output redirect on an otherwise-scoped clause is still denied (by redirectsAllowed)', () => {
      expect(bash(a, `cp ${wt}/a > /Users/x/out`, wt)).toBe(false);
    });

    it('an fd-prefixed redirect does not get misread as a bogus operand', () => {
      // The "2" in `2>/dev/null` must not be treated as a stray relative-path argument — but
      // the real destination two words later is still out of scope and still denies.
      expect(bash(a, `mv ${wt}/a 2>/dev/null /Users/x/b`, wt)).toBe(false);
    });

    it('a legitimate device-sink redirect does not newly deny an otherwise in-scope clause', () => {
      expect(bash(a, `rm -rf ${wt}/build 2>/dev/null`, wt)).toBe(true);
      expect(bash(a, `rm -rf ${wt}/build > /tmp/log 2>&1`, wt)).toBe(true);
    });
  });

  // POSIX `--` ends option parsing: everything after it is a literal operand, even one that
  // looks like a flag. A classifier that treats "starts with -" as "is a flag" unconditionally
  // would let `-rf` slide right past the relative-path check that denies every other operand.
  describe('-- ends flag parsing, so a disguised relative path still denies', () => {
    it('denies a flag-shaped operand after a bare --', () => {
      expect(bash(a, 'rm -- -rf', wt)).toBe(false);
    });

    it('denies the real out-of-scope target that follows --', () => {
      expect(bash(a, 'rm -rf -- /etc', wt)).toBe(false);
    });
  });
});

describe('a session with no worktree path is unaffected', () => {
  // Mirrors an interactive PWA session: no sessionWorktreePath, no actionName. Nothing here
  // should throw, and the same scoping applies with the worktree branch simply unavailable —
  // a call denied here still falls through to the ordinary interactive approval queue exactly
  // as any other allowlist miss does; this gate does not change that path.
  const a = forGroups('edit');

  it('still allows what a path rule covers', () => {
    expect(a.allows('Bash', { command: 'mkdir /tmp/x' })).toBe(true);
  });

  it('denies what is out of scope, same as any other unscoped destination', () => {
    expect(a.allows('Bash', { command: 'rm -rf /Users/x/Documents' })).toBe(false);
  });

  it('a session-scoped bash grant for the command still needs the destination in scope', () => {
    a.addRule('bash', '^rm(\\s|$)', { session: 's1' });
    expect(a.allows('Bash', { command: 'rm -rf /tmp/x' }, undefined, undefined, undefined, 's1')).toBe(true);
    expect(a.allows('Bash', { command: 'rm -rf /Users/x/Documents' }, undefined, undefined, undefined, 's1')).toBe(false);
  });
});
