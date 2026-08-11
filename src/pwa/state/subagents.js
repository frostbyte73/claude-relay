import { createStore } from './create-store.js';
import { sessions } from './sessions.js';
import { approvals } from './approvals.js';
import { TASK_TOOL_NAMES, isHighDetailTool } from '../components/tool-use-tile.js';

// Subagents are the child agents spawned by Task tool calls. Multi-live scopes
// the display fields (byId, activeId, tabOrder) by sessionId so two concurrently-
// live sessions don't co-mingle their agent buckets in the agents sheet — but
// keeps global dedup sets (seenBlockSigs, taskToolUseIds, pendingCreates)
// shared, because those exist to suppress duplicate WS deliveries and would
// break dedup if partitioned per-session.
//
// Session-scoped fields (per bySession entry):
//   byId: Map<agentId, bucket>            (each bucket carries its sessionId)
//   activeId: agentId | null              (which agent tab is open in the sheet)
//   tabOrder: agentId[]                   (stable display order in the sheet)
//
// Access:
//   subagents.forSession(id) — {byId, activeId, tabOrder} scoped to one session.
//     Preferred entry point for multi-live callers that know their session id.
//   subagents.focused() — same shape, scoped to whichever session was last
//     pointed at via setFocused(). Used by the agents-sheet UI on both mobile
//     (currentSessionId) and desktop (per-tab, set on sheet open).

const initial = {
  bySession: new Map(),           // Map<sessionId, {byId, activeId, tabOrder}>
  focusedSessionId: null,         // which session the agents-sheet is showing
  // Global (not per-session):
  unboundInvocations: [],
  seenBlockSigs: new Set(),
  taskToolUseIds: new Set(),
  pendingCreates: new Map(),
};

const store = createStore(initial);

function emptySlice() {
  return { byId: new Map(), activeId: null, tabOrder: [] };
}

const EMPTY_SLICE = Object.freeze({
  byId: new Map(),
  activeId: null,
  tabOrder: [],
});

function ensureSliceIn(state, sid) {
  if (state.bySession.has(sid)) return state;
  const next = new Map(state.bySession);
  next.set(sid, emptySlice());
  return { ...state, bySession: next };
}

// Merge-write: apply `mut` to the slice for `sid` and install it back into
// bySession.
function withSlice(state, sid, mut) {
  const withEnsured = ensureSliceIn(state, sid);
  const prev = withEnsured.bySession.get(sid);
  const next = mut(prev);
  if (next === prev) return state;
  const bySession = new Map(withEnsured.bySession);
  bySession.set(sid, next);
  return { ...withEnsured, bySession };
}

