import { describe, it, expect } from 'vitest';
import { runScript } from '../../src/schedules/script-runner.js';
import { tmpdir } from 'node:os';

describe('runScript', () => {
  it('returns ok on exit 0 and captures stdout', async () => {
    const r = await runScript({ script: 'echo hello', cwd: tmpdir(), env: {} });
    expect(r.outcome).toBe('ok');
    expect(r.output).toContain('hello');
  });
  it('returns error on nonzero exit and captures stderr', async () => {
    const r = await runScript({ script: 'echo boom >&2; exit 3', cwd: tmpdir(), env: {} });
    expect(r.outcome).toBe('error');
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('boom');
  });
});
