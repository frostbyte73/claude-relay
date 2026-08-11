import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDaemonSettings, writeMcpConfig } from '../../src/settings-gen.js';

describe('writeDaemonSettings', () => {
  it('writes a valid JSON file with the loopback hook URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'));
    const path = join(dir, 'daemon-settings.json');
    writeDaemonSettings({
      outPath: path,
      hookPort: 8444,
    });
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const entry = j.hooks.PreToolUse[0];
    expect(entry.matcher).toBe('');
    const hook = entry.hooks[0];
    expect(hook.type).toBe('http');
    expect(hook.url).toBe('http://127.0.0.1:8444/hook/pretool');
    expect(hook.headers['X-Daemon-Auth']).toBe('$DAEMON_AUTH');
    expect(hook.allowedEnvVars).toContain('DAEMON_AUTH');
    expect(hook.timeout).toBe(600);
  });

  it('registers a PostToolUseFailure hook pointing at /hook/posttoolfail on the same loopback port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'));
    const path = join(dir, 'daemon-settings.json');
    writeDaemonSettings({ outPath: path, hookPort: 8444 });
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const entry = j.hooks.PostToolUseFailure[0];
    expect(entry.matcher).toBe('');
    const hook = entry.hooks[0];
    expect(hook.type).toBe('http');
    expect(hook.url).toBe('http://127.0.0.1:8444/hook/posttoolfail');
    expect(hook.headers['X-Daemon-Auth']).toBe('$DAEMON_AUTH');
    expect(hook.allowedEnvVars).toContain('DAEMON_AUTH');
    expect(hook.timeout).toBe(30);
  });

  it('registers a Stop hook pointing at /hook/stop on the same loopback port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'));
    const path = join(dir, 'daemon-settings.json');
    writeDaemonSettings({ outPath: path, hookPort: 8444 });
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const entry = j.hooks.Stop[0];
    expect(entry.matcher).toBe('');
    const hook = entry.hooks[0];
    expect(hook.type).toBe('http');
    expect(hook.url).toBe('http://127.0.0.1:8444/hook/stop');
    expect(hook.headers['X-Daemon-Auth']).toBe('$DAEMON_AUTH');
    expect(hook.allowedEnvVars).toContain('DAEMON_AUTH');
    expect(hook.timeout).toBe(30);
  });

  it('does not embed mcpServers in the settings file (Claude Code ignores it there)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'));
    const path = join(dir, 'daemon-settings.json');
    writeDaemonSettings({ outPath: path, hookPort: 8444 });
    const j = JSON.parse(readFileSync(path, 'utf8'));
    expect(j.mcpServers).toBeUndefined();
  });
});

describe('writeMcpConfig', () => {
  it('writes an --mcp-config file with the outpost server and the literal secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    const path = join(dir, 'daemon-mcp.json');
    writeMcpConfig({ outPath: path, hookPort: 8444, daemonAuthSecret: 'literal-secret' });
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const server = j.mcpServers.outpost;
    expect(server.type).toBe('http');
    expect(server.url).toBe('http://127.0.0.1:8444/mcp');
    expect(server.headers['X-Daemon-Auth']).toBe('literal-secret');
  });
});