export const subagents = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  // Multi-live entry point: return a read-only handle to the given session's
  // slice. Returns a frozen empty slice if the session has no subagents yet.
  forSession(sessionId) {
    if (!sessionId) return EMPTY_SLICE;
    return store.get().bySession.get(sessionId) ?? EMPTY_SLICE;
  },

  // The slice for whichever session `setFocused` last pointed at. Used by the
  // agents-sheet UI, which is a singleton overlay showing one session at a
  // time.
  focused() {
    const sid = store.get().focusedSessionId;
    return sid ? (store.get().bySession.get(sid) ?? EMPTY_SLICE) : EMPTY_SLICE;
  },

  setFocused(sessionId) {
    store.set((s) => (s.focusedSessionId === sessionId ? s : { ...s, focusedSessionId: sessionId ?? null }));
  },

  replaceFromDisk(map, sessionId) {
    // Bulk replace one session's byId + tabOrder. Called by openSession +
    // catchUpFromDisk after the transcript replay has enumerated the session's
    // subagents from disk.
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return;
    store.set((s) => {
      const nextSlice = { byId: map, activeId: null, tabOrder: Array.from(map.keys()) };
      const bySession = new Map(s.bySession);
      bySession.set(sid, nextSlice);
      return { ...s, bySession };
    });
  },

  getOrCreateBucket({ sessionId, agentId, agentType, firstSeenAt }) {
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return null;
    let created = null;
    store.set((s) => withSlice(s, sid, (slice) => {
      if (slice.byId.has(agentId)) { created = slice.byId.get(agentId); return slice; }
      const bucket = { sessionId: sid, agentType, firstSeenAt, entries: [] };
      created = bucket;
      const byId = new Map(slice.byId); byId.set(agentId, bucket);
      const tabOrder = [...slice.tabOrder, agentId];
      return { ...slice, byId, tabOrder };
    }));
    return created;
  },

  addEntry(agentId, entry, sessionId) {
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return;
    store.set((s) => withSlice(s, sid, (slice) => {
      const bucket = slice.byId.get(agentId);
      if (!bucket) return slice;
      bucket.entries.push(entry);
      // Bump byId ref so subscribers see the change (entries are mutated in
      // place for cheap identity-preserving reads).
      return { ...slice, byId: new Map(slice.byId) };
    }));
  },

  // Store-notifying completion write. Direct `bucket.completion =` mutation
  // is invisible to subscribers (the slice reference never changes), so the
  // running→completed flip wouldn't repaint until an unrelated store tick.
  setCompletion(agentId, sessionId, completion) {
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return;
    store.set((s) => withSlice(s, sid, (slice) => {
      const bucket = slice.byId.get(agentId);
      if (!bucket) return slice;
      bucket.completion = completion;
      return { ...slice, byId: new Map(slice.byId) };
    }));
  },

  // A finished agent can be woken again — the parent SendMessages it and the
  // harness resumes the SAME agentId from its transcript, so no new bucket ever
  // arrives. `completion` is what every surface reads as "done", so clear it and
  // fold the finished round into the feed as history; the agent's next
  // <task-notification> re-stamps a fresh completion. Returns whether a bucket
  // actually woke, so callers can skip a repaint when it didn't.
  markResumed(agentId, sessionId, summary) {
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return false;
    let woke = false;
    store.set((s) => withSlice(s, sid, (slice) => {
      const bucket = slice.byId.get(agentId);
      if (!bucket || !bucket.completion) return slice;
      const at = Date.now();
      bucket.entries.push({ kind: 'completed-round', completion: bucket.completion, decision: 'allow' });
      bucket.entries.push({ kind: 'resumed', summary: summary ?? null, at, decision: 'allow' });
      bucket.completion = null;
      bucket.resumedAt = at;
      woke = true;
      return { ...slice, byId: new Map(slice.byId) };
    }));
    return woke;
  },

  // Store-notifying resolution of pending approval entries. Flips every entry
  // matching approvalId from decision:null to the given decision (entries are
  // mutated in place, as elsewhere) and bumps the touched slices' byId ref so
  // subscribers repaint. A direct `e.decision =` write is invisible to
  // subscribers — the same hazard setCompletion guards against — and would
  // leave the Sessions rail frozen on a stale live-tail until an unrelated tick.
  resolveApproval(approvalId, decision, timedOut) {
    if (!approvalId) return;
    store.set((s) => {
      let changed = false;
      const bySession = new Map(s.bySession);
      for (const [sid, slice] of s.bySession) {
        let sliceChanged = false;
        for (const bucket of slice.byId.values()) {
          for (const e of bucket.entries) {
            if (e.approvalId === approvalId && e.decision === null) {
              e.decision = decision;
              if (timedOut) e.timedOut = true;
              sliceChanged = true;
            }
          }
        }
        if (sliceChanged) {
          bySession.set(sid, { ...slice, byId: new Map(slice.byId) });
          changed = true;
        }
      }
      return changed ? { ...s, bySession } : s;
    });
  },

  bringToFront(agentId, sessionId) {
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return;
    store.set((s) => withSlice(s, sid, (slice) => {
      if (!slice.byId.has(agentId)) return slice;
      const tabOrder = [agentId, ...slice.tabOrder.filter((id) => id !== agentId)];
      return { ...slice, tabOrder };
    }));
  },

  setActive(agentId, sessionId) {
    const sid = sessionId ?? store.get().focusedSessionId;
    if (!sid) return;
    store.set((s) => withSlice(s, sid, (slice) => (
      slice.activeId === agentId ? slice : { ...slice, activeId: agentId }
    )));
  },

  // Clear one session's subagents entirely. Used by openSession when the user
  // enters a fresh spawn of the same session id (Claude's /clear semantics).
  clearSession(sessionId) {
    const sid = sessionId;
    if (!sid) return;
    store.set((s) => {
      if (!s.bySession.has(sid)) return s;
      const bySession = new Map(s.bySession);
      bySession.set(sid, emptySlice());
      return { ...s, bySession };
    });
  },

  // ── Global (cross-session) fields ─────────────────────────────────

  recordUnboundInvocation(inv) {
    store.set((s) => ({ ...s, unboundInvocations: [...s.unboundInvocations, inv] }));
  },
  consumeUnboundInvocation({ agentType }) {
    const s = store.get();
    const idx = s.unboundInvocations.findIndex((u) => u.subagentType === agentType);
    if (idx === -1) return null;
    const got = s.unboundInvocations[idx];
    const next = s.unboundInvocations.slice();
    next.splice(idx, 1);
    store.set({ ...s, unboundInvocations: next });
    return got;
  },
  markBlockSigSeen(sig) {
    const s = store.get();
    if (s.seenBlockSigs.has(sig)) return;
    const next = new Set(s.seenBlockSigs);
    next.add(sig);
    store.set({ ...s, seenBlockSigs: next });
  },
  hasBlockSig(sig) {
    return store.get().seenBlockSigs.has(sig);
  },
  markTaskToolUse(useId) {
    const s = store.get();
    if (s.taskToolUseIds.has(useId)) return;
    const next = new Set(s.taskToolUseIds);
    next.add(useId);
    store.set({ ...s, taskToolUseIds: next });
  },
  hasTaskToolUse(useId) {
    return store.get().taskToolUseIds.has(useId);
  },
  recordPendingCreate(useId, payload) {
    store.set((s) => {
      const next = new Map(s.pendingCreates);
      next.set(useId, payload);
      return { ...s, pendingCreates: next };
    });
  },
  resolvePendingCreate(useId) {
    const s = store.get();
    const got = s.pendingCreates.get(useId);
    if (!got) return null;
    const next = new Map(s.pendingCreates);
    next.delete(useId);
    store.set({ ...s, pendingCreates: next });
    return got;
  },
};

