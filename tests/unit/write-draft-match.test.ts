import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractFileReferences, hashFileContents, matchPinnedCall, normalizeBash, parseDraftCalls,
  tokenize, verifyFileDigests,
} from '../../src/work/write-draft.js';
import type { WriteDraft } from '../../src/work/write-draft.js';

function draft(calls: WriteDraft['calls']): WriteDraft {
  return {
    id: 'd1', action: 'code.fix-ci', raisedBy: { kind: 'step' },
    summary: 's', calls, requestedAt: 1000, approvedAt: 1001,
  };
}

describe('matchPinnedCall — bash', () => {
  it('matches an identical command, ignoring only surrounding whitespace', () => {
    const d = draft([{ id: 'c1', bash: 'git push origin fix-ci' }]);
    expect(matchPinnedCall(d, 'Bash', { command: '  git push origin fix-ci  ' })?.id).toBe('c1');
  });

  it('does not match when internal whitespace differs', () => {
    const d = draft([{ id: 'c1', bash: 'gh pr create --body "line one\nline two"' }]);
    expect(matchPinnedCall(d, 'Bash', { command: 'gh pr create --body "line one line two"' })).toBeUndefined();
  });

  it('does not match when a flag differs', () => {
    const d = draft([{ id: 'c1', bash: 'gh pr merge 12 --squash' }]);
    expect(matchPinnedCall(d, 'Bash', { command: 'gh pr merge 12 --rebase' })).toBeUndefined();
  });

  it('does not match an already-consumed call', () => {
    const d = draft([{ id: 'c1', bash: 'git push origin main', consumedAt: 2000 }]);
    expect(matchPinnedCall(d, 'Bash', { command: 'git push origin main' })).toBeUndefined();
  });

  it('returns the first unconsumed call when two pins are identical', () => {
    const d = draft([
      { id: 'c1', bash: 'git push origin b', consumedAt: 2000 },
      { id: 'c2', bash: 'git push origin b' },
    ]);
    expect(matchPinnedCall(d, 'Bash', { command: 'git push origin b' })?.id).toBe('c2');
  });

  it('does not match an unapproved draft', () => {
    const d = { ...draft([{ id: 'c1', bash: 'git push origin b' }]), approvedAt: undefined };
    expect(matchPinnedCall(d, 'Bash', { command: 'git push origin b' })).toBeUndefined();
  });
});

describe('matchPinnedCall — mcp', () => {
  const args = { teamId: 'T1', title: 'Bug', description: 'body' };

  it('matches on tool name plus deep-equal args regardless of key order', () => {
    const d = draft([{ id: 'c1', tool: { name: 'mcp__linear__save_issue', args } }]);
    const reordered = { description: 'body', title: 'Bug', teamId: 'T1' };
    expect(matchPinnedCall(d, 'mcp__linear__save_issue', reordered)?.id).toBe('c1');
  });

  it('does not match when a value differs', () => {
    const d = draft([{ id: 'c1', tool: { name: 'mcp__linear__save_issue', args } }]);
    expect(matchPinnedCall(d, 'mcp__linear__save_issue', { ...args, title: 'Other' })).toBeUndefined();
  });

  it('does not match when the call carries an extra key', () => {
    const d = draft([{ id: 'c1', tool: { name: 'mcp__linear__save_issue', args } }]);
    expect(matchPinnedCall(d, 'mcp__linear__save_issue', { ...args, priority: 2 })).toBeUndefined();
  });

  it('does not match a different tool with identical args', () => {
    const d = draft([{ id: 'c1', tool: { name: 'mcp__linear__save_issue', args } }]);
    expect(matchPinnedCall(d, 'mcp__linear__save_comment', args)).toBeUndefined();
  });
});

describe('normalizeBash', () => {
  it('trims outer whitespace only', () => {
    expect(normalizeBash('  git push origin b ')).toBe('git push origin b');
  });

  it('preserves internal whitespace so a reformatted payload is not an approved match', () => {
    expect(normalizeBash('git push   origin b')).not.toBe(normalizeBash('git push origin b'));
  });
});

