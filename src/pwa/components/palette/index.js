// ⌘K palette overlay (D5). Two-step "Where → What" per palette-v3.html.
//
// Single instance: openPalette()/closePalette() build and tear down one
// overlay in document.body per open, mirroring the sidebar usage-popover
// pattern (shell/sidebar.js) rather than keeping a permanently-mounted (and mostly hidden) DOM
// subtree around.
//
// Rendering discipline (fixes the P1 caret-snap nit): the outer chrome for
// each step is rendered once per step-entry; anything that changes on every
// keystroke (search results, the autocomplete panel) patches its own
// sub-region only. The `<input>`/`<textarea>` nodes themselves are never
// destroyed by a keystroke, so native caret position is never disturbed.
//
// Launch modes talk directly to the same state stores the rest of the P1/P2
// shell already uses for session/job creation — no app-bridge callback
// needed (checked: nav.select + setSessionHint is the real spawn path used
// by shell/list-sessions.js today; work.createJob/launchOrchestrator is the real
// tracked-job path used by new-job-dialog.js). session-ws.js's
// sendUserMessage/sessionWsReadyState are already-exported leaf functions,
// so the initial prompt can be sent once the freshly-spawned session's WS
// comes up, without forking session-view's mount path.

import { sessions } from '../../state/sessions.js';
import { nav, setSessionHint } from '../../state/nav.js';
import { work } from '../../state/work.js';
import { usage } from '../../state/usage.js';
import { actions } from '../../state/actions.js';
import { keymap } from '../../state/keymap.js';
import { settings } from '../../state/settings.js';
import { sessions } from '../../state/sessions.js';
import { startScheduleDraft } from '../schedules/draft.js';
import { sendUserMessage, sessionWsReadyState } from '../session-view/session-ws.js';
import { openAddProjectSheet } from '../cwd-picker.js';
import { registerBackHandler } from '../mobile-shell/history.js';
import { escapeHtml } from '../../util.js';

const RECENT_LIMIT = 5;
const PREFS_KEY = 'outpost:palette:v1';
// Session spawn accepts a per-launch model family ('fable'|'opus'|'sonnet'|'haiku';
// null defers to the daemon default) — the chip's pick rides the session hint
// into the spawn WS query. Ids match state/settings.js's VALID_DEFAULT_MODELS
// so the "Model defaults" setting seeds the chip's initial position 1:1.
const MODEL_CHOICES = [
  { id: null, label: 'Default' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

let overlayEl = null;
let modalEl = null;
export function isPaletteOpen() { return !!overlayEl; }

// Hardware back closes the palette instead of popping a screen — see
// mobile-shell/history.js's registry.
let unregisterPaletteBack = null;

let step = 1;
let query = '';
let highlightIndex = 0;
let selectedCwd = null; // { cwd, branch, kind: 'repo'|'worktree', isGitRepo }
let lastFocused = null;

// Step-2 transient state. promptText/worktreeMode/baseBranch persist across a
// step2→step1→step2 round trip (changing cwd mid-compose shouldn't lose the
// draft); everything resets on openPalette().
let promptText = '';
let worktreeMode = 'in-place';
let baseBranch = null;
let defaultBranch = null;
let branchList = [];
let branchesLoading = false;
let modelIndex = 0;
let autocomplete = null; // { kind: 'skill'|'file', start, query, items, loading } | null
let acIndex = 0;
let fileFetchToken = 0;
let fileDebounceTimer = null;

let installed = false;
// Guards launchSession/launchTrack/launchSchedule against re-entrant firing
// from a double-click on a .p-launch-row button or a repeated ⌘⇧Enter/⌘Enter/
// ⌘⇧S while a previous launch is still in flight (launchTrack awaits two
// network round-trips before closePalette() tears down the listeners).
let submitting = false;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { lastCwd: null, worktreeMode: 'in-place' };
    const p = JSON.parse(raw);
    return {
      lastCwd: typeof p.lastCwd === 'string' ? p.lastCwd : null,
      worktreeMode: p.worktreeMode === 'worktree' ? 'worktree' : 'in-place',
    };
  } catch { return { lastCwd: null, worktreeMode: 'in-place' }; }
}
function savePrefs(next) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
}
let prefs = loadPrefs();

export function initPalette() {
  if (installed) return;
  installed = true;
}

