import { createStore } from './create-store.js';
import { register, push } from './preferences.js';

// Replaces state/workspace.js's activity+paneTree model for the desktop shell
// (D1/D8 of the UX redesign). Surfaces are the new top-level nav destinations;
// each remembers its own last-selected item so switching surfaces and back
// doesn't lose your place. No pane tree — one surface is visible at a time.

const STORAGE_KEY = 'outpost:nav:v1';
const LEGACY_STORAGE_KEY = 'outpost:workspace:v1';

export const KNOWN_SURFACES = ['cockpit', 'tracked', 'sessions', 'schedules', 'skills', 'runs', 'settings'];
const KNOWN_DENSITIES = ['compact', 'default', 'roomy'];
const DEFAULT_LIST_WIDTH = 280;

// Legacy activity → new surface. Anything not listed (or not a known surface
// after mapping) falls back to 'cockpit' per the migration guard.
const ACTIVITY_TO_SURFACE = {
  tickets: 'tracked',
  actions: 'skills',
  prs: 'tracked',
  sessions: 'sessions',
};

function hostKey() {
  // Same daemon origin can be reached from multiple hostnames (localhost, LAN
  // IP, Tailscale magic-DNS) — keyed by host so one host's nav state doesn't
  // clobber another's, matching state/workspace.js's precedent.
  return (typeof location !== 'undefined' && location.host) || 'default';
}

const DENSITY_MIRROR_KEY = 'cr:density';

// density is a global preference (not per-host) — mirrored at `cr:density`.
// One-time migration: existing users have it stashed inside the per-host
// nav blob, so lift it out on first read of a host that hasn't migrated yet.
function loadDensity() {
  try {
    const v = localStorage.getItem(DENSITY_MIRROR_KEY);
    if (KNOWN_DENSITIES.includes(v)) return v;
  } catch { /* fall through */ }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const forHost = raw ? JSON.parse(raw)?.[hostKey()] : null;
    if (forHost && KNOWN_DENSITIES.includes(forHost.density)) {
      localStorage.setItem(DENSITY_MIRROR_KEY, forHost.density);
      return forHost.density;
    }
  } catch { /* fall through */ }
  try {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const legacyForHost = legacyRaw ? JSON.parse(legacyRaw)?.[hostKey()] : null;
    if (legacyForHost && KNOWN_DENSITIES.includes(legacyForHost.density)) {
      localStorage.setItem(DENSITY_MIRROR_KEY, legacyForHost.density);
      return legacyForHost.density;
    }
  } catch { /* fall through */ }
  return 'default';
}

function sanitize(forHost) {
  if (!forHost || typeof forHost !== 'object') return null;
  const surface = KNOWN_SURFACES.includes(forHost.surface) ? forHost.surface : 'cockpit';
  const selectionBySurface = {};
  if (forHost.selectionBySurface && typeof forHost.selectionBySurface === 'object') {
    for (const key of KNOWN_SURFACES) {
      if (forHost.selectionBySurface[key] != null) selectionBySurface[key] = forHost.selectionBySurface[key];
    }
  }
  return {
    surface,
    selectionBySurface,
    listWidth: Number.isFinite(forHost.listWidth) ? forHost.listWidth : DEFAULT_LIST_WIDTH,
    contextCollapsed: !!forHost.contextCollapsed,
    sidebarCollapsed: !!forHost.sidebarCollapsed,
  };
}

// One-time migration from the pane/tab-era workspace store: activity→surface,
// paneTree is dropped entirely (no tab concept survives), density carries over.
function migrateFromWorkspace() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    const forHost = all && all[hostKey()];
    if (!forHost) return null;
    const surface = ACTIVITY_TO_SURFACE[forHost.activity] ?? 'cockpit';
    return sanitize({ surface, density: forHost.density });
  } catch { return null; }
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const all = JSON.parse(raw);
      const forHost = all && all[hostKey()];
      if (forHost) return sanitize(forHost);
    }
  } catch { /* fall through to migration */ }
  return migrateFromWorkspace();
}

function persist(state) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let all = {};
    try { all = raw ? JSON.parse(raw) : {}; } catch { all = {}; }
    all[hostKey()] = {
      surface: state.surface,
      selectionBySurface: state.selectionBySurface,
      listWidth: state.listWidth,
      contextCollapsed: state.contextCollapsed,
      sidebarCollapsed: state.sidebarCollapsed,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch { /* localStorage full or blocked — drop silently */ }
}

