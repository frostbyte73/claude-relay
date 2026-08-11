// Mobile shell header. Visual modes:
//   - list-root: greeting + compact usage widget (Cockpit's home shape)
//   - list:      title + count sub-line (Tracked/Sessions/Schedules/More)
//   - drill-in:  back chevron + compact title stack + ⋯ menu (any surface's
//                detail screen)
//   - session:   back chevron + stacked title (session name / skill) over
//                branch · live-state sub-line, with the permission-mode chip
//                (mode-popover), a source-control icon when diffable, and a
//                ⋯ menu (Promote to tracked / Open diff / Archive / Delete)
//
// The header is rebuilt from scratch on every render() — the DOM is a single
// #header container that this module fills. State comes from the sessions
// and settings stores. App.js provides the pieces that reach outside
// the mobile shell (leaveSession, openDiffOverlay, etc.) via init. All four
// shapes are built by ./mobile-shell/header.js — this module delegates to
// them so mobile-shell doesn't need its own #header-touching entry point
// (single owner of the header DOM); the session shape's store reads, menu
// behavior, and mode-popover live here.

import { sessions } from '../state/sessions.js';
import { settings } from '../state/settings.js';
import { getHeader as getGitHeader } from '../state/git.js';
import { sendApprovalModeSet } from './session-view/session-ws.js';
import { escapeHtml } from '../util.js';
import { renderListRoot, renderList as renderListShape, renderDrillIn, renderSessionShape } from './mobile-shell/header.js';
import { computeGitInfo, resolveSessionTitle, sessionRunMeta, archiveSession, deleteSession } from './session-view/session-actions.js';
import { promoteSessionToJob } from '../app-bridge.js';
import { deriveSkillLabel } from '../vm/sessions.js';
import { confirmInSheet } from './sheet-utils.js';

// Was settings-sheet.js's wrapper around settings.setAcceptEdits — that sheet
// is gone (settings-surface replaced it) but this mutation is still driven
// live from the session header's mode chip and from ws/dispatch.js's
// approval_mode_set handler, so it moved here rather than to a dead module.
export function setAcceptEdits(v) {
  settings.setAcceptEdits(v);
  if (sessions.get().view === 'session') refreshHeaderModeChip();
}

let _deps = {
  appState: null,
  leaveSession: () => {},
  openDiffOverlay: () => {},
  maybeRefreshHeaderBranch: () => {},
};

let header = null;

// list-root (usage.subscribe) and session (sessions.subscribe + duration
// ticker + outside-click listener) return teardowns — tracked so a repaint
// doesn't leak a fresh subscription on top of the previous (now-detached) one
// every time setHeader() rebuilds the DOM.
let headerTeardown = null;

export function initMobileHeader(deps) {
  _deps = { ..._deps, ...deps };
  header = document.getElementById('header');
  // Outside-click closes the mode popover. Attached once at init; the popover
  // itself lives inside the header chip and stops propagation of its own clicks.
  document.addEventListener('click', (e) => {
    if (!settings.get().modePopoverOpen) return;
    if (e.target.closest('#mode-popover')) return;
    if (e.target.closest('#header-mode-chip')) return;
    closeModePopover();
  });
}

// opts is only used by the tab-driven shapes (mobile-shell/index.js is the
// only caller that passes it); the session branch reads straight from the
// stores as it always has.
export function setHeader(mode, opts) {
  if (headerTeardown) { try { headerTeardown(); } catch { /* ignore */ } headerTeardown = null; }

  if (mode === 'list-root') { header.innerHTML = ''; headerTeardown = renderListRoot(header, opts) ?? null; return; }
  if (mode === 'list-tab')  { header.innerHTML = ''; headerTeardown = renderListShape(header, opts) ?? null; return; }
  if (mode === 'drill-in')  { header.innerHTML = ''; renderDrillIn(header, opts); return; }

  header.innerHTML = '';
  headerTeardown = buildSessionHeader() ?? null;
}

async function handleSessionMenuAction(action, sessionId) {
  if (action === 'promote') { promoteSessionToJob(sessionId); return; }
  if (action === 'diff') { _deps.openDiffOverlay({ sessionId }); return; }
  if (action === 'archive') {
    const ok = await archiveSession(sessionId, confirmInSheet);
    if (ok) _deps.leaveSession();
    return;
  }
  if (action === 'delete') {
    const ok = await deleteSession(sessionId, confirmInSheet);
    if (ok) _deps.leaveSession();
  }
}

