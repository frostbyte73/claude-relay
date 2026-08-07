// The second bar every Bash clause clears on top of matching a bash pattern: what a rule
// reads as one operand must actually reach the program as one operand, and the argv it
// forms must not carry an exec or a write the rule never described. Pure text analysis —
// it knows nothing about rules or scopes, because the weakness is in the command, not in
// whichever scope granted it: an action's own anchored `allowlist.json` rule leaks flags
// through `$X` exactly like a group's does.

import { matchRedirect, readWordAt, skipDoubleQuoted, splitShellClauses, stripLeadingAssignments } from './shell-split.js';

// True when the clause expands something outside quotes. Bash word-splits the value of an
// unquoted expansion, so `curl $X https://…` with `X='-o /etc/cron.d/pwn'` set by an earlier
// clause of the SAME Bash call reaches curl as two extra argv words — arbitrary flag
// injection into any allowlisted program, out of command text every anchored pattern reads
// as one harmless operand. `"$VAR"` passes exactly one word and is left alone; it can still
// carry a single `--flag=value`, which is why the anchored rules also refuse a leading `-`.
function hasUnquotedExpansion(clause: string): boolean {
  let i = 0;
  while (i < clause.length) {
    const c = clause[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = clause.indexOf("'", i + 1); i = e < 0 ? clause.length : e + 1; continue; }
    if (c === '"') { i = skipDoubleQuoted(clause, i); continue; }
    if (c === '`') return true;
    if (c === '$' && /[A-Za-z_{(@*]/.test(clause[i + 1] ?? '')) return true;
    i++;
  }
  return false;
}

// Dequoted argv words for a clause, with the leading assignments and the redirections taken
// out. Approximate — an expansion survives as its literal text — but exact enough for flag
// matching, which is the whole point: `find . -delete`, `find . '-delete'`, `find . "-delete"`
// and `find . -de""lete` reach argv as one flag that a regex blocklist reads as four strings.
function clauseArgv(clause: string): string[] {
  const body = stripLeadingAssignments(clause);
  const words: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  const flush = () => { if (started) { words.push(cur); cur = ''; started = false; } };
  while (i < body.length) {
    const c = body.charAt(i);
    if (c === '\\' && body[i + 1] === '\n') { i += 2; continue; }
    if (/\s/.test(c)) { flush(); i++; continue; }
    const redir = matchRedirect(body, i);
    if (redir) {
      // The fd digits of `2>` were accumulated as a word; they are not an operand.
      if (started && /^\d+$/.test(cur)) { cur = ''; started = false; }
      flush();
      i += redir.len;
      while (i < body.length && (body[i] === ' ' || body[i] === '\t')) i++;
      i += readWordAt(body, i).length;
      continue;
    }
    if (c === '\\' && i + 1 < body.length) { cur += body[i + 1]; started = true; i += 2; continue; }
    if (c === "'") {
      const e = body.indexOf("'", i + 1);
      cur += e < 0 ? body.slice(i + 1) : body.slice(i + 1, e);
      started = true; i = e < 0 ? body.length : e + 1; continue;
    }
    if (c === '"') {
      const end = skipDoubleQuoted(body, i);
      cur += body.slice(i + 1, Math.max(i + 1, end - 1)).replace(/\\(.)/g, '$1');
      started = true; i = end; continue;
    }
    cur += c; started = true; i++;
  }
  flush();
  return words;
}

// argv[0] → the words that turn an otherwise read-shaped command into an exec or a write to
// a path nobody granted. `permissions: [read]` is eight actions' entire grant and is
// documented as "local file reads + git-read-only"; without this it was arbitrary code
// execution (`find -exec`, `git fetch --upload-pack`, `git -c core.pager`, `rg --pre`) and
// arbitrary file write (`sort -o`, `find -fprintf`, `git diff --output`, `find -delete`).
const DANGEROUS_FLAGS: Record<string, ReadonlyArray<string>> = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sort: ['-o', '--output', '--compress-program'],
  tree: ['-o', '--output'],
  rg:   ['--pre', '--hostname-bin'],
  git:  ['--output', '--upload-pack', '--receive-pack', '--exec-path', '--open-files-in-pager'],
};
// Programs whose output-file short option clusters (`sort -uo out`, `sort -oout`).
const DANGEROUS_SHORT_O = new Set(['sort', 'tree']);
// Programs whose SECOND file operand is an output file (`uniq in out`, `xxd in out`), mapped
// to the options that consume the word after them so a flag value isn't counted as one.
const SECOND_OPERAND_WRITES: Record<string, ReadonlyArray<string>> = {
  uniq: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars', '--group'],
  xxd:  ['-c', '-g', '-l', '-o', '-s'],
};
// git options that consume the following word, so the scan for the subcommand skips their value.
const GIT_LEVEL_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
// `git branch` is in the read group for `--list`; these are its delete/rename/copy half.
const GIT_BRANCH_WRITES = new Set([
  '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream', '--edit-description',
]);

function argvIsDangerous(argv: string[]): boolean {
  const prog = argv[0]?.split('/').pop() ?? '';
  const rest = argv.slice(1);
  const flags = DANGEROUS_FLAGS[prog];
  if (flags && rest.some((w) => flags.some((f) => w === f || w.startsWith(`${f}=`)))) return true;
  if (DANGEROUS_SHORT_O.has(prog) && rest.some((w) => /^-[A-Za-z]*o/.test(w))) return true;
  const valueOpts = SECOND_OPERAND_WRITES[prog];
  if (valueOpts) {
    let operands = 0;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (w.startsWith('-') && w.length > 1) { if (valueOpts.includes(w)) i++; continue; }
      operands++;
    }
    if (operands > 1) return true;
  }
  return prog === 'git' && gitArgvIsDangerous(rest);
}

// `-c` is only a git-level option before the subcommand, where it sets any config key for the
// run — core.pager, diff.external and core.sshCommand are all "run this program". After the
// subcommand it means something harmless (`git commit -c HEAD`), so the scan stops there.
function gitArgvIsDangerous(rest: string[]): boolean {
  let i = 0;
  for (; i < rest.length; i++) {
    const w = rest[i]!;
    if (!w.startsWith('-')) break;
    if (w === '-c' || w === '--config-env' || w.startsWith('--config-env=')) return true;
    if (GIT_LEVEL_VALUE_OPTS.has(w)) i++;
  }
  const sub = rest[i];
  const args = rest.slice(i + 1);
  if (sub === 'grep' && args.some((w) => /^-[A-Za-z]*O/.test(w))) return true;
  if (sub === 'branch' && args.some((w) => GIT_BRANCH_WRITES.has(w) || /^-[A-Za-z]*[dDmMcC]/.test(w))) return true;
  return false;
}

export function clausesShellSafe(cmd: string): boolean {
  return unsafeClauseReason(cmd) === null;
}

// The same verdict with the reason kept, for telling the user why no grant would help.
// Short enough to render in a pill next to the denied call.
export function unsafeClauseReason(cmd: string): string | null {
  const clauses = splitShellClauses(cmd);
  if (clauses === null) return 'the command does not parse';
  for (const c of clauses) {
    if (hasUnquotedExpansion(stripLeadingAssignments(c.text))) return 'an unquoted expansion in the command';
    if (argvIsDangerous(clauseArgv(c.text))) return 'an exec-or-write flag in the argv';
  }
  return null;
}
