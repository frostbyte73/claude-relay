import type { WorkspaceRef } from './work-types.js';

// A step's workspace is authored outside the daemon — by a planner via submit_plan, or by the
// plan editor — so it needs checking where it enters. A `readonly`/`writable` ref missing
// repoCwd materializes fine and then fails at provision time, which is a dead end: the step
// can only be dropped and re-added, since retrying re-provisions the same broken ref.
export function workspaceError(ws: WorkspaceRef | undefined): string | null {
  if (ws === undefined) return null;
  if (!ws || typeof ws !== 'object') return 'workspace must be an object';
  const kind = (ws as { kind?: unknown }).kind;
  if (kind === 'none') return null;
  if (kind !== 'readonly' && kind !== 'writable') {
    return `unknown workspace.kind ${JSON.stringify(kind)} — expected "none", "readonly" or "writable"`;
  }
  const repoCwd = (ws as { repoCwd?: unknown }).repoCwd;
  if (typeof repoCwd !== 'string' || !repoCwd.trim()) {
    return `workspace.${kind} requires repoCwd (absolute path to the repo) — use {"kind":"none"} for work that needs no checkout of its own`;
  }
  if (kind === 'writable') {
    const branch = (ws as { branch?: unknown }).branch;
    if (typeof branch !== 'string' || !branch.trim()) return 'workspace.writable requires branch';
  }
  return null;
}
