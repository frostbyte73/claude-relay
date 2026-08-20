import { createStore } from './create-store.js';
import { actionsApi } from '../net/actions.js';

// Skills-library detail state: the permission-groups catalog (static-ish, loaded
// once) plus per-skill journal-entry and scorecard caches (loaded lazily per
// selection, since fetching all 40+ actions' up front is wasted work).

const store = createStore({
  permissionGroups: [],
  permissionGroupsLoaded: false,
  journalByAction: new Map(),
  journalLoading: new Set(),
  scorecardByAction: new Map(),
  scorecardLoading: new Set(),
  revisionsByAction: new Map(),
  revisionsLoading: new Set(),
});

export const library = {
  get: store.get,
  subscribe: store.subscribe,

  async loadPermissionGroups() {
    if (store.get().permissionGroupsLoaded) return;
    try {
      const data = await actionsApi.permissionGroups();
      store.set((s) => ({ ...s, permissionGroups: data?.groups ?? [], permissionGroupsLoaded: true }));
    } catch {
      // Detail view renders group names without descriptions/counts on failure.
    }
  },

  async loadJournal(name, limit = 8) {
    if (!name) return;
    const s = store.get();
    if (s.journalByAction.has(name) || s.journalLoading.has(name)) return;
    store.set((cur) => ({ ...cur, journalLoading: new Set(cur.journalLoading).add(name) }));
    try {
      const data = await actionsApi.journal(name, limit);
      store.set((cur) => {
        const journalByAction = new Map(cur.journalByAction);
        journalByAction.set(name, data?.entries ?? []);
        const journalLoading = new Set(cur.journalLoading);
        journalLoading.delete(name);
        return { ...cur, journalByAction, journalLoading };
      });
    } catch {
      store.set((cur) => {
        const journalLoading = new Set(cur.journalLoading);
        journalLoading.delete(name);
        return { ...cur, journalLoading };
      });
    }
  },

  async loadScorecard(name, { force = false } = {}) {
    if (!name) return;
    const s = store.get();
    if (s.scorecardLoading.has(name)) return;
    if (!force && s.scorecardByAction.has(name)) return;
    store.set((cur) => ({ ...cur, scorecardLoading: new Set(cur.scorecardLoading).add(name) }));
    let card = null;
    try {
      card = (await actionsApi.scorecard(name))?.scorecard ?? null;
    } catch {
      // Detail view falls back to "no runs recorded yet" on failure.
    }
    store.set((cur) => {
      const scorecardByAction = new Map(cur.scorecardByAction);
      if (card) scorecardByAction.set(name, card);
      const scorecardLoading = new Set(cur.scorecardLoading);
      scorecardLoading.delete(name);
      return { ...cur, scorecardByAction, scorecardLoading };
    });
  },

  // A round settled for this action — refresh only if we already had a card, so a
  // background run doesn't fetch cards for panes nobody is looking at.
  invalidateScorecard(name) {
    if (!name || !store.get().scorecardByAction.has(name)) return;
    void library.loadScorecard(name, { force: true });
  },

  async loadRevisions(name, { force = false } = {}) {
    if (!name) return;
    const s = store.get();
    if (s.revisionsLoading.has(name)) return;
    if (!force && s.revisionsByAction.has(name)) return;
    store.set((cur) => ({ ...cur, revisionsLoading: new Set(cur.revisionsLoading).add(name) }));
    let events = null;
    try {
      events = (await actionsApi.revisions(name))?.events ?? [];
    } catch {
      // Detail view falls back to "no recorded revisions yet" on failure.
    }
    store.set((cur) => {
      const revisionsByAction = new Map(cur.revisionsByAction);
      if (events) revisionsByAction.set(name, events);
      const revisionsLoading = new Set(cur.revisionsLoading);
      revisionsLoading.delete(name);
      return { ...cur, revisionsByAction, revisionsLoading };
    });
  },

  invalidateRevisions(name) {
    if (!name || !store.get().revisionsByAction.has(name)) return;
    void library.loadRevisions(name, { force: true });
  },
};