// `opts.prompt` seeds the step-2 textarea (e.g. Library's "Run now" passes
// `/skill-name `); `opts.cwd` (or the remembered lastCwd when a prompt is
// given) skips straight to step 2 so the seeded prompt is immediately
// editable/launchable.
export function openPalette(opts = {}) {
  if (overlayEl) return;
  step = 1;
  query = '';
  highlightIndex = initialHighlightIndex();
  selectedCwd = null;
  promptText = typeof opts.prompt === 'string' ? opts.prompt : '';
  worktreeMode = prefs.worktreeMode;
  baseBranch = null;
  defaultBranch = null;
  branchList = [];
  branchesLoading = false;
  modelIndex = initialModelIndex();
  autocomplete = null;
  acIndex = 0;
  submitting = false;
  lastFocused = document.activeElement;

  overlayEl = document.createElement('div');
  overlayEl.className = 'o-palette-overlay';
  overlayEl.addEventListener('mousedown', (e) => {
    if (e.target === overlayEl) closePalette();
  });

  modalEl = document.createElement('div');
  modalEl.className = 'o-palette';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-label', 'Command palette');
  overlayEl.appendChild(modalEl);
  document.body.appendChild(overlayEl);

  document.addEventListener('keydown', onOverlayKeydown, true);
  unregisterPaletteBack = registerBackHandler(closePalette);
  // Mobile virtual-keyboard-aware scroll: visualViewport shrinks when the
  // soft keyboard opens; re-scroll whatever's focused back into view rather
  // than trying to resize the overlay ourselves (it's already 100dvh and
  // most mobile browsers resize that on their own — this just covers the
  // stragglers). No-op on desktop (visualViewport rarely fires there).
  window.visualViewport?.addEventListener('resize', onViewportResize);
  const targetCwd = opts.cwd ?? (promptText ? prefs.lastCwd : null);
  const entry = targetCwd ? buildCandidates().find((c) => c.cwd === targetCwd) : null;
  if (entry) goToStep2(entry);
  else renderStep1();
}

export function closePalette() {
  if (!overlayEl) return;
  unregisterPaletteBack?.();
  unregisterPaletteBack = null;
  document.removeEventListener('keydown', onOverlayKeydown, true);
  window.visualViewport?.removeEventListener('resize', onViewportResize);
  clearTimeout(fileDebounceTimer);
  overlayEl.remove();
  overlayEl = null;
  modalEl = null;
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

function onViewportResize() {
  const active = document.activeElement;
  if (active && modalEl?.contains(active)) active.scrollIntoView({ block: 'nearest' });
}

function initialModelIndex() {
  const pref = settings.get()?.defaultModel;
  const idx = MODEL_CHOICES.findIndex((m) => m.id === pref);
  return idx >= 0 ? idx : 0; // 'default'/unknown → the null "Default" chip
}

// Preselect-on-reopen (open question resolved yes, per plan D5): the empty-
// query row order is already "Recent" first, but that's sorted by session
// activity, not by what was last picked *in the palette* — highlight the
// remembered cwd specifically when it's still present in the list, falling
// back to the top row otherwise.
function initialHighlightIndex() {
  if (!prefs.lastCwd) return 0;
  const rows = groupedCandidates().flatMap((g) => g.rows);
  const idx = rows.findIndex((r) => r.cwd === prefs.lastCwd);
  return idx >= 0 ? idx : 0;
}

// All keybinding logic lives here (single document-capture listener) rather
// than split across the textarea's own handler — a capture-phase listener on
// an ancestor always runs before a target element's own listener for the same
// event, so anything that needs to win over "Escape closes the autocomplete
// panel but not the whole step" has to be decided at this level.
function onOverlayKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (step === 2 && autocomplete) { autocomplete = null; acIndex = 0; renderAutocomplete(); return; }
    if (step === 2) { goToStep1(); return; }
    closePalette();
    return;
  }
  if (step === 1) {
    if (keymap.matches(e, 'palette.newProject')) { e.preventDefault(); closePalette(); openAddProjectSheet(); }
    return;
  }
  if (step !== 2) return;
  if (keymap.matches(e, 'palette.back')) { e.preventDefault(); goToStep1(); return; }
  if (keymap.matches(e, 'palette.cycleModel')) { e.preventDefault(); cycleModel(); return; }
  if (keymap.matches(e, 'palette.launchSchedule')) { e.preventDefault(); void launchSchedule(); return; }
  if (keymap.matches(e, 'palette.launchTrack')) { e.preventDefault(); void launchTrack(); return; }
  if (keymap.matches(e, 'palette.launchSession')) { e.preventDefault(); void launchSession(); return; }
}

function goToStep1() {
  step = 1;
  query = '';
  highlightIndex = 0;
  renderStep1();
}

function goToStep2(entry) {
  selectedCwd = entry;
  step = 2;
  worktreeMode = (entry.kind === 'repo' && entry.isGitRepo) ? prefs.worktreeMode : 'in-place';
  baseBranch = null;
  defaultBranch = null;
  branchList = [];
  branchesLoading = false;
  autocomplete = null;
  acIndex = 0;
  prefs = { ...prefs, lastCwd: entry.cwd };
  savePrefs(prefs);
  if (!actions.get().loaded && !actions.get().loading) actions.load();
  renderStep2();
  if (worktreeMode === 'worktree') hydrateBranches();
}

