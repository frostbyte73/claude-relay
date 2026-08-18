// Mobile shell: persistent bottom tab bar + FAB + screen navigator. Mounts
// inside the existing #root/#header (the same elements the legacy
// list/ticket-list/actions/ticket/pr view machinery used) whenever
// sessions.view isn't 'session' — app.js's render() owns the branch that
// decides when to show this vs. the untouched session-view flow.
//
// Screens are arranged from the SAME registry renderers shell/surfaces.js
// uses for desktop (D2) — this module supplies only the mobile chrome
// (tab bar, header shapes, FAB, screen stack) around them.

import { nav } from '../../state/nav.js';
import { work } from '../../state/work.js';
import { approvals } from '../../state/approvals.js';
import { sessions } from '../../state/sessions.js';
import { schedulesStore } from '../../state/schedules.js';
import { actions } from '../../state/actions.js';
import { runs } from '../../state/runs.js';
import { openSession } from '../../app-bridge.js';
import { renderDetail as renderCockpitDetail } from '../cockpit/index.js';
import { renderList as renderTrackedList, renderDetail as renderTrackedDetail } from '../tracked/index.js';
import { renderFocusCard } from '../tracked/focus-rail.js';
import { trackedGroups } from '../../vm/tracked.js';
import { renderList as renderSessionsList } from '../sessions-surface/list.js';
import { renderList as renderSchedulesList, renderDetail as renderSchedulesDetail } from '../schedules/index.js';
import { renderSkillsList, renderSkillsDetail, renderRunsDetail } from '../library/index.js';
import { renderList as renderSettingsList, renderDetail as renderSettingsDetail } from '../settings-surface/index.js';
import { renderMoreRoot } from './more.js';
import { mountListDetailScreens } from './screens.js';
import { TABS, MORE_SURFACES, tabForSurface, waitingOnYouCount } from './tabs.js';
import { initMoreAtRoot, computeMoreDeepLink, deepLinkKeyFor, resolveMoreScreen } from './more-state.js';
import { wireHistory, syncHistory } from './history.js';
import { setHeader } from '../mobile-header.js';
import { escapeHtml } from '../../util.js';
import { openPalette } from '../palette/index.js';

const SURFACE_TITLES = { tracked: 'Tracked', sessions: 'Sessions', schedules: 'Schedules', skills: 'Skills', settings: 'Settings', runs: 'Runs history' };

let mounted = false;
let shellEl = null;
let bodyEl = null;
let tabsEl = null;
let fabEl = null;

const tabContainers = {}; // key -> DOM container, created lazily
const screenHandles = {}; // key -> mountListDetailScreens() handle, for list-detail surfaces
let cockpitUnmount = null;
let sessionsListUnmount = null;
let moreRootUnmount = null;

// Root-vs-drilled state for the virtual "More" tab (not a nav surface — see
// tabs.js). Initialized so a cold boot landing on a persisted more-surface
// selection (deep link, or last session) opens straight to it rather than
// forcing the user back through the root menu every time. See more-state.js
// for the pure transitions this variable (and lastMoreDeepLinkKey below) are
// driven by.
let moreAtRoot = initMoreAtRoot(nav.get().surface, MORE_SURFACES);

// Dedup key for the "a More-owned surface just got a selection from outside
// (deep link, notification tap)" case — distinct from the user tapping a row
// in the More root or the More tab itself, both of which stamp this key
// explicitly so their navigation can't be reinterpreted as a deep link.
// Seeded from the persisted nav state so a months-old selection restored
// from localStorage doesn't hijack the first More-tab tap after boot.
let lastMoreDeepLinkKey = deepLinkKeyFor(nav.get(), MORE_SURFACES);

function maybeApplyMoreDeepLink() {
  const next = computeMoreDeepLink({ moreAtRoot, lastMoreDeepLinkKey }, nav.get(), MORE_SURFACES);
  moreAtRoot = next.moreAtRoot;
  lastMoreDeepLinkKey = next.lastMoreDeepLinkKey;
}

function ensureContainer(key) {
  if (tabContainers[key]) return tabContainers[key];
  const el = document.createElement('div');
  el.className = 'm-screen-root';
  el.dataset.tabScreen = key;
  bodyEl.appendChild(el);
  tabContainers[key] = el;
  return el;
}

