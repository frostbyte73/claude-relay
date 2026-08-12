import { sessions } from '../../state/sessions.js';
import { approvals } from '../../state/approvals.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { openSessionWs, closeSessionWs } from '../session-view/session-ws.js';
import { renderThinkingStrip } from '../session-view/regions.js';
import { oneLineMsgHtml } from '../session-view/message-html.js';
import {
  inlineApprovalCardHtml,
  bindApprovalCardHandlers,
} from '../session-view/approval-card.js';
import {
  askApprovalCardHtml,
  bindAskCardHandlers,
  buildAskAnswerWire,
} from '../ask-card.js';
import { renderIdleChipHtml, renderTerminalChipHtml, terminalChipVariant } from './session-terminal-chip.js';
import { decideApproval, openSession } from '../../app-bridge.js';

function isTerminal(step) { return step ? terminalChipVariant(step) !== null : false; }

// Mirrors the session-view bridge: flip the pending ask entry to answered
// immediately, then route the deny-decision through the shared bridge so the
// same routing (notifications WS → session WS → queued) applies.
function submitAskAnswer(sessionId, approval, picks, replyText) {
  const wire = buildAskAnswerWire(approval, picks, replyText);
  sessions.for(sessionId).mapTranscript((entry) =>
    entry.role === 'ask' && entry.answer == null ? { ...entry, answer: wire } : entry,
  );
  if (approval.toolUseId) approvals.markTaskResultConsumed(approval.toolUseId);
  approvals.set((s) => ({ ...s, pendingAsks: new Map() }));
  decideApproval(approval.approvalId, 'deny', wire);
}

// When there's a pending approval or ask for THIS session, render the card in
// place of the transcript tail — a blocked session shouldn't distract with
// stale prose.
function renderTail(slice, sessionId) {
  if (!slice) return '';
  // Path context is this inline preview's own session, not whichever session
  // the Sessions surface last painted — Tracked can mount several of these
  // concurrently for different sessions/projects.
  const ctx = { cwd: slice.cwd ?? null, worktreePath: slice.spawnCwd ?? null };
  const cards = approvals.get().pending.filter((a) => a.sessionId === sessionId && !a.agentId);
  if (cards.length > 0) {
    return cards.map((a) => (
      a.toolName === 'AskUserQuestion' ? askApprovalCardHtml(a) : inlineApprovalCardHtml(a)
    )).join('');
  }
  const pendingIds = new Set(cards.map((a) => a.toolUseId).filter(Boolean));
  const rest = slice.transcript.filter((m) => {
    if (m.role === 'tool_use' && m.toolUseId && pendingIds.has(m.toolUseId)) return false;
    if (m.role === 'ask' && m.answer == null && m.toolUseId && pendingIds.has(m.toolUseId)) return false;
    return true;
  });
  const lines = [];
  for (let i = rest.length - 1; i >= 0 && lines.length < 2; i -= 1) {
    const html = oneLineMsgHtml(rest[i], ctx);
    if (html) lines.unshift(html);
  }
  return lines.join('');
}

function buildSkeleton(mount) {
  mount.classList.add('step-inline-session');
  mount.innerHTML = `
    <div class="inline-session-header">
      <span class="inline-session-spacer"></span>
      <button class="inline-session-open" type="button" aria-label="Open session in its own tab">Open ↗</button>
    </div>
    <div class="inline-session-thinking"></div>
    <div class="inline-session-body"></div>
  `;
  return {
    root: mount,
    openBtn: mount.querySelector('.inline-session-open'),
    thinking: mount.querySelector('.inline-session-thinking'),
    body: mount.querySelector('.inline-session-body'),
  };
}

