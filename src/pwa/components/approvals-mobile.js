// Mobile approval-card rail. Renders the inline approval card in the
// transcript (approvalCardHtml), the cross-session toast that flies in when
// an approval arrives on a background session, the reject-with-note flow,
// and the decideApproval routing that prefers the notify WS.
//
// The "Always allow" suggestion path derives an allowlist rule from a tool
// call and POSTs it to /api/allowlist/rules on user confirmation.

import { sessions } from '../state/sessions.js';
import { approvals } from '../state/approvals.js';
import { subagents } from '../state/subagents.js';
import { usage } from '../state/usage.js';
import { escapeHtml } from '../util.js';
import { formatToolUse, renderToolExpandedBody } from './tool-use-tile.js';
import { sendOnNotifyWs, notifyWsReadyState } from '../state/notify-ws.js';
import { sendOnSessionWs } from './session-view/session-ws.js';
import { askApprovalCardHtml } from './ask-flow.js';
import { confirmInSheet } from './sheet-utils.js';
import { openAgentsForSession, openSession } from '../app-bridge.js';

let _deps = {
  showStatusToast: () => {},
  renderSession: () => {},
};

export function initApprovalsMobile(deps) {
  _deps = { ..._deps, ...deps };
  // Adaptive cadence: when any visible card is under 60s, tick every second
  // so "45s left" stays accurate; otherwise tick every 15s. Re-schedules
  // itself after each tick so cadence reacts as cards age in.
  (function scheduleApprovalCountdown() {
    const urgent = tickApprovalCountdowns();
    setTimeout(scheduleApprovalCountdown, urgent ? 1_000 : 15_000);
  })();
}

// Approval cards route through the same formatter the transcript uses, so
// the label, summary chip, detail line, and expandable payload all match.
// The approval chrome (accent left border, "Approval needed" banner, buttons)
// wraps around it. Expand-state uses "approval-<id>" so it doesn't collide
// with the tool_use_id state used by transcript tiles.
export function approvalCardHtml(a) {
  if (a.toolName === 'AskUserQuestion') return askApprovalCardHtml(a);
  // Resolve path context from the approval's own sessionId (parent or
  // subagent-tagged, always a real session id) rather than a shared
  // "currently viewed" pointer — this card can be rendered for a background
  // session (see showApprovalToast) or a subagent bucket entry.
  const slice = a.sessionId ? sessions.getSlice(a.sessionId) : null;
  const ctx = { cwd: slice?.cwd ?? null, worktreePath: slice?.spawnCwd ?? null };
  const f = formatToolUse(a.toolName, a.toolInput, a.summary, ctx);
  const detail = f.detail ? `<div class="tool-detail">${escapeHtml(f.detail)}</div>` : '';
  const expandable = a.toolInput !== undefined && a.toolInput !== null;
  const expandId = `approval-${a.approvalId}`;
  // Read expand state from the approval's own session (agents-sheet is a
  // desktop-reachable singleton too), not the mobile-only currentSlice().
  const expanded = expandable && (slice?.expandedTools.has(expandId) ?? false);
  const cls = `msg tool_use approval-card${expandable ? ' tool_use-expandable' : ''}${expanded ? ' tool_use-expanded' : ''}`;
  const idAttr = expandable ? ` data-tool-id="${escapeHtml(expandId)}"` : '';
  const chev = expandable ? `<span class="tool-chev" aria-hidden="true"></span>` : '';
  const expandedBody = expandable ? renderToolExpandedBody(a.toolName, a.toolInput, ctx) : '';
  const summary = f.body
    ? f.bodyKind === 'code'
      ? `<div class="tool-summary tool-summary-code"><code>${escapeHtml(f.body)}</code></div>`
      : `<div class="tool-summary">${escapeHtml(f.body)}</div>`
    : '';
  const enqueuedAt = a.enqueuedAt || Date.now();
  // Subagent approvals get a "via <agentType>" chip in the banner so a burst
  // from multiple concurrent subagents stays visually distinct in the parent
  // feed — matches inlineApprovalCardHtml's treatment in the desktop session-
  // view. Also flips the card class to sv-approval-card-subagent for the
  // accent-2 left rail styling defined in session-view.css.
  const agentType = a.agentType ? escapeHtml(a.agentType) : null;
  const agentChip = agentType
    ? `<span class="sv-approval-agent-chip">via ${agentType}</span>`
    : '';
  const subagentCls = agentType ? ' sv-approval-card-subagent' : '';
  return (
    `<div class="${cls}${subagentCls}"${idAttr} data-approval-id="${escapeHtml(a.approvalId)}" data-enqueued-at="${enqueuedAt}">` +
      `<div class="approval-banner">` +
        `<span class="approval-banner-label">Approval needed</span>` +
        agentChip +
        `<span class="approval-banner-meta" data-countdown>${escapeHtml(formatApprovalCountdown(enqueuedAt))}</span>` +
      `</div>` +
      `<span class="tool-label">${escapeHtml(f.label)}${chev}</span>` +
      `<div class="tool-content">` +
        summary +
        detail +
        expandedBody +
      `</div>` +
      (approvals.get().rejectionDrafts.has(a.approvalId)
        ? (
          `<div class="approval-reject-form">` +
            `<textarea class="approval-reject-reason" data-id="${escapeHtml(a.approvalId)}" rows="2" placeholder="Tell Claude why (optional)">${escapeHtml(approvals.get().rejectionDrafts.get(a.approvalId) || '')}</textarea>` +
            `<div class="approval-actions">` +
              `<button class="reject-cancel" data-id="${escapeHtml(a.approvalId)}" type="button">Cancel</button>` +
              `<button class="reject-send" data-id="${escapeHtml(a.approvalId)}" type="button" aria-label="Send rejection for ${escapeHtml(f.label)}">Send rejection</button>` +
            `</div>` +
          `</div>`
        )
        : (
          `<div class="approval-actions">` +
            `<button class="approve" data-id="${escapeHtml(a.approvalId)}" type="button" aria-label="Approve ${escapeHtml(f.label)}">Approve</button>` +
            `<button class="reject" data-id="${escapeHtml(a.approvalId)}" type="button" aria-label="Reject ${escapeHtml(f.label)}">Reject</button>` +
          `</div>`
        )
      ) +
      (a.suggestion && !approvals.get().rejectionDrafts.has(a.approvalId) ? (
        `<div class="approval-suggestion" data-approval-id="${escapeHtml(a.approvalId)}">` +
          `<div class="suggestion-text">` +
            `You've approved this ${a.suggestion.matchCount}× ${a.suggestion.triggerWindow === '24h' ? 'in the past day' : 'this week'}.` +
          `</div>` +
          `<div class="suggestion-controls">` +
            `<label class="suggestion-scope">` +
              `Always allow <code>${escapeHtml(a.suggestion.suggestedValue)}</code> in ` +
              `<select class="suggestion-scope-select">` +
                `<option value="project">this project</option>` +
                `<option value="session">this session</option>` +
                `<option value="global">all projects</option>` +
              `</select>` +
            `</label>` +
            `<button class="suggestion-confirm" type="button">Always allow</button>` +
          `</div>` +
        `</div>`
      ) : '') +
    `</div>`
  );
}

