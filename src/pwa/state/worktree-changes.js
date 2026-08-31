// Per-session count of uncommitted changes in a step's worktree, keyed by session id.
//
// This is what makes the tracked timeline's "Review changes" button accent itself: a dirty
// worktree is work waiting on the user, and the card can't tell that from the job record —
// nothing in `PrFacts` describes the working tree. So the render path reads whatever count is
// in hand (`for()`, never fetches) and `ensure()` refreshes it behind the paint, bumping
// `version` when it lands, exactly like pr-patches.js.
//
// `sig` is the primary invalidation key: pass something that moves when the worktree plausibly
// did — the step's `updatedAt` — so a controller round that commits its edits is what triggers
// the re-read, and a hundred repaints in between cost nothing. The dirty→clean transition no
// step mutation covers is the user committing in the diff overlay themselves; that path calls
// `note()` with the status it already fetched.

import { createStore } from './create-store.js';

const store = createStore({ version: 0, bySession: new Map() });

// The third way a tree gets dirty is the user editing files in their own editor, which moves
// no step and opens no overlay — so a cached count also expires on age. This is NOT a poll:
// nothing here runs on a timer, an expired entry is only re-read the next time something
// paints the card anyway.
const STALE_MS = 30_000;

export const worktreeChanges = {
  get: store.get,
  subscribe: store.subscribe,

  // `{ changed, clean }` in hand for this session, or null when nothing has landed yet
  // (including after a failed read — an unknown tree is reported as unknown, not as clean).
  for(sessionId) {
    const e = store.get().bySession.get(sessionId);
    return e && e.changed != null ? { changed: e.changed, clean: e.changed === 0 } : null;
  },

  ensure(sessionId, sig) {
    if (!sessionId) return;
    const key = String(sig ?? '');
    const entry = store.get().bySession.get(sessionId);
    if (entry?.pending) return;
    if (entry && entry.sig === key && Date.now() - entry.at < STALE_MS) return;

    write(sessionId, (prev) => ({ ...prev, pending: true }));
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/changes`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => land(sessionId, key, typeof data?.changed === 'number' ? data.changed : null))
      // A worktree that can't be read (archived, torn down, daemon hiccup) lands as unknown,
      // so it isn't re-tried until the sig moves or the entry ages out — never once a repaint.
      // The button just stays in its neutral variant meanwhile.
      .catch(() => land(sessionId, key, null));
  },

  // Fold in a `/git/status` payload a caller already had. Keeps the current sig, because this
  // reading is at least as fresh as the one the sig stands for.
  note(sessionId, status) {
    if (!sessionId || !status || !Array.isArray(status.files)) return;
    land(sessionId, store.get().bySession.get(sessionId)?.sig ?? null, status.files.length);
  },
};

function write(sessionId, update) {
  store.set((s) => {
    const bySession = new Map(s.bySession);
    bySession.set(sessionId, update(bySession.get(sessionId) ?? { changed: null, sig: null, at: 0, pending: false }));
    return { ...s, bySession };
  });
}

// `version` is what the tracked detail folds into its paint key, so it moves only when the
// answer moves: a re-read that confirms the same count must not cost a full repaint of the
// job (see detail.js — the paint rebuilds every inline session mount).
function land(sessionId, sig, changed) {
  store.set((s) => {
    const prev = s.bySession.get(sessionId);
    const bySession = new Map(s.bySession);
    bySession.set(sessionId, { changed, sig, at: Date.now(), pending: false });
    return { version: prev?.changed === changed ? s.version : s.version + 1, bySession };
  });
}
