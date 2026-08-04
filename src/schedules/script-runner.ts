import { spawn } from 'node:child_process';

export interface ScriptRunResult {
  outcome: 'ok' | 'error';
  output: string;
  exitCode: number | null;
}

// Runs a scheduled script directly (no Claude session) in `cwd` with `env` merged over the
// daemon's own environment, capturing combined stdout+stderr. Exit 0 → ok, anything else → error.
export function runScript(opts: {
  script: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', opts.script], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeoutMs ?? 120_000,
    });
    let output = '';
    const cap = (b: Buffer) => { output += b.toString(); if (output.length > 64_000) output = output.slice(-64_000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (e) => resolve({ outcome: 'error', output: output + `\n${e.message}`, exitCode: null }));
    child.on('close', (code) => resolve({ outcome: code === 0 ? 'ok' : 'error', output, exitCode: code }));
  });
}
