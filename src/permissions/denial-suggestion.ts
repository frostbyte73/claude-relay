// The rule the PWA offers as a one-click "Allow" next to a call the allowlist blocked.
// The bar it has to clear is that granting it actually unblocks the call — so a suggestion
// is derived from why the checker said no, not from the shape of the command.

import type { BashDenialCause, RuleKind } from './allowlist.js';
import { readWordAt, stripLeadingAssignments } from './shell-split.js';

// `none` is a real answer, not a failure: some calls are denied by a gate no rule lifts, and
// `value` then carries the reason so the user fixes the action's command instead of hunting
// for a grant that doesn't exist. POST /api/allowlist/rules refuses it.
export interface RuleSuggestion {
  kind: RuleKind | 'none';
  value: string;
}

// Tools whose input names a file, and the fields to look in. Same table as the checker's,
// deliberately re-stated: a tool the checker doesn't path-scope must not be suggested one.
const PATH_FIELDS: Record<string, ReadonlyArray<string>> = {
  Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'],
  MultiEdit: ['file_path'], NotebookEdit: ['notebook_path', 'file_path'],
  Glob: ['path'], Grep: ['path'],
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The directory of a path, as an anchored prefix rule: the grant covers the directory the
// call touched rather than the single file, which is what makes it worth a click.
function dirRule(tool: string, path: string): RuleSuggestion {
  const dir = path.replace(/\/[^/]*$/, '') || '/';
  return { kind: 'path', value: `${tool}:^${escapeRe(dir)}/` };
}

// A grant for `git` is a grant for `git push`, so anchoring on the bare binary of a
// subcommand-style CLI answers a read-shaped denial with a write-shaped rule the lint then
// refuses — the one-click Allow is dead for the whole family. It also collapses the evidence:
// DenialsStore dedups on the suggested value, so every distinct git denial merges into one row
// whose stored command is whichever hit it last. `git submodule update` and `git check-ignore`
// read as a single "git denied ×15", and nothing downstream can tell which operation an action
// actually keeps needing. Anchor on the operation instead — the level the groups' own rules are
// written at.
interface CliShape {
  // Global flags taking a SEPARATE value word. Skipping the flag but not its value takes the
  // value for the operation (`git -C /path status` → `/path`). `--flag=value` needs no entry.
  valueFlags: readonly string[];
  // Words that only group operations and never name one, so the operation is the word after.
  // Deliberately short: this is what keeps `gh pr view` (grantable) distinct from `gh pr create`
  // (belongs in `push`), which is the boundary `config/permission-groups.json` is written at.
  namespaces: readonly string[];
}

const SUBCOMMAND_CLIS: Record<string, CliShape> = {
  git: {
    valueFlags: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'],
    namespaces: ['submodule', 'remote', 'worktree', 'stash', 'bisect', 'notes', 'sparse-checkout'],
  },
  gh: {
    valueFlags: ['-R', '--repo', '--hostname'],
    namespaces: ['pr', 'issue', 'repo', 'run', 'release', 'workflow', 'cache', 'secret'],
  },
  go: { valueFlags: [], namespaces: ['mod', 'tool', 'work'] },
  cargo: { valueFlags: ['--config', '-Z', '--manifest-path'], namespaces: [] },
  uv: {
    valueFlags: ['--directory', '--project', '--python', '--cache-dir'],
    namespaces: ['pip', 'tool', 'python'],
  },
  npm: { valueFlags: ['--prefix', '-w', '--workspace'], namespaces: [] },
  yarn: { valueFlags: ['--cwd'], namespaces: [] },
  pnpm: { valueFlags: ['-C', '--dir', '--filter'], namespaces: [] },
  turbo: { valueFlags: ['--filter', '--cwd'], namespaces: [] },
  mage: { valueFlags: ['-d', '-w', '-t', '-gocmd'], namespaces: [] },
  docker: {
    valueFlags: ['-H', '--host', '--context', '--config', '--log-level'],
    namespaces: ['image', 'container', 'compose', 'volume', 'network', 'buildx'],
  },
  kubectl: {
    valueFlags: ['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '--as'],
    namespaces: ['config'],
  },
};

// An operation is a plain lowercase word. Anything else at that position is an operand — a path,
// a package, a sha, a URL, an env var name — and naming it would pin the rule to one invocation.
const OPERATION_WORD = /^[a-z][a-z0-9-]*$/;

function operationWords(binary: string, rest: string): string[] {
  const shape = SUBCOMMAND_CLIS[binary];
  if (!shape) return [];
  const words: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === ' ' || rest[i] === '\t') { i++; continue; }
    const word = readWordAt(rest, i);
    if (!word) break; // a metacharacter this scan doesn't read — keep what we have
    i += word.length;
    // `+nightly` is cargo's toolchain selector, which sits where a global flag would.
    if (word.startsWith('-') || word.startsWith('+')) {
      if (words.length) break; // a flag past the operation is the operation's own
      if (shape.valueFlags.includes(word)) {
        while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
        i += readWordAt(rest, i).length;
      }
      continue;
    }
    if (!OPERATION_WORD.test(word)) break;
    words.push(word);
    if (words.length === 1 && shape.namespaces.includes(word)) continue;
    break;
  }
  return words;
}

export function suggestRule(
  toolName: string,
  toolInput: unknown,
  bashCause: (cmd: string) => BashDenialCause,
): RuleSuggestion {
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string })?.command ?? '';
    const cause = bashCause(cmd);
    if (cause.kind === 'none') return { kind: 'none', value: cause.reason };
    if (cause.kind === 'redirect') return dirRule('Write', cause.target);
    // Anchor on the binary of the clause that failed — which is not the head of the command
    // when it's a later clause of a pipeline that had no rule — plus its operation, where the
    // binary is one that has operations.
    const clause = stripLeadingAssignments(cause.clause);
    const head = readWordAt(clause, 0);
    if (!head) return { kind: 'bash', value: '^' };
    const words = [head, ...operationWords(head, clause.slice(head.length))];
    return { kind: 'bash', value: `^${words.map(escapeRe).join(' ')}(\\s|$)` };
  }
  if (toolName.startsWith('mcp__')) {
    return { kind: 'mcp', value: `^${escapeRe(toolName)}$` };
  }
  const input = toolInput as Record<string, unknown> | null;
  for (const f of PATH_FIELDS[toolName] ?? []) {
    const v = input && typeof input === 'object' ? input[f] : undefined;
    if (typeof v === 'string' && v.length > 0) return dirRule(toolName, v);
  }
  return { kind: 'tool', value: toolName };
}