// The submit_write_draft MCP boundary: the tool's inputSchema is advisory, nothing enforces it
// before this runs, so a session-controlled payload has to be rejected outright rather than
// coerced into something harmless-looking.
describe('parseDraftCalls', () => {
  it('rejects a non-array', () => {
    expect(parseDraftCalls(undefined)).toBeUndefined();
    expect(parseDraftCalls('not an array')).toBeUndefined();
  });

  it('rejects an empty array — would park the step with no way for Approve to ever fire', () => {
    expect(parseDraftCalls([])).toBeUndefined();
  });

  it('rejects an element with neither bash nor tool — a pin that authorizes nothing', () => {
    expect(parseDraftCalls([{ label: 'do the thing' }])).toBeUndefined();
  });

  it('rejects an element with BOTH bash and tool — one pin, two payloads, only one ever rendered for approval', () => {
    expect(parseDraftCalls([{
      bash: 'git push origin fix', tool: { name: 'mcp__linear__save_comment', args: { body: 'x' } },
    }])).toBeUndefined();
  });

  it('rejects a tool call missing a string name or an object args', () => {
    expect(parseDraftCalls([{ tool: { args: {} } }])).toBeUndefined();
    expect(parseDraftCalls([{ tool: { name: 'save_comment', args: 'not an object' } }])).toBeUndefined();
  });

  // A blank bash/tool-name is typewise valid but can never match a real call
  // (matchPinnedCall compares against an actual command/tool name) — same dead-end class as
  // rejecting `calls: []`, just spelled as a single unmatchable element instead of an empty list.
  it('rejects an empty or whitespace-only bash string', () => {
    expect(parseDraftCalls([{ bash: '' }])).toBeUndefined();
    expect(parseDraftCalls([{ bash: '   ' }])).toBeUndefined();
  });

  it('rejects an empty or whitespace-only tool name', () => {
    expect(parseDraftCalls([{ tool: { name: '', args: {} } }])).toBeUndefined();
    expect(parseDraftCalls([{ tool: { name: '   ', args: {} } }])).toBeUndefined();
  });

  it('accepts a well-formed mix of bash and tool calls, minting ids and dropping unknown fields', () => {
    const calls = parseDraftCalls([
      { label: 'push', bash: 'git push origin fix' },
      { tool: { name: 'mcp__linear__save_comment', args: { body: 'x' } } },
    ]);
    expect(calls).toEqual([
      { id: 'c1', label: 'push', bash: 'git push origin fix' },
      { id: 'c2', tool: { name: 'mcp__linear__save_comment', args: { body: 'x' } } },
    ]);
  });

  it('never lets a session-supplied id/consumedAt survive into the minted pin', () => {
    const calls = parseDraftCalls([
      { id: 'not-mine', bash: 'echo hi', consumedAt: 999, consumedToolUseId: 'tu-x', releasedAfterFailure: true },
    ]);
    expect(calls).toEqual([{ id: 'c1', bash: 'echo hi' }]);
  });
});

