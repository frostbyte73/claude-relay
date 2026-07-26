import { createStore } from './create-store.js';
import { register, push } from './preferences.js';

export const VALID_THEMES = ['halcyon', 'almanac', 'terminal', 'nordic', 'ink', 'botanical', 'plasma', 'atlas', 'library'];
export const VALID_MODES = ['light', 'dark'];
// 'default' defers to whatever the `claude` binary picks (today's behavior —
// the daemon passes no --model flag). Named options let a session-spawn path
// that reads this later (⌘K palette, D5) pin a family without duplicating
// the exact model-id string this file has no authority over.
export const VALID_DEFAULT_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];

function loadTheme() {
  const v = localStorage.getItem('cr:theme');
  return VALID_THEMES.includes(v) ? v : 'halcyon';
}
function loadMode() {
  const v = localStorage.getItem('cr:mode');
  return VALID_MODES.includes(v) ? v : 'dark';
}
function loadDefaultApprovalMode() {
  const v = localStorage.getItem('cr:defaultApprovalMode');
  if (v === 'ask' || v === 'accept-edits' || v === 'plan' || v === 'bypass') return v;
  if (localStorage.getItem('cr:acceptEdits') === 'true') {
    localStorage.removeItem('cr:acceptEdits');
    localStorage.setItem('cr:defaultApprovalMode', 'accept-edits');
    return 'accept-edits';
  }
  return 'ask';
}
function loadDefaultModel() {
  const v = localStorage.getItem('cr:defaultModel');
  return VALID_DEFAULT_MODELS.includes(v) ? v : 'default';
}

const store = createStore({
  theme: loadTheme(),
  mode: loadMode(),
  defaultApprovalMode: loadDefaultApprovalMode(),
  defaultModel: loadDefaultModel(),
  acceptEdits: false,
  modePopoverOpen: false,
  pushPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  pushSubscribed: false,
  pushBusy: false,
  pushLastStatus: '',
});

// pre-paint script in index.html applies these on <html>; mirror so subscribers
// see the same source-of-truth from first read
document.documentElement.setAttribute('data-theme', store.get().theme);
document.documentElement.setAttribute('data-mode', store.get().mode);

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('cr:theme', theme); } catch {}
  store.set((s) => (s.theme === theme ? s : { ...s, theme }));
}
function applyMode(mode) {
  if (!VALID_MODES.includes(mode)) return;
  document.documentElement.setAttribute('data-mode', mode);
  try { localStorage.setItem('cr:mode', mode); } catch {}
  store.set((s) => (s.mode === mode ? s : { ...s, mode }));
}
function applyDefaultApprovalMode(mode) {
  if (mode !== 'ask' && mode !== 'accept-edits' && mode !== 'plan' && mode !== 'bypass') return;
  try { localStorage.setItem('cr:defaultApprovalMode', mode); } catch {}
  store.set((s) => (s.defaultApprovalMode === mode ? s : { ...s, defaultApprovalMode: mode }));
}
function applyDefaultModel(model) {
  if (!VALID_DEFAULT_MODELS.includes(model)) return;
  try { localStorage.setItem('cr:defaultModel', model); } catch {}
  store.set((s) => (s.defaultModel === model ? s : { ...s, defaultModel: model }));
}

register({ key: 'theme', apply: applyTheme, current: () => store.get().theme });
register({ key: 'mode', apply: applyMode, current: () => store.get().mode });
register({ key: 'defaultApprovalMode', apply: applyDefaultApprovalMode, current: () => store.get().defaultApprovalMode });
register({ key: 'defaultModel', apply: applyDefaultModel, current: () => store.get().defaultModel });

export const settings = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  setTheme(theme) {
    applyTheme(theme);
    push('theme', store.get().theme);
  },
  setMode(mode) {
    applyMode(mode);
    push('mode', store.get().mode);
  },
  setDefaultApprovalMode(mode) {
    applyDefaultApprovalMode(mode);
    push('defaultApprovalMode', store.get().defaultApprovalMode);
  },
  setDefaultModel(model) {
    applyDefaultModel(model);
    push('defaultModel', store.get().defaultModel);
  },
  setAcceptEdits(v) {
    store.set((s) => ({ ...s, acceptEdits: !!v }));
  },
  setModePopoverOpen(v) {
    store.set((s) => ({ ...s, modePopoverOpen: !!v }));
  },
  setPushState(patch) {
    store.set((s) => ({ ...s, ...patch }));
  },
};
