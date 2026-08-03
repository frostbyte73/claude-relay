import { createStore } from './create-store.js';
import { stableStringify } from '../components/tool-use-tile.js';
import { register, push } from './preferences.js';

const IDENTITY_FIELDS = ['cwd', 'spawnCwd', 'fromTicketId', 'title', 'worktreePath', 'worktreeBranch'];

function loadExpandedProjects() {
  try { return JSON.parse(localStorage.getItem('op:expandedProjects') ?? '{}'); }
  catch { return {}; }
}

function persistExpandedProjects(map) {
  try { localStorage.setItem('op:expandedProjects', JSON.stringify(map)); } catch {}
}

function loadMaxTranscriptLines() {
  try {
    const v = Number(localStorage.getItem('op:maxTranscriptLines'));
    if (Number.isFinite(v) && v >= 50 && v <= 10000) return v;
  } catch {}
  return 500;
}

// Every session that has been observed lives in `sessionsById`. Entries stay
// resident regardless of foreground/background state so tabs that aren't
// currently visible keep accumulating transcripts, todos and tool state as
// WebSocket messages arrive. The transcript is bounded per session by
// `maxTranscriptLines` so this doesn't grow without limit.
//
// `runState` is derived from `mountedCount` + subprocess-alive signals:
//   foreground = at least one mounted view is showing this session
//   background = subprocess alive, no view mounted
//   inactive   = subprocess exited
function emptySlice(id, meta = {}) {
  return {
    id,
    cwd:                meta.cwd ?? null,
    spawnCwd:           meta.spawnCwd ?? meta.cwd ?? null,
    fromTicketId:       meta.fromTicketId ?? null,
    title:              meta.title ?? null,
    worktreePath:       meta.worktreePath ?? null,
    worktreeBranch:     meta.worktreeBranch ?? null,
    approvalMode:       meta.approvalMode ?? 'ask',
    runState:           'background',
    mountedCount:       0,
    transcript:         [],
    todos:              new Map(),
    expandedTools:      new Set(),
    activeTools:        [],
    pendingExpand:      [],
    lastSeenSeq:        0,
    sessionWsHasConnected: false,
    lingeringVerb:      null,
    expectedInterrupt:  false,
    expectedArchive:    false,
    replayGapCount:     0,
    thinking:           false,
    thinkingStartedAt:  0,
    thinkingOutputTokens: 0,
    thinkingOutputChars: 0,
    pendingDefaultPush: false,
  };
}

const EMPTY_SLICE = Object.freeze(emptySlice(null));

const initial = {
  view: 'list',
  projects: [],
  currentSessionId: null,       // mobile-only UI pointer; desktop uses per-tab
  currentSessionCwd: null,
  currentSessionSpawnCwd: null,
  currentSessionFromTicketId: null,
  approvalMode: 'ask',          // default for new sessions (settings-like)
  expandedProjects: loadExpandedProjects(),
  showArchivedByProject: new Map(),
  maxTranscriptLines: loadMaxTranscriptLines(),
  sessionsById: new Map(),      // Map<sessionId, SessionSlice>
};

const store = createStore(initial);

function withSlice(s, id, mut) {
  const prev = s.sessionsById.get(id);
  if (!prev) return s;
  const next = mut(prev);
  if (next === prev) return s;
  const map = new Map(s.sessionsById);
  map.set(id, next);
  return { ...s, sessionsById: map };
}

function upsertSliceInState(s, id, partial = {}) {
  const existing = s.sessionsById.get(id);
  if (!existing) {
    const map = new Map(s.sessionsById);
    map.set(id, emptySlice(id, partial));
    return { ...s, sessionsById: map };
  }
  // Fill only null identity holes — a later hint or projects-list row must never
  // clobber a value the slice already resolved (e.g. a WS frame or optimistic
  // append mints a cwd-less slice before the spawn cwd is known).
  let changed = false;
  const patch = {};
  for (const f of IDENTITY_FIELDS) {
    const next = existing[f] ?? partial[f] ?? null;
    if (next !== existing[f]) { patch[f] = next; changed = true; }
  }
  if (!changed) return s;
  const map = new Map(s.sessionsById);
  map.set(id, { ...existing, ...patch });
  return { ...s, sessionsById: map };
}

function ensureSliceInState(s, id, meta = {}) {
  return upsertSliceInState(s, id, meta);
}

function trimTranscript(list, cap) {
  if (list.length <= cap) return list;
  return list.slice(list.length - cap);
}

