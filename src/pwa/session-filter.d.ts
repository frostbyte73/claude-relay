import type { SessionInfo } from '../session/session-store.js';

// The 2nd/3rd params are kept for source-compat (call sites pass them) but ignored —
// the daemon auto-archives anything past the 7d window before the PWA ever sees it.
// `hiddenRemaining` always returns 0 for the same reason.
export function partitionSessions(
  sessions: SessionInfo[],
  _extraRevealed: number,
  _nowMs: number,
  opts?: { showArchived?: boolean },
): { visible: SessionInfo[]; hiddenRemaining: number; archivedCount: number };
