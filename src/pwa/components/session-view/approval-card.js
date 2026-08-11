import { escapeHtml } from '../../util.js';
import { askApprovalCardHtml } from '../ask-card.js';
import { toolUseHtml, shellLineHtml, readLineHtml } from '../tool-use-tile.js';
import { decideApproval } from '../../app-bridge.js';
import { isDesktop } from '../../layout/index.js';
import { approvals } from '../../state/approvals.js';
import { sessions } from '../../state/sessions.js';
import { formatApprovalCountdown, confirmSuggestion } from '../approvals-mobile.js';

// Same dispatch the feed's toolTileHtml uses — approval cards render the
// pending tool the exact way it would land in the transcript once approved.
const SHELL_TOOLS = new Set(['Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch']);

// Approval objects carry the sessionId of the session they belong to (parent
// or subagent-tagged, always the top-level session) — resolve the tile's path
// context from that session's own slice rather than any shared "currently
// viewed" pointer, so a background/cross-session approval card still shortens
// paths against the right project.
function ctxForApproval(a) {
  const slice = a.sessionId ? sessions.getSlice(a.sessionId) : null;
  return { cwd: slice?.cwd ?? null, worktreePath: slice?.spawnCwd ?? null };
}

// Reject-form state (open flag + typed reason) keyed by approvalId. Module-
// scoped rather than on the reactive approvals store for the same reason
// ask-card keeps askDrafts off it: renderTranscript rebuilds this card's DOM
// on every WS tick / approvals change, and the draft must survive that
// without triggering another repaint per keystroke.
const rejectDrafts = new Map();
function getRejectDraft(id) {
  return rejectDrafts.get(id) ?? { open: false, reason: '' };
}

// The suggestion scope <select> is rebuilt on the same repaints — keep the
// user's choice keyed by approvalId so a WS tick can't flip it back to the
// default right before they hit "Always allow".
const suggestionScopeChoice = new Map();

function toolTileForApproval(a) {
  const ctx = ctxForApproval(a);
  if (a.toolName === 'Read') return readLineHtml(a.toolInput, ctx);
  if (SHELL_TOOLS.has(a.toolName)) return shellLineHtml(a.toolName, a.toolInput, ctx);
  return toolUseHtml({
    toolName: a.toolName,
    toolInput: a.toolInput,
    toolUseId: `approval-${a.approvalId}`,
    text: '',
  }, {
    ctx,
    // Expand state belongs to the approval's own session — the same resolution
    // approvals-mobile.js uses. toolUseHtml's fallback is currentSlice(), which
    // is empty on desktop (nav selection, not currentSessionId), so without this
    // the tile could never read back the expansion the tap handler just wrote.
    expandedTools: (a.sessionId ? sessions.getSlice(a.sessionId)?.expandedTools : null) ?? new Set(),
  });
}

