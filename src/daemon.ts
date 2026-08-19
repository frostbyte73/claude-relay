import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, statSync, createReadStream, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { Allowlist, type AllowlistConfig } from './permissions/allowlist.js';
import { loadRuntimePermissionGroups } from './permissions/permission-groups-loader.js';
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
import { serializeJob } from './work/job-liveness.js';
import { JournalStore } from './storage/journal-store.js';
import { LinearWriter } from './integrations/linear-writer.js';
import { PrWatcher } from './integrations/pr-watcher.js';
import { UserPrsWatcher } from './integrations/user-prs-watcher.js';
import { WorkEngine } from './work/engine.js';
import { LaunchGovernor } from './work/launch-governor.js';
import type { JobRecord } from './work/work-types.js';
import { ensureActionsInstalled, bundledRepoDir } from './setup-actions.js';
import { ActionsStore } from './storage/actions-store.js';
import { ActionRegistry } from './actions/index.js';
import { actionDirFor } from './actions/registry.js';
import type { PermissionGroupMap } from './actions/types.js';
import { handleHook, handlePostToolFailureHook, type HookInput, type PostToolFailureHookInput } from './permissions/hook-handler.js';
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
import { parseJsonObject } from './routes/util.js';
import { parseDraftCalls, draftNotificationTag, type DraftRaisedBy } from './work/write-draft.js';
import { handleNotificationsMessage, handleSessionMessage } from './ws/client-messages.js';
import { registerGitRoutes } from './routes/git.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerProjectsRoutes } from './routes/projects.js';
import { registerPushRoutes } from './routes/push.js';
import { registerMetaRoutes, createGroupApplier } from './routes/meta.js';
import { registerActionsRoutes, type ActionsRoutesHandlers } from './routes/actions.js';
import { registerActionRevisionsRoutes } from './routes/action-revisions.js';
import { registerScheduleEditRoutes } from './routes/schedule-edits.js';
import { runScript } from './schedules/script-runner.js';
import { homeOrKnownCwd } from './git/known-cwd.js';
import { PreferencesStore } from './storage/preferences-store.js';
import { registerPreferencesRoutes } from './routes/preferences.js';
import { RunsStore } from './storage/runs-store.js';
import { ActionRunsStore } from './storage/action-runs-store.js';
import { DenialsStore } from './storage/denials-store.js';
import { ActionRevisionsStore } from './storage/action-revisions-store.js';
import { PermissionGroupRevisionsStore } from './storage/permission-group-revisions-store.js';
import { ActionRunLedger } from './work/action-run-ledger.js';
import { UsageLedger } from './integrations/usage-ledger.js';
import { createRunsCapture, type ScheduleRunContext } from './storage/runs-capture.js';
import { registerRunsRoutes } from './routes/runs.js';
import { SchedulesStore } from './schedules/schedules-store.js';
import { seedBuiltinSchedules } from './schedules/setup-schedules.js';
import { whatLabel, type Trigger, type What } from './schedules/types.js';
import { Scheduler, SkipRun } from './schedules/scheduler.js';
import { TokenScheduler } from './schedules/token-scheduler.js';
import { registerSchedulesRoutes } from './routes/schedules.js';
import { createGuardProviders, createInlineDeps, createRoutingDeps, createSpawnDeps } from './schedules/wiring.js';
import { NativeHandlerRegistry } from './schedules/native-handlers.js';
import { EnvelopeEnricherRegistry } from './schedules/schedule-envelope.js';
import { buildImprovementPack, parsePackOpts, selectActionToImprove } from './actions/improvement-pack.js';
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
// See permission-groups-loader.ts for the provenance-based merge on subsequent starts.
const PERMISSION_GROUPS_PATH = join(SRC_DIR, '..', 'config', 'permission-groups.json');
const PERMISSION_GROUPS_SEEDED_PATH = join(SRC_DIR, '..', 'config', 'permission-groups.seeded.json');

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

  // Every spawned session inherits process.env (claude-proc merges it under its own
  // per-session vars), so exporting the loopback base URL here is what makes
  // $OUTPOST_API_URL resolvable inside action steps — they POST back to the daemon
  // (e.g. write.add-project registering a fresh clone) and have no other way to
  // learn the port.
  if (config.httpPort !== null) {
    process.env.OUTPOST_API_URL = `http://127.0.0.1:${config.httpPort}`;
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
  const permissionGroups = loadRuntimePermissionGroups(PERMISSION_GROUPS_PATH, PERMISSION_GROUPS_SEEDED_PATH, permissionGroupsDefault as PermissionGroupMap);
  // Seed the bundled action defaults into ~/.outpost/actions before the registry
  // reads it — user-modified action dirs are left alone, so LiveKit-specific edits
  // survive upgrades and never touch the repo. The registry is rooted at this live
  // copy (NOT the repo) so user-authored/edited actions actually reach the catalog.
  try { ensureActionsInstalled(bundledRepoDir(SRC_DIR), RUNTIME_DIR); }
  catch (e) { console.warn(`[work] seeding actions failed: ${(e as Error).message}`); }
  const actionRegistry = new ActionRegistry(outpostActionsDir, {
    permissionGroups,
  });
  // Tolerant load: the registry reads the user-editable ~/.outpost/actions, so one
  // stale/invalid action (e.g. a deprecated category left behind by an upgrade) must
  // not brick startup. load() populates every VALID action before it throws on the
  // invalid ones — catch, log which failed, and continue with what loaded.
  let loadedActionCount = 0;
  try {
    loadedActionCount = actionRegistry.load().actions;
  } catch (e) {
    loadedActionCount = actionRegistry.listActions().length;
    console.warn(`[work] action registry loaded with issues (skipped invalid entries):\n${(e as Error).message}`);
  }
  console.log(`[work] action registry: ${loadedActionCount} action${loadedActionCount === 1 ? '' : 's'}`);

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
  const sessionStore = new SessionStore({ root: projectsRoot, registry: projectRegistry, worktreeManager, sessionMetaDir: join(RUNTIME_DIR, 'session-meta') });
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
    // The mirror of the Stop hook's own rebroadcast below: a session starting a turn is a
    // liveness change no job mutation reports. A step resume writes its step BEFORE it
    // sends the prompt (resumeControllerRound's `run()`), so the broadcast that mutation
    // triggers still says the session is idle — and nothing follows it until the session
    // reports progress, which can be a whole turn later. Without this edge the PWA's inline
    // feed shows a woken controller as parked for that entire window.
    onTurnStart: (sessionId) => {
      stopTracker.recordTurnStart(sessionId);
      rebroadcastJobLiveness(sessionId);
    },
    onSessionRegistered: () => {
      // Trailing debounce: a burst of spawns (e.g. work orchestrator kicking off
      // multiple child sessions) coalesces into a single PWA refresh.
      scheduleSessionsChangedBroadcast();
    },
    onSessionExit: (sessionId, code) => {
      // Session-scoped allow rules die with the session's process.
      allowlist.clearSession(sessionId);
      // A crash / idle-reap fires no Stop hook, so the Stop-handler slot release never runs —
      // free any governor slot this session held here too (idempotent; a plain active.delete).
      engine.releaseLaunchSlot(sessionId);
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
          actionRoutes.dropEditForSession(sessionId);
        }
        try { notifyAll({ type: 'actions_changed' }); } catch { /* notifyAll not in scope yet during startup */ }
      }
      if (kind === 'schedule-edit') {
        // Same reasoning as the action-edit drop above: stop a dead builder session's
        // card from showing a stale "review" pill.
        const dropped = scheduleRoutes.dropEditForSession(sessionId);
        // If the builder exited/crashed/timed out before ever delivering a proposal, no
        // schedule_draft_ready was broadcast — the draft pane would spin on "Drafting…"
        // forever. Signal the failure so it can offer a way out. (A delivered proposal
        // means the user already has a draft to work with — don't fire.)
        if (dropped && !dropped.proposal) {
          try {
            notifyAll({ type: 'schedule_draft_failed', sessionId, reason: 'The schedule builder stopped before proposing a draft.' });
          } catch { /* notifyAll not in scope yet during startup */ }
        }
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
  const preferencesStore = new PreferencesStore(join(RUNTIME_DIR, 'preferences.json'));
  // Token-aware launch queue. Constructed before the engine (which takes it as a dep).
  // `latestAccountUsage` is declared later and read lazily through the closure — same
  // pattern as tokenScheduler below.
  const launchGovernor = new LaunchGovernor({
    getSnapshot: () => latestAccountUsage ?? undefined,
    getConcurrency: () => preferencesStore.getLaunchConcurrency(),
    onChange: () => notifyLaunchStatesChanged(),
  });
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
    governor: launchGovernor,
    writeActionMeta: (id, meta) => sessionStore.writeActionMeta(id, meta),
  });
  const runsStore = new RunsStore(join(RUNTIME_DIR, 'runs.jsonl'));
  const usageLedger = new UsageLedger(join(RUNTIME_DIR, 'usage-ledger.json'));
  const actionRunsStore = new ActionRunsStore(join(RUNTIME_DIR, 'action-runs.jsonl'));
  const denialsStore = new DenialsStore(join(RUNTIME_DIR, 'denials.json'));
  const actionRevisionsStore = new ActionRevisionsStore(join(RUNTIME_DIR, 'action-revisions'));
  const groupRevisions = new PermissionGroupRevisionsStore(
    join(RUNTIME_DIR, 'permission-group-revisions.jsonl'));
  const actionRunLedger = new ActionRunLedger({
    store: actionRunsStore,
    onSettled: (action) => {
      try { notifyAll({ type: 'action_run_settled', action }); } catch { /* during startup */ }
    },
  });
  const runsCapture = createRunsCapture({
    runsStore,
    usageLedger,
    onRunAppended: (run) => notifyAll({ type: 'run_appended', run }),
  });

  const schedulesStore = new SchedulesStore(join(RUNTIME_DIR, 'schedules', 'index.json'));
  const nativeHandlers = new NativeHandlerRegistry();
  const envelopeEnrichers = new EnvelopeEnricherRegistry();
  // Late-bound: the improver's ActionEdit is owned by registerActionsRoutes, which runs well
  // after the scheduler is constructed. Read through the closure at fire time — same pattern as
  // `latestAccountUsage` above.
  let beginImproverEdit: ActionsRoutesHandlers['beginImproverEdit'] | undefined;
  let listPendingEdits: ActionsRoutesHandlers['listPendingEdits'] | undefined;
  const scriptEnv = () => ({ OUTPOST_HOOK_PORT: String(HOOK_PORT), DAEMON_AUTH: secret });
  const scheduler = new Scheduler({
    store: schedulesStore,
    guardProviders: createGuardProviders(() => latestAccountUsage ?? undefined, projectRegistry, worktreeManager),
    spawn: createSpawnDeps({
      engine,
      sessionManager: manager,
      projectRegistry,
      worktreeManager,
      runtimeDir: RUNTIME_DIR,
      apiUrl: config.httpPort !== null ? `http://127.0.0.1:${config.httpPort}` : '',
      hookPort: HOOK_PORT,
      secret,
      enrichers: envelopeEnrichers,
      recentLessons: (skill) => journalStore.recent(skill),
    }),
    inline: createInlineDeps(scriptEnv, nativeHandlers, projectRegistry, worktreeManager),
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

  const prWatcher = new PrWatcher({ queue: jobQueue, engine });
  const userPrsWatcher = new UserPrsWatcher({
    statePath: join(RUNTIME_DIR, 'user-prs.json'),
    onChange: (snap) => {
      try { notifyAll({ type: 'user_prs_changed', snapshot: snap }); }
      catch { /* pre-startup */ }
    },
  });

  nativeHandlers.register('pr-watcher', () => prWatcher.runOnce());
  nativeHandlers.register('user-prs-watcher', () => userPrsWatcher.runOnce());

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
    const kind = manager.getKind(id);
    if (kind === 'action-edit' || kind === 'skill-edit' || kind === 'schedule-edit') return;
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
  let onScheduleProposal: (p: { sessionId: string; name: string; summary: string; trigger: Trigger; what: What }) => void = () => { /* wired later */ };

  // Hook endpoints are loopback-only and authenticated by a per-launch secret —
  // see hook-server.ts. Any new endpoint added there must validate the secret header.
  const hookServer = new HookServer({
    port: HOOK_PORT,
    daemonAuthSecret: secret,
    onStatusLineHook: async (body) => {
      // Schema: https://code.claude.com/docs/en/statusline#available-data.
      const payload = parseJsonObject(body) as {
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
      } | null;
      if (!payload) throw new Error('invalid json body');
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
      if (typeof payload.cost?.total_cost_usd === 'number') {
        actionRunLedger.noteSessionCost(sessionId, payload.cost.total_cost_usd);
      }
    },
    onStopHook: async (body) => {
      const payload = parseJsonObject(body) as { session_id?: string } | null;
      if (!payload) throw new Error('invalid json body');
      const sessionId = payload.session_id;
      if (!sessionId) return;
      manager.markTurnEnded(sessionId);
      // Mirror that onto the wire. The PWA's thinking strip is otherwise driven purely by
      // the model's own stream, so a client that misses the turn's terminal event keeps
      // spinning; this rides the event log, so a reconnect inside the replay window
      // recovers it too. Kept next to markTurnEnded so `working` and what clients believe
      // can't drift — including on a stale Stop, which clears `working` all the same.
      manager.broadcast(sessionId, { type: 'daemon_turn_end' });
      // Free the governor slot this turn held BEFORE the stale-Stop / handoff logic below —
      // this must run even on a stale Stop (which skips onSessionTurnEnded) and for orchestrator
      // sessions (which onSessionTurnEnded early-returns on), or a queued follow-up round would
      // deadlock behind the un-freed slot. Draining here also lets any other job's queued launch
      // fill the freed slot.
      engine.releaseLaunchSlot(sessionId);
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
        // If this session is bound to an unresolved step, the assistant ended its turn
        // without calling submit_step_output. Arm the failure rather than applying it —
        // a round that yielded to background subagents gets re-invoked, and the next tool
        // call on the session calls the check off (see WorkEngine.armUnresolvedCheck).
        if (engine.armUnresolvedCheck(
          sessionId,
          'Session ended without submitting output via mcp__outpost__submit_step_output',
        )) {
          console.log(`[work] stop session=${sessionId.slice(0,8)} → unresolved-step check armed`);
        }
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
      const hookInput = parseJsonObject(body) as HookInput | null;
      if (!hookInput) throw new Error('invalid json body');
      console.log(`[hook] ${hookInput.tool_name} session=${hookInput.session_id?.slice(0,8)}${hookInput.agent_id ? ` agent=${hookInput.agent_type ?? '?'}/${hookInput.agent_id.slice(0,8)}` : ''} input=${JSON.stringify(hookInput.tool_input).slice(0, 200)}`);
      // Proof of life for the session — disarms any "ended without submitting" check left
      // by an earlier Stop. Subagent calls count (they carry the parent's session id).
      if (hookInput.session_id) engine.noteSessionActivity(hookInput.session_id);
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
        gatedForAction: (name) => actionRegistry.gatedFor(name),
        pinFor: (sid, tool, input) => engine.pinFor(sid, tool, input),
        onPinConsumed: (sid, callId, toolUseId) => engine.consumePin(sid, callId, toolUseId),
        draftStateFor: (sid) => engine.draftStateFor(sid),
        onGatedDenial: (sid, act, reason) => engine.journalGatedDenial(sid, act, reason),
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
    onPostToolFailureHook: async (body) => {
      const input = parseJsonObject(body) as PostToolFailureHookInput | null;
      if (!input) throw new Error('invalid json body');
      handlePostToolFailureHook(input, (sid, tool, toolInput, toolUseId) => engine.releaseConsumedPin(sid, tool, toolInput, toolUseId));
      return '{}';
    },
    onWorkPlanReady: async (body) => {
      const payload = parseJsonObject(body) as { jobId: string; mode?: 'initial' | 'replan'; steps: unknown[]; drops?: string[]; feedback?: string; findings?: unknown } | null;
      if (!payload) throw new Error('invalid json body');
      engine.onPlanReady(payload.jobId, payload.mode ?? 'initial', payload.steps as never, payload.drops, payload.feedback, payload.findings as never);
    },
    onWorkStepResolved: async (body) => {
      const payload = parseJsonObject(body) as { jobId: string; stepId: string; output?: string } | null;
      if (!payload) throw new Error('invalid json body');
      engine.onStepResolved(payload.jobId, payload.stepId, { output: payload.output });
    },
    onWorkStepFailed: async (body) => {
      const payload = parseJsonObject(body) as { jobId: string; stepId: string; reason: string } | null;
      if (!payload) throw new Error('invalid json body');
      engine.onStepFailed(payload.jobId, payload.stepId, payload.reason);
    },
    onActionProposal: (body) => onActionProposalHandler(body),
    onWorkJournal: async (body) => {
      const payload = parseJsonObject(body) as { action?: string; jobId?: string; stepId?: string; outcome?: string; lesson?: string } | null;
      if (!payload) throw new Error('invalid json body');
      if (!payload.action || !payload.jobId || !payload.outcome || !payload.lesson) return;
      journalStore.append({
        action: payload.action,
        jobId: payload.jobId,
        stepId: payload.stepId,
        outcome: payload.outcome,
        lesson: payload.lesson,
      });
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
      submit_step_progress: async (a) => {
        engine.onStepProgress(a.jobId as string, a.stepId as string, {
          memo: a.memo as string | undefined,
          phase: a.phase as string | undefined,
          artifacts: a.artifacts as Record<string, string> | undefined,
          next: a.next as never,
        });
        return { ok: true };
      },
      submit_write_draft: async (a) => {
        const jobId = a.jobId as string;
        const stepId = a.stepId as string;
        const dispatchId = a.dispatchId as string | undefined;
        if (typeof a.summary !== 'string' || !a.summary.trim()) {
          throw new Error('submit_write_draft refused: summary must be a non-empty string');
        }
        if (a.evidence !== undefined && typeof a.evidence !== 'string') {
          throw new Error('submit_write_draft refused: evidence must be a string');
        }
        const calls = parseDraftCalls(a.calls);
        if (!calls) {
          throw new Error(
            'submit_write_draft refused: calls must be a non-empty array, each element with '
            + 'exactly one of `bash` (string) or `tool: {name: string, args: object}`');
        }
        // A dispatch child's draft is labelled with the CHILD's action, not the controller's —
        // actionForStep(jobId, stepId) alone would resolve `stepId` (the PARENT orchestrated
        // step) to `s.controller`, mislabeling every dispatched-child draft.
        const action = engine.actionForStep(jobId, stepId, dispatchId) ?? 'unknown';
        const result = engine.onWriteDraftReady(jobId, stepId, {
          action,
          raisedBy: dispatchId
            ? { kind: 'dispatch', dispatchId }
            : { kind: 'step' },
          summary: a.summary,
          ...(a.evidence ? { evidence: a.evidence } : {}),
          calls,
        });
        // Fail the tool call, not just log it — the MCP protocol's own error channel (see
        // handleOne's catch in mcp-server.ts) is how the calling session learns its draft was
        // refused instead of hanging or writing blind on a phantom "ok".
        if (!result.ok) throw new Error(`submit_write_draft refused: ${result.reason}`);
        // Only notify once the draft is actually accepted and parked — never on a refusal
        // above. submitDraft (write-draft-runner.ts) silently coerces a step-less
        // `{kind:'step'}` raiser to `{kind:'controller'}` for an orchestrated step; mirror
        // that here so the notification's dedupe tag agrees with the draft actually stored,
        // not the pre-coercion guess passed above.
        const job = jobQueue.get(jobId);
        const step = job?.steps.find((s) => s.id === stepId);
        const raisedBy: DraftRaisedBy = dispatchId
          ? { kind: 'dispatch', dispatchId }
          : step?.type === 'orchestrated' ? { kind: 'controller' } : { kind: 'step' };
        void pushSender.send({
          title: job?.title ? `Draft ready: ${job.title}` : 'Draft ready for approval',
          body: `${action} — ${a.summary as string}`,
          tag: draftNotificationTag(jobId, stepId, raisedBy),
          data: { kind: 'draft', jobId, stepId },
        });
        return { ok: true };
      },
      submit_action_proposal: async (a) => {
        await onActionProposalHandler(JSON.stringify(a));
        return { ok: true };
      },
      submit_schedule_proposal: async (a) => {
        onScheduleProposal({
          sessionId: String(a.scheduleEditSessionId),
          name: String(a.name),
          summary: a.summary ? String(a.summary) : '',
          trigger: a.trigger as Trigger,
          what: a.what as What,
        });
        return { ok: true };
      },
      create_job: async (a) => {
        const r = engine.createExternalJob({
          source: String(a.source),
          title: String(a.title),
          body: a.body ? String(a.body) : undefined,
          dedupeKey: a.dedupeKey ? String(a.dedupeKey) : undefined,
          externalRef: a.externalRef as JobRecord['externalRef'] | undefined,
        });
        return r;
      },
    }),
    onCreateJob: async (p: { source: string; title: string; body?: string; dedupeKey?: string; externalRef?: JobRecord['externalRef'] }) =>
      engine.createExternalJob(p),
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
  registerJobsRoutes(server, { jobQueue, engine, prWatcher, scheduler, sessionStore, worktreeManager, jobsDir: join(RUNTIME_DIR, 'jobs') });
  registerPushRoutes(server, { pushStore, pushSender, userPrsWatcher });
  registerMetaRoutes(server, {
    actionRegistry, permissionGroups, allowlist, allowlistPath: ALLOWLIST_PATH, projectAllowlistDir,
    actionsStore, actionsStorePath: join(RUNTIME_DIR, 'actions.json'), projectRegistry, worktreeManager,
    journalStore, denialsStore, mcpConfigPath,
    permissionGroupsPath: PERMISSION_GROUPS_PATH, groupRevisions,
  });
  registerRunsRoutes(server, { runsStore, usageLedger, getAccountUsage: () => latestAccountUsage });
  registerSchedulesRoutes(server, { store: schedulesStore, scheduler, notify: notifyAll, tokenStatus: (id) => tokenScheduler.describe(id) });
  registerPreferencesRoutes(server, { preferencesStore, notify: notifyAll });

  // A second instance of the same stateless factory registerMetaRoutes uses — both close over
  // the same permissionGroups object and permission-groups.json path, so a `promote` verdict
  // applied here gets the identical validate/write/reload/revision guarantees as the group
  // editor itself, with no group-writing logic duplicated in routes/actions.ts.
  const applyGroup = createGroupApplier({
    actionRegistry, permissionGroups, permissionGroupsPath: PERMISSION_GROUPS_PATH, groupRevisions,
  });
  const actionRoutes = registerActionsRoutes(server, {
    outpostActionsDir, RUNTIME_DIR, SRC_DIR, secret, config,
    actionRegistry, actionsStore, allowlist, actionRunsStore, denialsStore, actionRunLedger,
    actionRevisionsStore, manager, engine, notifyAll,
    permissionGroups, applyGroup,
  });
  recordActionDenial = actionRoutes.recordActionDenial;
  onActionProposalHandler = actionRoutes.onActionProposalHandler;
  beginImproverEdit = actionRoutes.beginImproverEdit;
  listPendingEdits = actionRoutes.listPendingEdits;

  // Assembles the evidence for one action per fire and points the session at it. Daemon-side
  // in TypeScript on purpose: reflection quality is the binding constraint, so the model gets
  // a curated pack rather than a query API to go fishing with.
  envelopeEnrichers.register('meta.improve-actions', (ctx) => {
    const packDeps = {
      listActionNames: () => actionRegistry.listActions().map((a) => a.name),
      runsFor: (action: string) => actionRunsStore.listByAction(action),
      denialsFor: (action: string) => denialsStore.list(action),
      revisionsFor: (action: string) => actionRevisionsStore.listByAction(action),
      lessonsFor: (action: string) => journalStore.recent(action),
      skillMdFor: (action: string) => {
        try { return readFileSync(join(actionDirFor(outpostActionsDir, action).dir, 'SKILL.md'), 'utf8'); }
        catch { return ''; }
      },
      pendingEdits: () => listPendingEdits?.() ?? [],
      now: () => Date.now(),
    };
    const opts = parsePackOpts(ctx.args);
    const picked = selectActionToImprove(packDeps, opts);
    if (!picked) throw new SkipRun('Skipped — no action has enough new run evidence to review');
    console.log(`[improver] selected ${picked.reason}`);
    return {
      envelope: {
        actionName: picked.action,
        whySelected: picked.reason,
        improve: buildImprovementPack(picked.action, packDeps, opts, picked.reason),
      },
      cwd: actionDirFor(outpostActionsDir, picked.action).dir,
      onSpawned: (sessionId) => {
        // 'action-edit' reuses onSessionExit's cleanup and keeps the improver out of the
        // user-facing runs ledger. Safe for a pending proposal now that dropEditForSession
        // preserves one (see onSessionGone).
        manager.tagKind(sessionId, 'action-edit');
        engine.bindAction(sessionId, 'meta.improve-actions');
        engine.stampActionSession(sessionId, 'meta.improve-actions', `Improve action: ${picked.action}`);
        beginImproverEdit?.({ sessionId, actionName: picked.action });
      },
    };
  });

  registerActionRevisionsRoutes(server, {
    outpostActionsDir, actionsStore, revisionsStore: actionRevisionsStore, notifyAll,
    reloadActions: () => {
      try { ensureActionsInstalled(bundledRepoDir(SRC_DIR), RUNTIME_DIR); } catch { /* tolerate */ }
      try { actionRegistry.load(); } catch (e) { console.warn(`[action-revert] registry reload failed: ${(e as Error).message}`); }
    },
  });

  // Same shape meta.orchestrate's envelope carries (WorkEngine.buildActionCatalog),
  // reproduced here rather than exposed off WorkEngine — the schedule builder only
  // needs it as a read-only hint of what already exists.
  const scheduleRoutes = registerScheduleEditRoutes(server, {
    manager, engine, notifyAll, config, secret, runtimeDir: RUNTIME_DIR,
    actionCatalog: () => actionRegistry.listActions().map((a) => ({
      name: a.name,
      description: a.frontmatter.description,
      category: a.frontmatter.outpost.category,
      runner: a.frontmatter.outpost.runner,
      side_effects: a.frontmatter.outpost.side_effects,
      input_schema: a.inputSchema,
      output_schema: a.outputSchema,
    })),
    runScriptTest: async (what) => {
      if (!homeOrKnownCwd(what.cwd, projectRegistry, worktreeManager)) {
        return { outcome: 'error', output: `cwd is not a registered project or your home directory: ${what.cwd}` };
      }
      const r = await runScript({ script: what.script, cwd: what.cwd, env: scriptEnv() });
      return { outcome: r.outcome, output: r.output };
    },
  });
  onScheduleProposal = (p) => scheduleRoutes.onProposal(p);




  // Held open by every client for the app lifetime; carries all approval events so
  // cross-session toasts fire even when no session WS is attached.
  const notificationClients = new Set<import('ws').WebSocket>();
  function notifyAll(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of notificationClients) ws.send(payload);
  }

  // Launch-queue state changed (a launch fired, parked, freed a slot, or was cancelled).
  // The PWA re-fetches per-job launch status on this. Wired as the governor's onChange.
  function notifyLaunchStatesChanged(): void {
    try { notifyAll({ type: 'work_launch_changed' }); } catch { /* pre-startup */ }
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
    try { notifyAll({ type: 'work_job_changed', jobId, job: serializeJob(owner, (id) => engine.isSessionWorking(id), (job) => engine.launchStatusFor(job)) }); }
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
      // Fresh headroom may unblock parked autonomous launches — drain the launch queue too.
      launchGovernor.onUsageSnapshot();
    },
  });
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
      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => handleNotificationsMessage(raw, { queue }));
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
    // mode=<approval mode> carries the client's default for a brand-new session
    // so it takes effect server-side at spawn, rather than the PWA healing it
    // after the first broadcast (which the ⌘K spawn path never armed).
    let spawnApprovalMode: string | undefined;
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
      const rawMode = params.get('mode');
      if (rawMode) spawnApprovalMode = rawMode;
      const rawSince = params.get('since');
      if (rawSince !== null) {
        const n = Number(rawSince);
        // undefined → SessionManager defaults to 0 (send everything in the log).
        if (Number.isFinite(n) && n >= 0) since = Math.floor(n);
      }
    }
    manager.attach(sessionId, ws, { cwd, spawnMode, baseBranch, since, model });
    // Seed the spawn default only when this session has never had a mode set —
    // a reconnect (or a session whose mode the user already changed) keeps its
    // stored choice. modes.set() validates and ignores anything unrecognized.
    if (spawnApprovalMode && !modes.has(sessionId)) {
      try { modes.set(sessionId, spawnApprovalMode as ApprovalMode); }
      catch { /* invalid mode in query — fall back to the 'ask' default */ }
    }
    ws.send(JSON.stringify({ type: 'approval_mode', sessionId, mode: modes.get(sessionId) }));
    // Replay last statusline so the meter renders before claude's next fire; PWA handler is idempotent.
    const cachedSl = latestStatuslineBySession.get(sessionId);
    if (cachedSl) ws.send(JSON.stringify(cachedSl));
    // Backstop: nothing thrown while dispatching a client frame may unwind through
    // ws.on('message'), where an uncaught error takes the whole daemon down and with
    // it every other session. handleSessionMessage guards its own known throwers;
    // this catches whatever a future branch forgets.
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        handleSessionMessage(raw, sessionId, { queue, manager, modes, log: (l) => console.log(l) });
      } catch (e) {
        console.error(`[api] session ${sessionId.slice(0, 8)} message handler threw: ${(e as Error).message}`);
        try { ws.send(JSON.stringify({ type: 'daemon_error', message: (e as Error).message })); } catch { /* socket already gone */ }
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

  // Must precede anything that can mutate a job (the scheduler's first fire,
  // reconcileInterruptedSteps below) or those rounds settle before the ledger is
  // watching and their runs stay dangling.
  actionRunLedger.attach(jobQueue);
  actionRunLedger.reconcileAtBoot(jobQueue.list());

  seedBuiltinSchedules(schedulesStore, homedir());
  scheduler.start();

  // Broadcast every queue mutation to the notifications WS so the PWA work UI can
  // re-render the affected ticket without polling, and feed the runs ledger /
  // schedule-run completion. This must stay unconditional: schedule-spawned
  // code.* jobs go through engine.createJob directly and run regardless
  // of whether Linear integration is configured.
  jobQueue.subscribe((ev) => {
    if (ev.kind === 'upsert') {
      notifyAll({ type: 'work_job_changed', jobId: ev.jobId, job: serializeJob(ev.job, (id) => engine.isSessionWorking(id), (job) => engine.launchStatusFor(job)) });
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
    // Actions are already seeded + loaded at startup (see the registry construction above).
    console.log(`[work] actions available: ${loadedActionCount}`);
    engine.reconcileInterruptedSteps();
    engine.reconcileWaits();
    engine.reconcilePendingLaunches();
    void engine.tick();
    const n = jobQueue.list().length;
    console.log(`[work] orchestrator started (queue: ${n} ticket${n === 1 ? '' : 's'})`);
  } else {
    console.log('[work] LINEAR_API_TOKEN missing from ~/.outpost/.env — work orchestrator disabled');
  }

  // Reclaim worktrees whose owner is gone: a job that finished before organic completion
  // reaped its own, or an interactive session the user never explicitly archived (the
  // 15-minute idle reap kills the process and leaves the checkout). Unconditional — worktrees
  // leak with or without Linear — and last, so the reconciles above have already settled any
  // step this would otherwise judge ownerless. A `failed` job counts as owned: it's a
  // resumable halt whose retry resumes into the checkout.
  void worktreeManager.sweepOrphaned((key) => {
    for (const job of jobQueue.list()) {
      const owns = job.steps.some((s) => s.id === key
        || (s.type === 'orchestrated' && s.dispatches.some((d) => d.id === key)));
      if (owns) return job.state !== 'done' && job.state !== 'abandoned';
    }
    return !!sessionStore.findSession(key);
  }).then((reaped) => {
    if (reaped.length) console.log(`[daemon] swept ${reaped.length} orphaned worktree(s)`);
  }).catch((e) => console.error(`[daemon] worktree sweep: ${(e as Error).message}`));
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
  // 2. Plugin commands AND plugin skills — a plugin ships either or both.
  scanPlugins(claudeDir, push);
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

// Driven off installed_plugins.json rather than a walk of plugins/cache: the cache
// keeps superseded version dirs and plugins the user has since disabled, neither of
// which Claude Code itself offers in the menu.
function scanPlugins(claudeDir: string, push: (c: SlashCommand) => void) {
  let manifest: { plugins?: Record<string, { installPath?: string }[]> };
  try {
    manifest = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
  } catch { return; }
  // Project-scoped enables aren't consulted — one daemon serves every cwd.
  let enabled: Record<string, boolean> = {};
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    if (settings?.enabledPlugins && typeof settings.enabledPlugins === 'object') enabled = settings.enabledPlugins;
  } catch { /* absent settings means nothing is explicitly disabled */ }
  for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
    if (enabled[key] === false) continue;
    const source = `plugin:${key.split('@')[0] ?? key}`;
    for (const install of installs ?? []) {
      if (!install?.installPath) continue;
      scanCommandDir(join(install.installPath, 'commands'), source, push);
      scanSkillDir(join(install.installPath, 'skills'), source, push);
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
