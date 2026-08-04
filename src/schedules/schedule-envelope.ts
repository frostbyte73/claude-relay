import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What makes a scheduled skill session something other than blind. Before this, spawnSkillSession
// handed the session an empty env and a bare `/<skill>` message: no envelope, no API url, no auth —
// so a scheduled action had neither its inputs nor a way to report back.
//
// An enricher lets the daemon fold skill-specific state into that envelope (and redirect cwd)
// without this module, or spawnSkillSession, knowing what any particular skill needs. `onSpawned`
// is the post-spawn hook for daemon-side registration that has to exist before the session's
// first turn — meta.improve-actions uses it to open the ActionEdit its proposal will land on.

export interface EnrichedEnvelope {
  envelope: object;
  // Overrides the schedule's repos[0]. Only ever set from a path the daemon resolved itself
  // (actionDirFor), never from schedule input — see spawnSkillSession.
  cwd?: string;
  onSpawned?: (sessionId: string) => void;
}

export interface EnricherContext {
  skill: string;
  args?: Record<string, unknown>;
  repos?: string[];
  scope?: string;
}

export type EnvelopeEnricher = (ctx: EnricherContext) => EnrichedEnvelope;

export class EnvelopeEnricherRegistry {
  private enrichers = new Map<string, EnvelopeEnricher>();
  register(skill: string, fn: EnvelopeEnricher): void { this.enrichers.set(skill, fn); }
  get(skill: string): EnvelopeEnricher | undefined { return this.enrichers.get(skill); }
}

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeScheduleEnvelope(runtimeDir: string, sessionId: string, envelope: object): string {
  const dir = join(runtimeDir, 'schedule-runs', sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'envelope.json');
  atomicWrite(path, JSON.stringify(envelope, null, 2));
  return path;
}