// `live` is destructured under another name: the WS-attach flag below is also called `live`,
// and they are different questions — "is the subprocess alive" vs "have we attached to it".
export function mountInlineSession(mount, sessionId, { jobId, step = null, live: sessionLive = true }) {
  if (!sessionId) return { unmount() {}, updateStep() {} };

  sessions.ensureSlice(sessionId);

  const dom = buildSkeleton(mount);
  let currentStep = step;
  // Whether THIS session's subprocess is alive, straight from the job's own liveness
  // (job.live.sessionIds — see src/work/job-liveness.ts for why it can't be derived here).
  let currentLive = sessionLive;

  // A terminal step renders a static chip from persisted timing and never needs a
  // live view, so we attach nothing for it:
  //   - openSessionWs would make the daemon resume (respawn) the long-since-reaped
  //     Claude subprocess, resurfacing every finished step as a backend-"active"
  //     session on each job-detail open.
  //   - mountView flips the slice's runState to 'foreground' (mountedCount > 0),
  //     which the sessions-list vm treats as running — so a finished step would show
  //     as active purely from being visible in the job timeline.
  // A retry can flip a step back to non-terminal, so syncLive re-runs on updateStep.
  // (The "Open ↗" button still resumes on explicit user intent.)
  let live = false;
  const syncLive = () => {
    const wantLive = !isTerminal(currentStep);
    if (wantLive && !live) { sessions.mountView(sessionId); openSessionWs(sessionId); live = true; }
    else if (!wantLive && live) { closeSessionWs(sessionId); sessions.unmountView(sessionId); live = false; }
  };
  syncLive();

  dom.openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSession({ id: sessionId, fromTicketId: jobId });
  });

  bindApprovalCardHandlers(dom.body);
  bindAskCardHandlers(dom.body, {
    submitAnswer: (approval, picks, replyText) =>
      submitAskAnswer(sessionId, approval, picks, replyText),
  });

  let metaTicker = null;
  const stopMetaTicker = () => { if (metaTicker) { clearInterval(metaTicker); metaTicker = null; } };

  const paint = () => {
    if (isTerminal(currentStep)) {
      stopMetaTicker();
      setHtmlIfChanged(dom.thinking, '');
      setHtmlIfChanged(dom.body, renderTerminalChipHtml(currentStep));
      return;
    }
    // A controller that has parked (on CI, on a dispatch, on an approval) states its status
    // here rather than leaving the last two lines it said before parking on screen looking
    // like live work. Same slot, same shape as the terminal chip above.
    if (!currentLive) {
      const idle = renderIdleChipHtml(currentStep);
      if (idle) {
        stopMetaTicker();
        setHtmlIfChanged(dom.thinking, '');
        setHtmlIfChanged(dom.body, idle);
        return;
      }
    }
    const slice = sessions.getSlice(sessionId);
    const hasActivity = !!slice?.thinking || (slice?.transcript?.length ?? 0) > 0;
    if (!hasActivity) {
      // Guarded for the same reason renderThinkingStrip patches in place: these
      // dots animate on a staggered infinite delay, and this paint runs on every
      // slice/approvals tick (uncoalesced), so rebuilding meant dots 2 and 3
      // never reached their bright frame.
      setHtmlIfChanged(dom.thinking,
        '<div class="thinking-strip" role="status" aria-live="polite">' +
          '<span class="thinking-strip-label">starting</span>' +
          '<span class="thinking-strip-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
        '</div>');
      setHtmlIfChanged(dom.body, '');
      return;
    }
    renderThinkingStrip(dom.thinking, slice);
    setHtmlIfChanged(dom.body, renderTail(slice, sessionId));

    if (slice?.thinking && !metaTicker) {
      metaTicker = setInterval(() => {
        const s = sessions.getSlice(sessionId);
        if (!s?.thinking) { stopMetaTicker(); return; }
        renderThinkingStrip(dom.thinking, s);
      }, 200);
    } else if (!slice?.thinking && metaTicker) {
      stopMetaTicker();
    }
  };

  const unsubSlice = sessions.subscribeSlice(sessionId, paint);
  const unsubApprovals = approvals.subscribe(paint);
  paint();

  return {
    updateStep(nextStep, nextLive = true) {
      currentStep = nextStep;
      currentLive = nextLive;
      syncLive();
      paint();
    },
    unmount() {
      unsubSlice();
      unsubApprovals();
      stopMetaTicker();
      if (live) { closeSessionWs(sessionId); sessions.unmountView(sessionId); live = false; }
      mount.textContent = '';
      mount.classList.remove('step-inline-session');
    },
  };
}
