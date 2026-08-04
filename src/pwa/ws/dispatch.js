// WebSocket message dispatcher. Every frame the client receives — whether on a
// per-session `/ws/sessions/<id>` socket or the singleton `/ws/notifications`
// socket — routes through here.
//
// Two dispatch tables: `sessionHandlers` for messages arriving on a session WS
// (session-scoped mutations, transcript growth, subprocess lifecycle) and
// `broadcastHandlers` for the global notification WS (approvals, cross-session
// state changes, background events).
//
// State stores and stateless helpers are imported directly. App-level side
// effects (renderers, toasts, sheet openers, thinking-lifecycle helpers) can't
// import from app.js without cycling, so they're passed in via
// installDispatchDeps() at boot.

import { sessions, applyPendingExpand, expandToolByContent } from '../state/sessions.js';
import { approvals } from '../state/approvals.js';
import {
  subagents,
  applyTaskUse,
  applyTaskResult,
  applyTaskNotification,
  recordParentAgentInvocation,
  addSubagentEntry,
  bringAgentToFront,
} from '../state/subagents.js';
import { usage } from '../state/usage.js';
import { work } from '../state/work.js';
import { settings } from '../state/settings.js';
import { EDIT_TOOLS, TASK_TOOL_NAMES, isHighDetailTool } from '../components/tool-use-tile.js';
import { TOOL_VERBS } from '../components/session-view/regions.js';
import { sendApprovalModeSet, forceCloseSessionWs } from '../components/session-view/session-ws.js';
import { openSession } from '../app-bridge.js';

let deps = /** @type {any} */ (null);

// How long the thinking strip keeps showing a just-finished tool's verb
// before falling back to "thinking" — long enough that fast tools (Read,
// Grep, Glob) don't flash the verb too briefly to read.
const VERB_LINGER_MS = 10_000;

// Debounces work_launch_changed bursts (a governor drain() pass can fire onChange
// several times in a row) into a single jobs-list refetch.
let launchStatusRefetchTimer = null;
function scheduleLaunchStatusRefetch() {
  if (launchStatusRefetchTimer) return;
  launchStatusRefetchTimer = setTimeout(() => {
    launchStatusRefetchTimer = null;
    void work.loadAll();
  }, 200);
}

// Fields expected on the deps object:
//   state — the app.js mutable state object (pendingNewSession, lingeringTimer, bypassConfirmPending)
//   renderSession / renderList / render — top-level renderers. renderSession
//     is a no-op today (session-view/index.js's own paint() already repaints
//     reactively via store subscriptions for whichever session is mounted;
//     kept only so this module's many call sites don't need a follow-up edit)
//   showApprovalToast, openCwdPickerSheet, refreshHeaderModeChip, setAcceptEdits — UI side effects
//   applyTaskUse, applyTaskResult, applyTaskNotification, applyPendingExpand,
//   expandToolByContent, recordUsage, startThinking, stopThinking,
//   recordParentAgentInvocation, addSubagentEntry, bringAgentToFront,
//   ensureAskInlineTile, leaveSession, sendApprovalDecide — app.js helpers
export function installDispatchDeps(d) {
  deps = d;
}

// Entry point for per-session WS messages. Filters out sidechain content
// (subagent-generated frames that the agents sheet feed already handles) and
// stamps out pendingNewSession on the first non-error frame so a bad-cwd spawn
// bounces back to the picker via daemon_error.
export function dispatchSession(msg, sid) {
  if (
    msg.isSidechain === true
    || msg.parent_tool_use_id
    || msg.parentToolUseId
    || msg.agent_id
    || msg.agentId
  ) return;
  const resolvedSid = sid ?? sessions.get().currentSessionId;
  const isCurrent = resolvedSid === sessions.get().currentSessionId;
  if (msg.type !== 'daemon_error' && deps.state.pendingNewSession && deps.state.pendingNewSession.id === resolvedSid) {
    deps.state.pendingNewSession = null;
  }
  const h = sessionHandlers[msg.type];
  if (h) h(msg, resolvedSid, isCurrent);
}

// Entry point for notification-WS messages. No sid resolution — these are
// global broadcasts that carry their own sessionId (or none) inside the frame.
export function dispatchBroadcast(msg) {
  const h = broadcastHandlers[msg.type];
  if (h) h(msg);
}

