// Tracked surface (list-detail-context layout). Wired into shell/surfaces.js's
// registry — surfaces.js imports renderList/renderDetail/renderContext from
// this file only, so everything P2 needed lives here: list.js (grouped list
// column), detail.js (the one-scroll-story drill-in), focus-rail.js (right
// column). This file is just the three thin entry points surfaces.js expects.

import { work } from '../../state/work.js';
import { prPatches } from '../../state/pr-patches.js';
import { worktreeChanges } from '../../state/worktree-changes.js';
import { mountFilterableList } from '../shell/list-filter.js';
import { emptyState } from '../shell/placeholder.js';
import { renderTrackedList } from './list.js';
import { renderTrackedDetail } from './detail.js';
import { renderContext as renderFocusRail } from './focus-rail.js';
import { teardownAllExcept } from './session-mounts.js';

export function renderList(mount) {
  return mountFilterableList(mount, renderTrackedList);
}

export function renderDetail(mount, deps) {
  const { selection } = deps ?? {};
  if (!selection) {
    teardownAllExcept(null); // nothing is selected — close any lingering inline session mounts
    emptyState(mount, 'Select a tracked job to view its timeline.');
    return undefined;
  }
  const paint = () => renderTrackedDetail(mount, selection);
  paint();
  const unsub = work.subscribe(paint);
  // A PR's file diffs arrive after the job does (fetched on demand), and they change what the
  // comment threads render — so they need their own repaint trigger, not just the work store's.
  const unsubPatches = prPatches.subscribe(paint);
  // Ditto for the uncommitted-change count behind the diff button's variant.
  const unsubChanges = worktreeChanges.subscribe(paint);
  return () => {
    unsub();
    unsubPatches();
    unsubChanges();
    teardownAllExcept(null);
  };
}

export function renderContext(mount) {
  return renderFocusRail(mount);
}
