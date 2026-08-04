import { createStore } from './create-store.js';
import { schedulesApi } from '../net/schedules.js';

// Full Schedules store (P2). Started as a P1 badge-minimal placeholder (just
// `{schedules, loaded, loading}` for the sidebar's enabled-count); now backs
// the Schedules surface's list/detail too: `runsBySchedule` is a scheduleId →
// ScheduleRun[] (newest-first) map, populated lazily via loadRuns() when a
// schedule is opened rather than eagerly for every schedule.

const store = createStore({
  schedules: [],
  runsBySchedule: new Map(),
  loaded: false,
  loading: false,
  err: null,
});

async function reloadAfter(action) {
  const res = await action();
  await schedulesStore.load();
  return res;
}

export const schedulesStore = {
  get: store.get,
  subscribe: store.subscribe,

  async load() {
    if (store.get().loading) return;
    store.set((s) => ({ ...s, loading: true, err: null }));
    try {
      const data = await schedulesApi.list();
      store.set((s) => ({
        ...s,
        schedules: Array.isArray(data?.schedules) ? data.schedules : [],
        loaded: true,
        loading: false,
      }));
    } catch (e) {
      store.set((s) => ({ ...s, loading: false, err: e.message }));
    }
  },

  async loadRuns(id) {
    try {
      const data = await schedulesApi.listRuns(id);
      const runsList = Array.isArray(data?.runs) ? data.runs : [];
      store.set((s) => {
        const runsBySchedule = new Map(s.runsBySchedule);
        runsBySchedule.set(id, runsList);
        return { ...s, runsBySchedule };
      });
    } catch (e) {
      store.set((s) => ({ ...s, err: e.message }));
    }
  },

  // WS events: `schedules_changed` carries no payload (list-shape change — create/
  // update/delete/duplicate/pause) so it just triggers a refetch; `schedule_run_changed`
  // carries `{scheduleId, run}` and patches that schedule's run list in place (a run's
  // start/finish/skip), no refetch needed.
  applyWsEvent(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'schedules_changed') {
      void this.load();
      return;
    }
    if (msg.type === 'schedule_run_changed' && msg.run && typeof msg.scheduleId === 'string') {
      const { scheduleId, run } = msg;
      store.set((s) => {
        const existing = s.runsBySchedule.get(scheduleId) ?? [];
        const idx = existing.findIndex((r) => r.id === run.id);
        const nextRuns = idx >= 0
          ? existing.map((r, i) => (i === idx ? run : r))
          : [run, ...existing];
        const runsBySchedule = new Map(s.runsBySchedule);
        runsBySchedule.set(scheduleId, nextRuns);
        return { ...s, runsBySchedule };
      });
    }
  },

  // Mutators: the server is authoritative on `nextRunAt` (computed per-GET from the
  // scheduler's armed croner jobs, not stored on the record), so each of these
  // reloads the list rather than merging the raw create/update response in place.
  async create(input)      { return reloadAfter(() => schedulesApi.create(input)); },
  async update(id, patch)  { return reloadAfter(() => schedulesApi.update(id, patch)); },
  async remove(id)         { return reloadAfter(() => schedulesApi.remove(id)); },
  async pause(id)          { return reloadAfter(() => schedulesApi.pause(id)); },
  async resume(id)         { return reloadAfter(() => schedulesApi.update(id, { enabled: true })); },
  async duplicate(id)      { return reloadAfter(() => schedulesApi.duplicate(id)); },
  async runNow(id)         { return schedulesApi.runNow(id); }, // schedule_run_changed WS covers the resulting state
};

export function enabledScheduleCount(state) {
  return (state.schedules ?? []).filter((s) => s.enabled).length;
}
