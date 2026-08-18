// Tab bar definitions + derived counts. Kept separate from index.js (the
// mounter) so the "what counts as which tab" logic is easy to find and test
// independent of DOM wiring.

import { approvals } from '../../state/approvals.js';
import { work } from '../../state/work.js';
import { actions } from '../../state/actions.js';
import { schedulesStore } from '../../state/schedules.js';
import { runs } from '../../state/runs.js';
import { cockpitInbox } from '../../vm/cockpit.js';

export const PRIMARY_SURFACES = ['cockpit', 'tracked', 'sessions', 'schedules'];
export const MORE_SURFACES = ['skills', 'runs', 'settings'];

export const TABS = [
  { key: 'cockpit', label: 'Cockpit', icon: '◈' },
  { key: 'tracked', label: 'Tracked', icon: '◨' },
  { key: 'sessions', label: 'Sessions', icon: '◇' },
  { key: 'schedules', label: 'Schedules', icon: '↻' },
  { key: 'more', label: 'More', icon: '≡' },
];

// Which bottom-tab a nav surface belongs under. Anything not in
// PRIMARY_SURFACES/MORE_SURFACES (shouldn't happen — nav.js sanitizes to
// KNOWN_SURFACES) falls back to cockpit rather than highlighting nothing.
export function tabForSurface(surface) {
  if (PRIMARY_SURFACES.includes(surface)) return surface;
  if (MORE_SURFACES.includes(surface)) return 'more';
  return 'cockpit';
}

// Cockpit tab badge: everything the Cockpit surface itself counts as needing the
// user — one derivation (vm/cockpit.js), two presentations (badge vs. section
// headers). It must be fed the SAME stores the surface reads, or the badge
// silently under-reports exactly the items with no other notification (a pending
// action proposal is the whole reason the surface exists).
export function waitingOnYouCount() {
  const inbox = cockpitInbox({
    pendingApprovals: approvals.get().pending,
    jobs: work.get().jobs,
    actionEdits: actions.get().edits,
    scheduleDrafts: schedulesStore.get().draftBySession,
    runs: runs.get().runs,
    now: Date.now(),
  });
  return inbox.decide.length + inbox.broken.length;
}