// ── Data: candidate cwds from the sessions store — known project roots plus
// every distinct worktree path seen across their sessions. No new endpoint;
// full "git status" (clean/N modified/N ahead) isn't in this data (only
// /api/projects/:x/branches has git detail, and that's branch-only) so that
// status column is omitted rather than faked — branch is shown when known.
function buildCandidates() {
  const projects = sessions.get().projects ?? [];
  const repos = projects.map((p) => ({
    cwd: p.cwd,
    branch: null,
    kind: 'repo',
    isGitRepo: !!p.isGitRepo,
    lastModified: p.lastModified,
  }));
  const worktrees = new Map();
  for (const p of projects) {
    for (const s of p.sessions ?? []) {
      if (!s.worktreePath) continue;
      const existing = worktrees.get(s.worktreePath);
      if (!existing || s.lastModified > existing.lastModified) {
        worktrees.set(s.worktreePath, {
          cwd: s.worktreePath,
          branch: s.worktreeBranch ?? null,
          kind: 'worktree',
          isGitRepo: true,
          lastModified: s.lastModified,
        });
      }
    }
  }
  return [...repos, ...worktrees.values()];
}

function basename(cwd) {
  return (cwd || '').split('/').filter(Boolean).pop() || cwd || '';
}

function groupedCandidates() {
  const all = [...buildCandidates()].sort((a, b) => b.lastModified - a.lastModified);
  const recent = all.slice(0, RECENT_LIMIT);
  const recentCwds = new Set(recent.map((c) => c.cwd));
  const rest = all.filter((c) => !recentCwds.has(c.cwd));
  const ephemeral = rest.filter((c) => c.kind === 'worktree').sort((a, b) => a.cwd.localeCompare(b.cwd));
  const known = rest.filter((c) => c.kind === 'repo').sort((a, b) => a.cwd.localeCompare(b.cwd));
  return [
    { label: 'Recent', rows: recent },
    { label: 'Ephemeral worktrees', rows: ephemeral },
    { label: 'Known repos', rows: known },
  ].filter((g) => g.rows.length > 0);
}

function filteredCandidates(q) {
  const needle = q.toLowerCase();
  const matches = buildCandidates().filter((c) => c.cwd.toLowerCase().includes(needle));
  matches.sort((a, b) => {
    const aBase = basename(a.cwd).toLowerCase().includes(needle);
    const bBase = basename(b.cwd).toLowerCase().includes(needle);
    if (aBase !== bBase) return aBase ? -1 : 1;
    return b.lastModified - a.lastModified;
  });
  return matches;
}

// Flat list of rows in on-screen order — used by both rendering and
// keyboard nav so highlightIndex always lines up with what's drawn.
function flatRows() {
  if (query.trim()) return filteredCandidates(query.trim());
  return groupedCandidates().flatMap((g) => g.rows);
}

function iconFor(kind) {
  return kind === 'worktree'
    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="14" height="14" rx="3" transform="rotate(45 12 12)"/></svg>'
    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="3" transform="rotate(45 12 12)"/></svg>';
}

function highlightPath(cwd, needle) {
  const escaped = escapeHtml(cwd);
  if (!needle) return escaped;
  const idx = cwd.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return escaped;
  const pre = escapeHtml(cwd.slice(0, idx));
  const hit = escapeHtml(cwd.slice(idx, idx + needle.length));
  const post = escapeHtml(cwd.slice(idx + needle.length));
  return `${pre}<span class="match">${hit}</span>${post}`;
}

function rowHtml(entry, idx, needle) {
  const branch = entry.branch ? `<span class="branch">${escapeHtml(entry.branch)}</span>` : '';
  return `
    <div class="search-row${idx === highlightIndex ? ' hit' : ''}" data-idx="${idx}" role="option">
      <span class="icon">${iconFor(entry.kind)}</span>
      <span class="path">${highlightPath(entry.cwd, needle)}</span>
      ${branch}
    </div>`;
}

// ── Step 1 chrome (rendered once per step-entry) + results (patched per keystroke) ──

// Mobile-only takeover header (P3): desktop closes via Escape/scrim-click,
// but a full-screen mobile push has no "outside" to tap — these give touch
// an equivalent close (step 1) / back-to-step-1 (step 2). Hidden on desktop
// via CSS rather than skipped here, so there's one markup source per step.
function mobileBarHtml(withBack) {
  const back = withBack ? '<button type="button" class="p-mobile-btn" data-mact="back" aria-label="Back">&lsaquo; Back</button>' : '<span></span>';
  return `
    <div class="p-mobile-bar">
      ${back}
      <button type="button" class="p-mobile-btn p-mobile-close" data-mact="close" aria-label="Close">&#10005;</button>
    </div>`;
}

function bindMobileBar(root) {
  root.querySelector('[data-mact="close"]')?.addEventListener('click', closePalette);
  root.querySelector('[data-mact="back"]')?.addEventListener('click', goToStep1);
}

