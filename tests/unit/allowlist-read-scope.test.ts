import { describe, expect, it } from 'vitest';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import groups from '../../config/permission-groups.default.json' with { type: 'json' };

// The fourth structural bar, and the one that let `core` keep `^cat ` / `^jq ` as two-word
// rules. A bash pattern gates a clause by its leading command, which says nothing about which
// file it opens — so `^cat ` was every file on the machine, granted implicitly to every
// runner:claude action including the four that declare no read group at all. `^jq ` was the
// same reach in a second spelling, which is why narrowing the regex on one of them would have
// been theatre (and why the fix is not a regex).
//
// The exemption is the load-bearing half: a whole-tool `Read` grant is an explicit "read
// anything", exactly like a whole-tool `Bash` grant is for redirections, so this bar skips an
// action that inherits `read` entirely. What's left is precisely the actions that never asked
// to read files.

function group(...names: Array<keyof typeof groups>): Allowlist {
  const merged: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const n of names) {
    const g = groups[n] as AllowlistConfig;
    merged.alwaysAllow.push(...g.alwaysAllow);
    merged.alwaysAllowBashPatterns.push(...g.alwaysAllowBashPatterns);
    merged.alwaysAllowMcpPatterns.push(...g.alwaysAllowMcpPatterns);
    merged.alwaysAllowPathPatterns!.push(...(g.alwaysAllowPathPatterns ?? []));
  }
  return new Allowlist(merged);
}

const coreOnly = (c: string) => group('core').allows('Bash', { command: c });

describe('a core-only action reads its envelope and nothing else', () => {
  it('allows the envelope in every spelling that actually works', () => {
    expect(coreOnly('cat "$OUTPOST_ENVELOPE"')).toBe(true);
    expect(coreOnly('cat "${OUTPOST_ENVELOPE}"')).toBe(true);
    expect(coreOnly('jq -r \'.goal\' "$OUTPOST_ENVELOPE"')).toBe(true);
    expect(coreOnly('jq -c \'[.pr.comments[]? | {id,body}]\' "$OUTPOST_ENVELOPE"')).toBe(true);
    expect(coreOnly('jq -r .pr.number "$OUTPOST_ENVELOPE"')).toBe(true);
  });

  it('allows the pipe shape, where jq reads stdin and names no file', () => {
    expect(coreOnly('cat "$OUTPOST_ENVELOPE" | jq -r \'.goal\'')).toBe(true);
    expect(coreOnly('cat "$OUTPOST_ENVELOPE" | jq \'.pr.comments\'')).toBe(true);
  });

  it('denies every other file, through either command', () => {
    for (const c of [
      'cat /etc/passwd',
      'cat /Users/dc/.ssh/id_rsa',
      'cat /Users/dc/.outpost/.env',
      // The second spelling of the same read. Closing one without the other is theatre.
      'jq . /Users/dc/.ssh/id_rsa',
      'jq -r .foo /Users/dc/.aws/credentials',
      'jq -r \'.x\' /etc/passwd',
    ]) expect(coreOnly(c), c).toBe(false);
  });

  it('denies a second file smuggled in beside the envelope', () => {
    expect(coreOnly('cat "$OUTPOST_ENVELOPE" /etc/passwd')).toBe(false);
    expect(coreOnly('jq -r \'.x\' "$OUTPOST_ENVELOPE" /etc/passwd')).toBe(false);
    // Every clause is checked on its own; a legal read can't chaperone an illegal one.
    expect(coreOnly('cat "$OUTPOST_ENVELOPE" && cat /etc/passwd')).toBe(false);
  });

  it('denies a path it cannot resolve statically', () => {
    // Only the envelope is recognised by spelling — no other variable, and no `~`, since the
    // checker sees command text and never the expansion.
    expect(coreOnly('cat "$SOME_OTHER_VAR"')).toBe(false);
    expect(coreOnly('cat ~/.outpost/projects.json')).toBe(false);
    expect(coreOnly('cat "$OUTPOST_ENVELOPE_BACKUP"')).toBe(false);
  });

  it('treats jq\'s first operand as a filter, not a path', () => {
    // `.pr.number` is not a file — reading it as one would deny every real jq call.
    expect(coreOnly('jq .pr.number')).toBe(true);
    expect(coreOnly('jq -r \'.recentLessons[]? | .text\'')).toBe(true);
  });
});

describe('the bar is skipped for an action that holds a whole-tool Read grant', () => {
  const withRead = (c: string) => group('core', 'read').allows('Bash', { command: c });

  it('leaves a read-inheriting action reading whatever it already could', () => {
    // `read` grants `alwaysAllow: ["Read", ...]` — an explicit "read anything". Gating the bash
    // equivalents under it would deny nothing while breaking every code action.
    for (const c of [
      'cat /Users/dc/frostbyte73/outpost/package.json',
      'cat ~/.outpost/projects.json',
      'jq . /Users/dc/frostbyte73/outpost/package.json',
      'head -50 /Users/dc/some/repo/src/main.go',
    ]) expect(withRead(c), c).toBe(true);
  });
});

describe('the shipped catalog still works under the bar', () => {
  it('covers every cat/jq shape the three core-only actions use', () => {
    // write.linear-comment [push], write.linear-issue [push], write.run-github-workflow
    // [pull, push] — none has a read grant, and none reads anything but the envelope.
    // Verified against their SKILL.md files when this bar was added.
    for (const c of [
      'cat "$OUTPOST_ENVELOPE"',
      'jq -r \'.issueId\' "$OUTPOST_ENVELOPE"',
      'cat "$OUTPOST_ENVELOPE" | jq -r \'.workflow\'',
    ]) {
      expect(group('core', 'pull').allows('Bash', { command: c }), c).toBe(true);
      expect(group('core', 'push').allows('Bash', { command: c }), c).toBe(true);
    }
  });
});