// `mobile` extras: the countdown chip is mobile-only (mirrors the legacy
// mobile-session-view.js singleton's approvalCardHtml — desktop's own header
// chrome already surfaces enough urgency without it). The "always allow
// N-times" suggestion, though, is useful on both layouts — desktop sessions
// hit the same repeated-approval pattern — so it renders whenever the
// approval carries a `suggestion`, regardless of layout. The countdown
// ticker itself (approvals-mobile.js's initApprovalsMobile) is already
// running unconditionally and drives ANY `[data-countdown]` inside a
// `.approval-card[data-enqueued-at]` it finds in the document — no extra
// wiring needed here beyond emitting the matching markup.
export function inlineApprovalCardHtml(a, opts = {}) {
  if (a.toolName === 'AskUserQuestion') return askApprovalCardHtml(a);
  const agentType = opts.agentType ? escapeHtml(opts.agentType) : null;
  const agentChip = agentType
    ? `<span class="sv-approval-agent-chip">via ${agentType}</span>`
    : '';
  const tile = toolTileForApproval(a);
  const mobile = !isDesktop();
  const enqueuedAt = a.enqueuedAt || Date.now();
  const countdownChip = mobile
    ? `<span class="approval-banner-meta" data-countdown>${escapeHtml(formatApprovalCountdown(enqueuedAt))}</span>`
    : '';
  const chosenScope = suggestionScopeChoice.get(a.approvalId) ?? 'project';
  const scopeOption = (value, label) =>
    `<option value="${value}"${chosenScope === value ? ' selected' : ''}>${label}</option>`;
  const suggestionHtml = a.suggestion ? (
    `<div class="approval-suggestion" data-approval-id="${escapeHtml(a.approvalId)}">` +
      `<div class="suggestion-text">You've approved this ${escapeHtml(String(a.suggestion.matchCount))}× ${a.suggestion.triggerWindow === '24h' ? 'in the past day' : 'this week'}.</div>` +
      `<div class="suggestion-controls">` +
        `<label class="suggestion-scope">` +
          `Always allow <code>${escapeHtml(a.suggestion.suggestedValue)}</code> in ` +
          `<select class="suggestion-scope-select">` +
            scopeOption('project', 'this project') +
            scopeOption('session', 'this session') +
            scopeOption('global', 'all projects') +
          `</select>` +
        `</label>` +
        `<button class="suggestion-confirm" type="button">Always allow</button>` +
      `</div>` +
    `</div>`
  ) : '';
  // Reject-form open state + typed reason re-render from the module-scoped
  // draft so the WS-tick transcript rewrite doesn't snap the form shut or
  // wipe what the user typed (see rejectDrafts above).
  const rejectDraft = getRejectDraft(a.approvalId);
  return (
    `<div class="approval-card sv-approval-card${agentType ? ' sv-approval-card-subagent' : ''}"` +
      ` data-approval-id="${escapeHtml(a.approvalId)}"${mobile ? ` data-enqueued-at="${enqueuedAt}"` : ''}>` +
      `<div class="approval-banner"><span class="approval-banner-label">Approval needed</span>${agentChip}${countdownChip}</div>` +
      tile +
      `<div class="approval-actions"${rejectDraft.open ? ' data-open="false"' : ''}>` +
        `<button class="reject" data-id="${escapeHtml(a.approvalId)}" type="button">Reject</button>` +
        `<button class="approve" data-id="${escapeHtml(a.approvalId)}" type="button">Approve</button>` +
      `</div>` +
      `<div class="approval-reject-form" data-open="${rejectDraft.open ? 'true' : 'false'}" aria-hidden="${rejectDraft.open ? 'false' : 'true'}">` +
        `<textarea class="approval-reject-reason" placeholder="Reason (optional)…" rows="2">${escapeHtml(rejectDraft.reason)}</textarea>` +
        `<div class="approval-reject-actions">` +
          `<button class="approval-reject-cancel" type="button">Cancel</button>` +
          `<button class="approval-reject-send" type="button">Send rejection</button>` +
        `</div>` +
      `</div>` +
      suggestionHtml +
    `</div>`
  );
}

function openRejectForm(card) {
  const form = card.querySelector('.approval-reject-form');
  const primary = card.querySelector('.approval-actions');
  if (!form || !primary) return;
  form.setAttribute('data-open', 'true');
  form.setAttribute('aria-hidden', 'false');
  primary.setAttribute('data-open', 'false');
  setTimeout(() => form.querySelector('textarea')?.focus(), 40);
}

function closeRejectForm(card) {
  const form = card.querySelector('.approval-reject-form');
  const primary = card.querySelector('.approval-actions');
  if (!form || !primary) return;
  form.setAttribute('data-open', 'false');
  form.setAttribute('aria-hidden', 'true');
  primary.setAttribute('data-open', 'true');
  const ta = form.querySelector('textarea');
  if (ta) ta.value = '';
}