const sessionHandlers = {
  assistant(msg, sid, isCurrent) {
    const S = sessions.for(sid);
    const msgId = msg.message?.id;
    const blocks = msg.message?.content ?? [];
    let processed = false;
    for (const b of blocks) {
      if (b.type === 'text') {
        const sig = `${msgId}|${b.text}`;
        if (subagents.hasBlockSig(sig)) continue;
        subagents.markBlockSigSeen(sig);
        S.appendTranscript({ role: 'assistant', text: b.text, msgId });
        processed = true;
      } else if (b.type === 'tool_use') {
        if (b.id && subagents.hasBlockSig(b.id)) continue;
        if (b.id) subagents.markBlockSigSeen(b.id);
        if (b.name && TASK_TOOL_NAMES.has(b.name)) {
          applyTaskUse(b.name, b.input, b.id, sid);
          processed = true;
          continue;
        }
        if (b.name === 'AskUserQuestion') {
          deps.ensureAskInlineTile({ toolInput: b.input, msgId, toolUseId: b.id }, sid);
          processed = true;
          continue;
        }
        // hook stream only carries agent_id+agent_type; capture parent description for binding
        if (b.name === 'Agent' && b.input && typeof b.input === 'object') {
          recordParentAgentInvocation({
            toolUseId: b.id,
            subagentType: b.input.subagent_type,
            description: b.input.description,
          });
        }
        // approval card races content_block_stop; pre-stamp if already rejected
        const preReject = b.id ? approvals.get().rejectionReasons.get(b.id) : undefined;
        S.appendTranscript({
          role: 'tool_use',
          text: `${b.name}(${JSON.stringify(b.input).slice(0, 200)})`,
          toolName: b.name,
          toolInput: b.input,
          ...(b.id ? { toolUseId: b.id } : {}),
          ...(preReject ? { decision: 'deny', rejectReason: preReject.reason } : {}),
          msgId,
        });
        applyPendingExpand(b.name, b.input, b.id, sid);
        if (b.id) {
          S.recordActiveTool({ toolUseId: b.id, toolName: b.name });
          if (deps.state.lingeringTimer) clearTimeout(deps.state.lingeringTimer);
          S.setLingeringVerb(null);
          deps.state.lingeringTimer = null;
        }
        // auto-expansion is driven by tool_auto_allowed, NOT tool_use arrival — otherwise
        // user-approved calls would expand whenever tool_use raced ahead of the click
        processed = true;
      }
    }
    if (!processed) return; // thinking-only delivery
    deps.recordUsage(msg.message?.usage, msg.message?.model, sid);
    // only terminal stop_reasons stop the thinking strip; tool_use means more turns coming
    const reason = msg.message?.stop_reason;
    if (reason && reason !== 'tool_use') {
      deps.stopThinking(sid);
    } else if (!sessions.getSlice(sid)?.thinking) {
      deps.startThinking(sid);
    }
    if (isCurrent) deps.renderSession();
  },

  stream_event(msg, sid, isCurrent) {
    // message_stop fires at the end of EVERY assistant turn; message_delta is canonical
    const ev = msg.event ?? msg;
    const deltaReason = ev?.delta?.stop_reason;
    if (deltaReason && deltaReason !== 'tool_use') {
      deps.stopThinking(sid);
      if (isCurrent) deps.renderSession();
    }
    if (!sessions.getSlice(sid)?.thinking && ev?.type && ev.type !== 'message_stop' && ev.type !== 'message_delta') {
      deps.startThinking(sid);
      if (isCurrent) deps.renderSession();
    }
    const slice = sessions.getSlice(sid);
    if (!slice?.thinking) return;
    const u = ev?.usage ?? ev?.message?.usage;
    const out = u?.output_tokens;
    if (typeof out === 'number') {
      if (out > slice.thinkingOutputTokens) {
        sessions.for(sid).updateThinking({ tokens: out });
      }
    }
    // estimate ~4 chars/token between message_deltas to keep the counter climbing.
    // No eager repaint here — the per-mount 200ms metaTicker repaints the strip;
    // painting per-delta made the digits shimmer sub-frame.
    if (ev?.type === 'content_block_delta') {
      const d = ev?.delta;
      let added = 0;
      if (d?.type === 'text_delta' && typeof d.text === 'string') added = d.text.length;
      else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') added = d.partial_json.length;
      else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') added = d.thinking.length;
      if (added > 0) {
        const sl = sessions.getSlice(sid);
        const chars = (sl?.thinkingOutputChars ?? 0) + added;
        const estimated = Math.ceil(chars / 4);
        if (estimated > (sl?.thinkingOutputTokens ?? 0)) {
          sessions.for(sid).updateThinking({ chars, tokens: estimated });
        } else {
          sessions.for(sid).updateThinking({ chars });
        }
      }
    }
  },

  user(msg, sid, isCurrent) {
    // two shapes: string (synthetic <task-notification>) or array of tool_result blocks
    const S = sessions.for(sid);
    const content = msg.message?.content;
    if (typeof content === 'string') {
      if (content.trimStart().startsWith('<task-notification>')) {
        if (applyTaskNotification(content, sid) && isCurrent) deps.renderSession();
      }
      return;
    }
    const blocks = content;
    if (!Array.isArray(blocks)) return;
    let touched = false;
    for (const b of blocks) {
      if (b?.type !== 'tool_result') continue;
      const useId = b.tool_use_id;
      if (!useId) continue;
      // pop the matching in-flight entry; thinking-strip verb falls back to next active or lingers
      const sliceForTools = sessions.getSlice(sid);
      const activeTools = sliceForTools?.activeTools ?? [];
      const idx = activeTools.findIndex((t) => t.toolUseId === useId);
      if (idx >= 0) {
        const popped = activeTools[idx];
        S.clearActiveTool(useId);
        // empty stack: hold the verb long enough to read; next push clears lingering immediately
        const remaining = sessions.getSlice(sid)?.activeTools ?? [];
        if (remaining.length === 0 && TOOL_VERBS[popped.toolName]) {
          S.setLingeringVerb(TOOL_VERBS[popped.toolName]);
          if (deps.state.lingeringTimer) clearTimeout(deps.state.lingeringTimer);
          // S.setLingeringVerb(null) below is the only side effect that
          // matters — session-view's own slice subscription already repaints
          // the thinking strip from it, on both layouts.
          deps.state.lingeringTimer = setTimeout(() => {
            S.setLingeringVerb(null);
            deps.state.lingeringTimer = null;
          }, VERB_LINGER_MS);
        }
        touched = true;
      }
      const innerBlocks = Array.isArray(b.content) ? b.content : null;
      const text = typeof b.content === 'string'
        ? b.content
        : innerBlocks
          ? innerBlocks.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
          : '';
      // stream-JSON has no toolUseResult sidecar; agentId regex is the only completion signal
      const agentMatch = /agentId:\s*([a-f0-9]+)/i.exec(text);
      if (agentMatch) {
        const agentId = agentMatch[1];
        const bucket = subagents.forSession(sid).byId.get(agentId);
        if (bucket && !bucket.completion) {
          let summary = null;
          if (innerBlocks) {
            for (const inner of innerBlocks) {
              if (inner?.type === 'text' && typeof inner.text === 'string' && !inner.text.startsWith('agentId:')) {
                summary = inner.text.trim();
                break;
              }
            }
          }
          subagents.setCompletion(agentId, sid, {
            status: 'completed',
            summary,
            result: null,
            completedAt: Date.now(),
          });
          touched = true;
        }
      }
      if (subagents.get().pendingCreates.has(useId)) {
        applyTaskResult(useId, text, sid);
        touched = true;
      } else if (approvals.get().pendingAsks.has(useId)) {
        const entry = approvals.get().pendingAsks.get(useId);
        entry.answer = text;
        approvals.resolvePendingAsk(useId);
        approvals.markTaskResultConsumed(useId);
        touched = true;
      }
    }
    if (touched && isCurrent) deps.renderSession();
  },

  daemon_error(msg, sid, isCurrent) {
    if (deps.state.pendingNewSession && deps.state.pendingNewSession.id === sid) {
      const failedCwd = deps.state.pendingNewSession.cwd;
      deps.state.pendingNewSession = null;
      if (isCurrent) deps.leaveSession();
      deps.openCwdPickerSheet({ message: msg.message, failedCwd });
      return;
    }
    sessions.for(sid).appendTranscript({ role: 'error', text: msg.message });
    deps.stopThinking(sid);
    if (isCurrent) deps.renderSession();
  },

  daemon_proc_exit(msg, sid, isCurrent) {
    const S = sessions.for(sid);
    deps.stopThinking(sid);
    // Subprocess exit → this session's slice becomes 'inactive'. Background
    // sessions never get demoted otherwise, so this is where we detect death.
    // Force-close its WS: keeping a socket open to an already-dead session
    // wastes a connection and the daemon drops it anyway.
    sessions.setRunState(sid, 'inactive');
    forceCloseSessionWs(sid);
    const now = Date.now();
    for (const [agentId, bucket] of subagents.forSession(sid).byId) {
      if (!bucket.completion) subagents.setCompletion(agentId, sid, { status: 'killed', completedAt: now });
    }
    const slice = sessions.getSlice(sid);
    if (slice?.expectedInterrupt) {
      // user-initiated stop: skip the error+Reopen tile and resume transparently
      S.clearExpectInterrupt();
      if (sid) { openSession({ id: sid }); return; }
    }
    if (slice?.expectedArchive) {
      // user archived the session: the SIGTERM is expected, so show a calm
      // notice rather than a crash tile — and no Reopen (the worktree is gone).
      S.clearExpectArchive();
      S.appendTranscript({ role: 'archived', text: 'Session archived.' });
      if (isCurrent) deps.renderSession();
      return;
    }
    if (msg.expected) {
      // Daemon-initiated graceful shutdown (idle reap / step teardown), not a crash.
      // The SIGTERM makes claude exit 143, which would otherwise read as a crash even
      // though the session's work already landed. An idle-reaped session resumes on the
      // next message; a teardown/archive is gone for good.
      S.appendTranscript({
        role: 'archived',
        text: msg.reason === 'idle'
          ? 'Session reaped after 15 min idle — send a message to resume.'
          : 'Session archived.',
      });
      if (isCurrent) deps.renderSession();
      return;
    }
    S.appendTranscript({
      role: 'error',
      text: `Session subprocess exited (code ${msg.code}).`,
      action: 'reopen',
    });
    if (isCurrent) deps.renderSession();
  },

  daemon_statusline(msg, sid) {
    // authoritative; carries real context_window_size so 1M Opus doesn't look 5× over
    const sl = {
      model: msg.model ?? null,
      contextWindow: msg.contextWindow ?? null,
      cost: msg.cost ?? null,
      rateLimits: msg.rateLimits ?? null,
      effort: msg.effort ?? null,
      exceeds200k: !!msg.exceeds200k,
    };
    // Attribute to the socket's own session id, not the mobile-singleton
    // `currentSessionId` pointer — desktop's multi-live sessions each have
    // their own per-session WS and need their own statusline entry (the
    // Sessions right rail's info card reads the slice's statusline per session).
    if (sid) sessions.for(sid).setStatusline(sl);
  },

  approval_mode(msg, sid, isCurrent) {
    // first broadcast on a fresh session: push the per-client default if it differs from 'ask'.
    // Flag lives on the slice so mobile and desktop tabs share the same trigger; the send
    // routes through session-ws regardless.
    const slice = sessions.getSlice(sid);
    const desired = settings.get().defaultApprovalMode;
    if (slice?.pendingDefaultPush && desired !== 'ask' && desired !== msg.mode) {
      sessions.for(sid).setPendingDefaultPush(false);
      const sent = sendApprovalModeSet(sid, desired);
      if (sent) return;
    }
    sessions.for(sid).setPendingDefaultPush(false);
    sessions.for(sid).setApprovalMode(msg.mode);
    if (isCurrent) sessions.setApprovalMode(msg.mode);
    deps.state.bypassConfirmPending = false;
    if (isCurrent) deps.setAcceptEdits(msg.mode === 'accept-edits');
    deps.refreshHeaderModeChip();
  },
};

