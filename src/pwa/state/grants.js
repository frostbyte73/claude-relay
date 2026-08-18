import { createStore } from './create-store.js';
import { metaApi } from '../net/meta.js';

// Backs the Settings > Permissions and Settings > MCP connections sections.
// Groups and allowlist rules change rarely, so the load* entry points are
// cached for the tab's lifetime; MCP status is a live probe and reloads every
// time (mount, and the section's refresh button).
//
// The Permissions page edits groups and rules, so it needs the uncached
// reload* pair: a save repaints from what the server actually persisted, never
// from a local guess at what the PUT did — the daemon normalizes the group and
// can refuse part of an edit, so optimistic state is a lie waiting to happen.

const store = createStore({
  groups: [],
  rules: [],
  mcpServers: [],
  groupsLoaded: false,
  rulesLoaded: false,
  mcpLoaded: false,
  mcpLoading: false,
  err: null,
});

export const grantsStore = {
  get: store.get,
  subscribe: store.subscribe,

  async reloadGroups() {
    try {
      const data = await metaApi.permissionGroups();
      store.set((s) => ({ ...s, groups: Array.isArray(data?.groups) ? data.groups : [], groupsLoaded: true }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message }));
    }
  },

  async reloadRules() {
    try {
      const data = await metaApi.allowlistRules();
      store.set((s) => ({ ...s, rules: Array.isArray(data?.rules) ? data.rules : [], rulesLoaded: true }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message }));
    }
  },

  async loadGroups() {
    if (store.get().groupsLoaded) return;
    await this.reloadGroups();
  },

  async loadRules() {
    if (store.get().rulesLoaded) return;
    await this.reloadRules();
  },

  async loadMcp() {
    store.set((s) => ({ ...s, mcpLoading: true }));
    try {
      const data = await metaApi.mcpStatus();
      store.set((s) => ({ ...s, mcpServers: Array.isArray(data?.servers) ? data.servers : [], mcpLoaded: true, mcpLoading: false }));
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message, mcpLoading: false }));
    }
  },

  async ensurePermissionsLoaded() {
    await Promise.all([this.loadGroups(), this.loadRules()]);
  },
  async ensureMcpLoaded() {
    if (store.get().mcpLoaded || store.get().mcpLoading) return;
    await this.loadMcp();
  },
};

// Cross-section warn-dot signal: Settings > Permissions' MCP connections nav
// item lights up if any configured server is unreachable. Consumed by
// vm/settings.js's settingsSections() rather than computed inline there so
// the view-model stays a pure function of already-derived booleans.
export function mcpHasWarning(state) {
  return (state.mcpServers ?? []).some((s) => s.status === 'unreachable');
}
