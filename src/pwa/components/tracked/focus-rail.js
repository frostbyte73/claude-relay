// Tracked focus rail (right column) — repeats the "what's next" focus card
// from Cockpit at the job level, plus sessions-on-this-job, at-a-glance
// metadata, and a recent-activity tail. Self-subscribes to nav (the shell
// frame only calls renderContext once per surface mount, not per selection —
// see shell/surfaces.js's paint()) so it stays in sync as the user browses
// the Tracked list.

import { work } from '../../state/work.js';
import { nav } from '../../state/nav.js';
import { setHtmlIfChanged } from '../../utils/keyed-rows.js';
import { focusAction, sessionsOnJob } from '../../vm/tracked.js';
import { renderActivityStream } from '../work/activity-stream.js';
import { workApi } from '../../net/work.js';
import { emptyState } from '../shell/placeholder.js';
import { openSession } from '../../app-bridge.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function shortName(cwd) { const p = String(cwd ?? '').split('/').filter(Boolean); return p.slice(-2).join('/'); }
function ago(epochMs) {
  if (!epochMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function primaryOrchestratedStep(job) {
  return (job.steps ?? []).find((s) => s.type === 'orchestrated' && !s.cancelled);
}

function kv(job) {
  const step = primaryOrchestratedStep(job);
  const rows = [];
  if (job.externalRef?.issueIdentifier) {
    rows.push(['Linear', job.externalRef.url
      ? `<a href="${escapeHtml(job.externalRef.url)}" target="_blank" rel="noopener">${escapeHtml(job.externalRef.issueIdentifier)} ↗</a>`
      : escapeHtml(job.externalRef.issueIdentifier)]);
  }
  if (step?.workspace?.branch) rows.push(['Branch', escapeHtml(step.workspace.branch)]);
  if (step?.pr?.prUrl) {
    const m = step.pr.prUrl.match(/\/pull\/(\d+)/);
    rows.push(['PR', `<a href="${escapeHtml(step.pr.prUrl)}" target="_blank" rel="noopener">${m ? `#${m[1]}` : 'view'} ↗</a>`]);
  }
  if (step?.workspace?.repoCwd) rows.push(['Repo', escapeHtml(shortName(step.workspace.repoCwd))]);
  rows.push(['Age', ago(job.createdAt)]);
  rows.push(['Idle', ago(job.updatedAt)]);
  return rows;
}

function sessionsListHtml(job) {
  const list = sessionsOnJob(job);
  if (!list.length) return '<p class="focus-empty">No sessions yet.</p>';
  return `
    <div class="focus-list">
      ${list.map((s) => `
        <button type="button" class="focus-list-item" data-session-id="${escapeHtml(s.sessionId)}">
          <span class="fli-dot ${s.running ? 'busy' : ''}"></span>
          <span class="fli-title">${escapeHtml(s.label)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

// Scroll targets live inside .tk-shell — the root renderTrackedDetail renders
// in BOTH layouts (desktop's .o-frame-detail and mobile's .m-tk-mount), so
// the CTA works wherever the focus card is mounted.
function runFocusCta(job, cta) {
  if (!cta || cta.action === 'none') return;
  if (cta.action === 'review-plan') {
    const el = document.querySelector('.tk-shell .plan-section');
    if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    return;
  }
  if (cta.action === 'retry' && cta.stepId) {
    void work.retryStep(job.id, cta.stepId);
    return;
  }
  if (cta.action === 'resume-wait' && cta.stepId) {
    void work.approve(job.id, { gate: 'wait', stepId: cta.stepId });
    return;
  }
  // review-gate / review-diff / watch: land on the relevant timeline step.
  const stepEl = cta.stepId ? document.querySelector(`.tk-shell .tl-step[data-step-id="${CSS.escape(cta.stepId)}"]`) : null;
  if (stepEl) { stepEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (cta.action === 'watch' && cta.sessionId) openSession({ id: cta.sessionId, fromTicketId: job.id });
}

// Categorical eyebrow for the focus card — the title itself renders once, in
// .o-focus-title below.
function focusLabel(fa) {
  const a = fa.cta?.action;
  if (a === 'retry') return 'Failed';
  if (a === 'watch') return 'In progress';
  if (a === 'none') return 'Status';
  return 'Needs you';
}

// Focus-card markup, factored out so the mobile shell can mount just this
// piece at the top of the Tracked drill-in scroll (mockup: "Focus card at the
// top of the drill-in replaces the desktop right rail's focus card") without
// forking the markup — same function backs both call sites (D2).
function focusCardHtml(fa) {
  return `
    <div class="o-focus-card">
      <div class="o-focus-label">◆ ${escapeHtml(focusLabel(fa))}</div>
      <div class="o-focus-title">${escapeHtml(fa.title)}</div>
      <div class="o-focus-desc">${escapeHtml(fa.description)}</div>
      ${fa.cta.action !== 'none' ? `<button type="button" class="o-focus-cta" data-focus-cta>${escapeHtml(fa.cta.label)} →</button>` : ''}
    </div>`;
}

// Standalone mount for the mobile Tracked drill-in — same card, no sessions/
// metadata/activity sections (those have no mobile mockup; the desktop right
// rail below stays the full renderContext for the list-detail-context layout).
export function renderFocusCard(mount, jobId) {
  const paint = () => {
    const job = jobId ? work.get().byId.get(jobId) : null;
    if (!job) { setHtmlIfChanged(mount, ''); return; }
    const fa = focusAction(job);
    // Guarded: work-store events for other jobs notify this subscriber too.
    if (!setHtmlIfChanged(mount, focusCardHtml(fa))) return;
    mount.querySelector('[data-focus-cta]')?.addEventListener('click', () => runFocusCta(job, fa.cta));
  };
  paint();
  return work.subscribe(paint);
}

export function renderContext(mount) {
  let unsubWork;
  let unsubNav;
  let dom = null;
  let currentJobId = null;

  // Regions are guarded independently, not as one blob: the sessions list holds
  // forever-pulsing .fli-dot elements while "At a glance" and the activity tail
  // hold `ago()` strings that change with the clock. One shared guard would
  // rebuild the dots every time a duration ticked over. Keeping the audit-log
  // container persistent also means an expanded log is no longer collapsed by
  // the next unrelated work event.
  function buildSkeleton() {
    mount.innerHTML = `
      <div class="focus-card-slot"></div>
      <div class="focus-section">
        <div class="focus-section-hdr o-microhead">Sessions on this job</div>
        <div class="focus-sessions-slot"></div>
      </div>
      <div class="focus-section">
        <div class="focus-section-hdr o-microhead">At a glance</div>
        <div class="focus-kv"></div>
      </div>
      <div class="focus-section">
        <div class="focus-section-hdr o-microhead">Recent activity</div>
        <div class="focus-activity-slot"></div>
        <div class="focus-activity-full" hidden></div>
        <button type="button" class="focus-audit-link" data-action="full-audit">Full audit log →</button>
      </div>
    `;
    dom = {
      card:     mount.querySelector('.focus-card-slot'),
      sessions: mount.querySelector('.focus-sessions-slot'),
      kv:       mount.querySelector('.focus-kv'),
      activity: mount.querySelector('.focus-activity-slot'),
      full:     mount.querySelector('.focus-activity-full'),
      auditBtn: mount.querySelector('[data-action="full-audit"]'),
    };
    dom.sessions.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target.closest('.focus-list-item[data-session-id]') : null;
      if (el) nav.select('sessions', el.getAttribute('data-session-id'));
    });
    dom.auditBtn.addEventListener('click', () => toggleAudit());
  }

  async function toggleAudit() {
    const job = currentJobId ? work.get().byId.get(currentJobId) : null;
    if (!job) return;
    const tail = mount.querySelector('.focus-activity-tail');
    if (dom.full.hasAttribute('hidden')) {
      // job.events is the last 50; the spill log has the rest.
      const events = await workApi.getJobEvents(job.id).then((r) => r?.events).catch(() => null);
      dom.full.innerHTML = renderActivityStream(events?.length ? { ...job, events } : job);
      dom.full.hidden = false;
      if (tail) tail.hidden = true;
      dom.auditBtn.textContent = 'Hide audit log';
    } else {
      dom.full.hidden = true;
      if (tail) tail.hidden = false;
      dom.auditBtn.textContent = 'Full audit log →';
    }
  }

  const paint = () => {
    const jobId = nav.get().selectionBySurface.tracked ?? null;
    const job = jobId ? work.get().byId.get(jobId) : null;
    if (!job) {
      dom = null;
      currentJobId = null;
      emptyState(mount, 'Select a tracked job to see its focus.');
      return;
    }
    if (!dom) buildSkeleton();
    currentJobId = job.id;

    const fa = focusAction(job);
    if (setHtmlIfChanged(dom.card, focusCardHtml(fa))) {
      dom.card.querySelector('[data-focus-cta]')?.addEventListener('click', () => runFocusCta(job, fa.cta));
    }
    setHtmlIfChanged(dom.sessions, sessionsListHtml(job));
    setHtmlIfChanged(dom.kv, kv(job).map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${v}</span>`).join(''));

    const events = Array.isArray(job.events) ? [...job.events].reverse() : [];
    const tailEvents = events.slice(0, 6);
    const auditOpen = !dom.full.hasAttribute('hidden');
    setHtmlIfChanged(dom.activity, tailEvents.length === 0
      ? '<p class="focus-empty">No activity yet.</p>'
      : `<div class="focus-list focus-activity-tail"${auditOpen ? ' hidden' : ''}>` +
          tailEvents.map((e) => `<div class="focus-activity-item"><span class="at">${ago(e.at)}</span><span class="body">${escapeHtml(e.body || e.kind)}</span></div>`).join('') +
        `</div>`);
  };

  paint();
  unsubWork = work.subscribe(paint);
  unsubNav = nav.subscribe(paint);
  return () => { unsubWork(); unsubNav(); };
}
