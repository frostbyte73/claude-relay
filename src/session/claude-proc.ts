import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LineParser } from './stream-json.js';

// launchd strips the shell PATH, so a bare `spawn('claude')` can ENOENT even though the
// binary is installed (e.g. Homebrew's /opt/homebrew/bin). Resolve an absolute path from
// an explicit override or the usual install locations, re-checked on every spawn so a
// `claude-code` cask upgrade that relocates the symlink is picked up on the next session.
function resolveClaudeBin(): string {
  const override = process.env.OUTPOST_CLAUDE_BIN;
  if (override && existsSync(override)) return override;
  const dirs = [
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
    join(homedir(), '.claude/local'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return 'claude'; // last resort: let spawn search PATH; a miss surfaces via the 'error' handler
}

export interface ClaudeProcOpts {
  sessionId: string;
  // 'new' uses --session-id to start a fresh conversation under this UUID;
  // 'resume' uses --resume to continue an existing one.
  mode: 'new' | 'resume';
  settingsPath: string;
  // Claude Code ignores `mcpServers` inside --settings; MCP servers only register via
  // --mcp-config. This is the JSON file listing our outpost MCP server.
  mcpConfigPath: string;
  // Claude stores sessions under ~/.claude/projects/<sanitized-cwd>/, so the cwd at spawn
  // time determines where sessions land on disk. Pinning a consistent cwd ensures the
  // daemon's SessionStore (which reads from a single dir) sees every session it spawned.
  cwd: string;
  env: Record<string, string>;
  // Optional `--permission-mode` override. Used to clamp agent sessions to `default`
  // (interactive + hook-driven) regardless of the user's global preference, so the
  // deny-on-miss path in hook-handler.ts always runs.
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  // Optional `--model` override; absent means claude's configured default.
  model?: 'sonnet' | 'opus' | 'haiku' | 'fable';
  onMessage: (msg: unknown) => void;
  onError: (msg: string) => void;
  onExit: (code: number | null) => void;
}

export class ClaudeProc {
  private readonly proc: ChildProcess;
  private readonly parser = new LineParser();
  private exited = false;

  constructor(opts: ClaudeProcOpts) {
    this.parser.onLine = opts.onMessage;
    this.parser.onError = (raw, err) => opts.onError(`malformed line from claude: ${raw.slice(0, 200)} (${err.message})`);

    const sessionArgs = opts.mode === 'resume'
      ? ['--resume', opts.sessionId]
      : ['--session-id', opts.sessionId];

    const permissionArgs = opts.permissionMode ? ['--permission-mode', opts.permissionMode] : [];
    const modelArgs = opts.model ? ['--model', opts.model] : [];
    this.proc = spawn(
      resolveClaudeBin(),
      [
        '--print',
        '--verbose',
        '--input-format=stream-json',
        '--output-format=stream-json',
        '--include-hook-events',
        '--include-partial-messages',
        '--settings', opts.settingsPath,
        '--mcp-config', opts.mcpConfigPath,
        ...permissionArgs,
        ...modelArgs,
        ...sessionArgs,
      ],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.parser.write(chunk));
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk: string) => opts.onError(`[claude stderr] ${chunk}`));
    this.proc.on('exit', (code) => {
      if (this.exited) return;
      this.exited = true;
      opts.onExit(code);
    });
    // A failed spawn (e.g. `claude` not on PATH) emits 'error' and never 'exit'. Without
    // this listener Node rethrows it as a fatal exception and the whole daemon crashes —
    // launchd then relaunches it, dropping every WS client and killing every other in-flight
    // session. Handle it as a normal session exit so only this one session fails.
    this.proc.on('error', (err) => {
      if (this.exited) return;
      this.exited = true;
      opts.onError(`failed to spawn claude: ${err.message}`);
      opts.onExit(null);
    });
  }

  send(message: unknown): void {
    if (this.exited) throw new Error('claude proc has exited');
    this.proc.stdin?.write(JSON.stringify(message) + '\n');
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.exited) this.proc.kill('SIGKILL');
      }, 5000);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  interrupt(): void {
    if (this.exited) return;
    this.proc.kill('SIGINT');
    setTimeout(() => {
      if (!this.exited) this.proc.kill('SIGKILL');
    }, 1000);
  }
}