function showOnly(activeKey) {
  for (const [key, el] of Object.entries(tabContainers)) {
    el.classList.toggle('m-screen-hidden', key !== activeKey);
  }
}

function mountCockpit() {
  const el = ensureContainer('cockpit');
  if (el.childElementCount) return;
  const ret = renderCockpitDetail(el, {});
  cockpitUnmount = typeof ret === 'function' ? ret : null;
}

function mountTracked() {
  const el = ensureContainer('tracked');
  if (screenHandles.tracked) return;
  screenHandles.tracked = mountListDetailScreens(el, 'tracked', {
    renderList: renderTrackedList,
    renderDetail: (mount, deps) => renderTrackedDetail(mount, deps),
  }, {
    // Focus card at the top of the drill-in scroll (mockup: replaces the
    // desktop right rail entirely on mobile) — mounted above the SAME
    // renderTrackedDetail body desktop uses, not a second copy of it.
    wrapDetail(detailEl, jobId) {
      detailEl.innerHTML = '<div class="m-focus-mount"></div><div class="m-tk-mount"></div>';
      const focusMount = detailEl.querySelector('.m-focus-mount');
      const bodyMount = detailEl.querySelector('.m-tk-mount');
      const unsubFocus = renderFocusCard(focusMount, jobId);
      return { mount: bodyMount, unmount: unsubFocus };
    },
  });
}

function mountSessions() {
  const el = ensureContainer('sessions');
  if (sessionsListUnmount) return;
  const ret = renderSessionsList(el);
  sessionsListUnmount = typeof ret === 'function' ? ret : null;
}

function mountSchedules() {
  const el = ensureContainer('schedules');
  if (screenHandles.schedules) return;
  screenHandles.schedules = mountListDetailScreens(el, 'schedules', {
    renderList: renderSchedulesList,
    renderDetail: renderSchedulesDetail,
  });
}

function mountMoreRoot() {
  const el = ensureContainer('more-root');
  if (moreRootUnmount) return;
  moreRootUnmount = renderMoreRoot(el, {
    onSelect(key) {
      moreAtRoot = false;
      nav.setSurface(key);
      lastMoreDeepLinkKey = deepLinkKeyFor(nav.get(), MORE_SURFACES);
      paint();
    },
  });
}

function mountSkills() {
  const el = ensureContainer('skills');
  if (screenHandles.skills) return;
  screenHandles.skills = mountListDetailScreens(el, 'skills', {
    renderList: renderSkillsList,
    renderDetail: renderSkillsDetail,
  });
}

function mountSettings() {
  const el = ensureContainer('settings');
  if (screenHandles.settings) return;
  screenHandles.settings = mountListDetailScreens(el, 'settings', {
    renderList: renderSettingsList,
    renderDetail: renderSettingsDetail,
  });
}

function mountRuns() {
  const el = ensureContainer('runs');
  if (el.childElementCount) return;
  // renderRunsDetail loads its own default window on mount (runs-view.js's
  // own reload()) — no separate fetch needed here.
  const ret = renderRunsDetail(el);
  el.__runsUnmount = typeof ret === 'function' ? ret : null;
}

// ── FAB ──────────────────────────────────────────────────────────────────

function setFabVisible(visible) {
  fabEl.hidden = !visible;
}

// ── Header per active screen ─────────────────────────────────────────────

function paintCockpitHeader() {
  const groups = { waiting: waitingOnYouCount() };
  const running = [...sessions.get().sessionsById.values()].filter((s) => s.runState === 'foreground' || s.runState === 'background').length;
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const parts = [];
  parts.push(groups.waiting === 0 ? 'nothing needs you' : `${groups.waiting} need${groups.waiting === 1 ? 's' : ''} you`);
  parts.push(running === 0 ? 'nothing running' : `${running} running`);
  setHeader('list-root', { greeting, sub: parts.join(' · ') });
  setFabVisible(true);
}