// Session header: drill-in row language with the session's identity stacked
// into rows (title over branch · run-state — never one crammed eyebrow line).
// Patches text/menu in place on store ticks so the open mode-popover / ⋯ menu
// aren't blown away mid-interaction; returns a teardown for setHeader.
function buildSessionHeader() {
  const sid = sessions.get().currentSessionId;
  if (!sid) return null;
  const shape = renderSessionShape(header, {
    onBack: () => _deps.leaveSession(),
    onDiff: () => _deps.openDiffOverlay({ sessionId: sid }),
    onMenuAction: (action) => handleSessionMenuAction(action, sid),
  });
  shape.els.modeSlot.appendChild(buildHeaderModeChip());

  let lastMenuKey = null;
  const paint = () => {
    const slice = sessions.getSlice(sid);
    let title = resolveSessionTitle(sid, null);
    if (title === sid.slice(0, 8)) title = deriveSkillLabel(slice?.transcript) || title;
    if (shape.els.title.textContent !== title) shape.els.title.textContent = title;

    const info = computeGitInfo(sid);
    const branch = getGitHeader(sid)?.branch ?? info.branch;
    const { live, text } = sessionRunMeta(slice, sid);
    // Patch the sub-row's parts, never its markup: `text` is a running duration
    // that ticks every second, so rebuilding the row re-created the pulsing
    // .mh-live-dot beside it and restarted its animation each tick.
    const branchLabel = branch ? `⎇ ${branch}` : '';
    shape.els.branch.hidden = !branch;
    if (shape.els.branch.textContent !== branchLabel) shape.els.branch.textContent = branchLabel;
    shape.els.subSep.hidden = !branch;
    shape.els.liveDot.hidden = !live;
    if (shape.els.stateText.textContent !== text) shape.els.stateText.textContent = text;

    shape.els.diffBtn.hidden = !info.diffable;
    const items = [{ action: 'promote', label: 'Promote to tracked' }];
    if (info.diffable) items.push({ action: 'diff', label: 'Open diff' });
    if (!info.archived) items.push({ action: 'archive', label: 'Archive' });
    items.push({ action: 'delete', label: 'Delete', danger: true });
    const menuKey = items.map((i) => i.action).join(',');
    if (menuKey !== lastMenuKey) { shape.renderMenuItems(items); lastMenuKey = menuKey; }
  };
  paint();
  if (computeGitInfo(sid).diffable) _deps.maybeRefreshHeaderBranch(sid);
  const unsubSessions = sessions.subscribe(paint);
  // Running-duration sub-line ticks between store updates.
  const ticker = setInterval(paint, 1000);
  return () => {
    unsubSessions();
    clearInterval(ticker);
    shape.teardown();
  };
}

function modeBadgeLabel(mode) {
  if (mode === 'ask') return 'ASK';
  if (mode === 'plan') return 'PLAN';
  if (mode === 'bypass') return 'BYPASS';
  return 'EDIT';
}

const MODE_DESCRIPTIONS = {
  'ask': 'Tool calls outside the allowlist require explicit approval.',
  'plan': 'Read-only. Only Read, Glob, Grep, Web*, Task list/get, and MCP read tools run.',
  'accept-edits': 'Edit, Write, MultiEdit, and NotebookEdit auto-approve. Bash and side-effect tools still require approval.',
  'bypass': 'All tool calls auto-approve. Equivalent to --dangerously-skip-permissions.',
};