function step1Html() {
  return `
    ${mobileBarHtml(false)}
    <div class="search-input">
      <span class="caret" aria-hidden="true">&rsaquo;</span>
      <span class="label o-microhead">In</span>
      <input type="text" class="search-typed" id="p-search-input" value="${escapeHtml(query)}"
        placeholder="Search a repo or worktree…" autocomplete="off" spellcheck="false">
      <div class="step-crumbs" aria-hidden="true">
        <span class="crumb active">1 &middot; Where</span>
        <span class="sep">&rarr;</span>
        <span class="crumb">2 &middot; What</span>
      </div>
    </div>
    <div class="search-results" id="p-search-results" role="listbox"></div>
    <div class="p-foot">
      <div><span class="o-kbd">&uarr;&darr;</span>navigate</div>
      <div><span class="o-kbd">&crarr;</span>select</div>
      <div class="divider">&middot;</div>
      <div><span class="o-kbd">esc</span>close</div>
    </div>`;
}

function searchResultsInnerHtml() {
  const needle = query.trim();
  const rows = flatRows();
  let html;
  if (rows.length === 0) {
    html = `<div class="search-nomatch">No match for <strong>${escapeHtml(needle)}</strong>. Try a different path, or Browse&hellip;.</div>`;
  } else if (needle) {
    html = `<div class="search-group-label o-microhead">Best match</div>${rowHtml(rows[0], 0, needle)}`
      + (rows.length > 1 ? `<div class="search-group-label o-microhead">Other matches</div>${rows.slice(1).map((r, i) => rowHtml(r, i + 1, needle)).join('')}` : '');
  } else {
    let i = 0;
    html = groupedCandidates().map((g) => {
      const rowsHtml = g.rows.map((r) => rowHtml(r, i++, '')).join('');
      return `<div class="search-group-label o-microhead">${escapeHtml(g.label)}</div>${rowsHtml}`;
    }).join('');
  }
  // No OS folder picker exists in this daemon (checked src/routes — /api/files
  // lists tracked files in a KNOWN cwd, it doesn't browse the filesystem), and
  // there's no clone-from-URL backend path either — "Browse…" opens the
  // existing type-a-path add-project sheet (cwd-picker.js) instead of
  // pretending either exists.
  return `${html}
    <div class="search-foot-actions">
      <button type="button" class="search-mini-btn o-btn o-btn--default sm" id="p-browse-btn"
        title="Add a project by path">
        &#128193; Browse&hellip; <span class="o-kbd">&#8984;O</span>
      </button>
    </div>`;
}

function renderStep1() {
  if (!modalEl) return;
  modalEl.innerHTML = step1Html();
  bindStep1Chrome();
  renderSearchResults();
}

function renderSearchResults() {
  const el = modalEl?.querySelector('#p-search-results');
  if (!el) return;
  const rows = flatRows();
  if (highlightIndex >= rows.length) highlightIndex = Math.max(0, rows.length - 1);
  el.innerHTML = searchResultsInnerHtml();
  bindSearchRows(el);
  el.querySelector('#p-browse-btn')?.addEventListener('click', () => {
    closePalette();
    openAddProjectSheet();
  });
  el.querySelector('.search-row.hit')?.scrollIntoView({ block: 'nearest' });
}