function paintTrackedHeader() {
  const { running, needsYou } = trackedGroups(work.get().jobs ?? []);
  const showingDetail = screenHandles.tracked?.isShowingDetail();
  if (!showingDetail) {
    setHeader('list-tab', { title: 'Tracked', sub: `${running.length} running · ${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you` });
    setFabVisible(true);
    return;
  }
  const jobId = nav.get().selectionBySurface.tracked;
  const job = jobId ? work.get().byId.get(jobId) : null;
  setHeader('drill-in', {
    title: job?.externalRef?.issueIdentifier ?? job?.title ?? 'Job',
    sub: job?.externalRef?.issueIdentifier ? job.title : null,
    onBack: () => screenHandles.tracked.back(),
  });
  setFabVisible(false);
}

function paintSessionsHeader() {
  const running = [...sessions.get().sessionsById.values()].filter((s) => s.runState === 'foreground' || s.runState === 'background').length;
  setHeader('list-tab', { title: 'Sessions', sub: `${running} running` });
  setFabVisible(true);
}

function paintSchedulesHeader() {
  const { schedules } = schedulesStore.get();
  const active = schedules.filter((s) => s.enabled).length;
  const showingDetail = screenHandles.schedules?.isShowingDetail();
  if (!showingDetail) {
    setHeader('list-tab', { title: 'Schedules', sub: `${active} active · ${schedules.length - active} paused` });
    setFabVisible(true);
    return;
  }
  const id = nav.get().selectionBySurface.schedules;
  const sched = id ? schedules.find((s) => s.id === id) : null;
  setHeader('drill-in', { title: sched?.name ?? 'Schedule', onBack: () => screenHandles.schedules.back() });
  setFabVisible(false);
}

function paintMoreHeader() {
  if (moreAtRoot) {
    setHeader('list-tab', { title: 'More' });
    setFabVisible(false);
    return;
  }
  const surfaceKey = nav.get().surface; // one of MORE_SURFACES
  const backToRoot = () => { moreAtRoot = true; paint(); };
  if (surfaceKey === 'runs') {
    setHeader('drill-in', { title: 'Runs history', onBack: backToRoot });
    setFabVisible(false);
    return;
  }
  const handle = screenHandles[surfaceKey];
  const showingDetail = handle?.isShowingDetail();
  setFabVisible(false);
  if (!showingDetail) {
    setHeader('drill-in', { title: SURFACE_TITLES[surfaceKey] ?? surfaceKey, onBack: backToRoot });
    return;
  }
  const sel = nav.get().selectionBySurface[surfaceKey];
  const title = surfaceKey === 'skills' ? (sel ?? 'Skill') : (SETTINGS_SECTION_LABEL(sel) ?? 'Settings');
  setHeader('drill-in', { title, onBack: () => handle.back() });
}

function SETTINGS_SECTION_LABEL(key) {
  // Settings sections don't carry a display label anywhere but their nav
  // list row markup (vm/settings.js) — good enough for a drill-in title is
  // just title-casing the key rather than importing vm/settings.js's icon
  // map for one string.
  if (!key) return null;
  return key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Sessions-tab special routing ─────────────────────────────────────────
// The shared sessions-surface list (list.js) calls nav.select('sessions', id)
// on row tap — same call desktop uses to mount its own session-view in the
// detail pane. Mobile has no inline drill-in for Sessions (mockup gap; the
// existing full-screen mobile session flow already owns this) — intercept
// the selection, hand off, and CLEAR it: on mobile the selection is a one-shot
// routing event, not durable state. Leaving it set made the Sessions tab a
// trap (any later paint with the stale selection re-opened the last session).
// Clearing after openSession() keeps the nav.select() re-entrancy harmless:
// openSession flips sessions.view synchronously, so this shell is already
// unmounted (paint unsubscribed) by the time the cleared state notifies.
function maybeRouteSessionSelection() {
  const n = nav.get();
  if (n.surface !== 'sessions') return;
  const sel = n.selectionBySurface.sessions ?? null;
  if (!sel) return;
  const alreadyOpen = sessions.get().currentSessionId === sel && sessions.get().view === 'session';
  if (!alreadyOpen) openSession({ id: sel });
  nav.select('sessions', null);
}

// ── Tab bar ────────────────────────────────────────────────────────────

function tabBadge(key) {
  if (key !== 'cockpit') return '';
  const n = waitingOnYouCount();
  return n > 0 ? String(n) : '';
}

function paintTabs() {
  const active = tabForSurface(nav.get().surface);
  for (const btn of tabsEl.querySelectorAll('.m-tab')) {
    const isActive = btn.dataset.tab === active;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    const badgeEl = btn.querySelector('.badge');
    if (badgeEl) {
      const b = tabBadge(btn.dataset.tab);
      badgeEl.textContent = b;
      badgeEl.hidden = !b;
    }
  }
}

function buildTabs() {
  tabsEl.innerHTML = TABS.map((t) => `
    <button type="button" class="m-tab" role="tab" aria-selected="false" data-tab="${t.key}">
      <span class="icon" aria-hidden="true">${t.icon}</span>
      <span>${escapeHtml(t.label)}</span>
      ${t.key === 'cockpit' ? '<span class="badge" hidden></span>' : ''}
    </button>
  `).join('');
  tabsEl.querySelectorAll('.m-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      if (key === 'more') {
        moreAtRoot = true;
        if (!MORE_SURFACES.includes(nav.get().surface)) nav.setSurface('skills');
        // Stamp the deep-link dedup key so paint() can't reinterpret a
        // persisted selection on the target surface as a fresh deep link and
        // yank the user into a stale detail instead of the More root.
        lastMoreDeepLinkKey = deepLinkKeyFor(nav.get(), MORE_SURFACES);
        paint();
        return;
      }
      nav.setSurface(key);
    });
  });
}