function recomputeRunState(slice) {
  // Foreground iff at least one view mounted. Otherwise, keep whatever the
  // last subprocess-alive signal said (background vs inactive).
  if (slice.mountedCount > 0) return { ...slice, runState: 'foreground' };
  if (slice.runState === 'foreground') return { ...slice, runState: 'background' };
  return slice;
}

// Clamp + mirror + retrim; returns the effective (clamped) value. No daemon push.
function applyMaxTranscriptLines(n) {
  const v = Math.max(50, Math.min(10000, Math.floor(Number(n) || 0)));
  try { localStorage.setItem('op:maxTranscriptLines', String(v)); } catch {}
  store.set((s) => {
    if (v === s.maxTranscriptLines) return s;
    const map = new Map();
    for (const [k, sl] of s.sessionsById) {
      map.set(k, { ...sl, transcript: trimTranscript(sl.transcript, v) });
    }
    return { ...s, maxTranscriptLines: v, sessionsById: map };
  });
  return v;
}

register({ key: 'maxTranscriptLines', apply: applyMaxTranscriptLines, current: () => store.get().maxTranscriptLines });

export const sessions = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  // ────────────────────────────────────────────────────────────────────
  // Slice accessors
  // ────────────────────────────────────────────────────────────────────

  getSlice(id) {
    return id ? store.get().sessionsById.get(id) ?? null : null;
  },

  // The mobile-current session's slice (or a frozen empty slice if no
  // session is current). Mobile rendering paths that don't have a session
  // id in scope read via this helper.
  currentSlice() {
    const id = store.get().currentSessionId;
    if (!id) return EMPTY_SLICE;
    return store.get().sessionsById.get(id) ?? EMPTY_SLICE;
  },

  ensureSlice(id, meta = {}) {
    if (!id) return;
    store.set((s) => ensureSliceInState(s, id, meta));
  },

  upsertSlice(id, partial = {}) {
    if (!id) return;
    store.set((s) => upsertSliceInState(s, id, partial));
  },

  // Subscribe to changes for a specific session. The callback receives the
  // current slice on subscribe and whenever THAT slice's reference changes
  // (identity comparison — cheap and correct because we always produce a new
  // slice object on mutation).
  subscribeSlice(id, fn) {
    let last = store.get().sessionsById.get(id);
    fn(last);
    return store.subscribe((s) => {
      const cur = s.sessionsById.get(id);
      if (cur !== last) {
        last = cur;
        fn(cur);
      }
    });
  },

  // View lifecycle. Called by session-view.mountSessionView on mount/unmount.
  // Mounted count promotes to foreground; last unmount demotes to background.
  mountView(id) {
    if (!id) return;
    store.set((s) => {
      const withEnsured = ensureSliceInState(s, id);
      return withSlice(withEnsured, id, (sl) =>
        recomputeRunState({ ...sl, mountedCount: sl.mountedCount + 1 }));
    });
  },
  unmountView(id) {
    if (!id) return;
    store.set((s) => withSlice(s, id, (sl) => {
      const count = Math.max(0, sl.mountedCount - 1);
      return recomputeRunState({ ...sl, mountedCount: count });
    }));
  },

  setRunState(id, state) {
    if (!id || (state !== 'foreground' && state !== 'background' && state !== 'inactive')) return;
    store.set((s) =>
      withSlice(s, id, (sl) => (sl.runState === state ? sl : { ...sl, runState: state })));
  },

  setMaxTranscriptLines(n) {
    const v = applyMaxTranscriptLines(n);
    push('maxTranscriptLines', v);
  },

  // ────────────────────────────────────────────────────────────────────
  // Global (non-per-session)
  // ────────────────────────────────────────────────────────────────────

  setProjects(projects) {
    store.set((s) => ({ ...s, projects }));
  },

  // Mobile / mobile-shell UI pointer. Called when a session enters the visible
  // slot on mobile. Also seeds a slice if none exists. Does NOT clobber existing
  // per-session state (that's the whole point of multi-live — going back to a
  // session preserves its transcript, tool state, etc.).
  enterSession({ id, cwd, spawnCwd, approvalMode, fromTicketId }) {
    store.set((s) => {
      const withEnsured = ensureSliceInState(s, id, { cwd, spawnCwd, approvalMode, fromTicketId });
      // If caller provided fresher identity metadata (e.g. approvalMode override),
      // stamp it onto the slice — but do NOT reset transcript/todos/tools.
      const patched = withSlice(withEnsured, id, (sl) => ({
        ...sl,
        cwd: cwd ?? sl.cwd,
        spawnCwd: spawnCwd ?? sl.spawnCwd,
        fromTicketId: fromTicketId ?? sl.fromTicketId,
        approvalMode: approvalMode ?? sl.approvalMode,
      }));
      return {
        ...patched,
        view: 'session',
        currentSessionId: id,
        currentSessionCwd: cwd,
        currentSessionSpawnCwd: spawnCwd ?? cwd,
        currentSessionFromTicketId: fromTicketId ?? null,
        approvalMode: approvalMode ?? patched.approvalMode,
      };
    });
  },
  leaveSession() {
    store.set((s) => {
      // 'view' always lands on 'list' — mobile-shell (P3) owns navigation for
      // everything but the session feed now. app.js's leaveSession() wrapper
      // re-selects the originating tracked job via nav.select('tracked', ...).
      return {
        ...s,
        view: 'list',
        currentSessionId: null,
        currentSessionCwd: null,
        currentSessionSpawnCwd: null,
        currentSessionFromTicketId: null,
      };
    });
  },
  setExpandedProject(cwd, expanded) {
    store.set((s) => {
      const next = { ...s.expandedProjects, [cwd]: expanded };
      persistExpandedProjects(next);
      return { ...s, expandedProjects: next };
    });
  },
  setShowArchived(cwd, show) {
    store.set((s) => {
      const next = new Map(s.showArchivedByProject);
      next.set(cwd, show);
      return { ...s, showArchivedByProject: next };
    });
  },
  setApprovalMode(mode) {
    store.set((s) => ({ ...s, approvalMode: mode }));
  },

  // ────────────────────────────────────────────────────────────────────
  // Per-session mutators — sliced API. Access via `sessions.for(id)`.
  // Each `for(id)` returns an object whose methods bind to that session id;
  // these are what WS handlers and session-view instances use.
  // ────────────────────────────────────────────────────────────────────

  for(id) { return makeSliceApi(id); },

  // Convenience wrapper: `sessions.for(currentSessionId)`. Used by mobile
  // rendering paths that mutate "whichever session is currently visible".
  forCurrent() { return makeSliceApi(store.get().currentSessionId); },
};