function bindStep1Chrome() {
  bindMobileBar(modalEl);
  const input = modalEl.querySelector('#p-search-input');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.addEventListener('focus', () => input.scrollIntoView({ block: 'nearest' }));

  input.addEventListener('input', (e) => {
    query = e.target.value;
    highlightIndex = 0;
    renderSearchResults();
  });

  input.addEventListener('keydown', (e) => {
    const rows = flatRows();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rows.length) { highlightIndex = (highlightIndex + 1) % rows.length; renderSearchResults(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) { highlightIndex = (highlightIndex - 1 + rows.length) % rows.length; renderSearchResults(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = rows[highlightIndex] ?? rows[0];
      if (pick) goToStep2(pick);
    }
  });
}

function bindSearchRows(el) {
  for (const row of el.querySelectorAll('.search-row')) {
    row.addEventListener('click', () => {
      const rows = flatRows();
      const pick = rows[Number(row.dataset.idx)];
      if (pick) goToStep2(pick);
    });
  }
}

// ── Step 2 chrome ─────────────────────────────────────────────────────

function step2Html() {
  return `
    ${mobileBarHtml(true)}
    <div class="cwd-bar" id="p-cwd-bar">${cwdBarInnerHtml()}</div>
    <div class="prompt-area" id="p-prompt-area">
      <textarea class="prompt-textarea" id="p-prompt" rows="4"
        placeholder="Ask, describe a task, or type / for a skill&hellip;"
        spellcheck="false"></textarea>
      <div class="prompt-autocomplete" id="p-autocomplete" hidden></div>
      <div class="prompt-hint">
        <div><span class="o-kbd">&crarr;</span>send as session</div>
        <div><span class="o-kbd">&#8984;&#8679;&crarr;</span>track as job</div>
        <div><span class="o-kbd">&#8679;&#8984;S</span>schedule</div>
      </div>
      <div class="p-launch-row">
        <button type="button" class="p-launch-btn o-btn o-btn--primary" data-launch="session">Send</button>
        <button type="button" class="p-launch-btn o-btn o-btn--default" data-launch="track">Track</button>
        <button type="button" class="p-launch-btn o-btn o-btn--default" data-launch="schedule">Schedule</button>
      </div>
      <div class="p-launch-error" id="p-launch-error" hidden></div>
    </div>
    <div class="p-foot">
      <div><span class="o-kbd">&#8984;&#8679;D</span>change cwd</div>
      <div><span class="o-kbd">&#8984;M</span>model</div>
      <div><span class="o-kbd">@</span>reference file</div>
      <div class="divider">&middot;</div>
      <div><span class="o-kbd">esc</span>back</div>
      <button type="button" class="model-chip o-pill code" title="Cycle model (&#8984;M)">${escapeHtml(MODEL_CHOICES[modelIndex].label)}</button>
    </div>`;
}

function cwdBarInnerHtml() {
  const entry = selectedCwd ?? { cwd: '', branch: null, kind: 'repo' };
  const branch = entry.branch ? `<span class="branch">${escapeHtml(entry.branch)}</span>` : '';
  const canWorktree = entry.kind === 'repo' && entry.isGitRepo;

  let asRow = '';
  if (canWorktree) {
    const explain = worktreeMode === 'worktree'
      ? `Fresh worktree at <code>~/.outpost/wt/&lt;auto&gt;</code>. Your checkout stays untouched.`
      : `Runs directly in the checkout. Modifications land on the current branch.`;
    const branchPicker = worktreeMode === 'worktree' ? `
        <span class="worktree-from">from</span>
        <div class="branch-picker">
          <select class="branch-select" aria-label="Base branch" ${branchesLoading ? 'disabled' : ''}>
            ${branchesLoading
    ? '<option>loading&hellip;</option>'
    : (branchList.length ? branchList : [defaultBranch || 'main']).map((b) => (
      `<option value="${escapeHtml(b)}"${b === baseBranch ? ' selected' : ''}>${escapeHtml(b)}</option>`
    )).join('')}
          </select>
        </div>` : '';
    asRow = `
      <div class="cwd-bar-row">
        <span class="cwd-bar-label o-microhead">As</span>
        <div class="worktree-toggle" role="group" aria-label="Worktree mode">
          <button type="button" class="worktree-seg${worktreeMode === 'in-place' ? ' active' : ''}" data-mode="in-place" aria-pressed="${worktreeMode === 'in-place'}">In-place</button>
          <button type="button" class="worktree-seg${worktreeMode === 'worktree' ? ' active' : ''}" data-mode="worktree" aria-pressed="${worktreeMode === 'worktree'}">New worktree</button>
        </div>
        ${branchPicker}
        <span class="worktree-explain">${explain}</span>
      </div>`;
  } else if (entry.kind === 'worktree') {
    asRow = `
      <div class="cwd-bar-row">
        <span class="cwd-bar-label o-microhead">As</span>
        <span class="worktree-explain">Already an isolated worktree${entry.branch ? ` on <code>${escapeHtml(entry.branch)}</code>` : ''}.</span>
      </div>`;
  }

  return `
    <div class="cwd-bar-row">
      <span class="cwd-bar-label o-microhead">In</span>
      <button type="button" class="cwd-chip-compact" id="p-cwd-chip" title="Change cwd (⌘⇧D)">
        <span class="git-icon">${iconFor(entry.kind)}</span>
        <span>${escapeHtml(entry.cwd)}</span>
        ${branch}
      </button>
      <span class="cwd-change-kbd"><span class="o-kbd">&#8984;&#8679;D</span>change</span>
    </div>
    ${asRow}`;
}

function renderStep2() {
  if (!modalEl) return;
  modalEl.innerHTML = step2Html();
  bindMobileBar(modalEl);
  bindCwdBar(modalEl.querySelector('#p-cwd-bar'));
  bindPromptArea();
  modalEl.querySelector('.model-chip')?.addEventListener('click', cycleModel);
  modalEl.querySelector('.p-launch-row')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-launch]');
    if (!btn) return;
    if (btn.dataset.launch === 'session') void launchSession();
    else if (btn.dataset.launch === 'track') void launchTrack();
    else if (btn.dataset.launch === 'schedule') void launchSchedule();
  });
}

function patchCwdBar() {
  const el = modalEl?.querySelector('#p-cwd-bar');
  if (!el) return;
  el.innerHTML = cwdBarInnerHtml();
  bindCwdBar(el);
}

