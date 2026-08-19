import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface RunGhOpts { maxBuffer?: number; timeout?: number }

export type RunGh = (cwd: string, args: string[], opts?: RunGhOpts) => Promise<string>;

// Shared `gh` shell-out for the integrations that poll GitHub. `cwd` picks up the repo's
// remote + the token from ~/.outpost/.env (launchd strips shell env — see env-file.ts).
export async function runGh(
  cwd: string,
  args: string[],
  opts: RunGhOpts = {},
): Promise<string> {
  const { stdout } = await execFileP('gh', args, {
    cwd,
    maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
    timeout: opts.timeout ?? 15_000,
  });
  return stdout.toString();
}