// Factory: returns a per-session API surface bound to `id`.
function makeSliceApi(id) {
  if (!id) return NULL_SLICE_API;
  return {
    appendTranscript(msg) {
      store.set((s) => {
        const withEnsured = ensureSliceInState(s, id);
        return withSlice(withEnsured, id, (sl) => {
          const transcript = trimTranscript([...sl.transcript, msg], s.maxTranscriptLines);
          // Edit/Write tiles render expanded by default (see editWriteTileHtml). Seed the
          // id here, once, as the call lands — a later manual collapse removes it and
          // sticks, since subsequent appends only seed their own new message's id.
          const expandedTools = seedEditExpansion(sl.expandedTools, msg);
          return expandedTools
            ? { ...sl, transcript, expandedTools }
            : { ...sl, transcript };
        });
      });
    },
    setTranscript(msgs) {
      store.set((s) => {
        const withEnsured = ensureSliceInState(s, id);
        return withSlice(withEnsured, id, (sl) => ({
          ...sl,
          transcript: trimTranscript(msgs, s.maxTranscriptLines),
        }));
      });
    },
    // Seed default-expanded state for the Edit/Write tiles in a freshly loaded
    // transcript (history fetch). setTranscript deliberately does NOT do this on
    // its own — it also runs on every mapTranscript, which would re-expand tiles
    // the user has collapsed. Call this once, right after the initial load.
    seedEditExpansions(msgs) {
      store.set((s) => withSlice(s, id, (sl) => {
        let expandedTools = null;
        for (const m of msgs) {
          const next = seedEditExpansion(expandedTools ?? sl.expandedTools, m);
          if (next) expandedTools = next;
        }
        return expandedTools ? { ...sl, expandedTools } : sl;
      }));
    },
    setTodos(map) {
      store.set((s) => withSlice(s, id, (sl) => ({ ...sl, todos: map })));
    },
    updateTodo(todoId, todo) {
      store.set((s) => withSlice(s, id, (sl) => {
        const next = new Map(sl.todos);
        next.set(todoId, todo);
        return { ...sl, todos: next };
      }));
    },
    removeTodo(todoId) {
      store.set((s) => withSlice(s, id, (sl) => {
        if (!sl.todos.has(todoId)) return sl;
        const next = new Map(sl.todos);
        next.delete(todoId);
        return { ...sl, todos: next };
      }));
    },
    markToolExpanded(key, expanded) {
      store.set((s) => withSlice(s, id, (sl) => {
        const next = new Set(sl.expandedTools);
        if (expanded) next.add(key); else next.delete(key);
        return { ...sl, expandedTools: next };
      }));
    },
    setLastSeenSeq(n) {
      store.set((s) =>
        withSlice(s, id, (sl) => (sl.lastSeenSeq === n ? sl : { ...sl, lastSeenSeq: n })));
    },
    markSessionWsHasConnected() {
      store.set((s) =>
        withSlice(s, id, (sl) => (sl.sessionWsHasConnected ? sl : { ...sl, sessionWsHasConnected: true })));
    },
    recordActiveTool(t) {
      store.set((s) =>
        withSlice(s, id, (sl) => ({ ...sl, activeTools: [...sl.activeTools, t] })));
    },
    clearActiveTool(toolUseId) {
      store.set((s) => withSlice(s, id, (sl) => ({
        ...sl,
        activeTools: sl.activeTools.filter((x) => x.toolUseId !== toolUseId),
      })));
    },
    enqueuePendingExpand(entry) {
      store.set((s) =>
        withSlice(s, id, (sl) => ({ ...sl, pendingExpand: [...sl.pendingExpand, entry] })));
    },
    // Prune stale entries (older than maxAgeMs) and append a new one. Prevents
    // pendingExpand growing unbounded when tools never match.
    pruneAndEnqueuePendingExpand(entry, maxAgeMs) {
      const now = Date.now();
      store.set((s) => withSlice(s, id, (sl) => ({
        ...sl,
        pendingExpand: [...sl.pendingExpand.filter((e) => now - e.addedAt < maxAgeMs), entry],
      })));
    },
    consumePendingExpand(toolName, sig) {
      store.set((s) => withSlice(s, id, (sl) => ({
        ...sl,
        pendingExpand: sl.pendingExpand.filter((e) => !(e.toolName === toolName && e.toolInputSig === sig)),
      })));
    },
    setLingeringVerb(verb) {
      store.set((s) => withSlice(s, id, (sl) => ({ ...sl, lingeringVerb: verb })));
    },
    expectInterrupt() {
      store.set((s) => withSlice(s, id, (sl) => ({ ...sl, expectedInterrupt: true })));
    },
    clearExpectInterrupt() {
      store.set((s) => withSlice(s, id, (sl) => ({ ...sl, expectedInterrupt: false })));
    },
    // Set by archiveSession before the archive POST so the daemon_proc_exit
    // that SIGTERM triggers renders as "Session archived" rather than a crash.
    expectArchive() {
      store.set((s) => withSlice(s, id, (sl) => ({ ...sl, expectedArchive: true })));
    },
    clearExpectArchive() {
      store.set((s) => withSlice(s, id, (sl) => ({ ...sl, expectedArchive: false })));
    },
    incrReplayGap() {
      store.set((s) =>
        withSlice(s, id, (sl) => ({ ...sl, replayGapCount: (sl.replayGapCount ?? 0) + 1 })));
    },
    setApprovalMode(mode) {
      store.set((s) =>
        withSlice(s, id, (sl) => (sl.approvalMode === mode ? sl : { ...sl, approvalMode: mode })));
    },
    setPendingDefaultPush(v) {
      const next = !!v;
      store.set((s) =>
        withSlice(s, id, (sl) => (sl.pendingDefaultPush === next ? sl : { ...sl, pendingDefaultPush: next })));
    },
    startThinking() {
      store.set((s) => {
        const withEnsured = ensureSliceInState(s, id);
        return withSlice(withEnsured, id, (sl) => ({
          ...sl,
          thinking: true,
          thinkingStartedAt: Date.now(),
          thinkingOutputTokens: 0,
          thinkingOutputChars: 0,
        }));
      });
    },
    stopThinking() {
      store.set((s) => withSlice(s, id, (sl) => ({
        ...sl,
        thinking: false,
        activeTools: [],
        lingeringVerb: null,
      })));
    },
    updateThinking({ tokens, chars }) {
      store.set((s) => withSlice(s, id, (sl) => ({
        ...sl,
        thinkingOutputTokens: tokens ?? sl.thinkingOutputTokens,
        thinkingOutputChars: chars ?? sl.thinkingOutputChars,
      })));
    },
    mapTranscript(fn) {
      const sl = store.get().sessionsById.get(id);
      if (!sl) return;
      this.setTranscript(sl.transcript.map(fn));
    },
  };
}