function bindCwdBar(el) {
  if (!el) return;
  el.querySelector('#p-cwd-chip')?.addEventListener('click', goToStep1);
  for (const seg of el.querySelectorAll('.worktree-seg')) {
    seg.addEventListener('click', () => setWorktreeMode(seg.dataset.mode));
  }
  el.querySelector('.branch-select')?.addEventListener('change', (e) => { baseBranch = e.target.value; });
}

function setWorktreeMode(mode, { persist = true } = {}) {
  if (mode !== 'in-place' && mode !== 'worktree') return;
  if (worktreeMode === mode) return;
  worktreeMode = mode;
  if (persist) { prefs = { ...prefs, worktreeMode: mode }; savePrefs(prefs); }
  patchCwdBar();
  if (mode === 'worktree' && !branchList.length && !branchesLoading) hydrateBranches();
}

const branchCache = new Map();
const BRANCH_CACHE_MS = 30_000;

async function hydrateBranches() {
  if (!selectedCwd || selectedCwd.kind !== 'repo') return;
  const cwd = selectedCwd.cwd;
  const cached = branchCache.get(cwd);
  if (cached && Date.now() - cached.at < BRANCH_CACHE_MS) {
    applyBranches(cached);
    return;
  }
  branchesLoading = true;
  patchCwdBar();
  try {
    const sanitized = cwd.replace(/\//g, '-');
    const r = await fetch(`/api/projects/${encodeURIComponent(sanitized)}/branches`);
    if (r.ok) {
      const data = await r.json();
      const entry = { branches: data.branches ?? [], defaultBranch: data.defaultBranch ?? null, at: Date.now() };
      branchCache.set(cwd, entry);
      if (selectedCwd?.cwd === cwd) applyBranches(entry);
    }
  } catch { /* leave branch list empty — select falls back to a single "main" option */ }
  finally {
    branchesLoading = false;
    if (selectedCwd?.cwd === cwd) patchCwdBar();
  }
}

function applyBranches(entry) {
  branchList = entry.branches.length ? entry.branches : [entry.defaultBranch || 'main'];
  defaultBranch = entry.defaultBranch ?? branchList[0] ?? 'main';
  if (!baseBranch) baseBranch = defaultBranch;
}

// ── Prompt textarea: typing never re-renders the modal (keeps native caret) ──

function bindPromptArea() {
  const ta = modalEl.querySelector('#p-prompt');
  ta.value = promptText;
  ta.addEventListener('input', onPromptInput);
  ta.addEventListener('keydown', onPromptKeydown);
  ta.addEventListener('focus', () => ta.scrollIntoView({ block: 'nearest' }));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function onPromptInput(e) {
  promptText = e.target.value;
  const caret = e.target.selectionStart;
  const detected = computeAutocompleteToken(promptText, caret);
  if (!detected) { autocomplete = null; acIndex = 0; renderAutocomplete(); return; }
  if (detected.kind === 'skill') {
    autocomplete = { ...detected, items: skillItems(detected.query), loading: false };
    acIndex = 0;
    renderAutocomplete();
    return;
  }
  const prevItems = (autocomplete && autocomplete.kind === 'file') ? autocomplete.items : [];
  autocomplete = { ...detected, items: prevItems, loading: true };
  acIndex = 0;
  renderAutocomplete();
  if (selectedCwd?.cwd) {
    debouncedFileSearch(selectedCwd.cwd, detected.query, (files) => {
      if (!autocomplete || autocomplete.kind !== 'file') return; // stale response
      autocomplete = { ...autocomplete, items: files, loading: false };
      acIndex = 0;
      renderAutocomplete();
    });
  }
}

function onPromptKeydown(e) {
  const ta = e.target;
  if (autocomplete && (autocomplete.items.length || autocomplete.loading)) {
    if (e.key === 'ArrowDown' && autocomplete.items.length) {
      e.preventDefault();
      acIndex = (acIndex + 1) % autocomplete.items.length;
      renderAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp' && autocomplete.items.length) {
      e.preventDefault();
      acIndex = (acIndex - 1 + autocomplete.items.length) % autocomplete.items.length;
      renderAutocomplete();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.shiftKey && autocomplete.items.length) {
      e.preventDefault();
      acceptAutocomplete(autocomplete.items[acIndex]);
      return;
    }
    // Escape while the panel is open is handled at the overlay (document
    // capture) level — it runs before this handler ever sees the keydown.
  }
  // Plain Enter sends as a session; Shift+Enter falls through to the textarea's
  // native newline. When the autocomplete panel is open the block above claims
  // Enter to accept the selection, so this only fires with the panel closed.
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    void launchSession();
    return;
  }
  if (e.key === 'Backspace' && ta.value === '' && !autocomplete) {
    e.preventDefault();
    goToStep1();
  }
}

// `/` or `@` triggers autocomplete only when it's the first character of the
// token the caret is currently inside (i.e. right after whitespace/newline or
// at the very start of the text) — typing an email or a path with an `@`
// deeper in a word doesn't pop the panel.
function computeAutocompleteToken(text, caret) {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, caret);
  if (token.startsWith('/')) return { kind: 'skill', start, query: token.slice(1) };
  if (token.startsWith('@')) return { kind: 'file', start, query: token.slice(1) };
  return null;
}