const broadcastHandlers = {
  daemon_account_usage(msg) {
    // `breakdown` (per-model cost/burn-rate/runway) rides alongside rateLimits
    // in the same broadcast — folded into accountUsage so both the mobile meter
    // (five_hour/seven_day) and the desktop sidebar-foot popover (breakdown) read
    // one field. Absent on daemons that haven't computed it yet; consumers guard.
    // setAccountUsage's store mutation drives both the mobile meter and the
    // desktop sidebar-foot popover via their own usage.subscribe() hooks.
    usage.setAccountUsage(msg.rateLimits ? { ...msg.rateLimits, breakdown: msg.breakdown ?? null } : null);
  },

  notifications_snapshot(msg) {
    approvals.setPending(Array.isArray(msg.approvals) ? msg.approvals : []);
    for (const a of approvals.get().pending) {
      // Each approval carries its own sessionId — route the "expand this tool"
      // marker to that session's slice, not the current mobile session.
      if (isHighDetailTool(a.toolName) && a.sessionId) {
        sessions.for(a.sessionId).markToolExpanded(`approval-${a.approvalId}`, true);
      }
    }
    // additive re-apply; addSubagentEntry dedupes so resolved entries aren't
    // dropped on reconnect. Scoped to sessions the client already has a slice
    // for (i.e. opened this browser session) rather than the mobile-only
    // currentSessionId pointer — desktop can have several live tabs at once,
    // and gating on "current" silently skipped every one of them there.
    const known = sessions.get().sessionsById;
    for (const a of approvals.get().pending) {
      if (!a.sessionId || !known.has(a.sessionId)) continue;
      if (a.agentId) {
        addSubagentEntry(a);
      } else if (a.toolName === 'AskUserQuestion') {
        deps.ensureAskInlineTile({ toolInput: a.toolInput }, a.sessionId);
      }
    }
    const view = sessions.get().view;
    if (view === 'list') deps.renderList();
    else if (view === 'session') deps.renderSession();
  },

  work_job_changed(msg) {
    // Tracked-job surfaces (Tracked list/detail) already react to work.applyWsEvent
    // via their own store subscription — no forced re-render needed here.
    work.applyWsEvent({ jobId: msg.jobId, job: msg.job });
  },

  sessions_changed() {
    // Daemon debounces the broadcast (200ms) already, so pull the fresh list here.
    // renderList / renderDesktop react to sessions.projects via subscribe, so
    // there's no need to force a re-render explicitly.
    deps.loadSessions();
  },

  actions_changed() {
    import('../state/actions.js').then(({ actions: actStore }) => { void actStore.load(); });
  },

  user_prs_changed(msg) {
    import('../state/user-prs.js').then(({ userPrs }) => userPrs.applyWsEvent(msg.snapshot));
  },

  run_appended(msg) {
    import('../state/runs.js').then(({ runs }) => runs.applyWsAppend(msg.run));
  },

  action_run_settled(msg) {
    import('../state/library.js').then(({ library }) => library.invalidateScorecard(msg.action));
  },

  launch_concurrency_changed(msg) {
    settings.applyLaunchConcurrency(msg.value);
  },

  // Governor state changed (a launch fired/parked/freed a slot) — carries no jobId,
  // so refetch the jobs list to pick up fresh launchStatus everywhere. Debounced: a
  // drain() pass can fire onChange several times in a row.
  work_launch_changed() {
    scheduleLaunchStatusRefetch();
  },

  schedules_changed(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => schedulesStore.applyWsEvent(msg));
  },

  schedule_run_changed(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => schedulesStore.applyWsEvent(msg));
  },

  schedule_draft_ready(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => {
      schedulesStore.setDraft(msg.sessionId, {
        name: msg.name, summary: msg.summary, trigger: msg.trigger, what: msg.what,
      });
    });
  },

  schedule_draft_failed(msg) {
    import('../state/schedules.js').then(({ schedulesStore }) => {
      schedulesStore.setDraftFailed(msg.sessionId, msg.reason);
    });
  },

  action_edit_activity(msg) {
    import('../state/actions.js').then(({ actions: actStore }) => {
      actStore.pushActivity(msg.sessionId, msg.toolName, msg.at);
    });
  },

  agent_activity(msg) {
    // sent in place of approval_pending when allowlist short-circuits; needed so read-only subagents show up.
    // sessionId must ride along — addSubagentEntry's currentSessionId fallback
    // is a mobile-only pointer (null on desktop, wrong session on mobile when
    // the activity came from a background session).
    addSubagentEntry({
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      agentId: msg.agentId,
      agentType: msg.agentType,
      sessionId: msg.sessionId,
      decision: 'allow',
    });
    if (msg.sessionId === sessions.get().currentSessionId) {
      const view = sessions.get().view;
      if (view === 'session') deps.renderSession();
      else if (view === 'list') deps.renderList();
    }
  },

  tool_auto_allowed(msg) {
    // Hook can fire before or after content_block_stop — expandToolByContent matches
    // now or queues for later, either order works. Route to the source session's slice
    // so background sessions keep their expand-on-arrival behavior.
    if (isHighDetailTool(msg.toolName) && msg.sessionId) {
      expandToolByContent(msg.toolName, msg.toolInput, msg.sessionId);
      if (msg.sessionId === sessions.get().currentSessionId && sessions.get().view === 'session') {
        deps.renderSession();
      }
    }
  },

  approval_pending(msg) {
    if (approvals.get().pending.some((a) => a.approvalId === msg.approvalId)) return;
    // Mark the target session's tool as expanded so its details are visible
    // when the user lands on the approval.
    if (isHighDetailTool(msg.toolName) && msg.sessionId) {
      sessions.for(msg.sessionId).markToolExpanded(`approval-${msg.approvalId}`, true);
    }
    if (settings.get().acceptEdits && EDIT_TOOLS.has(msg.toolName)) {
      // Decide on the notifications WS — the only channel that survives iOS backgrounding.
      // Session WS would re-introduce the silent-drop bug where a backgrounded close
      // caused the hook to time out 10min later with a denied edit.
      deps.sendApprovalDecide({ approvalId: msg.approvalId, decision: 'allow' });
      if (msg.agentId) {
        addSubagentEntry({ ...msg, decision: 'allow' });
      } else if (msg.sessionId) {
        expandToolByContent(msg.toolName, msg.toolInput, msg.sessionId);
      }
      if (msg.sessionId === sessions.get().currentSessionId && sessions.get().view === 'session') {
        deps.renderSession();
      }
      return;
    }
    approvals.addPending(msg);
    if (msg.agentId) {
      const targetSlice = subagents.forSession(msg.sessionId);
      const wasNew = !targetSlice.byId.has(msg.agentId);
      addSubagentEntry(msg);
      // Reorder / activate operations touch the TARGET session's slice —
      // not necessarily the mobile-current session's — so background sessions'
      // subagent state also updates in real-time.
      bringAgentToFront(msg.agentId, msg.sessionId);
      const targetSliceAfter = subagents.forSession(msg.sessionId);
      const cur = targetSliceAfter.activeId ? targetSliceAfter.byId.get(targetSliceAfter.activeId) : null;
      const curHasPending = cur ? cur.entries.some((e) => e.decision === null) : false;
      if (!curHasPending) subagents.setActive(msg.agentId, msg.sessionId);
      if (msg.sessionId === sessions.get().currentSessionId) {
        const view = sessions.get().view;
        if (view === 'session') deps.renderSession();
        else if (view === 'list') deps.renderList();
      }
      void wasNew;
      return;
    }
    if (msg.toolName === 'AskUserQuestion' && msg.sessionId === sessions.get().currentSessionId) {
      deps.ensureAskInlineTile({ toolInput: msg.toolInput });
    }
    const view = sessions.get().view;
    if (view === 'session' && msg.sessionId === sessions.get().currentSessionId) {
      deps.renderSession();
    } else {
      if (view === 'list') deps.renderList();
      deps.showApprovalToast(msg);
    }
  },

  // Fires for cross-device user decisions and for server-side timeouts.
  approval_resolved(msg) {
    const wasPending = approvals.get().pending.some((a) => a.approvalId === msg.approvalId);
    approvals.removePending(msg.approvalId);
    // Store-notifying write: the Sessions rail repaints only off
    // subagents.subscribe, so a direct in-place decision flip would leave its
    // subagent live-tail frozen until an unrelated store tick.
    subagents.resolveApproval(msg.approvalId, msg.decision, msg.timedOut);
    // Timed-out tile is recorded in the target session's transcript (was
    // previously dropped for background sessions).
    if (msg.timedOut && wasPending && msg.sessionId && !msg.agentId) {
      sessions.for(msg.sessionId).appendTranscript({
        role: 'error',
        text: `${msg.toolName} approval timed out after 10 minutes — re-prompt to retry.`,
      });
    }
    if (msg.sessionId === sessions.get().currentSessionId) {
      const view = sessions.get().view;
      if (view === 'session') deps.renderSession();
      else if (view === 'list') deps.renderList();
    }
  },
};