// Returns a new expandedTools Set with the message's id added when it's an
// Edit/Write tool_use not already present, or null when nothing changed. Keeps
// the default-expanded seeding logic in one place (appendTranscript live path +
// seedEditExpansions history path).
function seedEditExpansion(expandedTools, msg) {
  if (!msg || msg.role !== 'tool_use') return null;
  if (msg.toolName !== 'Edit' && msg.toolName !== 'Write') return null;
  if (typeof msg.toolUseId !== 'string' || expandedTools.has(msg.toolUseId)) return null;
  const next = new Set(expandedTools);
  next.add(msg.toolUseId);
  return next;
}

// ── Tool-tracking helpers ───────────────────────────────────────────────
// Match a tool_use in the slice's transcript by (toolName, toolInput) so an
// out-of-band expand signal (tool_auto_allowed) can find the tile it should
// expand. Falls back to the current session when no id is passed (defensive
// for pre-multi-live callers).
export function findMatchingToolUseId(toolName, toolInput, sessionId) {
  const id = sessionId ?? store.get().currentSessionId;
  const sl = store.get().sessionsById.get(id);
  if (!sl) return null;
  let targetSig;
  try { targetSig = stableStringify(toolInput); } catch { return null; }
  for (let i = sl.transcript.length - 1; i >= 0; i--) {
    const m = sl.transcript[i];
    if (m.role !== 'tool_use' || m.toolName !== toolName || !m.toolUseId) continue;
    if (sl.expandedTools.has(m.toolUseId)) continue;
    try {
      if (stableStringify(m.toolInput) === targetSig) return m.toolUseId;
    } catch { /* keep walking */ }
  }
  return null;
}

