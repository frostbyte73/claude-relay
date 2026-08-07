// The rule the PWA offers as a one-click "Allow" next to a call the allowlist blocked.
// The bar it has to clear is that granting it actually unblocks the call — so a suggestion
// is derived from why the checker said no, not from the shape of the command.

import type { BashDenialCause, RuleKind } from './allowlist.js';
import { stripLeadingAssignments } from './shell-split.js';

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
    // when it's a later clause of a pipeline that had no rule.
    const head = stripLeadingAssignments(cause.clause).split(/\s+/)[0] ?? '';
    return { kind: 'bash', value: head ? `^${escapeRe(head)}(\\s|$)` : '^' };
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
