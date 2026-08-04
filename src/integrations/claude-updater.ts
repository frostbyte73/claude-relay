import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// launchd strips the shell PATH, so a bare `brew` can ENOENT even though it is
// installed. Resolve an absolute path from an explicit override or the usual
// Homebrew locations, the same way claude-proc.ts finds the `claude` binary.
function resolveBrewBin(): string {
  const override = process.env.OUTPOST_BREW_BIN;
  if (override && existsSync(override)) return override;
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'brew');
    if (existsSync(candidate)) return candidate;
  }
  return 'brew'; // last resort: let execFile search PATH; a miss surfaces as lastError
}

interface UpdaterState {
  lastRunAt: number | null;
  lastError: string | null;
}

// Keeps the installed Claude Code CLI current: runs `brew upgrade claude-code` once
// a day. Surfaced through the SystemPoller shape so it appears in the Schedules
// surface as a read-only row with last/next-run + a manual run-now.
//
// No daemon restart is needed after an upgrade: already-running Claude subprocesses
// keep their binary, and claude-proc.ts re-resolves the `claude` path on every new
// spawn, so the next session picks up the upgraded binary automatically.
export class ClaudeUpdater {
  readonly id = 'claude-updater';
  readonly name = 'Claude Code — auto-update';
  readonly description = 'Runs `brew upgrade claude-code` once a day to keep the CLI current.';
  readonly intervalMs: number;

  private readonly statePath: string;
  private readonly bootDelayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private running = false;

  constructor(opts: { statePath: string; intervalMs?: number; bootDelayMs?: number }) {
    this.statePath = opts.statePath;
    this.intervalMs = opts.intervalMs ?? (Number(process.env.OUTPOST_CLAUDE_UPDATE_MS) || 24 * 60 * 60_000);
    this.bootDelayMs = opts.bootDelayMs ?? 60_000;
    this.load();
  }

  // `kickstart -k` bounces the daemon on every worktree merge — often several times a
  // day — so a plain setInterval that resets on each boot would rarely fire. Persist
  // lastRunAt and compute the next run from it: run soon after boot if a day (or more)
  // has already elapsed, otherwise pick up where the previous process left off.
  start(): void {
    const now = Date.now();
    const due = this.lastRunAt == null || now - this.lastRunAt >= this.intervalMs;
    const delay = due ? this.bootDelayMs : this.lastRunAt! + this.intervalMs - now;
    this.scheduleNext(delay);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): { lastRunAt: number | null; lastError: string | null; running: boolean } {
    return { lastRunAt: this.lastRunAt, lastError: this.lastError, running: this.running };
  }

  async runNow(): Promise<void> {
    await this.upgrade();
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.upgrade().finally(() => this.scheduleNext(this.intervalMs));
    }, Math.max(0, delayMs));
    this.timer.unref();
  }

  // Records outcome into status/persisted state rather than throwing: both the timer
  // and the run-now route want the error surfaced in the Schedules row, not raised.
  private async upgrade(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await execFileP(resolveBrewBin(), ['upgrade', 'claude-code'], {
        timeout: 5 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error('[claude-updater] brew upgrade claude-code failed:', this.lastError);
    } finally {
      this.lastRunAt = Date.now();
      this.running = false;
      this.persist();
    }
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<UpdaterState>;
      this.lastRunAt = typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : null;
      this.lastError = typeof parsed.lastError === 'string' ? parsed.lastError : null;
    } catch {
      // Malformed → treat as never-run; overwritten on the next upgrade.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const blob: UpdaterState = { lastRunAt: this.lastRunAt, lastError: this.lastError };
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(blob, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}
