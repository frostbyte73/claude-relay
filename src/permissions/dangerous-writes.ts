// What makes an external write dangerous, and — the part worth being explicit about — whether
// that danger is answered by REFUSING the call or by WARNING the human who approves it.
//
// Both halves live here, driven by the same reading of one argv, so the choice between them is
// visible in one place instead of implied by how baroque some regex happens to be.
//
// The split follows from what the write-draft gate already guarantees. Every push-shaped call
// parks for a human pin before it runs, and the approval card shows the exact command text. So
// for anything the user can SEE in that text — `--admin`, `--repo other/org`, a merge, a
// delete — the enumeration in a rule was doing the same job as the card, twice, and losing:
// a denial teaches the model to go hunting for a spelling that gets through, where a warning
// puts the risk in front of the person deciding. Those are `warn`.
//
// `refuse` is reserved for the few where "the user saw it and clicked approve" is not an
// outcome worth allowing at all — a force-push destroys history that no approval restores.
//
// Why an argv denylist here is sound when a REGEX denylist is not (see CLAUDE.md's rule
// against forbidding a flag in a pattern): a regex reads command text, where `-f`, `"-f"`,
// `-f=x` and `-de""lete` are four different strings. `clauseArgv` dequotes and splices them
// back into the single word the program actually receives — the same reason shell-safety.ts's
// DANGEROUS_FLAGS works on argv. The list below is matched against argv words, never text.

import { clauseArgv } from './shell-safety.js';
import { splitShellClauses } from './shell-split.js';

// Three tiers, and the line between them is about what the user can DO about it, not about
// how bad the operation sounds:
//
//   refuse  — there is a correct alternative that does the same job, or the user structurally
//             cannot evaluate the call (a payload the card can't show). Confirming harder does
//             not fix either, so no pin authorises it and `allows()` says no.
//   confirm — legitimately needed sometimes, and the user CAN judge it from the command text,
//             but it must not be reachable by clicking Approve out of habit. Requires an
//             explicit per-finding acknowledgement, checked server-side in acceptDraft against
//             the SUBMITTED command, so editing a force flag in after drafting still trips it.
//   warn    — visible in the text and ordinary judgment applies; say it and move on.
export type WriteRisk = 'refuse' | 'confirm' | 'warn';

export interface WriteFinding {
  risk: WriteRisk;
  // Stable identifier, so the PWA can style a finding without matching on prose.
  code: string;
  // One line, addressed to the person approving the draft.
  message: string;
}

// The binary and subcommand a clause invokes, with the git-level options that take a value
// stepped over so their argument isn't mistaken for the subcommand.
const GIT_LEVEL_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);

function head(argv: string[]): { prog: string; sub: string | undefined; rest: string[] } {
  const prog = argv[0]?.split('/').pop() ?? '';
  let i = 1;
  if (prog === 'git') {
    for (; i < argv.length; i++) {
      const w = argv[i]!;
      if (!w.startsWith('-')) break;
      if (GIT_LEVEL_VALUE_OPTS.has(w)) i++;
    }
  }
  return { prog, sub: argv[i], rest: argv.slice(i + 1) };
}

// A force-push rewrites the remote's history. `--force-with-lease` is not a softer version of
// this for our purposes — it still discards commits, it only refuses when the remote moved in a
// way git happens to notice — and it is named explicitly because "use the safe one" is exactly
// the workaround a denied model reaches for next.
// Short options cluster: `git push -fu origin main` is `-f -u`, a force-push that a `w === '-f'`
// check reads as an unrelated flag. Caught by permission-group-push.test.ts on the first run of
// this list. `f` is unambiguous here — no other `git push` short option uses that letter.
function isForceFlag(w: string): boolean {
  if (w.startsWith('--force')) return true;
  return /^-[A-Za-z0-9]*f/.test(w);
}

const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev']);