// ── Action helpers ──────────────────────────────────────────────────────
// Effects that reach across the subagents / sessions / approvals stores in
// response to Task tool calls and subagent activity. Kept here alongside the
// store because their sole purpose is applying subagent-shaped events to the
// stores; app.js and ws/dispatch.js consume them.

// TaskCreate / TaskUpdate handling. Todos live on the session's slice.
export function applyTaskUse(name, input, useId, sessionId) {
  const sid = sessionId ?? sessions.get().currentSessionId;
  const S = sessions.for(sid);
  if (useId) subagents.markTaskToolUse(useId);
  if (name === 'TaskCreate') {
    if (useId) subagents.recordPendingCreate(useId, input ?? {});
    return;
  }
  if (name === 'TaskUpdate') {
    const id = input && input.taskId;
    if (!id || !sid) return;
    if (input.status === 'deleted') {
      S.removeTodo(id);
      return;
    }
    const sl = sessions.getSlice(sid);
    const cur = sl?.todos.get(id) ?? { subject: `Task #${id}`, status: 'pending' };
    const next = { ...cur };
    if (typeof input.subject === 'string') next.subject = input.subject;
    if (typeof input.description === 'string') next.description = input.description;
    if (typeof input.activeForm === 'string') next.activeForm = input.activeForm;
    if (typeof input.status === 'string' && input.status !== cur.status) {
      next.status = input.status;
      // Provenance is additive/best-effort: the todo protocol carries no explicit
      // attribution, so we stamp whichever tool or subagent was active in this
      // session at the moment the status flipped — close enough for "via
      // read.linear-issue" / "Explore agent" to be useful without a protocol
      // change. Timestamps let the rail compute a rough elapsed duration.
      if (!cur.createdAt) next.createdAt = Date.now();
      next.updatedAt = Date.now();
      next.producedBy = currentProvenance(sid);
    } else if (typeof input.status === 'string') {
      next.status = input.status;
    }
    S.updateTodo(id, next);
  }
}

// Best-effort "what's happening right now in this session" snapshot, used to
// attribute a todo's status flip. Prefers the most recently invoked tool
// (LIFO) over a running subagent, since the tool call is the more immediate
// cause of most TaskUpdate calls.
function currentProvenance(sessionId) {
  const sl = sessions.getSlice(sessionId);
  const activeTools = sl?.activeTools ?? [];
  if (activeTools.length) {
    const top = activeTools[activeTools.length - 1];
    if (top?.toolName) return { toolName: top.toolName };
  }
  const slice = subagents.forSession(sessionId);
  for (const id of slice.tabOrder) {
    const b = slice.byId.get(id);
    if (b && !b.completion) return { agentId: id, agentType: b.agentType };
  }
  return null;
}

// The assigned todo id only surfaces in "Task #N created successfully: …" text.
export function applyTaskResult(useId, text, sessionId) {
  if (approvals.get().consumedTaskResults.has(useId)) return;
  const pending = subagents.resolvePendingCreate(useId);
  if (!pending) return;
  approvals.markTaskResultConsumed(useId);
  const m = /^Task #(\d+)\b/.exec(String(text));
  if (!m) return;
  const id = m[1];
  const sid = sessionId ?? sessions.get().currentSessionId;
  if (!sid) return;
  sessions.for(sid).updateTodo(id, {
    subject: pending.subject ?? `Task #${id}`,
    description: pending.description,
    activeForm: pending.activeForm,
    status: 'pending',
  });
}