// ── Browser-history depth (see history.js) ────────────────────────────────
// How many "screens deep" the shell's own navigation is, derived purely from
// nav state + moreAtRoot so it stays answerable while the shell is unmounted
// (session view up, screenHandles torn down).
function shellNavDepth() {
  const n = nav.get();
  const tab = tabForSurface(n.surface);
  if (tab === 'more') {
    if (moreAtRoot) return 0;
    if (n.surface === 'runs') return 1;
    return 1 + ((n.selectionBySurface[n.surface] ?? null) != null ? 1 : 0);
  }
  if (tab === 'tracked' || tab === 'schedules') {
    return (n.selectionBySurface[tab] ?? null) != null ? 1 : 0;
  }
  return 0;
}

// Pop exactly one shell level — the hardware-back counterpart of the header
// back buttons (drill-in → list, More sub-screen → More root).
function popShellLevel() {
  const n = nav.get();
  const tab = tabForSurface(n.surface);
  if (tab === 'more') {
    if (moreAtRoot) return;
    if (n.surface !== 'runs' && (n.selectionBySurface[n.surface] ?? null) != null) {
      nav.select(n.surface, null);
      return;
    }
    moreAtRoot = true;
    if (mounted) paint(); else syncHistory();
    return;
  }
  if ((n.selectionBySurface[tab] ?? null) != null) nav.select(tab, null);
}

// ── Main paint ─────────────────────────────────────────────────────────

let painting = false;

function paint() {
  // Defensive: a store notification can synchronously cascade through
  // openSession()→sessions.enterSession()→app.js's own view-watcher→
  // unmountMobileShell() while this exact paint() call is still on the
  // stack (see maybeRouteSessionSelection below) — bail before touching any
  // of the now-torn-down DOM refs.
  if (!mounted) return;
  // Re-entrancy guard: mounting a screen can synchronously mutate a store this
  // paint subscribes to — the Tracked detail mounts an inline session, whose
  // sessions.mountView() notifies our own sessions subscriber mid-mount, before
  // mountTracked() has assigned its screenHandles.tracked idempotency guard. Left
  // unguarded that re-enters paint()→mountTracked()→mountListDetailScreens() and
  // recurses to a stack overflow. The in-flight paint always finishes with the
  // current store state, so collapsing the re-entrant call into it is correct.
  if (painting) return;
  painting = true;
  try {
    paintBody();
  } finally {
    painting = false;
  }
}