// `owner/repo#123` or a full github PR/issue URL as a positional argument — the two ways a `gh`
// write binds to a repository other than the checkout it is running in, without using --repo.
const FOREIGN_TARGET_RE = /^(?:https?:\/\/[^/]*github\.com\/|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#)/;

function ghFindings(sub: string | undefined, rest: string[], argv: string[]): WriteFinding[] {
  const out: WriteFinding[] = [];
  const has = (...names: string[]) => argv.some((w) => names.some((n) => w === n || w.startsWith(`${n}=`)));

  if (has('--admin')) {
    out.push({
      risk: 'confirm',
      code: 'gh-admin',
      message: '`--admin` bypasses branch protection — the checks the repository requires would '
        + 'not have to pass. Confirm only if you are deliberately overriding them, e.g. to land '
        + 'an urgent fix while CI is broken.',
    });
  }
  if (has('--repo', '-R') || rest.some((w) => FOREIGN_TARGET_RE.test(w))) {
    out.push({
      risk: 'warn',
      code: 'foreign-repo',
      message: 'This targets a repository other than the one this job is working in.',
    });
  }
  if (sub === 'pr' && rest[0] === 'merge') {
    out.push({ risk: 'warn', code: 'pr-merge', message: 'This merges the pull request.' });
    if (has('--auto')) {
      out.push({
        risk: 'warn',
        code: 'auto-merge',
        message: 'With `--auto` this merges by itself once checks pass — possibly long after you approve it.',
      });
    }
  }
  // Not a danger — a liveness bug Outpost has already shipped once. `--delete-branch` also
  // deletes the LOCAL branch, which git refuses while the step's worktree still holds it, so gh
  // exits non-zero even though the PR merged: the caller reads a failure and the step is
  // stranded at its merge gate forever. A warning is the wrong instrument, because the user
  // would read it, judge deleting the branch to be perfectly reasonable, and approve it. The
  // remote branch is deleted separately by `git push <remote> --delete`, which works fine.
  //
  // `-d` is gh's shorthand and pflag accepts it clustered (`-sd`) and valued (`-d=true`); argv
  // matching sees all of those as the same flag, which is why this check is not a text scan.
  if (has('--delete-branch') || rest.some((w) => /^-[A-Za-z]*d/.test(w) && !w.startsWith('--'))) {
    out.push({
      risk: 'refuse',
      code: 'delete-branch',
      message: '`--delete-branch` also deletes the local branch, which git refuses while this '
        + "step's worktree holds it — gh then exits non-zero even though the PR merged, and the "
        + 'step strands at its gate. Merge without it; delete the remote branch separately with '
        + '`git push <remote> --delete <branch>`.',
    });
  }
  if (sub === 'api') {
    const method = argv.find((w, i) => (argv[i - 1] === '--method' || argv[i - 1] === '-X') && /^(POST|PUT|PATCH|DELETE)$/i.test(w))
      ?? argv.map((w) => /^(?:--method|-X)=(.+)$/.exec(w)?.[1]).find((m) => m && /^(POST|PUT|PATCH|DELETE)$/i.test(m));
    if (method) {
      out.push({
        risk: 'warn',
        code: 'api-write',
        message: `This is a direct \`${method.toUpperCase()}\` to the GitHub API — it is not limited to the shapes the other commands allow.`,
      });
    }
  }
  // `--hostname` sends the call — body included — to a GitHub host other than the one the
  // checkout talks to. Same shape as a URL remote on `git push`: legitimate for GitHub
  // Enterprise, and the one `gh` flag that can move a payload off to an arbitrary server.
  if (has('--hostname')) {
    out.push({
      risk: 'warn',
      code: 'foreign-host',
      message: 'This sends the request to a different GitHub host — check the destination.',
    });
  }
  if (sub === 'release' || sub === 'workflow') {
    out.push({
      risk: 'warn',
      code: sub === 'release' ? 'release' : 'workflow-dispatch',
      message: sub === 'release'
        ? 'This publishes a release.'
        : 'This dispatches a CI workflow, which may deploy.',
    });
  }
  return out;
}

function gitFindings(sub: string | undefined, rest: string[]): WriteFinding[] {
  const out: WriteFinding[] = [];
  if (sub !== 'push') return out;

  if (rest.some(isForceFlag)) {
    out.push({
      risk: 'confirm',
      code: 'force-push',
      message: 'Force-push: this rewrites history on the remote and can destroy commits that '
        + 'are not recoverable from this machine. On a branch with an open PR, append a new '
        + 'commit and fast-forward instead. Confirm only if you know this branch is yours and '
        + 'the discarded history is not needed.',
    });
  }
  // `--mirror` makes the remote match this checkout exactly, deleting every ref the local repo
  // doesn't have. Same class as a force-push — the loss isn't undone by noticing it afterwards —
  // so it sits with force rather than in the warnings.
  if (rest.some((w) => w === '--mirror')) {
    out.push({
      risk: 'confirm',
      code: 'mirror-push',
      message: '`--mirror` overwrites the remote to match this checkout, deleting every branch '
        + 'and tag not present locally. Real for a repository migration, wrong for anything '
        + 'else — confirm only if you meant the whole remote, not one ref.',
    });
  }
  if (rest.some((w) => w === '--delete' || /^-[A-Za-z0-9]*d/.test(w))) {
    out.push({ risk: 'warn', code: 'delete-ref', message: 'This deletes a ref on the remote.' });
  }
  // A remote given as a URL rather than a configured name sends the repository somewhere the
  // checkout was never configured to talk to. Legitimate for a fork, so not refused — but it is
  // the one push shape that can move code off the machine entirely, and it should never scroll
  // past unremarked.
  if (rest.some((w) => /^[a-z][a-z0-9+.-]*:\/\//.test(w) || /^[^/\s]+@[^:\s]+:/.test(w))) {
    out.push({
      risk: 'warn',
      code: 'url-remote',
      message: 'This pushes to a URL rather than a configured remote — check the destination host.',
    });
  }
  const refs = rest.filter((w) => !w.startsWith('-'));
  // Case-folded: `Main` and `MASTER` are the same branch to everyone except a `===`.
  const target = refs[refs.length - 1]?.replace(/^refs\/heads\//, '').toLowerCase();
  if (refs.length > 1 && target !== undefined && DEFAULT_BRANCHES.has(target)) {
    out.push({
      risk: 'warn',
      code: 'default-branch',
      message: `This pushes directly to \`${refs[refs.length - 1]}\`, bypassing pull-request review.`,
    });
  }
  return out;
}

// Whether this clause is an external write — the same set the `push` group's rules name, since
// both answer "is this the kind of call that has to be approved". Kept here in code rather than
// read off the group config so this module stays usable without it.
function isWriteClause(prog: string, sub: string | undefined, rest: string[], argv: string[]): boolean {
  if (prog === 'git') {
    if (sub === 'push' || sub === 'commit') return true;
    return sub === 'tag' && rest.length > 0 && !['-l', '--list', '-n'].includes(rest[0]!);
  }
  if (prog !== 'gh') return false;
  const verb = rest[0];
  if (sub === 'pr') return ['create', 'edit', 'merge', 'review', 'comment', 'close', 'ready'].includes(verb ?? '');
  if (sub === 'issue') return ['create', 'comment', 'close', 'edit'].includes(verb ?? '');
  if (sub === 'release') return ['create', 'edit', 'upload'].includes(verb ?? '');
  if (sub === 'workflow') return verb === 'run';
  if (sub === 'api') return argv.some((w, i) => /^(?:--method|-X)$/.test(argv[i - 1] ?? '') && /^(?:POST|PUT|PATCH|DELETE)$/i.test(w))
    || argv.some((w) => /^(?:--method|-X)=(?:POST|PUT|PATCH|DELETE)$/i.test(w));
  return false;
}

// A command substitution inside a write's argument is the `--body-file` problem wearing
// different syntax: the approval card renders the command TEXT, so `--body "$(cat ~/.ssh/
// id_rsa)"` shows the user a plausible flag and sends them a private key. The enumerated rules
// used to stop this incidentally, by excluding `$` and backtick from every value's character
// class; the verb anchors don't, so it becomes explicit here.
//
// `shell-safety.ts` already refuses an UNQUOTED expansion (it word-splits into flags no rule
// read). This is the quoted case it deliberately lets through — correct for `"$BRANCH"`, where
// the value is one opaque word and gets an `opaque-expansion` warning, but not for `$(…)`,
// whose output is unbounded content chosen by a command the user never sees run.
//
// Refused rather than warned, and scoped to write clauses only: a read may substitute freely.
//
// Quote-aware, and that is not a detail: a backtick inside SINGLE quotes is a literal
// character, which is how every markdown code span in a PR comment body is written
// (`gh pr comment 12 --body 'wrapping the `+'`insert`'+` in a transaction'`). A flat
// `/\$\(|`/` over the clause text refuses those, which is most real review comments. Inside
// DOUBLE quotes both forms are still live substitutions and must be caught.
function hasCommandSubstitution(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '`') return true;
        if (s[i] === '$' && s[i + 1] === '(') return true;
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') return true;
    if (c === '$' && s[i + 1] === '(') return true;
    i++;
  }
  return false;
}

// a command that parses but carries nothing worth saying — and for one that does not parse,
// since `allows()` has already refused that outright and a second opinion here would only
// muddy the reason the user is shown.
export function writeFindings(cmd: string): WriteFinding[] {
  const clauses = splitShellClauses(cmd);
  if (clauses === null) return [];
  const out: WriteFinding[] = [];
  for (const clause of clauses) {
    const argv = clauseArgv(clause.text);
    const { prog, sub, rest } = head(argv);
    if (prog === 'git') out.push(...gitFindings(sub, rest));
    else if (prog === 'gh') out.push(...ghFindings(sub, rest, argv));
    if (!isWriteClause(prog, sub, rest, argv)) continue;
    if (hasCommandSubstitution(clause.text)) {
      out.push({
        risk: 'refuse',
        code: 'substituted-payload',
        message: 'This builds part of the payload with a command substitution, so what would '
          + 'actually be sent is not what the approval shows. Put the literal text in the '
          + 'command, or write the body to a file under /tmp and reference it with --body-file.',
      });
    }
    // A quoted `"$VAR"` reaches the program as one opaque word — shell-safety.ts deliberately
    // lets it through, and `code.merge-pr` documents exactly that spelling for a branch name.
    // But the card shows command TEXT, so the user approves an effect whose operand only the
    // session knows. Worth saying out loud rather than refusing: unlike a substitution, the
    // value is one word the session just computed, usually a branch or a PR number.
    // Anywhere in the clause, not just directly after an opening quote — the variable is
    // usually mid-string (`"repos/$OWNER/$REPO/pulls/7/reviews"`). No need to check that it IS
    // quoted: shell-safety refuses an unquoted expansion outright, so any that survives to be
    // shown on a draft is quoted. `$(` doesn't match — that is the refusal above, not a warning.
    if (/\$\{?[A-Za-z_]/.test(clause.text)) {
      out.push({
        risk: 'warn',
        code: 'opaque-expansion',
        message: 'This contains a shell variable — the daemon can show you the command, but not '
          + 'the value it will expand to.',
      });
    }
  }
  const seen = new Set<string>();
  const rank: Record<WriteRisk, number> = { refuse: 0, confirm: 1, warn: 2 };
  return out
    .filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)))
    .sort((a, b) => rank[a.risk] - rank[b.risk]);
}

// The findings a user must acknowledge individually before this command may be pinned. Checked
// in acceptDraft against the SUBMITTED command text, not the drafted one — the user can edit
// the textarea, so recomputing there is what stops a force flag added after the draft was
// raised from riding in on an acknowledgement that was never given for it.
export function confirmationsRequired(cmd: string): WriteFinding[] {
  return writeFindings(cmd).filter((f) => f.risk === 'confirm');
}

// The refuse half, for `allows()`. Kept as its own entry point so the checker never has to
// reason about warnings, and so a warning can never accidentally become a denial by being
// added to the wrong list.
export function refusedWrite(cmd: string): WriteFinding | undefined {
  return writeFindings(cmd).find((f) => f.risk === 'refuse');
}
