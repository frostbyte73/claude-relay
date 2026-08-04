import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from '../server.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorkEngine } from '../work/engine.js';
import type { Trigger, What } from '../schedules/types.js';
import { readJsonBody } from './util.js';

export interface ScheduleEditDeps {
  manager: SessionManager;
  engine: WorkEngine;
  notifyAll: (message: unknown) => void;
  config: { httpPort: number | null; hookPort: number };
  secret: string;
  runtimeDir: string;
  actionCatalog: () => unknown;
  runScriptTest: (what: Extract<What, { kind: 'script' }>) => Promise<{ outcome: 'ok' | 'error'; output: string }>;
}

export interface ScheduleEditProposal {
  sessionId: string;
  name: string;
  summary: string;
  trigger: Trigger;
  what: What;
}

export interface ScheduleEdit {
  sessionId: string;
  status: 'editing' | 'review';
  startedAt: number;
  prompt: string;
  proposal?: { name: string; summary: string; trigger: Trigger; what: What };
}

export interface ScheduleEditHandle {
  onProposal(p: ScheduleEditProposal): void;
  // Returns the edit that was tracked (so the caller can tell whether the builder
  // exited before ever delivering a proposal), or undefined if none was tracked.
  dropEditForSession(sessionId: string): ScheduleEdit | undefined;
}

// New-schedule authoring surface: prompt in, meta.build-schedule session out, draft
// proposal delivered back over MCP. Mirrors routes/actions.ts's action-edit flow —
// kept in its own module (not folded into routes/schedules.ts) because it owns
// detached-session spawning + envelope plumbing, not schedule CRUD.
export function registerScheduleEditRoutes(server: Server, deps: ScheduleEditDeps): ScheduleEditHandle {
  const { manager, engine, notifyAll, config, secret, runtimeDir } = deps;
  const edits = new Map<string, ScheduleEdit>();

  function loopbackApiUrl(): string {
    const port = config.httpPort;
    return port !== null ? `http://127.0.0.1:${port}` : '';
  }

  function scheduleEditEnv(sessionId: string, envelopePath: string): Record<string, string> {
    return {
      OUTPOST_API_URL: loopbackApiUrl(),
      OUTPOST_ENVELOPE: envelopePath,
      OUTPOST_HOOK_PORT: String(config.hookPort),
      DAEMON_AUTH: secret,
      SCHEDULE_EDIT_SESSION_ID: sessionId,
    };
  }

  function writeEnvelope(sessionId: string, body: object): string {
    const dir = join(runtimeDir, 'schedule-edits', sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'envelope.json');
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
  }

  function spawnBuilder(sessionId: string, envelope: object): void {
    const envelopePath = writeEnvelope(sessionId, envelope);
    manager.spawnDetached(sessionId, runtimeDir, scheduleEditEnv(sessionId, envelopePath), 'default');
    manager.tagKind(sessionId, 'schedule-edit');
    engine.bindAction(sessionId, 'meta.build-schedule');
    engine.stampActionSession(sessionId, 'meta.build-schedule', 'New schedule');
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: '/meta.build-schedule' } });
  }

  server.route('POST', '/api/schedules/new', async (req, res) => {
    const body = await readJsonBody<{ prompt?: string }>(req);
    const prompt = (body?.prompt ?? '').trim();
    if (!prompt) { res.statusCode = 400; res.end('prompt is required'); return; }
    const sessionId = randomUUID();
    spawnBuilder(sessionId, {
      kind: 'schedule-edit',
      mode: 'new' as const,
      prompt,
      actionCatalog: deps.actionCatalog(),
      scheduleEditSessionId: sessionId,
      proposalRoute: '/work/schedule-proposal',
    });
    edits.set(sessionId, { sessionId, status: 'editing', startedAt: Date.now(), prompt });
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId }));
  });

  server.route('POST', '/api/schedules/test', async (req, res) => {
    const body = await readJsonBody<{ what?: What }>(req);
    const what = body?.what;
    if (!what || (what as { kind?: string }).kind !== 'script') {
      res.statusCode = 400; res.end('test only applies to script schedules'); return;
    }
    try {
      const r = await deps.runScriptTest(what as Extract<What, { kind: 'script' }>);
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r));
    } catch (e) {
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ outcome: 'error', output: (e as Error).message }));
    }
  });

  server.route('POST', '/api/schedules/:sessionId/redraft', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/schedules\/([\w-]+)\/redraft$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sessionId = m[1]!;
    const body = await readJsonBody<{ error?: string; currentDraft?: { name: string; trigger: Trigger; what: What } }>(req);
    const edit = edits.get(sessionId);
    const envelope = {
      kind: 'schedule-edit', mode: 'redraft' as const,
      prompt: edit?.prompt ?? '',
      currentDraft: body?.currentDraft ?? edit?.proposal ?? null,
      testError: body?.error ?? '',
      actionCatalog: deps.actionCatalog(),
      scheduleEditSessionId: sessionId,
      proposalRoute: '/work/schedule-proposal',
    };
    const envelopePath = writeEnvelope(sessionId, envelope);
    if (edit) {
      // Session's still alive (test happens right after the proposal, in the same
      // review turn) — feed it the error + draft rather than spawning a duplicate builder.
      manager.sendOrResume(
        sessionId, runtimeDir,
        { type: 'user', message: { role: 'user', content: '/meta.build-schedule' } },
        scheduleEditEnv(sessionId, envelopePath),
      );
    } else {
      spawnBuilder(sessionId, envelope);
      edits.set(sessionId, { sessionId, status: 'editing', startedAt: Date.now(), prompt: envelope.prompt });
    }
    res.statusCode = 202; res.end();
  });

  function dropEditForSession(sessionId: string): ScheduleEdit | undefined {
    const edit = edits.get(sessionId);
    edits.delete(sessionId);
    return edit;
  }

  return {
    onProposal(p) {
      const edit = edits.get(p.sessionId);
      if (!edit) return;
      edit.status = 'review';
      edit.proposal = { name: p.name, summary: p.summary, trigger: p.trigger, what: p.what };
      notifyAll({ type: 'schedule_draft_ready', sessionId: p.sessionId, name: p.name, summary: p.summary, trigger: p.trigger, what: p.what });
    },
    dropEditForSession,
  };
}
