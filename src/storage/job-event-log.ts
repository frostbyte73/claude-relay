import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { JobEvent } from '../work/work-types.js';

// Full timeline for one job, alongside its envelope dirs at <jobsDir>/<jobId>/.
// The JobRecord keeps only the last MAX_EVENTS_PER_JOB events so the file it
// rewrites on every mutation stays small; everything spills here instead of being
// dropped, because reflective improvement works off whole traces and a truncated
// tail is the wrong input.

function logPath(jobsDir: string, jobId: string): string {
  return join(jobsDir, jobId, 'events.jsonl');
}

export function appendJobEvent(jobsDir: string, jobId: string, event: JobEvent): void {
  try {
    mkdirSync(join(jobsDir, jobId), { recursive: true, mode: 0o700 });
    appendFileSync(logPath(jobsDir, jobId), JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn(`[job-events] append ${jobId.slice(0, 8)}: ${(e as Error).message}`);
  }
}

export function readJobEvents(jobsDir: string, jobId: string, limit: number): JobEvent[] {
  const path = logPath(jobsDir, jobId);
  if (!existsSync(path)) return [];
  const out: JobEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n').slice(-limit)) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as JobEvent); } catch { /* skip corrupt line */ }
  }
  return out;
}

export function deleteJobEventLog(jobsDir: string, jobId: string): void {
  try { rmSync(join(jobsDir, jobId), { recursive: true, force: true }); }
  catch (e) { console.warn(`[job-events] delete ${jobId.slice(0, 8)}: ${(e as Error).message}`); }
}