const persisted = loadPersisted();

const initial = {
  surface: persisted?.surface ?? 'cockpit',
  selectionBySurface: persisted?.selectionBySurface ?? {},
  listWidth: persisted?.listWidth ?? DEFAULT_LIST_WIDTH,
  contextCollapsed: persisted?.contextCollapsed ?? false,
  sidebarCollapsed: persisted?.sidebarCollapsed ?? false,
  density: loadDensity(),
};

const store = createStore(initial);
store.subscribe(persist);

if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-density', initial.density);
}

function applyDensity(d) {
  if (!KNOWN_DENSITIES.includes(d)) return;
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-density', d);
  try { localStorage.setItem(DENSITY_MIRROR_KEY, d); } catch {}
  store.set((s) => (s.density === d ? s : { ...s, density: d }));
}
register({ key: 'density', apply: applyDensity, current: () => store.get().density });

export const nav = {
  get: store.get,
  subscribe: store.subscribe,

  setSurface(name) {
    if (!KNOWN_SURFACES.includes(name)) return;
    store.set((s) => (s.surface === name ? s : { ...s, surface: name }));
  },
  // Switches to `surface` (if not already there) and records `id` as its
  // selection in one step — the common case for sidebar/palette navigation.
  select(surface, id) {
    if (!KNOWN_SURFACES.includes(surface)) return;
    store.set((s) => ({
      ...s,
      surface,
      selectionBySurface: { ...s.selectionBySurface, [surface]: id ?? null },
    }));
  },
  // Records `id` as the selection for whichever surface is currently active —
  // what list-row click handlers want (the list is only shown for the active
  // surface, so there's no ambiguity about which bucket to write into).
  setSelection(id) {
    store.set((s) => ({
      ...s,
      selectionBySurface: { ...s.selectionBySurface, [s.surface]: id ?? null },
    }));
  },
  setListWidth(px) {
    store.set((s) => ({ ...s, listWidth: Math.max(220, Math.min(560, px)) }));
  },
  setContextCollapsed(v) {
    store.set((s) => ({ ...s, contextCollapsed: !!v }));
  },
  toggleContextCollapsed() {
    store.set((s) => ({ ...s, contextCollapsed: !s.contextCollapsed }));
  },
  toggleSidebarCollapsed() {
    store.set((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }));
  },
  setDensity(d) {
    applyDensity(d);
    push('density', store.get().density);
  },
};

// Transient (non-persisted) per-session spawn context: cwd/spawnCwd/title/
// worktree/spawnMode info for sessions that don't exist in the sessions store
// yet (brand-new sessions) or whose context is cheaper to carry along than to
// re-derive. Deliberately NOT part of the persisted nav shape — it's a
// same-tab handoff between "user clicked New session" and the sessions
// surface's renderDetail, not durable state.
const sessionHints = new Map();

// Fill only null/undefined holes, same rule the slice's identity funnel uses
// (upsertSliceInState). One launch re-enters startSession twice on mobile —
// nav.select('sessions', id) comes back through openSession(id) with no context —
// and a plain overwrite let that second, contextless pass erase the launcher's
// cwd/spawnMode/baseBranch, so the WS connected without a cwd and the daemon
// answered "cwd required for new session" on every reconnect.
export function setSessionHint(id, hint) {
  if (!id) return;
  const existing = sessionHints.get(id);
  if (!existing) { sessionHints.set(id, hint); return; }
  const merged = { ...existing };
  for (const [k, v] of Object.entries(hint)) {
    if (merged[k] === undefined || merged[k] === null) merged[k] = v;
  }
  sessionHints.set(id, merged);
}
// Non-consuming read, for callers that need to know a launcher already seeded
// this session (i.e. it's brand new) without stealing the hint from the mount
// that still has to spend it on the WS's first connect.
export function readSessionHint(id) {
  return (id && sessionHints.get(id)) || null;
}
// Single-consume: the hint only needs to survive the one lookup that resolves
// a brand-new session's context (see sessions-surface/index.js's
// resolveSessionContext), so reclaim it here rather than letting the Map grow
// unbounded for the life of the tab.
export function peekSessionHint(id) {
  const hint = sessionHints.get(id);
  if (hint === undefined) return null;
  sessionHints.delete(id);
  return hint;
}
