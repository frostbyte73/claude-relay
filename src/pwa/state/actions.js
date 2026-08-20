import { createStore } from './create-store.js';
import { actionsApi } from '../net/actions.js';

const initial = {
  // On-disk action registry (with merged allowlist) — what the Actions tab renders.
  actions: [],
  // Action catalog from ActionRegistry — what the plan editor's typed-action picker reads.
  catalog: [],
  skills: [],
  edits: [],
  denials: {},
  // sessionId → { verb, at } — live "doing X right now" indicator for the inline
  // action-builder edit card. Updated by action_edit_activity notifications.
  activity: new Map(),
  loaded: false,
  loading: false,
  err: null,
};

const store = createStore(initial);

// Maps a Claude tool name to the verb shown next to the glowy ellipses.
function verbForTool(toolName) {
  if (!toolName) return 'thinking';
  if (toolName === 'Bash') return 'bashing';
  if (toolName === 'Write') return 'writing';
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') return 'editing';
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS' || toolName === 'NotebookRead') return 'reading';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'searching';
  if (toolName.startsWith('mcp__')) return 'calling';
  return 'thinking';
}

export const actions = {
  get: store.get,
  subscribe: store.subscribe,
  async load() {
    store.set((s) => ({ ...s, loading: true, err: null }));
    try {
      const j = await actionsApi.list();
      store.set((s) => ({
        ...s,
        actions: j.actions ?? [],
        catalog: j.catalog ?? [],
        skills: j.skills ?? [],
        edits: j.edits ?? [],
        denials: j.denials ?? {},
        loaded: true,
        loading: false,
        err: null,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, loading: false, err: String(e) }));
    }
  },
  pushActivity(sessionId, toolName, at) {
    if (!sessionId) return;
    const verb = verbForTool(toolName);
    store.set((s) => {
      const next = new Map(s.activity);
      next.set(sessionId, { verb, at: at ?? Date.now() });
      return { ...s, activity: next };
    });
  },
};

export function editFor(state, actionName) {
  return (state.edits ?? []).find((e) => e.actionName === actionName);
}

// Lookup an in-flight action-edit by its builder session id — the resolver for
// the `new:<sessionId>` skills-surface selection used by the new-action WIP view.
export function findEditBySession(state, sessionId) {
  return (state.edits ?? []).find((e) => e.sessionId === sessionId) ?? null;
}
