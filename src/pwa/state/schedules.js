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
  // Prompt-first authoring (P-B): the builder's proposed draft per builder
  // sessionId (arrives over WS as schedule_draft_ready), and the last
  // Test-run result per session. Both live outside `schedules` — a draft isn't
  // a persisted record until the user hits Save.
  draftBySession: new Map(),
  testResultBySession: new Map(),
  // sessionId → { reason } when the builder exited before delivering a proposal
  // (arrives over WS as schedule_draft_failed). Lets the draft pane replace the
  // stuck "Drafting…" spinner with the failure + a "Start blank" escape hatch.
  draftFailedBySession: new Map(),
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

  // A fresh proposal supersedes any earlier one for this session and invalidates
  // its stale Test result — the draft the user just tested no longer exists.
  setDraft(sessionId, draft) {
    store.set((s) => {
      const draftBySession = new Map(s.draftBySession);
      draftBySession.set(sessionId, draft);
      const testResultBySession = new Map(s.testResultBySession);
      testResultBySession.delete(sessionId);
      // A proposal that lands after (or instead of) a failure supersedes it.
      const draftFailedBySession = new Map(s.draftFailedBySession);
      draftFailedBySession.delete(sessionId);
      return { ...s, draftBySession, testResultBySession, draftFailedBySession };
    });
  },

  // The builder session ended before proposing a draft: mark the failure so the pane
  // can surface it instead of spinning forever.
  setDraftFailed(sessionId, reason) {
    store.set((s) => {
      const draftFailedBySession = new Map(s.draftFailedBySession);
      draftFailedBySession.set(sessionId, { reason });
      return { ...s, draftFailedBySession };
    });
  },

  clearDraft(sessionId) {
    store.set((s) => {
      if (!s.draftBySession.has(sessionId) && !s.testResultBySession.has(sessionId) && !s.draftFailedBySession.has(sessionId)) return s;
      const draftBySession = new Map(s.draftBySession);
      draftBySession.delete(sessionId);
      const testResultBySession = new Map(s.testResultBySession);
      testResultBySession.delete(sessionId);
      const draftFailedBySession = new Map(s.draftFailedBySession);
      draftFailedBySession.delete(sessionId);
      return { ...s, draftBySession, testResultBySession, draftFailedBySession };
    });
  },

  setTestResult(sessionId, result) {
    store.set((s) => {
      const testResultBySession = new Map(s.testResultBySession);
      testResultBySession.set(sessionId, result);
      return { ...s, testResultBySession };
    });
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
