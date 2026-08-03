import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, createReadStream, writeFileSync, renameSync, readdirSync, readFileSync, realpathSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { Allowlist, type AllowlistConfig } from './permissions/allowlist.js';
import { ProjectRegistry } from './storage/project-registry.js';
import { ApprovalQueue } from './permissions/approvals.js';
import { SessionStore } from './session/session-store.js';
import { SessionManager } from './session/session-manager.js';
import { Server } from './server.js';
import { HookServer } from './permissions/hook-server.js';
import { handleMcpRequest, OUTPOST_MCP_TOOLS } from './mcp-server.js';
import { discoverTailscaleEnv } from './tailscale.js';
import { writeDaemonSettings, writeMcpConfig, generateSecret } from './settings-gen.js';
import { JobQueue } from './work/work-queue.js';
import { withLiveness } from './work/job-liveness.js';
import { JournalStore } from './storage/journal-store.js';
import { LinearPoller } from './integrations/linear-poller.js';
import { LinearWriter } from './integrations/linear-writer.js';
import { PrWatcher } from './integrations/pr-watcher.js';
import { UserPrsWatcher } from './integrations/user-prs-watcher.js';
import { WorkEngine } from './work/engine.js';
import { ensureActionsInstalled, bundledRepoDir } from './setup-actions.js';
import { ActionsStore } from './storage/actions-store.js';
import { ActionRegistry } from './actions/index.js';
import type { PermissionGroupMap } from './actions/types.js';
import { handleHook } from './permissions/hook-handler.js';
import { type ApprovalMode, ApprovalModeStore } from './permissions/approval-mode.js';
import { RecurrenceTracker } from './storage/recurrence-tracker.js';
import { WorktreeManager } from './git/worktree-manager.js';
import { loadOrCreateVapid } from './push-keys.js';
import { SubscriptionStore } from './push-subscriptions.js';
import { PushSender } from './push-sender.js';
import { StopHookTracker } from './storage/stop-hook-tracker.js';
import { UsagePoller, type AccountUsageSnapshot } from './integrations/usage-poller.js';
import { loadConfig } from './config.js';
import { loadEnvFile } from './env-file.js';
import { readBody } from './routes/util.js';
import { registerGitRoutes } from './routes/git.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerProjectsRoutes } from './routes/projects.js';
import { registerPushRoutes } from './routes/push.js';
import { registerMetaRoutes } from './routes/meta.js';
import { PreferencesStore } from './storage/preferences-store.js';
import { registerPreferencesRoutes } from './routes/preferences.js';
import { RunsStore } from './storage/runs-store.js';
import { UsageLedger } from './integrations/usage-ledger.js';
import { createRunsCapture, type ScheduleRunContext } from './storage/runs-capture.js';
import { registerRunsRoutes } from './routes/runs.js';
import { SchedulesStore } from './schedules/schedules-store.js';
import { whatLabel } from './schedules/types.js';
import { Scheduler } from './schedules/scheduler.js';
import { TokenScheduler } from './schedules/token-scheduler.js';
import { SystemScheduleRegistry } from './schedules/system-schedules.js';
import { registerSchedulesRoutes } from './routes/schedules.js';
import { createGuardProviders, createRoutingDeps, createSpawnDeps } from './schedules/wiring.js';
import allowlistDefault from '../config/allowlist.default.json' with { type: 'json' };
import permissionGroupsDefault from '../config/permission-groups.default.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };

// Source `<runtimeDir>/.env` before anything reads process.env: launchd strips shell
// env, so this is how subprocesses (gh pr view, etc.) see GITHUB_TOKEN. plist > .env > defaults.
const PRELOAD_RUNTIME_DIR = process.env.OUTPOST_RUNTIME_DIR ?? join(homedir(), '.outpost');
const envFilePath = join(PRELOAD_RUNTIME_DIR, '.env');
const envFileLoaded = loadEnvFile(envFilePath);
if (envFileLoaded > 0) {
  console.log(`[daemon] loaded ${envFileLoaded} env var${envFileLoaded === 1 ? '' : 's'} from ${envFilePath}`);
}

const config = loadConfig();
const RUNTIME_DIR = config.runtimeDir;
mkdirSync(RUNTIME_DIR, { recursive: true });

// PWA reads this via /api/info so the countdown UI matches the server's expiry deadline.
const APPROVAL_TIMEOUT_MS = config.approvalTimeoutMs;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PWA_DIR = join(SRC_DIR, 'pwa');
// Runtime allowlist is gitignored; first start copies from allowlist.default.json,
// hot-adds atomic-write back so rules survive a restart.
const ALLOWLIST_PATH = config.allowlistPath ?? join(SRC_DIR, '..', 'config', 'allowlist.json');

function loadRuntimeAllowlist(path: string): AllowlistConfig {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as AllowlistConfig;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(allowlistDefault, null, 2) + '\n');
  renameSync(tmp, path);
  return allowlistDefault;
}

// Runtime permission groups are gitignored too; first start copies from
// permission-groups.default.json so a checkout can carry setup-specific
// integrations (e.g. an extra MCP read pattern) without leaking them upstream.
const PERMISSION_GROUPS_PATH = join(SRC_DIR, '..', 'config', 'permission-groups.json');

