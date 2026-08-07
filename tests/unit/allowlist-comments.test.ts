import { describe, it, expect } from 'vitest';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { splitShellClauses } from '../../src/permissions/shell-split.js';

const textsOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.text) ?? null;
const targetsOf = (cmd: string) => splitShellClauses(cmd)?.map((c) => c.writeTargets) ?? null;

// The grants a code-shaped action actually carries, so the cases read as "would this SKILL
// line have stalled the step" rather than as an abstract regex exercise.
const a = new Allowlist({
  alwaysAllow: [],
  alwaysAllowBashPatterns: ['^git (log|fetch|status|diff)(\\s|$)', '^cat ', '^ls(\\s|$)', '^echo '],
  alwaysAllowMcpPatterns: [],
});

describe('shell comments — a trailing # is not a command', () => {
  // Verbatim out of actions/code/resolve-conflicts/SKILL.md. The assignment is peeled off,
  // and what was left behind — the comment — matched no bash pattern, so the step died with
  // no approval prompt.
  it('allows the assignment-plus-comment line from resolve-conflicts/SKILL.md', () => {
    const line = 'BASE=origin/main    # override only if boundNote says so';
    expect(textsOf(line)).toEqual(['BASE=origin/main']);
    expect(a.allows('Bash', { command: line })).toBe(true);
  });

  it('drops a comment trailing a real command', () => {
    expect(textsOf('git log --oneline -5 # recent commits')).toEqual(['git log --oneline -5']);
    expect(a.allows('Bash', { command: 'git log --oneline -5 # recent commits' })).toBe(true);
  });

  it('drops a whole-line comment among other lines', () => {
    expect(textsOf('# fetch first\ngit fetch origin')).toEqual(['git fetch origin']);
  });

  it('treats a comment after a separator as a comment', () => {
    expect(textsOf('ls;# note')).toEqual(['ls']);
    expect(textsOf('ls ; # note')).toEqual(['ls']);
  });

  it('keeps an apostrophe in a comment from fail-closing the parse', () => {
    expect(textsOf("git status # don't stage anything")).toEqual(['git status']);
    expect(a.allows('Bash', { command: "git status # don't stage anything" })).toBe(true);
  });

  it('strips a comment inside a command substitution', () => {
    expect(textsOf('cat $(ls -d /tmp # pick the dir\n)')).toEqual(['ls -d /tmp', 'cat $(ls -d /tmp # pick the dir\n)']);
  });

  it('leaves a comment out of the redirection target it precedes', () => {
    expect(targetsOf('ls > /tmp/a # note')).toEqual([['/tmp/a']]);
  });
});

describe('shell comments — a # that is not a comment stays literal', () => {
  it('keeps a mid-word #', () => {
    expect(textsOf('echo a#b')).toEqual(['echo a#b']);
    expect(textsOf('git log --format=%h#%s')).toEqual(['git log --format=%h#%s']);
    expect(textsOf('curl https://x.com/a#frag')).toEqual(['curl https://x.com/a#frag']);
  });

  it('keeps a # that follows a closing quote — same word, not a new one', () => {
    expect(textsOf("echo 'a'#b")).toEqual(["echo 'a'#b"]);
    expect(textsOf('echo "a"#b')).toEqual(['echo "a"#b']);
  });

  it('keeps a # that follows a substitution', () => {
    expect(textsOf('echo $(ls)#b')).toEqual(['ls', 'echo $(ls)#b']);
  });

  it('keeps a quoted #', () => {
    expect(textsOf("echo '# not a comment'")).toEqual(["echo '# not a comment'"]);
    expect(textsOf('echo "# not a comment"')).toEqual(['echo "# not a comment"']);
    expect(textsOf('echo "a # b" c')).toEqual(['echo "a # b" c']);
  });

  it('keeps an escaped #', () => {
    expect(textsOf('echo \\#literal')).toEqual(['echo \\#literal']);
  });

  it('keeps a # inside a redirection target word', () => {
    expect(targetsOf('ls > /tmp/a#b')).toEqual([['/tmp/a#b']]);
    expect(targetsOf('ls > /tmp/a#b # note')).toEqual([['/tmp/a#b']]);
  });

  // `${VAR#prefix}` and `${#arr[@]}` are parameter expansion, not comments — the `#` follows
  // `{` or a name, never a word boundary.
  it('keeps the # of a parameter expansion', () => {
    expect(textsOf('echo ${VAR#refs/heads/}')).toEqual(['echo ${VAR#refs/heads/}']);
    expect(textsOf('echo ${#arr[@]}')).toEqual(['echo ${#arr[@]}']);
    expect(textsOf('echo ${VAR#$(rm -rf /)}')).toEqual(['rm -rf /', 'echo ${VAR#$(rm -rf /)}']);
  });

  it('keeps a # that follows an escaped space — still the same word', () => {
    expect(textsOf('cat arg\\ #notword')).toEqual(['cat arg\\ #notword']);
  });
});