function paintBody() {
  maybeRouteSessionSelection();
  // Routing a session selection flips sessions.view to 'session' — app.js's
  // render() dispatch will unmount this shell on its next call; painting a
  // screen here in the meantime would just be thrown away, so bail.
  if (sessions.get().view === 'session') return;

  maybeApplyMoreDeepLink();
  const tab = tabForSurface(nav.get().surface);
  paintTabs();

  if (tab === 'cockpit') {
    mountCockpit();
    showOnly('cockpit');
    paintCockpitHeader();
  } else if (tab === 'tracked') {
    mountTracked();
    showOnly('tracked');
    paintTrackedHeader();
  } else if (tab === 'sessions') {
    mountSessions();
    showOnly('sessions');
    paintSessionsHeader();
  } else if (tab === 'schedules') {
    mountSchedules();
    showOnly('schedules');
    paintSchedulesHeader();
  } else {
    const { screen, nextMoreAtRoot } = resolveMoreScreen(moreAtRoot, nav.get().surface);
    moreAtRoot = nextMoreAtRoot;
    if (screen === 'skills') { mountSkills(); showOnly('skills'); }
    else if (screen === 'settings') { mountSettings(); showOnly('settings'); }
    else if (screen === 'runs') { mountRuns(); showOnly('runs'); }
    else { mountMoreRoot(); showOnly('more-root'); }
    paintMoreHeader();
  }
  // moreAtRoot flips don't pass through any store, so history.js's own
  // subscriptions can't see them — reconcile here as well.
  syncHistory();
}

// ── Mount / unmount ──────────────────────────────────────────────────────

let unsubscribers = [];

export function mountMobileShell(root) {
  if (mounted) { paint(); return; }
  mounted = true;

  // First-ever mount: #root still carries either the static index.html
  // placeholder (cold boot) or nothing (session-view's own unmount() already
  // clears its subtree) — either way, this is the one place that needs to
  // own a clean slate before appending .m-shell.
  root.textContent = '';

  shellEl = document.createElement('div');
  shellEl.className = 'm-shell';
  shellEl.innerHTML = `
    <div class="m-body" id="m-body"></div>
    <button type="button" class="m-fab" id="m-fab" aria-label="New session or project">＋</button>
    <div class="m-tabs" id="m-tabs" role="tablist" aria-label="Primary"></div>
  `;
  root.appendChild(shellEl);
  bodyEl = shellEl.querySelector('#m-body');
  fabEl = shellEl.querySelector('#m-fab');
  tabsEl = shellEl.querySelector('#m-tabs');

  buildTabs();
  fabEl.addEventListener('click', () => openPalette());
  wireHistory({ getShellDepth: shellNavDepth, popShell: popShellLevel });

  unsubscribers = [
    nav.subscribe(paint),
    work.subscribe(paint),
    approvals.subscribe(paint),
    sessions.subscribe(paint),
    schedulesStore.subscribe(paint),
    // The cockpit tab badge counts action proposals and routine failures too, so the
    // stores those come from have to repaint the tab bar like every other input.
    actions.subscribe(paint),
    runs.subscribe(paint),
  ];
  if (!schedulesStore.get().loaded && !schedulesStore.get().loading) schedulesStore.load();

  paint();
}

// Torn down when the layout flips to desktop mid-session (onLayoutChange) so
// the two shells never both hold live subscriptions at once.
export function unmountMobileShell() {
  if (!mounted) return;
  mounted = false;
  for (const unsub of unsubscribers) { try { unsub(); } catch { /* ignore */ } }
  unsubscribers = [];
  if (cockpitUnmount) { try { cockpitUnmount(); } catch { /* ignore */ } cockpitUnmount = null; }
  if (sessionsListUnmount) { try { sessionsListUnmount(); } catch { /* ignore */ } sessionsListUnmount = null; }
  if (moreRootUnmount) { try { moreRootUnmount(); } catch { /* ignore */ } moreRootUnmount = null; }
  if (tabContainers.runs?.__runsUnmount) { try { tabContainers.runs.__runsUnmount(); } catch { /* ignore */ } }
  for (const handle of Object.values(screenHandles)) { try { handle.unmount(); } catch { /* ignore */ } }
  for (const key of Object.keys(screenHandles)) delete screenHandles[key];
  for (const key of Object.keys(tabContainers)) delete tabContainers[key];
  shellEl?.remove();
  shellEl = null; bodyEl = null; tabsEl = null; fabEl = null;
}

export function isMobileShellMounted() {
  return mounted;
}

export function repaintMobileShell() {
  if (mounted) paint();
}