function loadRuntimePermissionGroups(path: string): PermissionGroupMap {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as PermissionGroupMap;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(permissionGroupsDefault, null, 2) + '\n');
  renameSync(tmp, path);
  return permissionGroupsDefault;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('manifest.json')) return 'application/manifest+json';
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function servePwa(server: Server, pwaDir: string): void {
  const root = resolvePath(pwaDir);
  server.routeFallback('GET', (req, res) => {
    let urlPath = req.url ?? '/';
    const q = urlPath.indexOf('?');
    if (q !== -1) urlPath = urlPath.slice(0, q);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    let decoded: string;
    try { decoded = decodeURIComponent(urlPath); } catch { res.statusCode = 400; res.end(); return; }
    const target = resolvePath(root, '.' + decoded);
    if (!target.startsWith(root + '/') && target !== root) {
      res.statusCode = 404; res.end(); return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.statusCode = 404; res.end(); return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', contentTypeFor(target));
    res.setHeader('cache-control', 'no-cache, must-revalidate');
    createReadStream(target).pipe(res);
  });
}

async function main() {
  // Tailscale discovery failure is non-fatal; the loopback listener is the floor.
  let tsEnv: { certPath: string; keyPath: string; hostname: string; ipv4: string } | null = null;
  if (config.certPath && config.keyPath && config.host) {
    tsEnv = {
      certPath: config.certPath,
      keyPath: config.keyPath,
      hostname: config.host,
      ipv4: config.bindAddress ?? '127.0.0.1',
    };
  } else {
    try {
      tsEnv = discoverTailscaleEnv({ certDir: RUNTIME_DIR });
    } catch (e) {
      console.warn(`[daemon] tailnet listener disabled: ${(e as Error).message}`);
      tsEnv = null;
    }
  }

  if (config.httpPort === null && !tsEnv) {
    console.error('[daemon] no listeners configured: set OUTPOST_HTTP_PORT (default 8080) or configure Tailscale/cert overrides');
    process.exit(1);
  }

  const secret = generateSecret();
  const HOOK_PORT = config.hookPort;
  const settingsPath = join(RUNTIME_DIR, 'daemon-settings.json');
  const mcpConfigPath = join(RUNTIME_DIR, 'daemon-mcp.json');
  writeDaemonSettings({ outPath: settingsPath, hookPort: HOOK_PORT });
  writeMcpConfig({ outPath: mcpConfigPath, hookPort: HOOK_PORT, daemonAuthSecret: secret });

  const projectAllowlistDir = join(RUNTIME_DIR, 'allowlists');
  const outpostActionsDir = join(RUNTIME_DIR, 'actions');
  const actionsStore = new ActionsStore(join(RUNTIME_DIR, 'actions.json'));
  const permissionGroups = loadRuntimePermissionGroups(PERMISSION_GROUPS_PATH);
  // Loaded eagerly so a malformed schema fails the daemon at startup, not at first spawn.
  const actionRegistry = new ActionRegistry(join(SRC_DIR, '..', 'actions'), {
    permissionGroups,
  });
  const registryStats = actionRegistry.load();
  console.log(`[work] action registry: ${registryStats.actions} action${registryStats.actions === 1 ? '' : 's'}`);

  const allowlist = new Allowlist(loadRuntimeAllowlist(ALLOWLIST_PATH), { projectAllowlistDir, actionsStore, actionRegistry });
  const queue = new ApprovalQueue({ timeoutMs: APPROVAL_TIMEOUT_MS });
  const modes = new ApprovalModeStore(join(RUNTIME_DIR, 'approval-modes.json'));
  const recurrence = new RecurrenceTracker();

  // VAPID generated on first start and never rotated — rotating invalidates every device.
  const vapid = loadOrCreateVapid(config.vapidPath);
  const pushStore = new SubscriptionStore(config.pushSubscriptionsPath);
  // Test-only CA pinning: lets e2e stand up a fake push service with a self-signed cert
  // without globally disabling cert verification. Lives at the daemon boundary because
  // production must use Node's default trust store.
  let pushAgent: import('node:https').Agent | undefined;
  const pushCaPath = process.env.OUTPOST_PUSH_CA_PATH;
  if (pushCaPath) {
    const { Agent } = await import('node:https');
    const { readFileSync } = await import('node:fs');
    pushAgent = new Agent({ ca: readFileSync(pushCaPath) });
    console.log(`[push] using pinned CA from ${pushCaPath}`);
  }
  const pushSender = new PushSender({
    store: pushStore,
    vapid,
    ttlSeconds: config.pushTtlSeconds,
    ...(pushAgent ? { agent: pushAgent } : {}),
  });
  console.log(`[daemon] push subscriptions: ${pushStore.list().length} loaded from ${config.pushSubscriptionsPath}`);

  const projectsRoot = config.projectsRoot;
  const projectRegistry = new ProjectRegistry(join(RUNTIME_DIR, 'projects.json'));
  const worktreeManager = new WorktreeManager({ root: join(RUNTIME_DIR, 'worktrees'), projectsRoot });
  const sessionStore = new SessionStore({ root: projectsRoot, registry: projectRegistry, worktreeManager });
  console.log(`[daemon] projects root: ${projectsRoot}`);

  function findSessionTitle(id: string): string | undefined {
    for (const p of sessionStore.listProjects()) {
      const s = p.sessions.find((x) => x.id === id);
      if (s) return s.title;
    }
    return undefined;
  }

  // Test-only event-log overrides; SessionManager applies production defaults if omitted.
  const eventLogMaxEvents = process.env.OUTPOST_EVENT_LOG_MAX_EVENTS
    ? Number(process.env.OUTPOST_EVENT_LOG_MAX_EVENTS)
    : undefined;
  const eventLogMaxAgeMs = process.env.OUTPOST_EVENT_LOG_MAX_AGE_MS
    ? Number(process.env.OUTPOST_EVENT_LOG_MAX_AGE_MS)
    : undefined;

  const stopTracker = new StopHookTracker({ thresholdMs: config.stopHookThresholdMs });

  const manager = new SessionManager({
    settingsPath,
    mcpConfigPath,
    daemonAuthSecret: secret,
    daemonHost: config.host ?? tsEnv?.hostname ?? '127.0.0.1',
    hookPort: config.hookPort,
    sessionStore,
    eventLogMaxEvents,
    eventLogMaxAgeMs,
    worktreeManager,
    onTurnStart: (sessionId) => stopTracker.recordTurnStart(sessionId),
    onSessionRegistered: () => {
      // Trailing debounce: a burst of spawns (e.g. work orchestrator kicking off
      // multiple child sessions) coalesces into a single PWA refresh.
      scheduleSessionsChangedBroadcast();
    },
    onSessionExit: (sessionId, code) => {
      // Session-scoped allow rules die with the session's process.
      allowlist.clearSession(sessionId);
      // Scheduler has no visibility into session completion on its own; a schedule-spawned
      // skill session (see createSpawnDeps.spawnSkillSession) finishing is exactly this event.
      // No-op (via findRunByRef) for any session the scheduler didn't spawn.
      const scheduleRun = schedulesStore.findRunByRef({ sessionId });
      const schedule = scheduleRun ? schedulesStore.get(scheduleRun.scheduleId) : undefined;
      void scheduler.completeRunByRef({ sessionId }, { outcome: code === 0 ? 'ok' : 'error' });
      // Covers ordinary completion (idle-reaped or crashed) — explicit archive/delete also
      // route through here via manager.close(), so runsCapture.onSessionEnd dedupes by sessionId.
      // Tag with schedule context (if this session was schedule-spawned) so it lands in the
      // ledger as kind:'sched' instead of a plain 'sess' row.
      captureSessionEnd(sessionId, schedule ? { id: schedule.id, name: schedule.name, skill: whatLabel(schedule.what) } : undefined);
      const kind = manager.getKind(sessionId);
      if (kind === 'action-edit' || kind === 'skill-edit') {
        if (kind === 'action-edit') {
          try { ensureActionsInstalled(bundledRepoDir(SRC_DIR), RUNTIME_DIR); }
          catch (e) { console.warn(`[work] post-edit re-symlink failed: ${(e as Error).message}`); }
          // Drop any action-edit tracking entry so the card stops showing a "review"
          // pill against a dead session. If the user already approved, the entry was
          // already cleared and this is a no-op.
          const located = findEditBySession(sessionId);
          if (located) clearEdit(located.key);
        }
        try { notifyAll({ type: 'actions_changed' }); } catch { /* notifyAll not in scope yet during startup */ }
      }

      rebroadcastJobLiveness(sessionId);
    },
  });

  const jobQueue = new JobQueue(RUNTIME_DIR);
  const journalStore = new JournalStore(join(RUNTIME_DIR, 'journal'));
  // Optional per-installation overrides. When unset (the default), LinearWriter
  // resolves the target state from each issue's own team — correct across teams,
  // which a single global UUID can never be. Only forward keys that are actually set.
  const linearStateIds = {
    ...(process.env.LINEAR_STATE_IN_PROGRESS ? { inProgress: process.env.LINEAR_STATE_IN_PROGRESS } : {}),
    ...(process.env.LINEAR_STATE_IN_REVIEW ? { inReview: process.env.LINEAR_STATE_IN_REVIEW } : {}),
    ...(process.env.LINEAR_STATE_DONE ? { done: process.env.LINEAR_STATE_DONE } : {}),
  };
  const linearWriter = new LinearWriter({ stateIds: linearStateIds });
  const engine = new WorkEngine({
    queue: jobQueue,
    linearWriter,
    sessionManager: manager,
    worktreeManager,
    jobsDir: join(RUNTIME_DIR, 'jobs'),
    actionsStore,
    modes,
    journalStore,
    actionRegistry,
  });
  const preferencesStore = new PreferencesStore(join(RUNTIME_DIR, 'preferences.json'));
  const runsStore = new RunsStore(join(RUNTIME_DIR, 'runs.jsonl'));
  const usageLedger = new UsageLedger(join(RUNTIME_DIR, 'usage-ledger.json'));
  const runsCapture = createRunsCapture({
    runsStore,
    usageLedger,
    onRunAppended: (run) => notifyAll({ type: 'run_appended', run }),
  });

  const schedulesStore = new SchedulesStore(join(RUNTIME_DIR, 'schedules', 'index.json'));
  const scheduler = new Scheduler({
    store: schedulesStore,
    guardProviders: createGuardProviders(() => latestAccountUsage ?? undefined, projectRegistry, worktreeManager),
    spawn: createSpawnDeps(engine, manager, projectRegistry, worktreeManager),
    routing: createRoutingDeps(() => process.env.OUTPOST_SLACK_WEBHOOK_URL || undefined, projectRegistry, worktreeManager),
    notify: notifyAll,
  });

  // Launches token-opportunistic schedules when 5h/7d usage leaves headroom. Driven by the usage
  // poller's snapshot stream (hooked in usagePoller.onSnapshot below) — `latestAccountUsage` is
  // read lazily through the closure, so its later declaration is fine.
  const tokenScheduler = new TokenScheduler({
    store: schedulesStore,
    getSnapshot: () => latestAccountUsage ?? undefined,
    fire: (id) => scheduler.fireTokenOpportunistic(id),
  });

  const linearPoller = new LinearPoller({ queue: jobQueue, engine });
  const prWatcher = new PrWatcher({ queue: jobQueue, engine });
  const userPrsWatcher = new UserPrsWatcher({
    statePath: join(RUNTIME_DIR, 'user-prs.json'),
    onChange: (snap) => {
      try { notifyAll({ type: 'user_prs_changed', snapshot: snap }); }
      catch { /* pre-startup */ }
    },
  });

  // Built-in pollers surfaced as read-only "system" schedules. usagePoller is
  // constructed later (after the server) and registered there.
  const systemSchedules = new SystemScheduleRegistry();
  systemSchedules.register(linearPoller);
  systemSchedules.register(prWatcher);
  systemSchedules.register(userPrsWatcher);

  const server = new Server({
    httpPort: config.httpPort,
    ...(tsEnv ? {
      https: {
        certPath: tsEnv.certPath,
        keyPath: tsEnv.keyPath,
        bindAddress: config.bindAddress ?? tsEnv.ipv4,
        httpsPort: config.httpsPort,
      },
    } : {}),
  });

  function cwdForSession(sessionId: string): string | undefined {
    // Worktree sessions return PARENT project's cwd so project-scoped allowlist rules match.
    const wtRec = worktreeManager.get(sessionId);
    if (wtRec && !wtRec.archivedAt) return wtRec.projectCwd;
    // In-memory spawn cwd handles brand-new sessions before the first JSONL flush.
    return sessionStore.findSession(sessionId)?.cwd ?? manager.getCwd(sessionId);
  }

  // Cache last statusline per session so the meter renders immediately on reattach after
  // the claude subprocess (and its event log) has exited. Memory-only by design.
  const latestStatuslineBySession = new Map<string, object>();

  // action-edit/skill-edit sessions aren't user-facing "runs" — exclude them from the ledger.
  // Called from onSessionExit (ordinary completion/idle-reap/crash) and from the sessions
  // routes' explicit archive/delete handlers; runsCapture.onSessionEnd dedupes by sessionId
  // so a session torn down via the PWA doesn't get double-counted.
  function captureSessionEnd(id: string, schedule?: ScheduleRunContext): void {
    if (manager.getKind(id) === 'action-edit' || manager.getKind(id) === 'skill-edit') return;
    const found = sessionStore.findSession(id);
    if (!found) return;
    const sl = latestStatuslineBySession.get(id) as { cost?: { total_cost_usd?: number; total_duration_ms?: number } } | undefined;
    runsCapture.onSessionEnd({
      sessionId: id,
      title: found.session.title,
      cwd: cwdForSession(id),
      durationMs: sl?.cost?.total_duration_ms,
      costUsd: sl?.cost?.total_cost_usd,
      schedule,
    });
  }

  // Forward-declared so the hook-server route can dispatch into the action-edit
  // handler defined later in main() (which closes over `actionEdits`, etc.).
  let onActionProposalHandler: (body: string) => Promise<void> = async () => { /* not yet wired */ };
  let recordActionDenial: (denial: {
    actionName: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
  }) => void = () => { /* wired later */ };

  // Hook endpoints are loopback-only and authenticated by a per-launch secret —
  // see hook-server.ts. Any new endpoint added there must validate the secret header.
  const hookServer = new HookServer({
    port: HOOK_PORT,
    daemonAuthSecret: secret,
    onStatusLineHook: async (body) => {
      // Schema: https://code.claude.com/docs/en/statusline#available-data.
      let payload: {
        session_id?: string;
        model?: { id?: string; display_name?: string };
        context_window?: {
          context_window_size?: number;
          used_percentage?: number | null;
          remaining_percentage?: number | null;
          total_input_tokens?: number;
          total_output_tokens?: number;
          current_usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          } | null;
        };
        cost?: {
          total_cost_usd?: number;
          total_duration_ms?: number;
          total_api_duration_ms?: number;
          total_lines_added?: number;
          total_lines_removed?: number;
        };
        rate_limits?: {
          five_hour?: { used_percentage?: number; resets_at?: number };
          seven_day?: { used_percentage?: number; resets_at?: number };
        };
        effort?: { level?: string };
        exceeds_200k_tokens?: boolean;
      };
      try { payload = JSON.parse(body); } catch {
        console.error('[hook] statusline: invalid JSON body');
        return;
      }
      const sessionId = payload.session_id;
      if (!sessionId) return;
      const msg = {
        type: 'daemon_statusline',
        sessionId,
        model: payload.model,
        contextWindow: payload.context_window,
        cost: payload.cost,
        rateLimits: payload.rate_limits,
        effort: payload.effort,
        exceeds200k: payload.exceeds_200k_tokens,
      };
      latestStatuslineBySession.set(sessionId, msg);
      manager.broadcast(sessionId, msg);
      runsCapture.onStatusline(sessionId, msg);
    },
    onStopHook: async (body) => {
      let payload: { session_id?: string };
      try { payload = JSON.parse(body); } catch {
        console.error('[hook] stop: invalid JSON body');
        return;
      }
      const sessionId = payload.session_id;
      if (!sessionId) return;
      manager.markTurnEnded(sessionId);
      rebroadcastJobLiveness(sessionId);
      const { shouldNotify, turnDurationMs } = stopTracker.consume(sessionId);
      console.log(`[hook] stop session=${sessionId.slice(0,8)} durationMs=${turnDurationMs ?? 'n/a'} push=${shouldNotify}`);
      // A resume queued behind an in-flight turn (e.g. a fast spec approval dispatching
      // /code.plan before the spec turn's Stop landed) leaves a trailing Stop that belongs
      // to the superseded round. Attributing it to the current round would spuriously fail
      // a step that's actively running — drop it here and wait for the real turn-end Stop.
      if (engine.consumeStaleTurnStop(sessionId)) {
        console.log(`[work] stop session=${sessionId.slice(0,8)} → stale (superseded round), ignored`);
      } else {
        // If this session is bound to an unresolved action step, the assistant
        // ended its turn without calling submit_step_output. Fail the step so
        // the orchestrator doesn't hang.
        if (engine.failStepIfUnresolved(
          sessionId,
          'Session ended without submitting output via mcp__outpost__submit_step_output',
        )) {
          console.log(`[work] stop session=${sessionId.slice(0,8)} → step failed (no MCP submission)`);
        }
        // Plan→implement hand-off: if code.plan just ended its turn, dispatch the implement
        // round now that the shared session is idle (see WorkEngine.onSessionTurnEnded).
        engine.onSessionTurnEnded(sessionId);
      }
      if (!shouldNotify) return;
      const title = findSessionTitle(sessionId);
      void pushSender.send({
        title: title ? `Claude finished: ${title}` : 'Claude finished',
        body: turnDurationMs
          ? `Turn took ${(turnDurationMs / 1000).toFixed(0)}s. Tap to continue.`
          : 'Tap to continue.',
        tag: `stop-${sessionId}`,
        data: { kind: 'stop', sessionId },
      });
    },
    onPreToolHook: async (body) => {
      const hookInput = JSON.parse(body);
      console.log(`[hook] ${hookInput.tool_name} session=${hookInput.session_id?.slice(0,8)}${hookInput.agent_id ? ` agent=${hookInput.agent_type ?? '?'}/${hookInput.agent_id.slice(0,8)}` : ''} input=${JSON.stringify(hookInput.tool_input).slice(0, 200)}`);
      // Light "what is meta.build-action doing right now" ping for the inline edit
      // card. Carries just the tool name — the PWA derives a verb (reading/editing/
      // writing/bashing) and animates a glowy ellipsis. Skip subagent calls; we only
      // care about the parent session for this indicator.
      if (!hookInput.agent_id && manager.getKind(hookInput.session_id) === 'action-edit') {
        notifyAll({
          type: 'action_edit_activity',
          sessionId: hookInput.session_id,
          toolName: hookInput.tool_name,
          at: Date.now(),
        });
      }
      // Auto-allowed calls bypass the approval queue, so emit dedicated mirror events:
      // subagent buckets need agent_activity (their feed would otherwise be empty for
      // read-only agents), and parent transcripts need tool_auto_allowed for expand-by-default.
      if (allowlist.allows(hookInput.tool_name, hookInput.tool_input)) {
        if (hookInput.agent_id) {
          notifyAll({
            type: 'agent_activity',
            sessionId: hookInput.session_id,
            toolName: hookInput.tool_name,
            toolInput: hookInput.tool_input,
            agentId: hookInput.agent_id,
            agentType: hookInput.agent_type,
            toolUseId: hookInput.tool_use_id,
          });
        } else {
          notifyAll({
            type: 'tool_auto_allowed',
            sessionId: hookInput.session_id,
            toolName: hookInput.tool_name,
            // PreToolUse hook doesn't include tool_use_id; JSON-equality of toolInput
            // is the only stable correlation against the streamed tool_use block.
            toolInput: hookInput.tool_input,
          });
        }
      }
      const result = await handleHook({
        hookInput,
        allowlist,
        queue,
        modes,
        cwdForSession,
        worktreePathForSession: (id) => {
          // Step sessions: sessionId ≠ stepId; ask the orchestrator to resolve session → step → worktree.
          const viaOrch = engine.worktreePathForSession(id);
          if (viaOrch) return viaOrch;
          // Interactive/adopted sessions where the record is keyed directly by session id.
          const rec = worktreeManager.get(id);
          return rec && !rec.archivedAt ? rec.worktreePath : undefined;
        },
        actionForSession: (id) => engine.actionForSession(id),
        onNotify: (approval) => {
          console.log(`[hook] enqueued approval ${approval.id.slice(0,8)} for ${approval.toolName}`);
          const summary = summarizeToolInput(approval.toolName, approval.toolInput);
          const sessionTitle = findSessionTitle(approval.sessionId);
          const cwd = cwdForSession(approval.sessionId);
          const suggestion = cwd ? recurrence.suggestionFor(cwd, approval.toolName, approval.toolInput) : null;
          notifyAll({
            type: 'approval_pending',
            approvalId: approval.id,
            sessionId: approval.sessionId,
            toolName: approval.toolName,
            // AskUserQuestion popup needs the full questions/options structure.
            toolInput: approval.toolInput,
            toolUseId: approval.toolUseId,
            // Subagent provenance routes the approval into the agents feed.
            agentId: approval.agentId,
            agentType: approval.agentType,
            summary,
            sessionTitle,
            suggestion,
          });
          // Web Push so devices ring when backgrounded; tag collapses repeats per approval.
          void pushSender.send({
            title: sessionTitle ? `Approval: ${approval.toolName} (${sessionTitle})` : `Approval: ${approval.toolName}`,
            body: summary,
            tag: `approval-${approval.id}`,
            data: { kind: 'approval', sessionId: approval.sessionId, approvalId: approval.id },
          });
        },
        onActionDenial: recordActionDenial,
      });
      console.log(`[hook] decision: ${result.hookSpecificOutput.permissionDecision} for ${hookInput.tool_name}`);
      return JSON.stringify(result);
    },
    onWorkPlanReady: async (body) => {
      const payload = JSON.parse(body) as { jobId: string; mode?: 'initial' | 'replan'; steps: unknown[]; drops?: string[]; feedback?: string; findings?: unknown };
      engine.onPlanReady(payload.jobId, payload.mode ?? 'initial', payload.steps as never, payload.drops, payload.feedback, payload.findings as never);
    },
    onWorkRepliesReady: async (body) => {
      try {
        const payload = JSON.parse(body) as { jobId: string; stepId: string; drafts: unknown[]; threadHash?: string };
        engine.applyOpenPrPatch(payload.jobId, payload.stepId, {
          state: 'reply_pending_review',
          draftedReplies: payload.drafts as never,
          ...(payload.threadHash ? { threadHash: payload.threadHash } : {}),
        });
        engine.markIterationPosted(payload.jobId, payload.stepId, 'replies');
      } catch (e) { console.error('[hook] /work/replies-ready:', (e as Error).message); }
    },
    onWorkEditDone: async (body) => {
      try {
        const payload = JSON.parse(body) as { jobId: string; stepId: string; editId: string; status: 'done' | 'failed'; failure?: string };
        engine.markEditDone(payload.jobId, payload.stepId, payload.editId, { status: payload.status, failure: payload.failure });
      } catch (e) { console.error('[hook] /work/edits/done:', (e as Error).message); }
    },
    onWorkStepResolved: async (body) => {
      try {
        const payload = JSON.parse(body) as { jobId: string; stepId: string; output?: string };
        engine.onStepResolved(payload.jobId, payload.stepId, { output: payload.output });
      } catch (e) { console.error('[hook] /work/step-resolved:', (e as Error).message); }
    },
    onWorkStepFailed: async (body) => {
      try {
        const payload = JSON.parse(body) as { jobId: string; stepId: string; reason: string };
        engine.onStepFailed(payload.jobId, payload.stepId, payload.reason);
      } catch (e) { console.error('[hook] /work/step-failed:', (e as Error).message); }
    },
    onActionProposal: (body) => onActionProposalHandler(body),
    onWorkJournal: async (body) => {
      try {
        const payload = JSON.parse(body) as { action?: string; jobId?: string; stepId?: string; outcome?: string; lesson?: string };
        if (!payload.action || !payload.jobId || !payload.outcome || !payload.lesson) return;
        journalStore.append({
          action: payload.action,
          jobId: payload.jobId,
          stepId: payload.stepId,
          outcome: payload.outcome,
          lesson: payload.lesson,
        });
      } catch (e) { console.error('[hook] /work/journal:', (e as Error).message); }
    },
    onMcp: (body) => handleMcpRequest(body, OUTPOST_MCP_TOOLS, {
      submit_plan: async (a) => {
        engine.onPlanReady(
          a.jobId as string,
          (a.mode as 'initial' | 'replan') ?? 'initial',
          a.steps as never,
          a.drops as string[] | undefined,
          a.feedback as string | undefined,
          a.findings as never,
        );
        return { ok: true };
      },
      submit_journal: async (a) => {
        journalStore.append({
          action: a.action as string,
          jobId: a.jobId as string,
          stepId: a.stepId as string | undefined,
          outcome: a.outcome as string,
          lesson: a.lesson as string,
        });
        return { ok: true };
      },
      submit_step_output: async (a) => {
        engine.onStepResolved(a.jobId as string, a.stepId as string, { output: a.output as string | undefined });
        return { ok: true };
      },
      submit_continue: async (a) => {
        engine.onOrchestratorContinue(a.jobId as string, a.reason as string | undefined);
        return { ok: true };
      },
      submit_step_failed: async (a) => {
        engine.onStepFailed(a.jobId as string, a.stepId as string, a.reason as string);
        return { ok: true };
      },
      submit_spec: async (a) => {
        engine.onSpecReady(a.jobId as string, a.stepId as string, a.spec as string);
        return { ok: true };
      },
      submit_impl_plan: async (a) => {
        engine.onImplPlanReady(a.jobId as string, a.stepId as string, a.plan as string);
        return { ok: true };
      },
      submit_replies: async (a) => {
        engine.mergeDraftedReplies(
          a.jobId as string,
          a.stepId as string,
          a.drafts as never,
          a.threadHash as string | undefined,
        );
        engine.markIterationPosted(a.jobId as string, a.stepId as string, 'replies');
        return { ok: true };
      },
      submit_edit_done: async (a) => {
        engine.markEditDone(a.jobId as string, a.stepId as string, a.editId as string, {
          status: a.status as 'done' | 'failed',
          failure: a.failure as string | undefined,
        });
        return { ok: true };
      },
      submit_conflict_resolved: async (a) => {
        engine.markConflictResolved(a.jobId as string, a.stepId as string, {
          status: a.status as 'resolved' | 'unresolvable',
          failure: a.failure as string | undefined,
        });
        return { ok: true };
      },
      submit_ci_fixed: async (a) => {
        engine.markCiFixed(a.jobId as string, a.stepId as string, {
          status: a.status as 'fixed' | 'unfixable',
          failure: a.failure as string | undefined,
        });
        return { ok: true };
      },
      submit_action_proposal: async (a) => {
        await onActionProposalHandler(JSON.stringify(a));
        return { ok: true };
      },
    }),
  });

  // Static for daemon lifetime; new plugin/skill installs require a restart to surface.
  const slashCommands = discoverSlashCommands();
  console.log(`[daemon] discovered ${slashCommands.length} slash commands`);

  registerSessionsRoutes(server, {
    sessionStore, manager, worktreeManager, queue, recurrence, allowlist,
    latestStatuslineBySession, cwdForSession, summarizeToolInput, captureSessionEnd,
    info: {
      version: pkg.version,
      approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
      home: homedir(),
      slashCommands,
      vapidPublicKey: vapid.publicKey,
    },
  });
  registerGitRoutes(server, { sessionStore, worktreeManager, engine, prWatcher });
  registerProjectsRoutes(server, { sessionStore, projectRegistry });
  registerJobsRoutes(server, { jobQueue, engine, prWatcher, linearPoller, sessionStore, worktreeManager });
  registerPushRoutes(server, { pushStore, pushSender, userPrsWatcher });
  registerMetaRoutes(server, {
    actionRegistry, permissionGroups, allowlist, allowlistPath: ALLOWLIST_PATH, projectAllowlistDir,
    actionsStore, actionsStorePath: join(RUNTIME_DIR, 'actions.json'), projectRegistry, worktreeManager,
    journalStore, mcpConfigPath,
  });
  registerRunsRoutes(server, { runsStore, usageLedger, getAccountUsage: () => latestAccountUsage });
  registerSchedulesRoutes(server, { store: schedulesStore, scheduler, system: systemSchedules, notify: notifyAll, tokenStatus: (id) => tokenScheduler.describe(id) });
  registerPreferencesRoutes(server, { preferencesStore });


  function readSkillDescription(dir: string): string {
    try {
      const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      const m = md.match(/^description:\s*(.+)$/m);
      return m && m[1] ? m[1].trim() : '';
    } catch { return ''; }
  }

  function listOutpostActions() {
    const out: Array<{ name: string; description: string; category: string; skillMd: string; dir: string; allowlist: object }> = [];
    for (const a of actionRegistry.listActions()) {
      const overlay = actionsStore.get(a.name).allowlist;
      const merged = {
        alwaysAllow:             dedupe([...a.allowlist.alwaysAllow,             ...(overlay.alwaysAllow ?? [])]),
        alwaysAllowBashPatterns: dedupe([...a.allowlist.alwaysAllowBashPatterns, ...(overlay.alwaysAllowBashPatterns ?? [])]),
        alwaysAllowMcpPatterns:  dedupe([...a.allowlist.alwaysAllowMcpPatterns,  ...(overlay.alwaysAllowMcpPatterns ?? [])]),
        alwaysAllowPathPatterns: dedupe([...a.allowlist.alwaysAllowPathPatterns, ...(overlay.alwaysAllowPathPatterns ?? [])]),
      };
      let body = '';
      try { body = readFileSync(join(a.dir, 'SKILL.md'), 'utf8'); } catch { /* missing */ }
      out.push({
        name: a.name,
        dir: a.dir,
        description: a.frontmatter.description,
        category: a.frontmatter.outpost.category,
        skillMd: body,
        allowlist: merged,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  function dedupe(xs: string[]): string[] { return Array.from(new Set(xs)); }

  function listExternalSkills() {
    const skillsDir = join(homedir(), '.claude', 'skills');
    // realpathSync follows the runtime → repo symlink (setup-actions's dev mode),
    // so we also exclude the repo's bundled actions dir to keep them out of skills.
    const repoActionsDir = join(SRC_DIR, '..', 'actions');
    let entries: string[] = [];
    try { entries = readdirSync(skillsDir); } catch { return []; }
    const out: Array<{ name: string; description: string; skillMd: string; dir: string }> = [];
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const link = join(skillsDir, name);
      let real: string;
      try { real = realpathSync(link); } catch { continue; }
      if (real.startsWith(outpostActionsDir)) continue;
      if (real.startsWith(repoActionsDir)) continue;
      if (real.includes('/.claude/plugins/cache/')) continue;
      try { if (!lstatSync(real).isDirectory()) continue; } catch { continue; }
      if (!existsSync(join(real, 'SKILL.md'))) continue;
      let body = '';
      try { body = readFileSync(join(real, 'SKILL.md'), 'utf8'); } catch { /* missing */ }
      out.push({ name, dir: real, description: readSkillDescription(real), skillMd: body });
    }
    return out;
  }

  // Action catalog from the registry + UI state (active edit sessions, denials,
  // external skills). The PWA's plan editor and actions tab both consume this.
  // The orchestrator action also receives the catalog portion in its envelope so it
  // can compose plans referencing any available action.
  server.route('GET', '/api/actions', async (_req, res) => {
    const actions = listOutpostActions();
    const catalog = actionRegistry.listActions().map((a) => ({
      name: a.name,
      description: a.frontmatter.description,
      category: a.frontmatter.outpost.category,
      runner: a.frontmatter.outpost.runner,
      permissions: a.frontmatter.outpost.permissions ?? [],
      side_effects: a.frontmatter.outpost.side_effects,
      human_gate: a.frontmatter.outpost.human_gate ?? false,
      timeout_sec: a.frontmatter.outpost.timeout_sec ?? null,
      input_schema: a.inputSchema,
      output_schema: a.outputSchema,
      allowlist: a.allowlist,
    }));
    const skills = listExternalSkills();
    const edits = Array.from(actionEdits.values()).map((e) => ({
      actionName: e.actionName,
      sessionId: e.sessionId,
      status: e.status,
      startedAt: e.startedAt,
      proposal: e.proposal,
    }));
    const denials: Record<string, ActionDenial[]> = {};
    for (const [name, list] of denialsByAction) denials[name] = list;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ actions, catalog, skills, edits, denials }));
  });

  // Dismiss a single denial entry (after the user adds the rule, or just ignores it).
  server.route('DELETE', '/api/actions/:name/denials/:denialId', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/actions\/([^/]+)\/denials\/([^/?]+)/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    const denialId = decodeURIComponent(m[2]!);
    const list = denialsByAction.get(name);
    if (list) {
      const next = list.filter((d) => d.id !== denialId);
      if (next.length === 0) denialsByAction.delete(name);
      else denialsByAction.set(name, next);
      try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
    }
    res.statusCode = 204;
    res.end();
  });

  // Clear all denials for an action at once.
  server.route('DELETE', '/api/actions/:name/denials', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/actions\/([^/]+)\/denials(?:\?|$)/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    if (denialsByAction.delete(name)) {
      try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
    }
    res.statusCode = 204;
    res.end();
  });

  // Body: { kind: 'tool'|'bash'|'mcp', value: string, scope?: 'global' | { project: string } | { action: string } | { session: string } | 'session' }.
  // Validates + dedupes + atomic-writes global allowlist.json or per-project file.
  // Action scope persists via ActionsStore (actions.json). Session scope is
  // in-memory only — dies with the session, never touches disk. The bare-string
  // 'session' form pairs with a top-level sessionId field.
  server.route('POST', '/api/allowlist/rules', async (req, res) => {
    const body = await readBody(req);
    let payload: { kind?: string; value?: string; sessionId?: string; scope?: 'global' | 'session' | { project?: string } | { action?: string } | { session?: string } };
    try { payload = JSON.parse(body); } catch {
      res.statusCode = 400; res.end('invalid json'); return;
    }
    const { kind, value, scope } = payload;
    if (kind !== 'tool' && kind !== 'bash' && kind !== 'mcp' && kind !== 'path') {
      res.statusCode = 400; res.end('kind must be tool|bash|mcp|path'); return;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
      res.statusCode = 400; res.end('value must be a 1..500 char string'); return;
    }
    let normalizedScope: 'global' | { project: string } | { action: string } | { session: string };
    if (scope === undefined || scope === 'global') {
      normalizedScope = 'global';
    } else if (scope === 'session' && typeof payload.sessionId === 'string' && payload.sessionId.length > 0) {
      normalizedScope = { session: payload.sessionId };
    } else if (typeof scope === 'object' && scope !== null && typeof (scope as { session?: string }).session === 'string' && (scope as { session: string }).session.length > 0) {
      normalizedScope = { session: (scope as { session: string }).session };
    } else if (typeof scope === 'object' && scope !== null && typeof (scope as { project?: string }).project === 'string' && (scope as { project: string }).project.startsWith('/')) {
      normalizedScope = { project: (scope as { project: string }).project };
    } else if (typeof scope === 'object' && scope !== null && typeof (scope as { action?: string }).action === 'string' && (scope as { action: string }).action.length > 0) {
      normalizedScope = { action: (scope as { action: string }).action };
    } else {
      res.statusCode = 400; res.end('scope must be "global" | {project: <absolute-cwd>} | {action: <name>} | {session: <id>} | "session" (+ sessionId)'); return;
    }
    let added: boolean;
    try {
      added = allowlist.addRule(kind, value, normalizedScope);
    } catch (e) {
      res.statusCode = 400; res.end(`invalid pattern: ${(e as Error).message}`); return;
    }
    if (added && normalizedScope === 'global') {
      const tmp = `${ALLOWLIST_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(allowlist.toConfig('global'), null, 2) + '\n');
      renameSync(tmp, ALLOWLIST_PATH);
      console.log(`[api] allowlist[global]: added ${kind} rule ${JSON.stringify(value)} (total ${allowlist.ruleCount()})`);
    } else if (added && typeof normalizedScope === 'object' && 'project' in normalizedScope) {
      // Project file persistence lives inside Allowlist.addRule.
      console.log(`[api] allowlist[project=${normalizedScope.project}]: added ${kind} rule ${JSON.stringify(value)}`);
    } else if (added && typeof normalizedScope === 'object' && 'action' in normalizedScope) {
      // Action persistence lives inside ActionsStore.addRule (chained via Allowlist).
      console.log(`[api] allowlist[action=${normalizedScope.action}]: added ${kind} rule ${JSON.stringify(value)}`);
    } else if (added && typeof normalizedScope === 'object' && 'session' in normalizedScope) {
      console.log(`[api] allowlist[session=${normalizedScope.session.slice(0, 8)}]: added ${kind} rule ${JSON.stringify(value)} (in-memory)`);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ added, ruleCount: allowlist.ruleCount() }));
  });

  function spawnEditSession(
    kind: 'action-edit' | 'skill-edit',
    cwd: string,
    initialInput: string,
    extraEnv: Record<string, string> = {},
  ): string {
    const sessionId = randomUUID();
    manager.spawnDetached(sessionId, cwd, extraEnv);
    manager.tagKind(sessionId, kind);
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: initialInput } });
    return sessionId;
  }

  function loopbackApiUrl(): string {
    const port = config.httpPort;
    return port !== null ? `http://127.0.0.1:${port}` : '';
  }

  async function readJsonBody<T>(req: NodeJS.ReadableStream): Promise<T | null> {
    const body = await readBody(req);
    if (!body) return null;
    try { return JSON.parse(body) as T; } catch { return null; }
  }

  // ── action-edit propose/verify/apply state ───────────────────────────
  // Keyed by action name (for edits) or by the placeholder `new:<sessionId>`
  // for "new action" flows where the name isn't chosen until the skill picks one.
  interface ActionProposal {
    summary: string;
    skillMdBefore: string;
    skillMdAfter: string;
    allowlistAdds: Array<{ kind: 'tool' | 'bash' | 'mcp' | 'path'; value: string }>;
    postedAt: number;
  }
  interface ActionEdit {
    actionName: string | null;  // null until the skill picks one (new-action flow)
    sessionId: string;
    status: 'editing' | 'review' | 'applying';
    startedAt: number;
    feedback: string;  // initial feedback that started this session
    proposal?: ActionProposal;
  }
  const actionEdits = new Map<string, ActionEdit>();
  function editKey(actionName: string | null, sessionId: string): string {
    return actionName ? `a:${actionName}` : `new:${sessionId}`;
  }
  function findEditBySession(sessionId: string): { key: string; edit: ActionEdit } | undefined {
    for (const [key, edit] of actionEdits) {
      if (edit.sessionId === sessionId) return { key, edit };
    }
    return undefined;
  }
  function setEdit(key: string, edit: ActionEdit): void {
    actionEdits.set(key, edit);
    try { notifyAll({ type: 'actions_changed' }); } catch { /* during startup */ }
  }
  function clearEdit(key: string): void {
    if (actionEdits.delete(key)) {
      try { notifyAll({ type: 'actions_changed' }); } catch { /* during startup */ }
    }
  }

  // ── Runtime denial tracking ───────────────────────────────────────────
  // Records every tool call that action sessions had blocked by allowlist-miss.
  // The PWA surfaces these as one-click "Add to allowlist" suggestions so the
  // user can see what the action tried that they overlooked.
  interface ActionDenial {
    id: string;
    actionName: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    suggested: { kind: 'tool' | 'bash' | 'mcp' | 'path'; value: string };
    at: number;
    count: number;  // bumped when an identical denial recurs
  }
  const DENIALS_PER_ACTION = 50;
  const denialsByAction = new Map<string, ActionDenial[]>();

  function suggestRule(toolName: string, toolInput: unknown): ActionDenial['suggested'] {
    if (toolName === 'Bash') {
      const cmd = (toolInput as { command?: string })?.command ?? '';
      // Anchor on the first whitespace-delimited token (the binary). Narrow enough
      // to avoid blanket Bash grants while obvious enough to one-click approve.
      const head = cmd.split(/\s+/)[0] ?? '';
      const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { kind: 'bash', value: escaped ? `^${escaped} ` : '^' };
    }
    if (toolName.startsWith('mcp__')) {
      return { kind: 'mcp', value: `^${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` };
    }
    // Try a path rule for file-touching tools — confines the grant to the actual
    // directory the action touched.
    const PATH_FIELDS: Record<string, string[]> = {
      Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'],
      MultiEdit: ['file_path'], NotebookEdit: ['notebook_path', 'file_path'],
      Glob: ['path'], Grep: ['path'],
    };
    const fields = PATH_FIELDS[toolName];
    if (fields) {
      const input = toolInput as Record<string, unknown> | null;
      for (const f of fields) {
        const v = input && typeof input === 'object' ? input[f] : undefined;
        if (typeof v === 'string' && v.length > 0) {
          const dir = v.replace(/\/[^/]*$/, '') || '/';
          const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return { kind: 'path', value: `${toolName}:^${escaped}/` };
        }
      }
    }
    return { kind: 'tool', value: toolName };
  }

  recordActionDenial = ({ actionName, sessionId, toolName, toolInput }) => {
    const list = denialsByAction.get(actionName) ?? [];
    const suggested = suggestRule(toolName, toolInput);
    // Collapse repeats: same suggested rule for the same tool = bump count.
    const existing = list.find((d) => d.toolName === toolName && d.suggested.kind === suggested.kind && d.suggested.value === suggested.value);
    if (existing) {
      existing.count += 1;
      existing.at = Date.now();
    } else {
      list.unshift({
        id: randomUUID(),
        actionName, sessionId, toolName, toolInput,
        suggested,
        at: Date.now(),
        count: 1,
      });
      if (list.length > DENIALS_PER_ACTION) list.length = DENIALS_PER_ACTION;
    }
    denialsByAction.set(actionName, list);
    console.log(`[deny] ${actionName} ${toolName} → suggest ${suggested.kind}:${suggested.value} (count ${existing?.count ?? 1})`);
    try { notifyAll({ type: 'actions_changed' }); } catch { /* during startup */ }
  };

  function readSkillMd(dir: string): string {
    try { return readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { return ''; }
  }

  function writeActionEnvelope(sessionId: string, body: object): string {
    const dir = join(RUNTIME_DIR, 'action-edits', sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'envelope.json');
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
  }

  // Wire the hook-server forward reference declared earlier.
  onActionProposalHandler = async (body) => {
    let payload: {
      sessionId?: string;
      actionName?: string | null;
      summary?: string;
      skillMdAfter?: string;
      allowlistAdds?: Array<{ kind: 'tool' | 'bash' | 'mcp' | 'path'; value: string }>;
    };
    try { payload = JSON.parse(body); }
    catch (e) { console.error('[hook] /work/action-proposal: invalid json'); return; }
    if (!payload.sessionId || typeof payload.skillMdAfter !== 'string') {
      console.warn('[hook] /work/action-proposal: missing sessionId or skillMdAfter');
      return;
    }
    const located = findEditBySession(payload.sessionId);
    if (!located) {
      console.warn(`[hook] /work/action-proposal: no edit-session for ${payload.sessionId.slice(0,8)}`);
      return;
    }
    let { key, edit } = located;
    // For "new action" flows the skill picks the name with this proposal —
    // promote the edit's key from `new:<sessionId>` → `a:<name>`.
    if (!edit.actionName && payload.actionName) {
      actionEdits.delete(key);
      edit = { ...edit, actionName: payload.actionName };
      key = editKey(payload.actionName, edit.sessionId);
    }
    const dir = edit.actionName ? join(outpostActionsDir, edit.actionName) : outpostActionsDir;
    const skillMdBefore = edit.actionName ? readSkillMd(dir) : '';
    edit.status = 'review';
    edit.proposal = {
      summary: payload.summary ?? '',
      skillMdBefore,
      skillMdAfter: payload.skillMdAfter,
      allowlistAdds: Array.isArray(payload.allowlistAdds) ? payload.allowlistAdds.filter((r) => r && (r.kind === 'tool' || r.kind === 'bash' || r.kind === 'mcp' || r.kind === 'path') && typeof r.value === 'string') : [],
      postedAt: Date.now(),
    };
    setEdit(key, edit);
    console.log(`[work] action-proposal posted for ${edit.actionName ?? '<new>'} (${payload.skillMdAfter.length}b skill_md, ${edit.proposal.allowlistAdds.length} rules)`);
  };

  function actionEditEnv(sessionId: string, envelopePath: string, actionName: string | null): Record<string, string> {
    const env: Record<string, string> = {
      OUTPOST_API_URL: loopbackApiUrl(),
      OUTPOST_ENVELOPE: envelopePath,
      OUTPOST_HOOK_PORT: String(config.hookPort),
      DAEMON_AUTH: secret,
      ACTION_EDIT_SESSION_ID: sessionId,
    };
    if (actionName) env.OUTPOST_ACTION_NAME = actionName;
    return env;
  }

  server.route('POST', '/api/actions/new', async (req, res) => {
    mkdirSync(outpostActionsDir, { recursive: true });
    const payload = await readJsonBody<{ feedback?: string; name?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    // Optional user-supplied name. We don't validate strictly here — the action-builder
    // skill is the source of truth for naming and will normalize. We just forward it as a hint.
    const rawName = (payload?.name ?? '').trim();
    const proposedName = /^[a-z0-9][a-z0-9-]{0,63}$/i.test(rawName) ? rawName.toLowerCase() : '';
    const sessionId = randomUUID();
    const envelope = {
      kind: 'action-edit',
      mode: 'new' as const,
      actionName: null,
      // Hint to the action-builder skill. The skill SHOULD honor it unless the name
      // is invalid (it then picks a corrected name and explains the override).
      proposedName: proposedName || undefined,
      actionsDir: outpostActionsDir,
      userFeedback: feedback,
      proposalRoute: '/work/action-proposal',
    };
    const envelopePath = writeActionEnvelope(sessionId, envelope);
    manager.spawnDetached(sessionId, outpostActionsDir, actionEditEnv(sessionId, envelopePath, null), 'default');
    manager.tagKind(sessionId, 'action-edit');
    engine.bindAction(sessionId, 'meta.build-action');
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: '/meta.build-action' } });
    const edit: ActionEdit = {
      // Pre-populate actionName so the pending-new card shows the user's chosen
      // name immediately instead of "(naming…)". The skill can still override if it
      // chooses a different one in its proposal.
      actionName: proposedName || null,
      sessionId,
      status: 'editing',
      startedAt: Date.now(),
      feedback,
    };
    setEdit(editKey(edit.actionName, sessionId), edit);
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId, actionName: proposedName || null }));
  });

  server.route('POST', '/api/actions/:name/edit', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!name) { res.statusCode = 400; res.end('missing name'); return; }
    const dir = join(outpostActionsDir, name);
    try { if (!lstatSync(dir).isDirectory()) throw new Error('not a dir'); }
    catch { res.statusCode = 404; res.end('no such action'); return; }
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    const key = editKey(name, '');

    // If an edit is already running for this action, treat this as proposal-feedback —
    // forward the message to the same session, clear any prior proposal, and reuse it.
    const existing = actionEdits.get(key);
    if (existing) {
      existing.feedback = feedback;
      existing.status = 'editing';
      existing.proposal = undefined;
      setEdit(key, existing);
      const followup = feedback
        ? `Replacement feedback from the user:\n\n${feedback}\n\nRe-read $OUTPOST_ENVELOPE (skill_md_before may be stale if you already applied a draft) and post a new proposal.`
        : 'Replan with no new feedback — refresh the proposal.';
      manager.sendOrResume(existing.sessionId, dir, { type: 'user', message: { role: 'user', content: followup } }, actionEditEnv(existing.sessionId, join(RUNTIME_DIR, 'action-edits', existing.sessionId, 'envelope.json'), name));
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessionId: existing.sessionId, reused: true }));
      return;
    }

    const sessionId = randomUUID();
    const skillMdBefore = readSkillMd(dir);
    const envelope = {
      kind: 'action-edit',
      mode: 'edit' as const,
      actionName: name,
      actionDir: dir,
      skillMdBefore,
      currentAllowlist: actionsStore.get(name).allowlist,
      userFeedback: feedback,
      proposalRoute: '/work/action-proposal',
    };
    const envelopePath = writeActionEnvelope(sessionId, envelope);
    manager.spawnDetached(sessionId, dir, actionEditEnv(sessionId, envelopePath, name), 'default');
    manager.tagKind(sessionId, 'action-edit');
    engine.bindAction(sessionId, 'meta.build-action');
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: '/meta.build-action' } });
    setEdit(key, {
      actionName: name,
      sessionId,
      status: 'editing',
      startedAt: Date.now(),
      feedback,
    });
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId }));
  });

  // Approve the pending proposal: write SKILL.md, add allowlist rules, close session.
  // Keyed by sessionId so the "new action" flow (no name at first) works the same.
  server.route('POST', '/api/action-edits/:sessionId/approve', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!sessionId) { res.statusCode = 400; res.end('missing sessionId'); return; }
    const located = findEditBySession(sessionId);
    if (!located || !located.edit.proposal) { res.statusCode = 404; res.end('no pending proposal'); return; }
    const { key, edit } = located;
    const proposal = edit.proposal;
    const name = edit.actionName;
    if (!proposal) { res.statusCode = 404; res.end('no pending proposal'); return; }
    if (!name) { res.statusCode = 400; res.end('proposal has no action name'); return; }
    const dir = join(outpostActionsDir, name);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), proposal.skillMdAfter);
      for (const rule of proposal.allowlistAdds ?? []) {
        try { actionsStore.addRule(name, rule.kind, rule.value); }
        catch (e) { console.warn(`[action-edit] skipping invalid rule ${rule.kind}=${rule.value}: ${(e as Error).message}`); }
      }
    } catch (e) {
      res.statusCode = 500; res.end(`apply failed: ${(e as Error).message}`); return;
    }
    edit.status = 'applying';
    setEdit(key, edit);
    void manager.close(edit.sessionId).catch(() => { /* tolerate */ });
    clearEdit(key);
    try { ensureActionsInstalled(bundledRepoDir(SRC_DIR), RUNTIME_DIR); } catch { /* tolerate */ }
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, actionName: name }));
  });

  // User submits new feedback on the active edit (with or without a posted proposal):
  // clear any proposal, send the feedback to the same session so it drafts again.
  server.route('POST', '/api/action-edits/:sessionId/proposal-feedback', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!sessionId) { res.statusCode = 400; res.end('missing sessionId'); return; }
    const located = findEditBySession(sessionId);
    if (!located) { res.statusCode = 404; res.end('no active edit'); return; }
    const { key, edit } = located;
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    if (!feedback) { res.statusCode = 400; res.end('feedback required'); return; }
    edit.feedback = feedback;
    edit.status = 'editing';
    edit.proposal = undefined;
    setEdit(key, edit);
    const cwd = edit.actionName ? join(outpostActionsDir, edit.actionName) : outpostActionsDir;
    const followup = `Replacement feedback from the user:\n\n${feedback}\n\nDraft a new proposal that addresses this, then POST it again.`;
    manager.sendOrResume(
      edit.sessionId, cwd,
      { type: 'user', message: { role: 'user', content: followup } },
      actionEditEnv(edit.sessionId, join(RUNTIME_DIR, 'action-edits', edit.sessionId, 'envelope.json'), edit.actionName),
    );
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  // Cancel: kill the session, drop the pending proposal.
  server.route('POST', '/api/action-edits/:sessionId/cancel', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!sessionId) { res.statusCode = 400; res.end('missing sessionId'); return; }
    const located = findEditBySession(sessionId);
    if (located) {
      void manager.close(located.edit.sessionId).catch(() => { /* tolerate */ });
      clearEdit(located.key);
    }
    res.statusCode = 204; res.end();
  });

  server.route('POST', '/api/skills/new', async (req, res) => {
    const skillsDir = join(homedir(), '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    const sections: string[] = [];
    if (feedback) sections.push(`User intent for this new skill:\n${feedback}`);
    sections.push('/skill-creator');
    const id = spawnEditSession('skill-edit', skillsDir, sections.join('\n\n'));
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId: id }));
  });

  server.route('POST', '/api/skills/:name/edit', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!name) { res.statusCode = 400; res.end('missing name'); return; }
    const skillDir = join(homedir(), '.claude', 'skills', name);
    let real: string;
    try { real = realpathSync(skillDir); }
    catch { res.statusCode = 404; res.end('no such skill'); return; }
    if (real.startsWith(outpostActionsDir)) {
      res.statusCode = 400; res.end('use /api/actions/:name/edit for actions'); return;
    }
    if (real.includes('/.claude/plugins/cache/')) {
      res.statusCode = 400; res.end('plugin-cache skills are read-only'); return;
    }
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    const sections: string[] = [`You are editing the existing skill "${name}" in cwd.`];
    if (feedback) sections.push(`User feedback for this revision:\n${feedback}`);
    sections.push('/skill-creator');
    const id = spawnEditSession('skill-edit', real, sections.join('\n\n'));
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId: id }));
  });

  server.route('DELETE', '/api/actions/:name', async (req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('?')[0]!.split('/').pop()!);
    if (!name || name.includes('/') || name.includes('..')) {
      res.statusCode = 400; res.end('invalid name'); return;
    }
    const dir = join(outpostActionsDir, name);
    const link = join(homedir(), '.claude', 'skills', name);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tolerate */ }
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) unlinkSync(link);
    } catch { /* tolerate missing */ }
    actionsStore.deleteAction(name);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });




  // Held open by every client for the app lifetime; carries all approval events so
  // cross-session toasts fire even when no session WS is attached.
  const notificationClients = new Set<import('ws').WebSocket>();
  function notifyAll(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of notificationClients) ws.send(payload);
  }

  // A session's turn ending or its proc exiting usually changes no job state
  // (e.g. an implement session finishing leaves the step in `implementing`), so
  // the queue emits no broadcast and the PWA keeps showing the job as Running.
  // Re-broadcast the owning job with fresh liveness on those edges.
  const rebroadcastJobLiveness = (sessionId: string) => {
    const jobId = engine.jobIdForSession(sessionId);
    if (!jobId) return;
    const owner = jobQueue.get(jobId);
    if (!owner) return;
    try { notifyAll({ type: 'work_job_changed', jobId, job: withLiveness(owner, (id) => engine.isSessionWorking(id)) }); }
    catch { /* notifyAll not in scope yet during startup */ }
  };

  // Coalesce bursts of session-spawn notifications into a single broadcast so a
  // work orchestrator kicking off multiple child sessions produces one refresh.
  let sessionsChangedTimer: NodeJS.Timeout | null = null;
  function scheduleSessionsChangedBroadcast(): void {
    if (sessionsChangedTimer) return;
    sessionsChangedTimer = setTimeout(() => {
      sessionsChangedTimer = null;
      notifyAll({ type: 'sessions_changed' });
    }, 200);
  }

  // Account-wide 5h/7d usage isn't in statusLine; UsagePoller hits claude.ai's OAuth
  // endpoint on a usage-adaptive cadence. Cache last snapshot for reconnect-replay.
  let latestAccountUsage: AccountUsageSnapshot | null = null;
  const usagePoller = new UsagePoller({
    onSnapshot: (snap) => {
      latestAccountUsage = snap;
      // breakdown is additive — the PWA tolerates its absence, so this stays cheap even
      // if the ledger has no entries yet.
      notifyAll({ type: 'daemon_account_usage', rateLimits: snap, breakdown: usageLedger.breakdown(5 * 60 * 60 * 1000, snap) });
      // Re-evaluate token-opportunistic schedules against the fresh headroom. Fire-and-forget;
      // the controller latches to serialize and never launches more than one job at a time.
      void tokenScheduler.onUsageSnapshot();
    },
  });
  systemSchedules.register(usagePoller);
  usagePoller.start();

  // Broadcast resolutions so cards render "Timed out" and multi-device sees the decision.
  queue.onResolve = (approval, decision) => {
    // Record before broadcasting so the next approval's onNotify sees the new count.
    recurrence.record({
      cwd: cwdForSession(approval.sessionId) ?? approval.sessionId,
      toolName: approval.toolName,
      toolInput: approval.toolInput,
      decision: decision.allow ? 'allow' : 'deny',
    });
    notifyAll({
      type: 'approval_resolved',
      approvalId: approval.id,
      sessionId: approval.sessionId,
      toolName: approval.toolName,
      agentId: approval.agentId,
      agentType: approval.agentType,
      decision: decision.allow ? 'allow' : 'deny',
      reason: decision.reason,
      timedOut: !decision.allow && (decision.reason ?? '').startsWith('Approval timed out'),
    });
  };

  server.onWebSocket((ws, req) => {
    const url = req.url ?? '';

    if (url === '/ws/notifications') {
      notificationClients.add(ws);
      // Snapshot pending queue so reconnects populate state without firing stale toasts.
      const titleById = new Map<string, string>();
      for (const p of sessionStore.listProjects()) for (const s of p.sessions) titleById.set(s.id, s.title);
      if (latestAccountUsage) {
        ws.send(JSON.stringify({
          type: 'daemon_account_usage',
          rateLimits: latestAccountUsage,
          breakdown: usageLedger.breakdown(5 * 60 * 60 * 1000, latestAccountUsage),
        }));
      }
      ws.send(JSON.stringify({
        type: 'notifications_snapshot',
        approvals: queue.listPending().map((a) => {
          const cwd = cwdForSession(a.sessionId);
          const suggestion = cwd ? recurrence.suggestionFor(cwd, a.toolName, a.toolInput) : null;
          return {
            approvalId: a.id,
            sessionId: a.sessionId,
            toolName: a.toolName,
            toolInput: a.toolInput,
            toolUseId: a.toolUseId,
            agentId: a.agentId,
            agentType: a.agentType,
            enqueuedAt: a.enqueuedAt,
            summary: summarizeToolInput(a.toolName, a.toolInput),
            sessionTitle: titleById.get(a.sessionId),
            suggestion,
          };
        }),
      }));
      // Accept approval_decide here too: notifications WS survives iOS backgrounding,
      // session WS often doesn't. Without this, decisions sent while session WS is
      // closed are dropped and the hook eventually times out.
      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let msg: { type?: string };
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'approval_decide') {
          const m2 = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
          queue.decide(m2.approvalId, { allow: m2.decision === 'allow', reason: m2.reason });
        }
      });
      ws.on('close', () => notificationClients.delete(ws));
      return;
    }

    const m = url.match(/^\/ws\/sessions\/([\w-]+)(?:\?.*)?$/);
    if (!m) {
      ws.close();
      return;
    }
    const sessionId = m[1]!;
    // Query: cwd (first attach only), spawn=worktree|shared, base=<branch>,
    // model=sonnet|opus|haiku|fable (first attach only; absent = claude default),
    // since=<seq> for replay-on-reconnect. SessionManager validates and may emit replay_gap.
    let cwd: string | undefined;
    let spawnMode: 'shared' | 'worktree' | undefined;
    let baseBranch: string | undefined;
    let model: 'sonnet' | 'opus' | 'haiku' | 'fable' | undefined;
    let since: number | undefined;
    const queryIdx = url.indexOf('?');
    if (queryIdx >= 0) {
      const params = new URLSearchParams(url.slice(queryIdx + 1));
      const rawCwd = params.get('cwd');
      if (rawCwd) cwd = rawCwd;
      const rawSpawn = params.get('spawn');
      if (rawSpawn === 'worktree' || rawSpawn === 'shared') spawnMode = rawSpawn;
      const rawBase = params.get('base');
      if (rawBase) baseBranch = rawBase;
      const rawModel = params.get('model');
      if (rawModel === 'sonnet' || rawModel === 'opus' || rawModel === 'haiku' || rawModel === 'fable') model = rawModel;
      const rawSince = params.get('since');
      if (rawSince !== null) {
        const n = Number(rawSince);
        // undefined → SessionManager defaults to 0 (send everything in the log).
        if (Number.isFinite(n) && n >= 0) since = Math.floor(n);
      }
    }
    manager.attach(sessionId, ws, { cwd, spawnMode, baseBranch, since, model });
    ws.send(JSON.stringify({ type: 'approval_mode', sessionId, mode: modes.get(sessionId) }));
    // Replay last statusline so the meter renders before claude's next fire; PWA handler is idempotent.
    const cachedSl = latestStatuslineBySession.get(sessionId);
    if (cachedSl) ws.send(JSON.stringify(cachedSl));
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'user_message') {
        const m2 = msg as { content: string };
        manager.send(sessionId, {
          type: 'user',
          message: { role: 'user', content: m2.content },
        });
      } else if (msg.type === 'approval_decide') {
        const m2 = msg as { approvalId: string; decision: 'allow' | 'deny'; reason?: string };
        queue.decide(m2.approvalId, { allow: m2.decision === 'allow', reason: m2.reason });
      } else if (msg.type === 'interrupt') {
        console.log(`[api] interrupt requested for session ${sessionId.slice(0, 8)}`);
        manager.interrupt(sessionId);
      } else if (msg.type === 'approval_mode_set') {
        const { mode } = msg as { mode?: string };
        if (typeof mode === 'string') {
          try {
            // ApprovalModeStore.set() throws on invalid mode.
            modes.set(sessionId, mode as ApprovalMode);
            manager.broadcast(sessionId, { type: 'approval_mode', sessionId, mode });
            console.log(`[api] approval mode for ${sessionId.slice(0, 8)} → ${mode}`);
          } catch {
            // Invalid mode — ignore.
          }
        }
      }
    });
  });

  servePwa(server, PWA_DIR);

  await server.listen();
  await hookServer.listen();
  if (config.httpPort !== null) {
    console.log(`[daemon] listening on http://127.0.0.1:${config.httpPort}`);
  }
  if (tsEnv) {
    console.log(`[daemon] listening on https://${config.host ?? tsEnv.hostname}:${config.httpsPort} (${config.bindAddress ?? tsEnv.ipv4})`);
  }
  console.log(`[daemon] hook server on http://127.0.0.1:${HOOK_PORT} (loopback only)`);

  userPrsWatcher.start();
  scheduler.start();

  // Broadcast every queue mutation to the notifications WS so the PWA work UI can
  // re-render the affected ticket without polling, and feed the runs ledger /
  // schedule-run completion. This must stay unconditional: schedule-spawned
  // code.* jobs go through engine.createJob directly and run regardless
  // of whether Linear integration is configured.
  jobQueue.subscribe((ev) => {
    if (ev.kind === 'upsert') {
      notifyAll({ type: 'work_job_changed', jobId: ev.jobId, job: withLiveness(ev.job, (id) => engine.isSessionWorking(id)) });
      const terminal = ev.job.state === 'done' || ev.job.state === 'failed' || ev.job.state === 'abandoned';
      // A schedule-spawned code.* job (createSpawnDeps.createJob) is a JobRecord like any
      // other — tag it with schedule context so it lands in the ledger as kind:'sched'
      // instead of a plain 'track' row.
      const scheduleRun = terminal ? schedulesStore.findRunByRef({ jobId: ev.job.id }) : undefined;
      const schedule = scheduleRun ? schedulesStore.get(scheduleRun.scheduleId) : undefined;
      runsCapture.onJobEvent(ev.job, schedule ? { id: schedule.id, name: schedule.name, skill: whatLabel(schedule.what) } : undefined);
      if (terminal) {
        void scheduler.completeRunByRef({ jobId: ev.job.id }, {
          outcome: ev.job.state === 'done' ? 'ok' : 'error',
          verdict: { summary: ev.job.state === 'done' ? 'Done' : (ev.job.failure?.reason ?? 'Failed') },
        });
      }
    } else {
      notifyAll({ type: 'work_job_changed', jobId: ev.jobId, job: null });
    }
  });

  // Rehydrate in-memory session→role/action bindings from the persisted queue before
  // anything can resume a session. Unconditional: reopen-orchestrator and step-resume run
  // through HTTP routes that are registered regardless of Linear integration.
  engine.rehydrateSessionBindings();

  if (process.env.LINEAR_API_TOKEN) {
    const newInstalled = ensureActionsInstalled(bundledRepoDir(SRC_DIR), RUNTIME_DIR);
    console.log(`[work] actions available: ${newInstalled.actions.length}`);
    linearPoller.start();
    prWatcher.start();
    engine.reconcileInterruptedEdits();
    engine.reconcileInterruptedSteps();
    void engine.tick();
    const n = jobQueue.list().length;
    console.log(`[work] orchestrator started (queue: ${n} ticket${n === 1 ? '' : 's'})`);
  } else {
    console.log('[work] LINEAR_API_TOKEN missing from ~/.outpost/.env — work orchestrator disabled');
  }
}

