// Cross-module callback bridge. app.js exports a handful of side-effectful
// functions (decideApproval, openSession, catchUpFromDisk, ...) that extracted
// components need to call back into. Direct imports would create cycles
// (app.js imports the components; the components would import app.js back), so
// this module holds the callbacks and app.js installs them at boot.
//
// Consumers import the specific functions they need; the wrappers are no-ops
// until installAppBridge() has run, which keeps the module import-safe.

import { nav } from './state/nav.js';

let bridge = {
  catchUpFromDisk: null,
  decideApproval: null,
  forceReconnect: null,
  leaveSession: null,
  openAgentsForSession: null,
  openDiffForSession: null,
  openSession: null,
  refreshSessions: null,
  // Reserved for P2 — keys exist now so surface stubs can import the wrapper
  // functions below without waiting on whoever lands the real implementation,
  // and so no P2 agent has to touch this shared file to register their impl.
  //   openDiffForStep({jobId, stepId, sessionId}) — diff-overlay agent's
  //     mount-parameterized API (D2/P2 contract); Tracked calls it from a
  //     step's CTA instead of reaching into diff-overlay internals.
  //   openScheduleDetail(scheduleId) — schedules agent; jumps the schedules
  //     surface to a given schedule (e.g. from a Cockpit/Runs row).
  //   openRunDetail(run) — runs-history agent; opens a run's underlying
  //     session transcript / step page / scheduled-run detail from any surface.
  //   promoteSessionToJob(sessionId) — ⌘⇧P "Promote to tracked" (D4 #5);
  //     POSTs /api/work/jobs/from-session/:sessionId and navigates to it.
  openDiffForStep: null,
  openScheduleDetail: null,
  openRunDetail: null,
  promoteSessionToJob: null,
};

export function installAppBridge(deps) {
  bridge = { ...bridge, ...deps };
}

export function catchUpFromDisk(sessionId) {
  return bridge.catchUpFromDisk?.(sessionId);
}
export function decideApproval(approvalId, decision, reason) {
  return bridge.decideApproval?.(approvalId, decision, reason);
}
export function forceReconnect() {
  return bridge.forceReconnect?.();
}
export function leaveSession() {
  return bridge.leaveSession?.();
}
export function openAgentsForSession(sessionId) {
  return bridge.openAgentsForSession?.(sessionId);
}
export function openDiffForSession(sessionId) {
  return bridge.openDiffForSession?.(sessionId);
}
export function openSession(opts) {
  return bridge.openSession?.(opts);
}
export function refreshSessions() {
  return bridge.refreshSessions?.() ?? Promise.resolve();
}
export function openDiffForStep(opts) {
  return bridge.openDiffForStep?.(opts);
}
// Default implementation needs no app.js internals (nav is a leaf store), so
// unlike the other bridge keys it works without installAppBridge() wiring it
// up — an override still wins if one's ever installed.
export function openScheduleDetail(scheduleId) {
  if (bridge.openScheduleDetail) return bridge.openScheduleDetail(scheduleId);
  return nav.select('schedules', scheduleId);
}
export function openRunDetail(run) {
  return bridge.openRunDetail?.(run);
}
export function promoteSessionToJob(sessionId) {
  return bridge.promoteSessionToJob?.(sessionId);
}
