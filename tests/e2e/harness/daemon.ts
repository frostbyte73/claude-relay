import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfSignedCert } from './tls.js';
import { freePort } from './port.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..', '..', '..');
const MOCK_CLAUDE_DIR = resolvePath(__dirname, '..', 'bin');

export interface SeedSession {
  id: string;
  // Raw JSONL content for the session — caller is responsible for valid lines.
  jsonl: string;
}

export interface SeedProject {
  cwd: string;
  sessions?: SeedSession[];
}

// Phase 2b: pre-seed a worktree record under <runtimeDir>/worktrees/index.json so the
// test can exercise UI affordances (badge, overflow menu) against a row that has both
// a JSONL on disk AND a live worktree record. The on-disk worktree dir itself is
// optional — many tests just need the record to drive UI; the few that need the dir
// can create it manually via the worktreePath returned by the seeder.
export interface SeedWorktreeRecord {
  sessionId: string;
  projectCwd: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  createdAt?: number;
  archivedAt?: number;
}

// Mirrors ActionDenial (storage/denials-store.ts) closely enough for a fixture — `id`/`at`
// default so a test only has to spell out what it's actually asserting on.
export interface SeedDenial {
  actionName: string;
  toolName: string;
  toolInput?: unknown;
  suggested: { kind: 'tool' | 'bash' | 'mcp' | 'path' | 'none'; value: string };
  count?: number;
  at?: number;
  id?: string;
}

export interface StartDaemonOpts {
  // Path to the fixture JSONL the mock claude will replay.
  fixturePath: string;
  // Optional: pre-seed projects and sessions on disk before the daemon starts.
  initialProjects?: SeedProject[];
  // Optional: pre-seed unresolved denials under <runtimeDir>/denials.json before the daemon
  // starts (DenialsStore's constructor loads this file synchronously and once, so seeding
  // after boot would never be picked up) — lets a Permissions-page test exercise the Pending
  // classifications panel without driving a real action session through an allowlist miss.
  initialDenials?: SeedDenial[];
  // Optional: pre-seed worktree records so UI tests can target archive/delete flows
  // against rows that look like they were spawned via the worktree path.
  initialWorktrees?: SeedWorktreeRecord[];
  // Optional: pre-seed work-queue jobs (raw JobRecord JSON) under <runtimeDir>/jobs/
  // before the daemon starts, so Tracked-surface tests can exercise a step in a
  // specific state without driving a real orchestrator/session through it.
  initialJobs?: Record<string, unknown>[];
  // Phase 3: shrink the per-session event log so tests can force replay_gap deterministically.
  eventLogMaxEvents?: number;
  eventLogMaxAgeMs?: number;
  // Phase 4: extra env vars to pass into the daemon process. Used for
  // OUTPOST_STOP_THRESHOLD_MS overrides + OUTPOST_PUSH_CA_PATH for push tests (web-push
  // hardcodes HTTPS; our fake push server uses a self-signed cert pinned via the CA path).
  extraEnv?: Record<string, string>;
  // Sanitizes PATH so `tailscale` lookups ENOENT; daemon falls through to HTTP-only.
  localhostOnly?: boolean;
}

export interface DaemonHandle {
  baseUrl: string;
  process: ChildProcess;
  runtimeDir: string;
  projectsRoot: string;
  certPath: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

// Mirrors how claude code sanitizes a cwd into a project-dir name:
// "/Users/alice/work/foo" → "-Users-alice-work-foo".
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

async function waitForListening(proc: ChildProcess, stderrBuf: { value: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('[daemon] listening on')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before listening (code ${code})\nstderr:\n${stderrBuf.value}`));
    };
    const cleanup = () => {
      proc.stdout?.off('data', onData);
      proc.off('exit', onExit);
      clearTimeout(timer);
    };
    proc.stdout?.on('data', onData);
    proc.on('exit', onExit);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for daemon\nstderr:\n${stderrBuf.value}`));
    }, 10_000);
  });
}