describe('shell comments — the security direction', () => {
  // Seeing less text is only safe because the shell runs less text too. `#` before the `;`
  // means bash never reaches the rm, so allowing the call is correct, not a bypass.
  it('allows a command whose commented-out tail would have been denied', () => {
    expect(textsOf('cat x # ; rm -rf /')).toEqual(['cat x']);
    expect(a.allows('Bash', { command: 'cat x # ; rm -rf /' })).toBe(true);
  });

  // A `\` inside a comment is NOT a line continuation — bash ends the comment at the newline
  // and runs the next line. Swallowing it would hide an executed command.
  it('does not let a comment continue across a newline via a trailing backslash', () => {
    expect(textsOf('cat x # cmt \\\nrm -rf /')).toEqual(['cat x', 'rm -rf /']);
    expect(a.allows('Bash', { command: 'cat x # cmt \\\nrm -rf /' })).toBe(false);
  });

  it('does not let a comment swallow the following line', () => {
    expect(textsOf('cat x # note\nrm -rf /')).toEqual(['cat x', 'rm -rf /']);
    expect(a.allows('Bash', { command: 'cat x # note\nrm -rf /' })).toBe(false);
  });

  // An unquoted heredoc delimiter expands its body, so a `$(…)` on a body line runs even when
  // the line starts with `#` — the `#` is data there, not a comment. The delimiter is chosen
  // to match an allowlisted rule so the terminator line can't be what saves us.
  it('still sees a command substitution hidden behind a # in a heredoc body', () => {
    expect(textsOf('cat <<ls\n# $(rm -rf /)\nls')).toContain('rm -rf /');
    expect(a.allows('Bash', { command: 'cat <<ls\n# $(rm -rf /)\nls' })).toBe(false);
  });

  it('still sees a backtick substitution hidden behind a #', () => {
    expect(textsOf('cat <<ls\n# `rm -rf /`\nls')).toContain('rm -rf /');
    expect(a.allows('Bash', { command: 'cat <<ls\n# `rm -rf /`\nls' })).toBe(false);
  });

  it('fails closed on an unterminated substitution inside a comment', () => {
    expect(textsOf('cat x # $(rm -rf /')).toBeNull();
    expect(textsOf('cat x # `rm -rf /')).toBeNull();
  });

  // bash rejects `ls > #foo` outright (the redirection has no target). The splitter can't
  // report a syntax error, so it must not hand back a clause that looks writable.
  it('denies a redirection whose target was eaten by a comment', () => {
    expect(targetsOf('ls > #foo')).toEqual([['']]);
    expect(a.allows('Bash', { command: 'ls > #foo' })).toBe(false);
  });

  // A command with nothing left to run is still refused rather than waved through: the
  // no-clause case is shared with the empty command, and neither is a call worth granting.
  it('denies a command that is nothing but a comment', () => {
    expect(textsOf('# just a note')).toEqual([]);
    expect(a.allows('Bash', { command: '# just a note' })).toBe(false);
  });

  it('drops a shebang line without dropping the script under it', () => {
    expect(textsOf('#!/bin/bash\nls -la')).toEqual(['ls -la']);
    expect(a.allows('Bash', { command: '#!/bin/bash\nls -la' })).toBe(true);
    expect(a.allows('Bash', { command: '#!/bin/bash\nrm -rf /' })).toBe(false);
  });

  // shell-safety.ts reads the same clause text: an expansion inside a comment is not
  // expanded by bash, so it must not count as the unquoted expansion that bar refuses.
  it('does not count an expansion inside a comment as an unquoted expansion', () => {
    expect(a.allows('Bash', { command: 'git status # $HOME may be stale' })).toBe(true);
    expect(a.allows('Bash', { command: 'git status $HOME' })).toBe(false);
  });
});