const boundScopes = new WeakSet();
export function bindApprovalCardHandlers(scope) {
  if (boundScopes.has(scope)) return;
  boundScopes.add(scope);
  scope.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const approveBtn = target.closest('.sv-approval-card .approve');
    if (approveBtn) {
      e.stopPropagation();
      const id = approveBtn.dataset.id;
      if (!id) return;
      rejectDrafts.delete(id);
      decideApproval(id, 'allow');
      return;
    }

    const rejectBtn = target.closest('.sv-approval-card .reject');
    if (rejectBtn) {
      e.stopPropagation();
      const card = rejectBtn.closest('.sv-approval-card');
      if (!card) return;
      const id = card.dataset.approvalId;
      if (id) rejectDrafts.set(id, { ...getRejectDraft(id), open: true });
      openRejectForm(card);
      return;
    }

    const cancelBtn = target.closest('.sv-approval-card .approval-reject-cancel');
    if (cancelBtn) {
      e.stopPropagation();
      const card = cancelBtn.closest('.sv-approval-card');
      if (!card) return;
      const id = card.dataset.approvalId;
      if (id) rejectDrafts.delete(id);
      closeRejectForm(card);
      return;
    }

    const sendBtn = target.closest('.sv-approval-card .approval-reject-send');
    if (sendBtn) {
      e.stopPropagation();
      const card = sendBtn.closest('.sv-approval-card');
      const id = card?.dataset.approvalId;
      if (!card || !id) return;
      const ta = card.querySelector('.approval-reject-reason');
      const reason = (ta?.value ?? '').trim();
      rejectDrafts.delete(id);
      decideApproval(id, 'deny', reason);
      return;
    }

    // "Always allow" suggestion (see inlineApprovalCardHtml) — renders on
    // both layouts whenever the approval carries a `suggestion`.
    const suggestionBtn = target.closest('.suggestion-confirm');
    if (suggestionBtn) {
      e.stopPropagation();
      const card = suggestionBtn.closest('.approval-suggestion');
      const approvalId = card?.dataset.approvalId;
      const pending = approvals.get().pending.find((x) => x.approvalId === approvalId);
      if (!pending?.suggestion) return;
      const scopeChoice = card.querySelector('.suggestion-scope-select')?.value ?? 'project';
      const sessionId = pending.sessionId;
      let ruleScope = 'global';
      if (scopeChoice === 'session' && sessionId) {
        // Ephemeral rule: applies for the rest of this session only, never
        // persisted to disk (backend keeps it in memory).
        ruleScope = { session: sessionId };
      } else if (scopeChoice === 'project') {
        const { projects } = sessions.get();
        const project = (projects || []).find((p) => (p.sessions || []).some((s) => s.id === sessionId));
        // Fall back to the session's own slice cwd (layout-neutral) rather than
        // the mobile-only currentSessionId/currentSessionCwd pointer — desktop
        // never sets those, so a brand-new session not yet reflected in
        // `projects` would otherwise always resolve to a null (global) scope.
        const cwd = project?.cwd ?? sessions.getSlice(sessionId)?.cwd ?? null;
        if (cwd) ruleScope = { project: cwd };
      }
      suggestionScopeChoice.delete(approvalId);
      confirmSuggestion(pending, ruleScope, suggestionBtn);
    }
  });

  scope.addEventListener('change', (e) => {
    const sel = e.target instanceof Element ? e.target.closest('.approval-suggestion .suggestion-scope-select') : null;
    if (!sel) return;
    const id = sel.closest('.approval-suggestion')?.dataset.approvalId;
    if (id) suggestionScopeChoice.set(id, sel.value);
  });

  // Keystrokes into the reject textarea persist onto the draft so the value
  // survives the next transcript rewrite (which also restores focus/caret —
  // see renderTranscript in index.js).
  scope.addEventListener('input', (e) => {
    const ta = e.target instanceof Element ? e.target.closest('.sv-approval-card .approval-reject-reason') : null;
    if (!ta) return;
    const id = ta.closest('.sv-approval-card')?.dataset.approvalId;
    if (!id) return;
    rejectDrafts.set(id, { open: true, reason: ta.value });
  });
}