export async function startDaemon(opts: StartDaemonOpts): Promise<DaemonHandle> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'outpost-test-'));
  const projectsRoot = join(runtimeDir, 'claude-projects');
  mkdirSync(projectsRoot, { recursive: true });

  // Seed fixture projects/sessions.
  for (const p of opts.initialProjects ?? []) {
    const projectDir = join(projectsRoot, sanitizeCwd(p.cwd));
    mkdirSync(projectDir, { recursive: true });
    for (const s of p.sessions ?? []) {
      writeFileSync(join(projectDir, `${s.id}.jsonl`), s.jsonl);
    }
  }

  // Seed worktree records BEFORE the daemon starts so it picks them up on boot.
  if (opts.initialWorktrees?.length) {
    const wtRoot = join(runtimeDir, 'worktrees');
    mkdirSync(wtRoot, { recursive: true, mode: 0o700 });
    const records = opts.initialWorktrees.map((r) => ({
      sessionId: r.sessionId,
      projectCwd: r.projectCwd,
      worktreePath: r.worktreePath,
      branch: r.branch,
      baseBranch: r.baseBranch,
      createdAt: r.createdAt ?? Date.now(),
      ...(r.archivedAt ? { archivedAt: r.archivedAt } : {}),
    }));
    writeFileSync(
      join(wtRoot, 'index.json'),
      JSON.stringify({ records }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  // Seed work-queue jobs BEFORE the daemon starts so JobQueue's constructor
  // (which does a synchronous loadAll() of <runtimeDir>/jobs/*.json) picks them up.
  if (opts.initialJobs?.length) {
    const jobsDir = join(runtimeDir, 'jobs');
    mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    for (const job of opts.initialJobs) {
      writeFileSync(join(jobsDir, `${String(job.id)}.json`), JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
    }
  }

  // Seed denials.json BEFORE the daemon starts — same one-shot-synchronous-load constraint
  // as jobs/worktrees above.
  if (opts.initialDenials?.length) {
    const byAction: Record<string, unknown[]> = {};
    let seq = 0;
    for (const d of opts.initialDenials) {
      const list = (byAction[d.actionName] ??= []);
      list.push({
        id: d.id ?? `seed-denial-${seq++}`,
        actionName: d.actionName,
        sessionId: 'seed-session',
        toolName: d.toolName,
        toolInput: d.toolInput ?? null,
        suggested: d.suggested,
        at: d.at ?? Date.now(),
        count: d.count ?? 1,
      });
    }
    writeFileSync(join(runtimeDir, 'denials.json'), JSON.stringify({ byAction }, null, 2) + '\n', { mode: 0o600 });
  }

  const host = '127.0.0.1';
  const hookPort = await freePort();
  const httpsPort = await freePort();
  const httpPort = await freePort();
  const { certPath, keyPath } = selfSignedCert(runtimeDir, host);

  // Omit /usr/local/bin (Tailscale.app installs there) when forcing ENOENT.
  const nodeBinDir = dirname(process.execPath);
  const pathForDaemon = opts.localhostOnly
    ? `${MOCK_CLAUDE_DIR}:${nodeBinDir}:/usr/bin:/bin`
    : `${MOCK_CLAUDE_DIR}:${process.env.PATH ?? ''}`;

  const baseEnv: Record<string, string> = {
    ...process.env,
    PATH: pathForDaemon,
    OUTPOST_RUNTIME_DIR: runtimeDir,
    OUTPOST_PROJECTS_ROOT: projectsRoot,
    OUTPOST_HOOK_PORT: String(hookPort),
    OUTPOST_TEST_FIXTURE: opts.fixturePath,
    OUTPOST_TEST_DELAY_MS: '5',
    // Point the daemon's allowlist write path at the per-test temp dir so /api/allowlist/rules
    // POSTs don't mutate the repo's checked-in config/allowlist.json. The in-memory allowlist
    // still starts from the repo's config (which is imported at compile time).
    OUTPOST_ALLOWLIST_PATH: join(runtimeDir, 'allowlist.json'),
    OUTPOST_HTTP_PORT: String(httpPort),
    ...(opts.eventLogMaxEvents !== undefined
      ? { OUTPOST_EVENT_LOG_MAX_EVENTS: String(opts.eventLogMaxEvents) }
      : {}),
    ...(opts.eventLogMaxAgeMs !== undefined
      ? { OUTPOST_EVENT_LOG_MAX_AGE_MS: String(opts.eventLogMaxAgeMs) }
      : {}),
    ...(opts.extraEnv ?? {}),
  };

  const env = opts.localhostOnly
    ? baseEnv
    : {
        ...baseEnv,
        OUTPOST_CERT_PATH: certPath,
        OUTPOST_KEY_PATH: keyPath,
        OUTPOST_HOST: host,
        OUTPOST_BIND_ADDRESS: host,
        OUTPOST_HTTPS_PORT: String(httpsPort),
      };

  const proc = spawn('npx', ['tsx', 'src/daemon.ts'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderrBuf = { value: '' };
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (c: string) => {
    stderrBuf.value += c;
    if (process.env.OUTPOST_TEST_VERBOSE) process.stderr.write(`[daemon stderr] ${c}`);
  });
  if (process.env.OUTPOST_TEST_VERBOSE) {
    proc.stdout?.on('data', (c: Buffer | string) => {
      process.stderr.write(`[daemon stdout] ${c.toString()}`);
    });
  }

  try {
    await waitForListening(proc, stderrBuf);
  } catch (e) {
    proc.kill('SIGTERM');
    throw e;
  }

  return {
    baseUrl: opts.localhostOnly
      ? `http://127.0.0.1:${httpPort}`
      : `https://${host}:${httpsPort}`,
    process: proc,
    runtimeDir,
    projectsRoot,
    certPath,
    host,
    port: opts.localhostOnly ? httpPort : httpsPort,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    },
  };
}
