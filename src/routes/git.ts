import type { Server } from '../server.js';
import type { SessionStore } from '../session/session-store.js';
import type { WorktreeManager } from '../git/worktree-manager.js';
import { diffBaseFor } from '../git/worktree-manager.js';
import type { WorkEngine } from '../work/engine.js';
import type { PrWatcher } from '../integrations/pr-watcher.js';
import {
  resolveSessionGitCwd, gitStatus, gitLog, gitCommit, gitPush, gitPull, gitStage,
  gitDiscard, gitCreateBranch, gitOpenPr, gitFinalizeSquashMerge, gitFinalizeSquashToBranch,
  gitFinalizeAppendToBranch, gitRemoteBranchExists, gitSquashMergeToBase,
} from '../git/git-ops.js';
import type { GitCommandResult } from '../git/git-ops.js';
import { handleDiffRoute } from '../git/diff-endpoint.js';
import { readJsonObject } from './util.js';

export interface GitRoutesDeps {
  sessionStore: SessionStore;
  worktreeManager: WorktreeManager;
  engine: WorkEngine;
  prWatcher: PrWatcher;
}

// Git endpoints resolve cwd to worktree path for worktree-backed sessions, else project cwd.
// Write actions return a fresh status snapshot so the PWA can repaint without an extra round-trip.
export function registerGitRoutes(server: Server, deps: GitRoutesDeps): void {
  const { sessionStore, worktreeManager, engine, prWatcher } = deps;

  server.route('GET', '/api/sessions/:id/diff', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/diff$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const mode = url.searchParams.get('mode') ?? 'branch';
    try {
      const result = handleDiffRoute(worktreeManager, sessionStore, m[1]!, mode, engine);
      res.statusCode = result.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.route('GET', '/api/sessions/:id/git/status', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/status$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    try {
      const status = await gitStatus(resolved.cwd);
      // Orchestrator step sessions run under a minted sessionId while their
      // worktree record is keyed by stepId, so a direct get(sessionId) misses.
      // Resolve through the engine first (session → stepId → record); fall back
      // to the direct lookup for plain worktree sessions keyed by their own id.
      const wt = engine.worktreeRecordForSession(m[1]!) ?? worktreeManager.get(m[1]!);
      const worktree = wt && !wt.archivedAt && wt.worktreePath
        ? { branch: wt.branch, baseBranch: wt.baseBranch || 'main', parentCwd: wt.projectCwd }
        : null;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...status, worktree }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.route('GET', '/api/sessions/:id/git/log', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/git\/log$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const limit = Number(url.searchParams.get('limit') ?? '20');
    try {
      const entries = await gitLog(resolved.cwd, Number.isFinite(limit) ? limit : 20);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ entries }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  // Diff-overlay "Send review" endpoint. Validates the text, then answers
  // `{ handled: 'chat' }` so the caller sends it as a plain user message over the
  // session WS.
  server.route('POST', '/api/sessions/:id/git/review', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/review$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sessionId = m[1]!;
    // Existence check — an unknown session shouldn't quietly route into orchestrator.
    if (!sessionStore.findSession(sessionId)) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    const payload = await readJsonObject<{ text?: unknown }>(req, res);
    if (!payload) return;
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
      res.statusCode = 400; res.end('text required'); return;
    }
    if (payload.text.length > 20000) {
      res.statusCode = 400; res.end('text too long (20000 char max)'); return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ handled: 'chat' }));
  });

  server.route('POST', '/api/sessions/:id/git/commit', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/commit$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const payload = await readJsonObject<{ message?: string }>(req, res);
    if (!payload) return;
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message.trim().length === 0) {
      res.statusCode = 400; res.end('commit message required'); return;
    }
    if (message.length > 5000) {
      res.statusCode = 400; res.end('commit message too long (5000 char max)'); return;
    }
    const result = await gitCommit(resolved.cwd, message);
    let status;
    try { status = await gitStatus(resolved.cwd); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });

  server.route('POST', '/api/sessions/:id/git/stage', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/stage$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const payload = await readJsonObject<{ paths?: unknown; action?: unknown }>(req, res);
    if (!payload) return;
    const action = payload.action;
    if (action !== 'stage' && action !== 'unstage') {
      res.statusCode = 400; res.end('action must be "stage" or "unstage"'); return;
    }
    if (!Array.isArray(payload.paths) || payload.paths.length === 0 || payload.paths.length > 500) {
      res.statusCode = 400; res.end('paths must be a 1..500 element array'); return;
    }
    const result = await gitStage(resolved.cwd, payload.paths as string[], action);
    let status;
    try { status = await gitStatus(resolved.cwd); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });

  // Destructive: staged + unstaged restored, untracked removed. Worktree-only —
  // same posture as /git/finalize; never runs against a user's primary checkout.
  server.route('POST', '/api/sessions/:id/git/discard', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/discard$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    // Step sessions key their worktree by stepId, so resolve through the engine
    // first (session → stepId → record); direct lookup covers plain sessions.
    const rec = engine.worktreeRecordForSession(m[1]!) ?? worktreeManager.get(m[1]!);
    if (!rec || rec.archivedAt || !rec.worktreePath) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'discard is only valid for active worktree sessions' }));
      return;
    }
    const payload = await readJsonObject<{ paths?: unknown }>(req, res, { allowEmpty: true });
    if (!payload) return;
    let paths: string[] | undefined;
    if (payload.paths !== undefined) {
      if (!Array.isArray(payload.paths) || payload.paths.length === 0 || payload.paths.length > 500) {
        res.statusCode = 400; res.end('paths must be a 1..500 element array'); return;
      }
      paths = payload.paths as string[];
    }
    const result = await gitDiscard(rec.worktreePath, paths);
    let status;
    try { status = await gitStatus(rec.worktreePath); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });

  server.route('POST', '/api/sessions/:id/git/create-branch', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/create-branch$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const payload = await readJsonObject<{ newBranch?: unknown }>(req, res);
    if (!payload) return;
    if (typeof payload.newBranch !== 'string') {
      res.statusCode = 400; res.end('newBranch required'); return;
    }
    const result = await gitCreateBranch(resolved.cwd, payload.newBranch);
    let status;
    try { status = await gitStatus(resolved.cwd); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });

  server.route('POST', '/api/sessions/:id/git/open-pr', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/open-pr$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const payload = await readJsonObject<{ title?: string; body?: string; base?: string }>(req, res, { allowEmpty: true });
    if (!payload) return;
    const result = await gitOpenPr(resolved.cwd, payload);
    let status;
    try { status = await gitStatus(resolved.cwd); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });

  // Worktree-only. kind=merge-to-base squashes into baseBranch in the parent (optional push);
  // kind=squash-to-branch collapses to one commit, pushes a new branch, opens a PR via gh.
  server.route('POST', '/api/sessions/:id/git/finalize', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/finalize$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sessionId = m[1]!;
    // Step sessions key their worktree by stepId, so resolve through the engine
    // first (session → stepId → record); direct lookup covers plain sessions.
    const rec = engine.worktreeRecordForSession(sessionId) ?? worktreeManager.get(sessionId);
    if (!rec || rec.archivedAt || !rec.worktreePath) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'finalize is only valid for active worktree sessions' }));
      return;
    }
    const payload = await readJsonObject<{ kind?: string; message?: string; newBranch?: string; push?: boolean }>(req, res);
    if (!payload) return;
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message.trim().length === 0) {
      res.statusCode = 400; res.end('message required'); return;
    }
    if (message.length > 5000) {
      res.statusCode = 400; res.end('message too long (5000 char max)'); return;
    }
    const baseBranch = rec.baseBranch && rec.baseBranch.length > 0 ? rec.baseBranch : 'main';
    if (payload.kind === 'merge-to-base') {
      const result = await gitFinalizeSquashMerge({
        parentCwd: rec.projectCwd,
        worktreeBranch: rec.branch,
        baseBranch,
        message,
        push: payload.push === true,
      });
      res.statusCode = result.ok ? 200 : 409;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }
    if (payload.kind === 'squash-to-branch') {
      if (typeof payload.newBranch !== 'string' || payload.newBranch.length === 0) {
        res.statusCode = 400; res.end('newBranch required for squash-to-branch'); return;
      }
      // If origin already has this branch, a PR is open on it — finalize means append,
      // not open. Re-squashing to base would rewind past the pushed head and fail the
      // push (and forcing would rewrite the PR). Fast-forward the round's commits instead.
      const exists = await gitRemoteBranchExists(rec.worktreePath, payload.newBranch);
      const result: GitCommandResult & { url?: string } = exists
        ? await gitFinalizeAppendToBranch({ worktreePath: rec.worktreePath, branch: payload.newBranch, baseBranch })
        : await gitFinalizeSquashToBranch({ worktreePath: rec.worktreePath, baseBranch, baseRef: diffBaseFor(rec), newBranch: payload.newBranch, message });
      // The PR head moved (or a new PR opened) — nudge the watcher so the owning step's
      // controller learns of it without waiting on the hourly sweep.
      if (result.ok) {
        const jobId = engine.jobIdForSession(sessionId);
        if (jobId) prWatcher.noteChanged(jobId);
      }
      res.statusCode = result.ok ? 200 : 409;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }
    res.statusCode = 400; res.end('kind must be "merge-to-base" or "squash-to-branch"');
  });

  // One-click squash-merge of a worktree branch onto its base branch, local only.
  // Conflicts come back to the user to resolve by hand.
  server.route('POST', '/api/sessions/:id/git/squash-to-base', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/squash-to-base$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sessionId = m[1]!;
    const respond = (code: number, body: unknown) => {
      res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
    };

    // Step sessions key their worktree by stepId, so resolve through the engine first.
    const rec = engine.worktreeRecordForSession(sessionId) ?? worktreeManager.get(sessionId);
    if (!rec || rec.archivedAt || !rec.worktreePath) {
      respond(400, { status: 'error', message: 'squash-to-base is only valid for active worktree sessions' });
      return;
    }
    const payload = await readJsonObject<{ message?: string }>(req, res, {
      onInvalid: () => respond(400, { status: 'error', message: 'invalid json' }),
    });
    if (!payload) return;
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) { respond(400, { status: 'error', message: 'message required' }); return; }
    if (message.length > 5000) { respond(400, { status: 'error', message: 'message too long (5000 char max)' }); return; }
    const baseBranch = rec.baseBranch && rec.baseBranch.length > 0 ? rec.baseBranch : 'main';
    const result = await gitSquashMergeToBase({ parentCwd: rec.projectCwd, worktreePath: rec.worktreePath, worktreeBranch: rec.branch, baseBranch, message });
    if (result.ok) respond(200, { status: 'merged' });
    else if (result.reason === 'conflict') respond(409, { status: 'conflict', files: result.files });
    else respond(409, { status: 'error', message: result.message });
  });

  server.route('POST', '/api/sessions/:id/git/push', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/push$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const result = await gitPush(resolved.cwd);
    // The push moves the head, so any prior CI result is stale. Arm the watcher's
    // 1m/5m/15m ladder so the new run's status lands without waiting on the hourly sweep.
    if (result.ok) {
      const jobId = engine.jobIdForSession(m[1]!);
      if (jobId) prWatcher.noteChanged(jobId);
    }
    let status;
    try { status = await gitStatus(resolved.cwd); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });

  server.route('POST', '/api/sessions/:id/git/pull', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/sessions\/([\w-]+)\/git\/pull$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const resolved = resolveSessionGitCwd(worktreeManager, sessionStore, m[1]!, engine);
    if (resolved.kind === 'error') {
      res.statusCode = resolved.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: resolved.message }));
      return;
    }
    const result = await gitPull(resolved.cwd);
    let status;
    try { status = await gitStatus(resolved.cwd); } catch { status = null; }
    res.statusCode = result.ok ? 200 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...result, status }));
  });
}