// Route a transcript-replay message through the task-tool handlers. Returns
// true if the message was consumed (caller can skip further processing).
export function applyTaskTranscriptMessage(m, sessionId) {
  if (m.role === 'tool_use' && m.toolName && TASK_TOOL_NAMES.has(m.toolName)) {
    applyTaskUse(m.toolName, m.toolInput, m.toolUseId, sessionId);
    return true;
  }
  if (m.role === 'tool_result' && m.toolUseId) {
    if (subagents.get().pendingCreates.has(m.toolUseId)) {
      applyTaskResult(m.toolUseId, m.text, sessionId);
      return true;
    }
    if (subagents.hasTaskToolUse(m.toolUseId)) return true;
  }
  return false;
}

// <task-notification> from the daemon-injected user message signals subagent
// completion. task-id is either an agent_id or a background Bash task id;
// Bash ones return false so callers can skip further handling.
export function applyTaskNotification(text) {
  const get = (tag) => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  const taskId = get('task-id');
  if (!taskId) return false;
  // agentId is globally unique, so search every session's slice.
  let bucketSid = null;
  for (const [sid, slice] of store.get().bySession) {
    if (slice.byId.has(taskId)) { bucketSid = sid; break; }
  }
  if (bucketSid == null) return false;
  subagents.setCompletion(taskId, bucketSid, {
    status: get('status') ?? 'completed',
    summary: get('summary') ?? null,
    result: get('result') ?? null,
    completedAt: Date.now(),
  });
  return true;
}

// SendMessage is how the parent wakes a finished agent. `to` is the raw agentId
// for background spawns — the completion result hands the model that id and tells
// it to send there — so an exact bucket match covers the common case. A teammate
// name doesn't resolve to a bucket at all (nothing in the hook or transcript
// stream carries agent names), which is what applyAgentMessageResult is for.
export function applyAgentMessageUse(input, sessionId) {
  const sid = sessionId ?? sessions.get().currentSessionId;
  if (!sid || !input || typeof input.to !== 'string') return false;
  const summary = typeof input.summary === 'string' ? input.summary : null;
  return subagents.markResumed(input.to, sid, summary);
}

// The SendMessage tool_result names the agent it actually woke (`resumedAgentId`,
// present only when the harness resumed a stopped agent in the background). It's
// the sole signal that resolves a name-addressed send back to a bucket, and it
// double-checks the id-addressed case — markResumed is a no-op the second time.
export function applyAgentMessageResult(text, sessionId) {
  const m = /"resumedAgentId"\s*:\s*"([^"]+)"/.exec(String(text));
  if (!m) return false;
  const sid = sessionId ?? sessions.get().currentSessionId;
  if (!sid) return false;
  return subagents.markResumed(m[1], sid, null);
}

// Bidirectional bind: the parent's assistant stream and the subagent's hook
// stream arrive over two independent WebSockets — either can win. Earliest-
// seen unbound bucket wins so parallel same-type dispatches bind in dispatch
// order.
export function recordParentAgentInvocation({ toolUseId, subagentType, description }) {
  if (!description) return;
  // Claude defaults subagent_type to 'general-purpose' when the model omits
  // it (the common case). Without this default, every general-purpose agent
  // shows up as the string "general-purpose" instead of its description.
  const type = subagentType || 'general-purpose';
  // Dedup by toolUseId so transcript/WS replays don't re-queue and mis-bind
  // to a fresh agent.
  if (toolUseId) {
    for (const [, slice] of store.get().bySession) {
      for (const [, b] of slice.byId) {
        if (b.parentToolUseId === toolUseId) return;
      }
    }
    if (store.get().unboundInvocations.some((inv) => inv.toolUseId === toolUseId)) return;
  }
  let candidate = null;
  for (const [, slice] of store.get().bySession) {
    for (const [, b] of slice.byId) {
      if (b.agentType !== type) continue;
      if (b.description) continue;
      if (!candidate || b.firstSeenAt < candidate.firstSeenAt) candidate = b;
    }
  }
  if (candidate) {
    candidate.description = description;
    if (toolUseId) candidate.parentToolUseId = toolUseId;
    return;
  }
  subagents.recordUnboundInvocation({
    toolUseId,
    subagentType: type,
    description,
    seenAt: Date.now(),
  });
}