// Suggest an allowlist rule that would cover a given tool call.
export function suggestAllowRule(toolName, toolInput) {
  if (toolName === 'Bash') {
    const cmd = (toolInput && typeof toolInput.command === 'string') ? toolInput.command.trim() : '';
    if (!cmd) return null;
    const rawTokens = cmd.split(/\s+/);
    const tokens = [];
    let truncated = false;
    for (const tok of rawTokens) {
      if (!/^[a-zA-Z0-9_][\w.-]*$/.test(tok)) { truncated = true; break; }
      tokens.push(tok);
      if (tokens.length === 3) { truncated = rawTokens.length > 3; break; }
    }
    if (tokens.length === 0) return null;
    // Refuse to derive a rule when the command starts with a destructive verb
    // and we had to truncate the tokens. Without this guard, 'rm -rf /tmp/x'
    // yields '^rm \\-rf(\\s|$)' which forever allows 'rm -rf <anything>'.
    const DESTRUCTIVE = new Set(['rm', 'mv', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'mkfs', 'fdisk', 'sudo', 'doas', 'curl', 'wget']);
    if (truncated && DESTRUCTIVE.has(tokens[0])) return null;
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ');
    const pattern = `^${escaped}(\\s|$)`;
    return { kind: 'bash', value: pattern, label: `Bash · ${tokens.join(' ')}${truncated ? ' …' : ''}` };
  }
  if (toolName.startsWith('mcp__')) {
    const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { kind: 'mcp', value: `^${escaped}$`, label: toolName };
  }
  return { kind: 'tool', value: toolName, label: toolName };
}