// `files` lets the payload the pin will hash be edited INLINE in the approval card instead of
// only ever being read off whatever the session already wrote to /tmp itself. Every key here is
// a path acceptDraft will later WRITE to (see write-draft-runner.ts) — a session-controlled key
// that slipped past validation would be an arbitrary-file-write primitive, so this has to fail
// closed exactly like extractFileReferences does, not coerce or drop the bad entry.
describe('parseDraftCalls — files', () => {
  const bash = 'gh api --method POST repos/o/r/pulls/1/reviews --input /tmp/review.json';

  it('accepts a files entry keyed to a path the same call\'s bash actually references', () => {
    const calls = parseDraftCalls([{ bash, files: { '/tmp/review.json': '{"body":"ok"}' } }]);
    expect(calls).toEqual([{ id: 'c1', bash, files: { '/tmp/review.json': '{"body":"ok"}' } }]);
  });

  it('rejects a files key the command does not reference', () => {
    expect(parseDraftCalls([{ bash, files: { '/tmp/unrelated.json': 'x' } }])).toBeUndefined();
  });

  it('rejects a files key outside /tmp, even when the command does reference it', () => {
    expect(parseDraftCalls([{
      bash: 'gh api --method POST x --input /etc/passwd',
      files: { '/etc/passwd': 'x' },
    }])).toBeUndefined();
  });

  it('rejects a files key with a .. segment, even when the command does reference it', () => {
    expect(parseDraftCalls([{
      bash: 'gh api --method POST x --input /tmp/../etc/passwd',
      files: { '/tmp/../etc/passwd': 'x' },
    }])).toBeUndefined();
  });

  it('rejects a non-string files value', () => {
    expect(parseDraftCalls([{ bash, files: { '/tmp/review.json': 123 } }])).toBeUndefined();
  });

  it('rejects files on a tool call — there is no bash command for a key to be "referenced" by', () => {
    expect(parseDraftCalls([{
      tool: { name: 'mcp__x__y', args: {} }, files: { '/tmp/review.json': 'x' },
    }])).toBeUndefined();
  });

  it('rejects files alongside a bash the daemon cannot confidently parse', () => {
    expect(parseDraftCalls([{
      bash: 'gh api --method POST x --input $FILE', files: { '/tmp/review.json': 'x' },
    }])).toBeUndefined();
  });
});

