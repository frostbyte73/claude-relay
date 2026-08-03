import { sessions } from './state/sessions.js';
import { setSessionHint } from './state/nav.js';

// The single state-seeding funnel for launching a session. Every entry point
// (⌘K palette, sessions list, tracked-job open, mobile open) calls this so a new
// identity field is wired once, not per-launcher. Navigation is deliberately NOT
// here — desktop (nav.select) and mobile (enterSession) route differently.
export function startSession(opts = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const cwd = opts.cwd ?? null;
  const spawnCwd = opts.spawnCwd ?? cwd;
  sessions.upsertSlice(id, {
    cwd,
    spawnCwd,
    title: opts.title ?? null,
    worktreePath: opts.worktreePath ?? null,
    worktreeBranch: opts.worktreeBranch ?? null,
    fromTicketId: opts.fromTicketId ?? null,
  });
  if (opts.approvalMode && opts.approvalMode !== 'ask') {
    sessions.for(id).setApprovalMode(opts.approvalMode);
  }
  setSessionHint(id, {
    id,
    cwd,
    spawnCwd,
    spawnMode: opts.spawnMode,
    baseBranch: opts.baseBranch,
    model: opts.model,
    approvalMode: opts.approvalMode,
    title: opts.title,
    worktreePath: opts.worktreePath,
    worktreeBranch: opts.worktreeBranch,
    fromTicketId: opts.fromTicketId,
  });
  return { id };
}