// Dedup by approvalId OR toolUseId; UUIDs and toolu_* IDs occupy disjoint
// namespaces. sessionId defaults to a.sessionId (WS deliveries carry it) so
// buckets land in the correct session's slice.
export function addSubagentEntry(a) {
  if (!a.agentId) return;
  const sid = a.sessionId ?? sessions.get().currentSessionId;
  if (!sid) return;
  const slice0 = subagents.forSession(sid);
  let bucket = slice0.byId.get(a.agentId);
  if (!bucket) {
    let description = null;
    let parentToolUseId = null;
    const consumed = subagents.consumeUnboundInvocation({ agentType: a.agentType });
    if (consumed) {
      description = consumed.description ?? null;
      parentToolUseId = consumed.toolUseId ?? null;
    }
    bucket = subagents.getOrCreateBucket({
      sessionId: sid,
      agentId: a.agentId,
      agentType: a.agentType || 'agent',
      firstSeenAt: a.enqueuedAt || Date.now(),
    });
    if (!bucket) return;
    bucket.description = description;
    bucket.parentToolUseId = parentToolUseId;
    bucket.completion = null;
    if (!subagents.forSession(sid).activeId) subagents.setActive(a.agentId, sid);
  }
  const id = a.approvalId || a.toolUseId;
  if (!id) return;
  if (bucket.entries.some((e) => (e.approvalId || e.toolUseId) === id)) return;
  subagents.addEntry(a.agentId, {
    approvalId: a.approvalId ?? null,
    toolUseId: a.toolUseId ?? null,
    toolName: a.toolName,
    toolInput: a.toolInput,
    decision: a.decision ?? null,
    enqueuedAt: a.enqueuedAt || Date.now(),
  }, sid);
  if (isHighDetailTool(a.toolName)) {
    if (a.decision === null && a.approvalId) {
      sessions.for(sid).markToolExpanded(`approval-${a.approvalId}`, true);
    } else if (a.decision === 'allow' && a.toolUseId) {
      sessions.for(sid).markToolExpanded(a.toolUseId, true);
    }
  }
}

// Disk entries are historical (all resolved 'allow'); prepended to in-memory
// entries so the feed reads in time order. Skips entries that already match
// by toolUseId.
export function applyDiskSubagents(disk, sessionId) {
  if (!Array.isArray(disk)) return;
  const sid = sessionId ?? sessions.get().currentSessionId;
  if (!sid) return;
  const slice0 = subagents.forSession(sid);
  for (const s of disk) {
    if (!s || !s.agentId) continue;
    const existing = slice0.byId.get(s.agentId);
    const diskEntries = (s.entries || [])
      .filter((m) => m && m.role === 'tool_use' && m.toolName)
      .map((m) => ({
        approvalId: null,
        toolUseId: m.toolUseId ?? null,
        toolName: m.toolName,
        toolInput: m.toolInput,
        decision: 'allow',
        enqueuedAt: 0,
      }));
    if (existing) {
      const seenIds = new Set(existing.entries.map((e) => e.toolUseId).filter(Boolean));
      const prepend = diskEntries.filter((e) => !e.toolUseId || !seenIds.has(e.toolUseId));
      existing.entries = [...prepend, ...existing.entries];
      if (!existing.description && s.description) existing.description = s.description;
      if (!existing.parentToolUseId && s.parentToolUseId) existing.parentToolUseId = s.parentToolUseId;
      if (s.completion && !existing.completion) existing.completion = s.completion;
      if (s.firstSeenAt && (!existing.firstSeenAt || s.firstSeenAt < existing.firstSeenAt)) {
        existing.firstSeenAt = s.firstSeenAt;
      }
    } else {
      const bucket = subagents.getOrCreateBucket({
        sessionId: sid,
        agentId: s.agentId,
        agentType: s.agentType || 'agent',
        firstSeenAt: s.firstSeenAt || Date.now(),
      });
      if (!bucket) continue;
      bucket.description = s.description ?? null;
      bucket.parentToolUseId = s.parentToolUseId ?? null;
      bucket.completion = s.completion ?? null;
      for (const e of diskEntries) subagents.addEntry(s.agentId, e, sid);
    }
  }
  const slice = subagents.forSession(sid);
  if (!slice.activeId) {
    // Prefer a still-running agent over a stale completed one.
    const running = slice.tabOrder.find((id) => {
      const b = slice.byId.get(id);
      return b && !b.completion;
    });
    subagents.setActive(running || slice.tabOrder[0] || null, sid);
  }
}

// Thin default-sessionId wrapper around subagents.bringToFront — used by ws
// handlers that default to the current mobile session.
export function bringAgentToFront(agentId, sessionId) {
  subagents.bringToFront(agentId, sessionId ?? sessions.get().currentSessionId);
}