// A pin covers command TEXT — `--input /tmp/x.json` matches whether or not /tmp/x.json still
// holds the content the user approved. extractFileReferences is the boundary that decides
// which paths get content-hashed at accept and re-verified at execution; it is a security
// surface, so ambiguity has to fail closed (null), never silently skip a flag it can't parse.
describe('extractFileReferences', () => {
  it('extracts a space-separated, unquoted path', () => {
    expect(extractFileReferences('gh api --method POST x --input /tmp/x.json')).toEqual(['/tmp/x.json']);
  });

  it('extracts a space-separated, double-quoted path', () => {
    expect(extractFileReferences('gh pr merge 1 --squash --body-file "/tmp/a file.txt"')).toEqual(['/tmp/a file.txt']);
  });

  it('extracts an =-separated, unquoted path', () => {
    expect(extractFileReferences('gh release create v1 --notes-file=/tmp/notes.md')).toEqual(['/tmp/notes.md']);
  });

  it('extracts an =-separated, single-quoted path', () => {
    expect(extractFileReferences("gh api --method POST x --input='/tmp/x.json'")).toEqual(['/tmp/x.json']);
  });

  it('extracts every file referenced in one command', () => {
    expect(extractFileReferences(
      'gh api --method POST a --input /tmp/a.json && gh pr merge 1 --squash --body-file /tmp/b.txt',
    )).toEqual(['/tmp/a.json', '/tmp/b.txt']);
  });

  it('yields an empty array, not a failure, for a command with no file reference', () => {
    expect(extractFileReferences('gh pr merge 12 --squash')).toEqual([]);
  });

  it('does not mistake a longer flag name for one of its own', () => {
    expect(extractFileReferences('gh api --input-extra /tmp/x.json')).toEqual([]);
  });

  it('fails closed on a variable reference — the expanded path is invisible to the daemon', () => {
    expect(extractFileReferences('gh api --method POST x --input $FILE')).toBeNull();
    expect(extractFileReferences('gh api --method POST x --input "$FILE"')).toBeNull();
  });

  it('fails closed on a command substitution', () => {
    expect(extractFileReferences('gh api --method POST x --input `cat pathfile`')).toBeNull();
  });

  it('fails closed on a flag with no attached value at all', () => {
    expect(extractFileReferences('gh api --method POST x --input')).toBeNull();
  });

  // IMPORTANT (post-merge review): raw-text scanning read a flag NAME sitting inside a quoted
  // argument as though it were argv — `code.fix-ci` drafting a commit message that merely
  // MENTIONS one of these flags (this branch's own commits do) made the draft un-approvable,
  // for a reason that had nothing to do with any actual file reference. Scanning tokens (via
  // splitShellClauses + the shared word reader), not the raw string, is what fixes this: the
  // whole quoted string is one word, and that word is not, itself, `--input`.
  it('does not mistake a flag name mentioned inside a quoted argument for a real flag', () => {
    expect(extractFileReferences('git commit -m "handle --input flag"')).toEqual([]);
  });

  it('does not mistake --body-file mentioned inside a quoted argument for a real flag', () => {
    expect(extractFileReferences('git commit -m "document the --body-file escape hatch"')).toEqual([]);
  });

  it('does not mistake --notes-file mentioned inside a quoted argument for a real flag', () => {
    expect(extractFileReferences('git commit -m "explain --notes-file behavior"')).toEqual([]);
  });

  it('a commit message merely mentioning a file-referencing flag makes an approvable draft', () => {
    const calls = parseDraftCalls([{ bash: 'git commit -m "handle --input flag"' }]);
    expect(calls).toEqual([{ id: 'c1', bash: 'git commit -m "handle --input flag"' }]);
  });

  // CRITICAL (post-merge re-review): `readWordAt` returns '' at `(`, `)`, `<`, `>` — a
  // metacharacter it refuses to cross as a word — and `tokenize` used to `break` the whole
  // scan on that instead of skipping past it. That silently truncates everything after the
  // first such character, which for a security check is the DANGEROUS direction: it
  // under-counts real flag occurrences and returns `[]` (no reference found) instead of
  // failing closed, so a file-referencing call could end up with no `fileDigests` recorded at
  // all — freely rewritable between approval and execution. Reachable through the shipped
  // anchored `push` rules via a leading `NAME=$(...)` assignment: `stripLeadingAssignments`
  // peels it before the allowlist ever judges the command, but the literal `(`/`)` characters
  // stay in the same clause text this function scans, ahead of the real `--input` reference.
  it('extracts past a leading NAME=$(...) assignment instead of truncating at the paren', () => {
    expect(extractFileReferences(
      'REVIEW_SHA=$(git rev-parse HEAD) gh api --method POST "repos/{owner}/{repo}/pulls/12/reviews" --input /tmp/outpost-review-12.json',
    )).toEqual(['/tmp/outpost-review-12.json']);
  });

  it('does not truncate the scan at a literal ">" appearing before the flag in the same clause', () => {
    expect(extractFileReferences(
      '> /tmp/out.log gh api --method POST x --input /tmp/x.json',
    )).toEqual(['/tmp/x.json']);
  });

  it('does not truncate the scan at a literal "<" appearing before the flag in the same clause', () => {
    expect(extractFileReferences(
      'gh api --method POST x < /tmp/stdin-source --input /tmp/x.json',
    )).toEqual(['/tmp/x.json']);
  });

  // CRITICAL (second post-merge re-review): splitShellClauses copies a backtick span's raw
  // text into the OUTER clause verbatim (comments and all), without the comment-stripping its
  // own recursive walk applies when that same span becomes its own separate clause. A stray
  // quote hidden in a comment inside the backticks — an apostrophe in the entirely ordinary
  // `# don't touch` — is real, uncommented text from a naive re-scan's point of view: it flips
  // quote tracking on and swallows everything after it, including the real `--input`, into one
  // bogus token. That returns `[]` (no reference found), not `null` — the dangerous direction,
  // since an empty list means no fileDigests get recorded on the pin. `$( )` doesn't share this
  // because `findBalancedParen` (its own span-finder) tracks quotes itself, so the same trick
  // there makes `splitShellClauses` fail closed upstream; `findBacktickEnd` is the one
  // span-finder in the file that doesn't track quotes, which is what makes backtick the unique
  // vector. Fixed by treating a backtick span as one atomic, opaque unit during tokenizing
  // (readTokenAt) rather than walking into its characters — extraction, not a blanket refusal,
  // since the span can be skipped cleanly and the real reference recovered exactly the way the
  // pre-rewrite raw-text scanner already did.
  it('extracts past a backtick span whose comment hides an apostrophe (assignment-prefixed)', () => {
    expect(extractFileReferences(
      'NOTE=`git log -1 --format=%h # don\'t touch` gh api --method POST '
      + '"repos/{owner}/{repo}/pulls/12/reviews" --input /tmp/r.json',
    )).toEqual(['/tmp/r.json']);
  });

  // Second prefix family: the same backtick span as a bare leading word, with no `NAME=`
  // assignment attached — still the same clause as the real flag, still the same desync.
  it('extracts past a backtick span whose comment hides an apostrophe (bare leading word)', () => {
    expect(extractFileReferences(
      '`git log -1 --format=%h # don\'t touch` gh api --method POST '
      + '"repos/{owner}/{repo}/pulls/12/reviews" --input /tmp/r2.json',
    )).toEqual(['/tmp/r2.json']);
  });
});