function buildHeaderModeChip() {
  const mode = sessions.get().approvalMode ?? 'ask';
  const wrap = document.createElement('span');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-flex';

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'header-mode-chip';
  chip.id = 'header-mode-chip';
  chip.setAttribute('data-mode', mode);
  chip.setAttribute('aria-haspopup', 'true');
  chip.setAttribute('aria-expanded', settings.get().modePopoverOpen ? 'true' : 'false');
  chip.setAttribute('aria-label', `Permission mode: ${modeBadgeLabel(mode)} — tap to change`);
  chip.innerHTML = `<span class="chip-label">${escapeHtml(modeBadgeLabel(mode))}</span><span class="chip-caret" aria-hidden="true">▾</span>`;
  chip.onclick = (e) => {
    e.stopPropagation();
    toggleModePopover();
  };

  const popover = document.createElement('div');
  popover.className = 'mode-popover';
  popover.id = 'mode-popover';
  popover.setAttribute('role', 'menu');
  popover.setAttribute('data-open', settings.get().modePopoverOpen ? 'true' : 'false');
  popover.addEventListener('click', (e) => e.stopPropagation());
  const items = ['ask', 'plan', 'accept-edits', 'bypass'].map((m) => {
    const label = m === 'accept-edits' ? 'Accept edits'
      : m === 'ask' ? 'Ask'
      : m === 'plan' ? 'Plan'
      : 'Bypass';
    const showConfirm = m === 'bypass' && _deps.appState?.bypassConfirmPending;
    const isCurrent = mode === m && !showConfirm;
    return `
      <button type="button" class="mode-popover-item" role="menuitemradio"
        data-mode="${m}" aria-pressed="${isCurrent ? 'true' : 'false'}">
        <span class="mode-popover-dot" aria-hidden="true"></span>
        <span>
          <span class="mode-popover-name">${showConfirm ? 'Tap again to confirm' : escapeHtml(label)}</span>
          <span class="mode-popover-desc">${escapeHtml(MODE_DESCRIPTIONS[m])}</span>
        </span>
      </button>`;
  }).join('');
  popover.innerHTML = `${items}
    <div class="mode-popover-footer">
      Changes apply to this session only. Set the default for new sessions in
      <strong>Settings → Default for new sessions</strong>.
    </div>`;
  popover.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setSessionApprovalMode(btn.dataset.mode);
  });

  wrap.appendChild(chip);
  wrap.appendChild(popover);
  return wrap;
}

export function refreshHeaderModeChip() {
  const existing = document.getElementById('header-mode-chip')?.parentElement;
  if (!existing) return;
  existing.replaceWith(buildHeaderModeChip());
  // The rebuilt popover has no inline `left`, so it reverts to its CSS default
  // (`left: 0`, overflowing off the right edge). Re-apply the off-screen
  // correction, else a refresh-while-open (e.g. the bypass-confirm state) snaps
  // the popover half off-screen.
  if (settings.get().modePopoverOpen) positionModePopover();
}

function toggleModePopover() {
  settings.setModePopoverOpen(!settings.get().modePopoverOpen);
  refreshHeaderModeChip();
  if (settings.get().modePopoverOpen) positionModePopover();
}

function positionModePopover() {
  const chip = document.getElementById('header-mode-chip');
  const popover = document.getElementById('mode-popover');
  if (!chip || !popover) return;
  popover.style.left = '0px';
  const chipRect = chip.getBoundingClientRect();
  const popoverWidth = popover.offsetWidth;
  const viewportRight = window.innerWidth - 8;
  const naturalRight = chipRect.left + popoverWidth;
  if (naturalRight > viewportRight) {
    popover.style.left = `${-(naturalRight - viewportRight)}px`;
  }
}

function closeModePopover() {
  if (!settings.get().modePopoverOpen) return;
  settings.setModePopoverOpen(false);
  refreshHeaderModeChip();
}

function setSessionApprovalMode(mode) {
  if (sessions.get().approvalMode === mode && !(mode === 'bypass' && _deps.appState?.bypassConfirmPending)) {
    closeModePopover();
    return;
  }
  if (mode === 'bypass' && sessions.get().approvalMode !== 'bypass' && !_deps.appState?.bypassConfirmPending) {
    _deps.appState.bypassConfirmPending = true;
    refreshHeaderModeChip();
    setTimeout(() => {
      if (_deps.appState?.bypassConfirmPending) {
        _deps.appState.bypassConfirmPending = false;
        refreshHeaderModeChip();
      }
    }, 4000);
    return;
  }
  if (_deps.appState) _deps.appState.bypassConfirmPending = false;
  const sid = sessions.get().currentSessionId;
  // Explicit pick cancels the auto-default-push (dispatch.js:approval_mode) so
  // it can't clobber this choice on a fresh session.
  if (sid) sessions.for(sid).setPendingDefaultPush(false);
  sendApprovalModeSet(sid, mode);
  sessions.setApprovalMode(mode);
  setAcceptEdits(mode === 'accept-edits');
  closeModePopover();
}

export function currentSessionDiffable() {
  const { currentSessionId, projects } = sessions.get();
  if (!currentSessionId || !projects) return false;
  for (const p of projects) {
    const s = p.sessions?.find((s) => s.id === currentSessionId);
    if (s) return Boolean(p.isGitRepo) && !s.archived;
  }
  return false;
}
