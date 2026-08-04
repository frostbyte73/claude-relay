import { createStore } from './create-store.js';
import { workApi } from '../net/work.js';

const initial = {
  jobs: [],
  byId: new Map(),
  focused: null,
  loading: false,
  syncing: false,
  syncingJobId: null,
  error: null,
  filter: 'all',
  lastFetchedAt: 0,
  lastLinearSyncAt: null,
};

const store = createStore(initial);

function indexJobs(list) {
  const byId = new Map();
  for (const j of list) byId.set(j.id, j);
  return byId;
}

function mergeOne(state, updated) {
  const existing = state.byId.get(updated.id);
  // Strict `>` on purpose: the Stop-hook liveness re-broadcast resends the same
  // job with an unchanged updatedAt to flip `live` — `>=` would drop it.
  if (existing && existing.updatedAt > updated.updatedAt) return state;
  const byId = new Map(state.byId);
  byId.set(updated.id, updated);
  const jobs = existing
    ? state.jobs.map((j) => (j.id === updated.id ? updated : j))
    : [updated, ...state.jobs];
  return { ...state, byId, jobs };
}

function removeOne(state, jobId) {
  if (!state.byId.has(jobId)) return state;
  const byId = new Map(state.byId);
  byId.delete(jobId);
  return {
    ...state,
    byId,
    jobs: state.jobs.filter((j) => j.id !== jobId),
    focused: state.focused === jobId ? null : state.focused,
  };
}

async function call(action) {
  try {
    const res = await action();
    if (res?.job) store.set((s) => mergeOne(s, res.job));
    return res;
  } catch (e) {
    store.set((s) => ({ ...s, error: e.message }));
    throw e;
  }
}

export const work = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  async loadAll() {
    store.set((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await workApi.listJobs();
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const lastLinearSyncAt = typeof data?.lastLinearSyncAt === 'number' ? data.lastLinearSyncAt : null;
      store.set((s) => ({ ...s, jobs, byId: indexJobs(jobs), loading: false, lastFetchedAt: Date.now(), lastLinearSyncAt }));
    } catch (e) {
      store.set((s) => ({ ...s, loading: false, error: e.message }));
    }
  },

  async syncLinear() {
    store.set((s) => ({ ...s, syncing: true, error: null }));
    try {
      const data = await workApi.syncNow();
      const lastLinearSyncAt = typeof data?.lastLinearSyncAt === 'number' ? data.lastLinearSyncAt : Date.now();
      store.set((s) => ({ ...s, syncing: false, lastLinearSyncAt }));
      await this.loadAll();
    } catch (e) {
      store.set((s) => ({ ...s, syncing: false, error: e.message }));
    }
  },

  async loadOne(id) {
    try {
      const data = await workApi.getJob(id);
      if (data?.job) store.set((s) => mergeOne(s, data.job));
    } catch (e) {
      store.set((s) => ({ ...s, error: e.message }));
    }
  },

  setFocused(id) {
    store.set((s) => (s.focused === id ? s : { ...s, focused: id }));
  },

  applyWsEvent(payload) {
    if (!payload || typeof payload.jobId !== 'string') return;
    if (payload.job === null) {
      store.set((s) => removeOne(s, payload.jobId));
      return;
    }
    if (payload.job && typeof payload.job.updatedAt === 'number') {
      store.set((s) => mergeOne(s, payload.job));
    }
  },

  setFilter(filter) {
    store.set((s) => (s.filter === filter ? s : { ...s, filter }));
  },

  async createJob(input)         { return call(() => workApi.createJob(input)); },
  async approve(id, body)        { return call(() => workApi.approve(id, body)); },
  async reject(id, body)         { return call(() => workApi.reject(id, body)); },
  async abandon(id)              { return call(() => workApi.abandon(id)); },
  async deleteJob(id)            { await workApi.deleteJob(id); store.set((s) => removeOne(s, id)); },
  async launchOrchestrator(id, context) { const r = await call(() => workApi.launchOrchestrator(id, context)); await this.loadOne(id); return r; },
  async replan(id, feedback)     { return call(() => workApi.replan(id, feedback)); },
  async applyReconciliation(id)  { return call(() => workApi.applyReconciliation(id)); },
  async discardReconciliation(id){ return call(() => workApi.discardReconciliation(id)); },
  async addStep(id, step)        { return call(() => workApi.addStep(id, step)); },
  async editStep(id, stepId, patch) { return call(() => workApi.editStep(id, stepId, patch)); },
  async cancelStep(id, stepId)   { return call(() => workApi.cancelStep(id, stepId)); },
  async reorderSteps(id, ids)    { return call(() => workApi.reorderSteps(id, ids)); },
  async resolveStep(id, stepId, payload) { return call(() => workApi.resolveStep(id, stepId, payload)); },
  async retryStep(id, stepId)    { return call(() => workApi.retryStep(id, stepId)); },
  async rerunLatest(id)          { return call(() => workApi.rerunLatest(id)); },
  async resetJob(id)             { return call(() => workApi.resetJob(id)); },
  async resolveReply(id, stepId, body) { return call(() => workApi.resolveReply(id, stepId, body)); },
  async enqueueEdit(id, stepId, body)  { return call(() => workApi.enqueueEdit(id, stepId, body)); },
  async lockReply(id, stepId, body)    {
    try { await workApi.lockReply(id, stepId, body); }
    catch (e) { store.set((s) => ({ ...s, error: e.message })); }
  },
  async react(id, stepId, body)        { return call(() => workApi.react(id, stepId, body)); },
  async regenerateReply(id, stepId, body) { return call(() => workApi.regenerateReply(id, stepId, body)); },
  // Launch-now: force-fires a parked launch. No job/step payload comes back (just
  // `{launched}`) — the badge update rides the WS work_launch_changed refetch, not a
  // hand-mutate here.
  async launchJob(id)            { return workApi.launchJob(id); },
  async launchStep(id, stepId)   { return workApi.launchStep(id, stepId); },
  async setPriority(id, highPriority) { return call(() => workApi.setJobPriority(id, highPriority)); },
  async syncJob(id) {
    store.set((s) => ({ ...s, syncingJobId: id, error: null }));
    try {
      const res = await workApi.syncJob(id);
      if (res?.job) store.set((s) => mergeOne(s, res.job));
    } catch (e) {
      store.set((s) => ({ ...s, error: e.message }));
    } finally {
      store.set((s) => (s.syncingJobId === id ? { ...s, syncingJobId: null } : s));
    }
  },
};