// Promotes a backend-detected "you've approved this N times" suggestion into
// an allowlist rule, then approves the call that triggered it. `scope` is the
// wire shape POST /api/allowlist/rules accepts: 'global', { project: cwd },
// or { session: id } (session rules are in-memory only — never persisted).
// Shares the POST shape with alwaysAllowAndApprove above but takes an
// explicit scope instead of a confirm-sheet — the suggestion block already
// carries its own scope control, so a second confirmation would be noise.
export async function confirmSuggestion(approval, scope, button) {
  const suggestion = approval?.suggestion;
  if (!suggestion) return;
  if (button) button.disabled = true;
  try {
    const r = await fetch('/api/allowlist/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: suggestion.kind,
        value: suggestion.suggestedValue,
        scope: scope ?? 'global',
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    sendApprovalDecide({ approvalId: approval.approvalId, decision: 'allow' });
  } catch (e) {
    console.error('promotion failed', e);
    if (button) button.disabled = false;
    _deps.showStatusToast('Promotion failed — try again');
  }
}

// Confirm-sheet + POST to /api/allowlist/rules. On success: refresh the
// info so the list-footer rule count updates, then approve the original
// call. Duplicate rules return added:false; we still approve the call but
// skip the "rule added" toast since nothing actually changed.
export async function alwaysAllowAndApprove(approvalId, toolName, toolInput) {
  const suggested = suggestAllowRule(toolName, toolInput);
  if (!suggested) {
    _deps.showStatusToast('Cannot derive a rule from this call');
    return;
  }
  const ok = await confirmInSheet({
    title: 'Always allow this?',
    body: `Future tool calls matching “${suggested.label}” will be auto-approved without prompting. Saved to the allowlist on disk.`,
    confirmLabel: 'Always allow',
    danger: false,
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/allowlist/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: suggested.kind, value: suggested.value }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (usage.get().daemonInfo) usage.setDaemonInfo({ ...usage.get().daemonInfo, allowlistRuleCount: data.ruleCount });
    _deps.showStatusToast(data.added ? 'Rule added — call approved' : 'Rule already present', 'success');
  } catch (e) {
    _deps.showStatusToast(`Save failed: ${(e && e.message) || 'unknown'}`);
    return;
  }
  decideApproval(approvalId, 'allow');
}

// Approval countdown — "8m left" / "45s left" / "expired". Reads the timeout
// from /api/info (with a 10-min fallback for the brief window before info
// loads).
export function formatApprovalCountdown(enqueuedAt) {
  const timeoutMs = usage.get().daemonInfo?.approvalTimeoutMs ?? 10 * 60 * 1000;
  const remaining = enqueuedAt + timeoutMs - Date.now();
  if (remaining <= 0) return 'expired';
  if (remaining < 60_000) return `${Math.ceil(remaining / 1000)}s left`;
  return `${Math.ceil(remaining / 60_000)}m left`;
}

// Walk every visible approval card's countdown span and update its text +
// urgent class. Returns true if any card has under 60s remaining — used by
// the adaptive scheduler to upgrade to a 1s tick.
function tickApprovalCountdowns() {
  let anyUrgent = false;
  for (const card of document.querySelectorAll('.approval-card[data-enqueued-at]')) {
    const enqueuedAt = Number(card.dataset.enqueuedAt) || 0;
    if (!enqueuedAt) continue;
    const meta = card.querySelector('[data-countdown]');
    if (!meta) continue;
    meta.textContent = formatApprovalCountdown(enqueuedAt);
    const timeoutMs = usage.get().daemonInfo?.approvalTimeoutMs ?? 10 * 60 * 1000;
    const remaining = enqueuedAt + timeoutMs - Date.now();
    if (remaining > 0 && remaining < 60_000) anyUrgent = true;
    meta.classList.toggle('approval-banner-meta-urgent', remaining > 0 && remaining < 60_000);
    meta.classList.toggle('approval-banner-meta-expired', remaining <= 0);
  }
  return anyUrgent;
}

// Cross-session toast: shown when an approval arrives on a session that
// isn't the one currently in view. Slides in from above the header for ~7s.
// Tap to switch to that session.
export function showApprovalToast(a) {
  // Replace any toast already on screen so we never stack — newest wins.
  document.getElementById('toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = 'toast';
  toast.setAttribute('role', 'alert');
  const sessionLabel = a.sessionTitle
    ? escapeHtml(a.sessionTitle)
    : escapeHtml('Session ' + String(a.sessionId).slice(0, 8));
  toast.innerHTML = `
    <div class="top-line">
      <span class="label">Approval needed</span>
      <span class="arrow">↗</span>
    </div>
    <div class="tool">${escapeHtml(a.toolName)}</div>
    <div class="session-ref">${sessionLabel}</div>
  `;
  toast.onclick = () => {
    toast.remove();
    const sid = a.sessionId;
    // Navigate to the session, then for subagent approvals also pop the agents
    // sheet so the user lands directly on the pending feed. Both go through the
    // app bridge because each layout routes differently — mobile flips
    // sessions.view, desktop selects the sessions surface via nav.
    const nav = openSession({ id: sid });
    if (a.agentId) {
      Promise.resolve(nav).finally(() => {
        if (subagents.forSession(sid).byId.size > 0) openAgentsForSession(sid);
      });
    }
  };
  document.body.appendChild(toast);
  // Match the CSS animation timeline: 0.34s in, 6.6s wait, 0.34s out.
  setTimeout(() => toast.remove(), 7400);
}

// Send an approval decision over the most reliable channel available.
// Notifications WS is preferred — it survives iOS backgrounding and is the
// channel that delivered the approval_pending. If both WSs are down, queue
// the decide for flush when the notifications WS next opens.
export function sendApprovalDecide(payload) {
  const wire = JSON.stringify({ type: 'approval_decide', ...payload });
  if (sendOnNotifyWs(wire)) return true;
  const sid = sessions.get().currentSessionId;
  if (sid && sendOnSessionWs(sid, wire)) return true;
  approvals.enqueueDecide(payload);
  return false;
}

export function flushPendingDecides() {
  if (approvals.get().pendingDecides.length === 0) return;
  if (notifyWsReadyState() !== WebSocket.OPEN) return;
  const drain = approvals.drainDecides();
  for (const p of drain) sendOnNotifyWs({ type: 'approval_decide', ...p });
}

// Reject-with-note flow. The reject button swaps the card's actions for a
// textarea so the user can tell Claude WHY. The reason is plumbed as
// permissionDecisionReason (hook-handler.ts), which Claude reads as feedback.
export function beginRejectWithNote(id) {
  approvals.setRejectionDraft(id, '');
  _deps.renderSession();
  requestAnimationFrame(() => {
    const ta = document.querySelector(`.approval-reject-reason[data-id="${id}"]`);
    if (ta instanceof HTMLTextAreaElement) ta.focus();
  });
}

export function cancelRejectWithNote(id) {
  if (!approvals.get().rejectionDrafts.has(id)) return;
  approvals.clearRejectionDraft(id);
  _deps.renderSession();
}

export function submitRejectWithNote(id) {
  // Prefer the live textarea value (covers the case where renderSession
  // hasn't fired since the user's last keystroke), falling back to whatever
  // we've cached in state.
  const ta = document.querySelector(`.approval-reject-reason[data-id="${id}"]`);
  const live = ta instanceof HTMLTextAreaElement ? ta.value : null;
  const draft = live != null ? live : (approvals.get().rejectionDrafts.get(id) || '');
  const reason = draft.trim() || undefined;
  approvals.clearRejectionDraft(id);
  decideApproval(id, 'deny', reason);
}

export function decideApproval(id, decision, reason) {
  // For denials, capture the transcript stamp before removePending wipes the
  // approval — the tool_use tile needs { decision: 'deny', rejectReason } to
  // render as rejected in both the current session-view and any late-
  // arriving tool_use block. Use the approval's own sessionId so cross-
  // session rejections stamp the right slice.
  if (decision === 'deny') {
    const approval = approvals.get().pending.find((a) => a.approvalId === id);
    const useId = approval?.toolUseId;
    const sid = approval?.sessionId;
    if (useId) {
      approvals.recordRejection(useId, reason || '');
      if (sid) {
        sessions.for(sid).mapTranscript((m) =>
          m.role === 'tool_use' && m.toolUseId === useId
            ? { ...m, decision: 'deny', rejectReason: reason || '' }
            : m,
        );
      }
    }
  }
  const sent = sendApprovalDecide({ approvalId: id, decision, ...(reason ? { reason } : {}) });
  if (!sent) _deps.showStatusToast('Queued — will send when connected');
  approvals.removePending(id);
  // Mirror the decision into any matching subagent bucket entry.
  for (const [, slice] of subagents.get().bySession) {
    for (const [, bucket] of slice.byId) {
      for (const e of bucket.entries) {
        if (e.approvalId === id && e.decision === null) {
          e.decision = decision === 'allow' ? 'allow' : 'deny';
          break;
        }
      }
    }
  }
  _deps.renderSession();
}