// Direct test of `readTokenAt`'s item 2 (via the `tokenize` seam it's exported through): a word
// scan that reaches the end of the clause with an open quote must fail closed (`null`), not
// return whatever it managed to accumulate. Under normal operation `splitShellClauses` never
// hands `tokenize` a clause whose own quote tracking disagrees with this — every span-finder
// but `findBacktickEnd` tracks quotes itself, and that vector is closed by skipping the span
// wholesale rather than by this backstop — so this is exercised directly rather than through a
// real bash string that can currently reach it: the whole point of a backstop for "a shape
// this function didn't anticipate" is that it has to hold before such a shape is known to
// exist, not only after.
describe('tokenize — fails closed on an unterminated word', () => {
  it('an unclosed double-quoted word at the end of a clause returns null', () => {
    expect(tokenize('gh api --input "/tmp/unterminated')).toBeNull();
  });

  it('an unclosed single-quoted word at the end of a clause returns null', () => {
    expect(tokenize("gh api --input '/tmp/unterminated")).toBeNull();
  });

  it('a well-formed clause with no dangling quote still tokenizes normally', () => {
    expect(tokenize('gh api --input /tmp/x.json')).toEqual(['gh', 'api', '--input', '/tmp/x.json']);
  });
});

describe('hashFileContents / verifyFileDigests', () => {
  function tempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'write-draft-digest-'));
    const path = join(dir, 'payload.json');
    writeFileSync(path, content);
    return path;
  }

  it('returns undefined for a file that does not exist', async () => {
    expect(await hashFileContents('/tmp/outpost-test-digest-does-not-exist-xyz')).toBeUndefined();
  });

  it('hashes the same content to the same digest', async () => {
    const path = tempFile('{"a":1}');
    expect(await hashFileContents(path)).toBe(await hashFileContents(path));
  });

  it('hashes different content to different digests', async () => {
    const a = tempFile('one');
    const b = tempFile('two');
    expect(await hashFileContents(a)).not.toBe(await hashFileContents(b));
  });

  it('verifyFileDigests passes with no digests to check at all', async () => {
    expect(await verifyFileDigests(undefined)).toBe(true);
  });

  it('verifyFileDigests passes when every recorded file is unchanged', async () => {
    const path = tempFile('original');
    const digest = await hashFileContents(path);
    expect(await verifyFileDigests({ [path]: digest! })).toBe(true);
  });

  it('verifyFileDigests fails when a recorded file has been rewritten', async () => {
    const path = tempFile('original');
    const digest = await hashFileContents(path);
    writeFileSync(path, 'rewritten');
    expect(await verifyFileDigests({ [path]: digest! })).toBe(false);
  });

  it('verifyFileDigests fails when a recorded file has since been deleted', async () => {
    const path = tempFile('original');
    const digest = await hashFileContents(path);
    rmSync(path);
    expect(await verifyFileDigests({ [path]: digest! })).toBe(false);
  });
});