// Merges native slash commands (usage.slashCommands, already loaded at boot
// via /api/info) with the action catalog (state/actions.js — lazily loaded
// on step-2 entry) so `/` surfaces both Claude's built-in commands and every
// Outpost skill by name.
function skillItems(query) {
  const q = query.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const c of usage.get().slashCommands ?? []) {
    if (!c?.name) continue;
    const name = c.name.startsWith('/') ? c.name : `/${c.name}`;
    const bare = name.slice(1).toLowerCase();
    if (q && !bare.includes(q)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: c.description ?? '' });
  }
  for (const a of actions.get().catalog ?? []) {
    if (!a?.name) continue;
    const name = `/${a.name}`;
    if (seen.has(name)) continue;
    const bare = a.name.toLowerCase();
    if (q && !bare.includes(q)) continue;
    seen.add(name);
    out.push({ name, description: a.description ?? a.category ?? '' });
  }
  out.sort((x, y) => {
    const xs = x.name.slice(1).toLowerCase().startsWith(q) ? 0 : 1;
    const ys = y.name.slice(1).toLowerCase().startsWith(q) ? 0 : 1;
    return xs !== ys ? xs - ys : x.name.localeCompare(y.name);
  });
  return out.slice(0, 20);
}

function debouncedFileSearch(cwd, q, cb) {
  const token = ++fileFetchToken;
  clearTimeout(fileDebounceTimer);
  fileDebounceTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}&limit=20`);
      if (token !== fileFetchToken) return;
      if (!r.ok) { cb([]); return; }
      const data = await r.json();
      cb(Array.isArray(data.files) ? data.files : []);
    } catch {
      if (token === fileFetchToken) cb([]);
    }
  }, 180);
}

function renderAutocomplete() {
  const el = modalEl?.querySelector('#p-autocomplete');
  if (!el) return;
  if (!autocomplete || (!autocomplete.items.length && !autocomplete.loading)) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  if (!autocomplete.items.length) {
    el.innerHTML = `<div class="ac-empty">${autocomplete.loading ? 'Searching&hellip;' : 'No matches'}</div>`;
    return;
  }
  el.innerHTML = autocomplete.kind === 'skill'
    ? autocomplete.items.map((it, i) => `
      <div class="ac-item${i === acIndex ? ' hit' : ''}" data-idx="${i}">
        <span class="ac-name">${escapeHtml(it.name)}</span>
        ${it.description ? `<span class="ac-desc">${escapeHtml(it.description)}</span>` : ''}
      </div>`).join('')
    : autocomplete.items.map((it, i) => `
      <div class="ac-item${i === acIndex ? ' hit' : ''}" data-idx="${i}">
        <span class="ac-name">${escapeHtml(it)}</span>
      </div>`).join('');
  for (const row of el.querySelectorAll('.ac-item')) {
    // mousedown (not click) + preventDefault so the textarea never blurs before the pick registers.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptAutocomplete(autocomplete.items[Number(row.dataset.idx)]);
    });
  }
  el.querySelector('.ac-item.hit')?.scrollIntoView({ block: 'nearest' });
}

function acceptAutocomplete(item) {
  const ta = modalEl?.querySelector('#p-prompt');
  if (!ta || !autocomplete) return;
  const insertText = autocomplete.kind === 'skill' ? `${item.name} ` : `@${item} `;
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, autocomplete.start) + insertText;
  const after = ta.value.slice(caret);
  ta.value = before + after;
  promptText = ta.value;
  const pos = before.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  autocomplete = null;
  acIndex = 0;
  renderAutocomplete();
}

function cycleModel() {
  modelIndex = (modelIndex + 1) % MODEL_CHOICES.length;
  const chip = modalEl?.querySelector('.model-chip');
  if (chip) chip.textContent = MODEL_CHOICES[modelIndex].label;
}

function showLaunchError(text) {
  const el = modalEl?.querySelector('#p-launch-error');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text ?? '';
}

function deriveTitle(prompt, cwd) {
  const text = (prompt || '').trim();
  if (text) {
    const firstLine = text.split('\n')[0].trim();
    return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
  }
  return basename(cwd) || 'Session';
}

// ── Launch modes ──────────────────────────────────────────────────────

// ⌘↵ — the real session-spawn path: setSessionHint + nav.select('sessions', id)
// is exactly what shell/list-sessions.js's "New session" row already does: the
// sessions surface's renderDetail reads the hint on mount and calls
// mountSessionView, which opens the WS with the spawn hints. No fork, no
// app-bridge callback needed — this file just calls the same public API.
async function launchSession() {
  if (!selectedCwd || submitting) return;
  submitting = true;
  try {
    const ta = modalEl?.querySelector('#p-prompt');
    const prompt = (ta?.value ?? promptText ?? '').trim();
    const cwd = selectedCwd.cwd;
    const id = crypto.randomUUID();
    const spawnMode = worktreeMode === 'worktree' ? 'worktree' : undefined;
    const spawnBaseBranch = spawnMode ? (baseBranch || defaultBranch || 'main') : undefined;
    setSessionHint(id, {
      id,
      cwd,
      spawnCwd: cwd,
      title: deriveTitle(prompt, cwd),
      spawnMode,
      baseBranch: spawnBaseBranch,
      model: MODEL_CHOICES[modelIndex].id ?? undefined,
    });
    nav.select('sessions', id);
    closePalette();
    if (prompt) {
      // Mirror the composer's send(): a brand-new session skips openSession's
      // disk fetch and the live WS user-frame handler ignores plain user text,
      // so without this optimistic append the initial prompt is sent to Claude
      // but never shows in the feed.
      sessions.for(id).appendTranscript({ role: 'user', text: prompt, __pending: true });
      waitForWsAndSend(id, prompt);
    }
  } finally {
    submitting = false;
  }
}

function waitForWsAndSend(id, text, attempt = 0) {
  if (sessionWsReadyState(id) === WebSocket.OPEN) { sendUserMessage(id, text); return; }
  if (attempt > 100) return; // ~15s — give up quietly rather than surface an error for a closed palette
  setTimeout(() => waitForWsAndSend(id, text, attempt + 1), 150);
}

// ⌘⇧↵ — track as job. Auto-flips to worktree (spec decision) without
// persisting that flip as the remembered preference — it's a per-launch
// override, not a manual toggle. `/api/work/jobs` only accepts
// title/description/externalUrl (no cwd/worktree fields), so cwd/worktree/
// model ride along as a metadata block in the description, matching the
// exact pattern the existing "promote session to tracked" endpoint uses.
async function launchTrack() {
  if (!selectedCwd || submitting) return;
  submitting = true;
  showLaunchError(null);
  try {
    const ta = modalEl?.querySelector('#p-prompt');
    const prompt = (ta?.value ?? promptText ?? '').trim();
    const canWorktree = selectedCwd.kind === 'repo' && selectedCwd.isGitRepo;
    if (canWorktree && worktreeMode !== 'worktree') {
      setWorktreeMode('worktree', { persist: false });
    }
    const usingWorktree = canWorktree && worktreeMode === 'worktree';
    if (usingWorktree && !branchList.length && !branchesLoading) await hydrateBranches();
    const effectiveBaseBranch = baseBranch || defaultBranch || 'main';

    const title = deriveTitle(prompt, selectedCwd.cwd);
    const metaLines = [
      `cwd: ${selectedCwd.cwd}`,
      usingWorktree ? `worktree: new, base ${effectiveBaseBranch}` : 'worktree: in-place',
      `model: ${MODEL_CHOICES[modelIndex].id ?? 'default'}`,
    ];
    const description = prompt ? `${prompt}\n\n---\n${metaLines.join('\n')}` : metaLines.join('\n');

    try {
      const res = await work.createJob({ title, description });
      if (res?.job?.id) {
        nav.select('tracked', res.job.id);
        closePalette();
      }
    } catch (e) {
      // Leave the palette open with the draft intact so the user can retry,
      // and say what went wrong right where they're looking.
      showLaunchError(`Track failed: ${e.message}`);
    }
  } finally {
    submitting = false;
  }
}

// ⇧⌘S — schedule. Navigates to the Schedules surface and opens a new draft
// schedule in the detail pane, seeded with the palette's prompt/cwd/model.
async function launchSchedule() {
  if (submitting) return;
  submitting = true;
  try {
    const ta = modalEl?.querySelector('#p-prompt');
    const prompt = (ta?.value ?? promptText ?? '').trim();
    const canWorktree = !!selectedCwd && selectedCwd.kind === 'repo' && selectedCwd.isGitRepo;
    const usingWorktree = canWorktree && worktreeMode === 'worktree';
    const prefill = {
      prompt,
      cwd: selectedCwd?.cwd ?? null,
      worktree: usingWorktree,
      baseBranch: usingWorktree ? (baseBranch || defaultBranch || 'main') : null,
      model: MODEL_CHOICES[modelIndex].id,
    };
    nav.setSurface('schedules');
    closePalette();
    startScheduleDraft(prefill);
  } finally {
    submitting = false;
  }
}
