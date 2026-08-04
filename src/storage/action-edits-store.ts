import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// In-flight meta.build-action edits, mirrored to <runtimeDir>/action-edits/<sessionId>/edit.json
// beside the envelope that session already reads. They used to live only in a Map, so a daemon
// bounce lost both the pending draft and any record that it had existed. The live Map stays in
// routes/actions.ts — this is just the durable half.

export interface ActionProposal {
  summary: string;
  skillMdBefore: string;
  skillMdAfter: string;
  allowlistAdds: Array<{ kind: 'tool' | 'bash' | 'mcp' | 'path'; value: string }>;
  postedAt: number;
}

export interface ActionEdit {
  actionName: string | null;  // null until the skill picks one (new-action flow)
  sessionId: string;
  status: 'editing' | 'review' | 'applying';
  startedAt: number;
  feedback: string;  // initial feedback that started this session
  proposal?: ActionProposal;
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function statePath(rootDir: string, sessionId: string): string {
  return join(rootDir, sessionId, 'edit.json');
}

export function persistEdit(rootDir: string, edit: ActionEdit): void {
  const path = statePath(rootDir, edit.sessionId);
  try {
    mkdirSync(join(rootDir, edit.sessionId), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(edit), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    console.warn(`[action-edit] could not persist edit state: ${(e as Error).message}`);
  }
}

export function forgetEdit(rootDir: string, sessionId: string): void {
  try { rmSync(statePath(rootDir, sessionId), { force: true }); } catch { /* tolerate */ }
}

export function loadPersistedEdits(rootDir: string, now: () => number = () => Date.now()): ActionEdit[] {
  let sessionIds: string[];
  try { sessionIds = readdirSync(rootDir); } catch { return []; }
  const cutoff = now() - STALE_MS;
  const out: ActionEdit[] = [];
  for (const sessionId of sessionIds) {
    let edit: ActionEdit | undefined;
    try { edit = JSON.parse(readFileSync(statePath(rootDir, sessionId), 'utf8')) as ActionEdit; }
    catch { continue; }
    // 'applying' is dropped rather than restored: its write already happened, so reviving it
    // would leave a card stuck mid-apply with nothing left for the user to do.
    const live = typeof edit?.sessionId === 'string' && (edit.status === 'editing' || edit.status === 'review');
    if (!live || !(edit.startedAt > cutoff)) { forgetEdit(rootDir, sessionId); continue; }
    out.push(edit);
  }
  return out;
}