// Expand a tool tile matching (toolName, toolInput) now if it's in the
// transcript, or enqueue for expansion when the matching tool_use lands.
// Returns true if it matched immediately.
export function expandToolByContent(toolName, toolInput, sessionId) {
  const id = sessionId ?? store.get().currentSessionId;
  if (!id) return false;
  const useId = findMatchingToolUseId(toolName, toolInput, id);
  if (useId) {
    makeSliceApi(id).markToolExpanded(useId, true);
    return true;
  }
  let sig;
  try { sig = stableStringify(toolInput); } catch { return false; }
  // 30s GC bound — claude would have emitted the block by then.
  makeSliceApi(id).pruneAndEnqueuePendingExpand(
    { toolName, toolInputSig: sig, addedAt: Date.now() },
    30_000,
  );
  return false;
}

// Called when a tool_use arrives; if a pending-expand entry matches it,
// expand the tile now and remove the pending entry.
export function applyPendingExpand(toolName, toolInput, toolUseId, sessionId) {
  const id = sessionId ?? store.get().currentSessionId;
  if (!toolUseId || !id) return false;
  const sl = store.get().sessionsById.get(id);
  if (!sl || sl.pendingExpand.length === 0) return false;
  let sig;
  try { sig = stableStringify(toolInput); } catch { return false; }
  for (const e of sl.pendingExpand) {
    if (e.toolName === toolName && e.toolInputSig === sig) {
      makeSliceApi(id).markToolExpanded(toolUseId, true);
      makeSliceApi(id).consumePendingExpand(toolName, sig);
      return true;
    }
  }
  return false;
}

// Returned by sessions.for(null) — every method is a no-op. Lets callers
// use `.for(msg.sessionId).xxx()` without null-guarding every site.
const NULL_SLICE_API = {
  appendTranscript() {}, setTranscript() {}, seedEditExpansions() {}, setTodos() {}, updateTodo() {}, removeTodo() {},
  markToolExpanded() {}, setLastSeenSeq() {}, markSessionWsHasConnected() {},
  recordActiveTool() {}, clearActiveTool() {}, enqueuePendingExpand() {},
  pruneAndEnqueuePendingExpand() {},
  consumePendingExpand() {}, setLingeringVerb() {}, expectInterrupt() {},
  clearExpectInterrupt() {}, expectArchive() {}, clearExpectArchive() {},
  incrReplayGap() {}, setApprovalMode() {},
  startThinking() {}, stopThinking() {}, updateThinking() {},
  setPendingDefaultPush() {}, mapTranscript() {},
};