function summarizeToolInput(toolName: string, toolInput: unknown): string {
  try {
    if (toolName === 'Bash') return (toolInput as { command?: string }).command?.slice(0, 200) ?? toolName;
    return `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`;
  } catch {
    return toolName;
  }
}

type SlashCommand = { name: string; source: string; description?: string };

// Scan order builtin → user → plugin → skill; first occurrence of a /name wins,
// so a user override beats a plugin shipping the same name.
function discoverSlashCommands(): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  const push = (c: SlashCommand) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    out.push(c);
  };
  // claude --help doesn't enumerate slash commands; maintain manually.
  for (const b of ['clear', 'compact', 'context', 'usage', 'help', 'exit', 'mcp', 'config', 'login', 'logout', 'model']) {
    push({ name: `/${b}`, source: 'builtin' });
  }
  const claudeDir = join(homedir(), '.claude');
  // 1. User commands.
  scanCommandDir(join(claudeDir, 'commands'), 'user', push);
  // 2. Plugin commands: walk ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/*.md.
  scanPluginCommands(join(claudeDir, 'plugins', 'cache'), push);
  // 3. User skills at ~/.claude/skills/<name>/SKILL.md.
  scanSkillDir(join(claudeDir, 'skills'), 'skill', push);
  return out;
}

function scanCommandDir(dir: string, source: string, push: (c: SlashCommand) => void) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    const description = readFrontmatterDescription(join(dir, f));
    push({ name: `/${name}`, source, ...(description ? { description } : {}) });
  }
}

