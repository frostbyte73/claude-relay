// Diff overlay + source-control state. The overlay is still a single-instance
// modal (only one review can be open at a time), so these remain mutable
// singletons — but `diffState.ctx` now carries the explicit
// {sessionId, jobId, stepId} context passed to openDiffOverlay/openDiffForStep
// instead of the overlay reaching into `sessions.get().currentSessionId` pervasively.
//
// sourceCtl.headerBySessionId and sourceCtl.busyBySessionId are the exception —
// the header chip can be visible for multiple sessions concurrently, and an
// in-flight commit/push/pull must not follow the overlay when it's reopened
// for a different session, so both are keyed by session id.

export const diffState = {
  // Context for the currently open overlay; null when closed.
  // { sessionId, jobId, stepId, job, step }
  ctx: null,
  mode: 'branch', // compare mode: 'branch' | 'worktree' | 'log'
  files: [],
  filter: '', // file-list search text
  comments: new Map(), // key: `${file}:${side}:${line}` -> { file, side, line, content, lineText }
  openDraftKey: null,
  collapsed: new Set(), // file paths currently collapsed in the content area
  hoveredRowKey: null, // last-hovered diff row key, for the 'c' keyboard shortcut
  // Cached refs per mode so the inactive pill keeps its label after switching.
  refs: {
    branch: { base: '…', head: '…' },
    worktree: { base: 'HEAD', head: 'working tree' },
  },
  // Commit dialog footer state.
  commit: {
    message: '',
    autoFilled: false,
    variant: 0, // ⌘R cycles through deterministic draft templates
    push: true,
    openPr: true,
    mergeMode: 'squash-to-branch', // 'squash-to-branch' | 'merge-to-base'
    newBranch: '',
  },
};

export const sourceCtl = {
  status: null,
  log: [],
  // Map<sessionId, 'commit'|'push'|'pull'|'finalize'|'open-pr'>. Keyed per session
  // (not a bare singleton) so a commit/push/pull started in one session's overlay
  // can't leave a different session's primary button permanently disabled if the
  // user jumps overlays mid-flight — openDiffOverlay/openDiffForStep support that
  // without any teardown step.
  busyBySessionId: new Map(),
  // Map<sessionId, { branch: string|null, prUrl: string|null, inFlight: boolean }>.
  // Populated lazily as session headers render and invalidated when a session
  // is deleted. Not cleared on session switch — cache hits give instant chip
  // labels when the user comes back to a session.
  headerBySessionId: new Map(),
};

export function getBusy(sessionId) {
  return sourceCtl.busyBySessionId.get(sessionId) ?? null;
}

export function setBusy(sessionId, kind) {
  if (kind == null) sourceCtl.busyBySessionId.delete(sessionId);
  else sourceCtl.busyBySessionId.set(sessionId, kind);
}

export function getHeader(sessionId) {
  return sourceCtl.headerBySessionId.get(sessionId) ?? null;
}

export function setHeader(sessionId, entry) {
  const prev = sourceCtl.headerBySessionId.get(sessionId) ?? {};
  sourceCtl.headerBySessionId.set(sessionId, { ...prev, ...entry });
}

// Cwd-keyed branch cache used by the mobile session list to label rows. Two
// sessions sharing a cwd share the label — last-writer-wins. Acceptable because
// worktree sessions get unique cwds and the shared-cwd case is read-mostly.
export const branchesByCwd = new Map();

// Wipe the singleton diff/status fields back to their initial values. Called
// on session switch so the next session's git viewer doesn't briefly show the
// previous session's diff, log, busy state, or drafted commit message.
// `headerBySessionId` and `branchesByCwd` are per-session/per-cwd and stay.
export function resetGitState() {
  if (diffState.ctx?.sessionId) setBusy(diffState.ctx.sessionId, null);
  diffState.ctx = null;
  diffState.mode = 'branch';
  diffState.files = [];
  diffState.filter = '';
  diffState.comments.clear();
  diffState.openDraftKey = null;
  diffState.collapsed.clear();
  diffState.hoveredRowKey = null;
  diffState.refs.branch = { base: '…', head: '…' };
  diffState.refs.worktree = { base: 'HEAD', head: 'working tree' };
  diffState.commit = {
    message: '', autoFilled: false, variant: 0,
    push: true, openPr: true, mergeMode: 'squash-to-branch', newBranch: '',
  };

  sourceCtl.status = null;
  sourceCtl.log = [];
}
