import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_EDITOR_COMMAND = 'code';

// How long to keep watching a just-spawned editor before calling it launched. A launcher
// that rejects its own flags (`goland --nope`) dies within milliseconds, so a short window
// turns a silent no-op into a message on the button that caused it; anything still running
// when the window closes has opened something.
const EARLY_EXIT_GRACE_MS = 700;

// Quote-aware split, so an editor can be named by a path with spaces
// (`"/Applications/My IDE.app/Contents/MacOS/ide" --new-window`). Nothing else about the
// string is interpreted: the result goes to spawn as argv with no shell, so a `$VAR`, a
// pipe or a `;` in here is a literal argument, not a second command.
export function splitEditorCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

// launchd strips the shell PATH, so a bare `code` / `goland` usually ENOENTs from the
// daemon even though it's installed — the same problem resolveClaudeBin solves in
// claude-proc.ts. Re-checked on every open so a Toolbox or cask upgrade that relocates the
// launcher is picked up without a daemon bounce.
function resolveEditorBin(name: string): string {
  if (name.includes('/')) return name;
  const dirs = [
    ...(process.env.PATH?.split(':').filter(Boolean) ?? []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
    // Where JetBrains Toolbox generates its `goland`/`idea`/… shell launchers on macOS.
    join(homedir(), 'Library/Application Support/JetBrains/Toolbox/scripts'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name; // let spawn search PATH; a miss surfaces as ENOENT on the 'error' handler
}

export function editorArgv(command: string, targetPath: string): { bin: string; args: string[] } {
  const parts = splitEditorCommand(command);
  if (parts.length === 0) throw new Error('editor command is empty');
  const [name, ...flags] = parts;
  return { bin: resolveEditorBin(name!), args: [...flags, targetPath] };
}

// Opens `targetPath` with the user's configured editor command, ON THIS MACHINE — which is
// where the files are. Resolves once the editor is up; rejects with something the user can
// act on if the command doesn't exist or refuses its own arguments.
export function openInEditor(command: string, targetPath: string): Promise<void> {
  const { bin, args } = editorArgv(command, targetPath);
  return new Promise((resolve, reject) => {
    // Detached so a launcher that stays in the foreground doesn't die with the daemon (or
    // keep it alive); stderr piped only for the grace window, to name a bad-flag failure.
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.destroy();
      child.unref();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(), EARLY_EXIT_GRACE_MS);
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (err) => {
      finish((err as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error(`editor command not found: ${bin} — install its shell launcher, or give an absolute path in Settings > External editor`)
        : err);
    });
    child.once('exit', (code) => {
      if (code === 0 || code === null) { finish(); return; }
      const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200);
      finish(new Error(`${bin} exited ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}