function scanPluginCommands(root: string, push: (c: SlashCommand) => void) {
  // BFS to depth 5; nesting varies by marketplace so we walk rather than glob a fixed shape.
  const stack: { dir: string; depth: number; owner: string | null }[] = [{ dir: root, depth: 0, owner: null }];
  while (stack.length) {
    const { dir, depth, owner } = stack.pop()!;
    if (depth > 5) continue;
    let entries: { name: string; isDirectory(): boolean }[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'commands') {
        scanCommandDir(join(dir, e.name), `plugin${owner ? `:${owner}` : ''}`, push);
        continue;
      }
      // First directory below cache/<marketplace> becomes the plugin label.
      const nextOwner = owner ?? (depth === 1 ? e.name : null);
      stack.push({ dir: join(dir, e.name), depth: depth + 1, owner: nextOwner });
    }
  }
}

function scanSkillDir(root: string, source: string, push: (c: SlashCommand) => void) {
  let entries: { name: string; isDirectory(): boolean }[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = join(root, e.name, 'SKILL.md');
    try { statSync(skillFile); } catch { continue; }
    const description = readFrontmatterDescription(skillFile);
    push({ name: `/${e.name}`, source, ...(description ? { description } : {}) });
  }
}

// Single-line `description:` from YAML frontmatter; multiline form not supported.
function readFrontmatterDescription(path: string): string | undefined {
  let content: string;
  try { content = readFileSync(path, 'utf-8'); } catch { return undefined; }
  // Cap at 4KB — skill bodies can be huge, frontmatter never is.
  const head = content.slice(0, 4096);
  const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm || !fm[1]) return undefined;
  const m = fm[1].match(/^description:\s*(.+?)\s*$/m);
  return m && m[1] ? m[1] : undefined;
}

// Only run the daemon when this module is the entry point, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
