// Per-step cache of a PR's file diffs, keyed `${jobId}:${stepId}`.
//
// The PR block renders synchronously from the work store, so it can't await anything: it asks
// for whatever patches are already in hand and renders the fallback (the comment's own
// `diff_hunk`) for the rest. `ensure()` kicks the fetch off on a miss and bumps `version` when
// it lands, which is what drives the repaint that swaps the fallback for the real window.

import { createStore } from './create-store.js';
import { workApi } from '../net/work.js';

const store = createStore({ version: 0, byStep: new Map() });

const keyOf = (jobId, stepId) => `${jobId}:${stepId}`;

export const prPatches = {
  get: store.get,
  subscribe: store.subscribe,

  // Patches in hand for this step, or null. Never triggers a fetch — render paths call this.
  for(jobId, stepId) {
    return store.get().byStep.get(keyOf(jobId, stepId))?.patches ?? null;
  },

  // Fetch once per (step, head sha). `headRefOid` is the invalidation key: a fresh push moves
  // every line number in the PR, so patches cached against the old head would anchor comments
  // at the wrong rows. Without a known head (the watcher hasn't polled yet) one fetch is all
  // we do — the next poll supplies a sha and re-arms this.
  ensure(jobId, stepId, headRefOid) {
    const key = keyOf(jobId, stepId);
    const entry = store.get().byStep.get(key);
    if (entry && entry.sha === (headRefOid ?? null)) return;
    if (entry?.pending) return;

    store.set((s) => {
      const byStep = new Map(s.byStep);
      byStep.set(key, { patches: entry?.patches ?? null, sha: entry?.sha ?? null, pending: true });
      return { ...s, byStep };
    });

    workApi.getPrPatches(jobId, stepId).then(
      (data) => land(key, data?.patches ?? {}, headRefOid ?? null),
      // A failed fetch is not an error state worth surfacing — every thread still renders from
      // its own hunk. Park the sha so this doesn't retry on a loop while the step repaints.
      () => land(key, entry?.patches ?? {}, headRefOid ?? null),
    );
  },
};

function land(key, patches, sha) {
  store.set((s) => {
    const byStep = new Map(s.byStep);
    byStep.set(key, { patches, sha, pending: false });
    return { version: s.version + 1, byStep };
  });
}
