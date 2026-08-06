import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';

// Drives the real checker over the real shipped permission groups, for the grant a
// `runner: claude` action resolves to (core is implicit — see ActionRegistry.resolvePermissions).
const GROUPS = JSON.parse(
  readFileSync(join(process.cwd(), 'config/permission-groups.default.json'), 'utf8'),
) as Record<string, AllowlistConfig>;

function forGroups(...names: string[]): Allowlist {
  const cfg: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const g of ['core', ...names]) {
    const src = GROUPS[g]!;
    cfg.alwaysAllow.push(...src.alwaysAllow);
    cfg.alwaysAllowBashPatterns.push(...src.alwaysAllowBashPatterns);
    cfg.alwaysAllowMcpPatterns.push(...src.alwaysAllowMcpPatterns);
    cfg.alwaysAllowPathPatterns!.push(...(src.alwaysAllowPathPatterns ?? []));
  }
  return new Allowlist(cfg);
}

const bash = (a: Allowlist, command: string, worktree?: string) =>
  a.allows('Bash', { command }, undefined, undefined, worktree, undefined);

// F4 — the path-rule branch normalised with a lexical resolve() while the session-scope
// check used realpathSync on the deepest existing ancestor. The two checkers disagreed, and
// the regex path was the weaker one: /tmp is world-writable, so any local user could plant
// a symlink there and turn an `Edit:^/tmp/`-shaped grant into a write anywhere on the box.
describe('path rules resolve symlinks, not just ..', () => {
  const a = forGroups('read', 'edit'); // edit grants Write:^/tmp/, Edit:^/tmp/, MultiEdit:^/tmp/
  let dir: string;
  let target: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'symlink-escape-'));
    mkdirSync(join(dir, 'real'), { recursive: true });
    target = join(dir, 'real', 'secret.txt');
    writeFileSync(target, 'secret\n');
    // /tmp/<random>/escape-file -> <dir>/real/secret.txt, i.e. a leaf symlink out of /tmp.
    symlinkSync(target, '/tmp/outpost-escape-file');
    // /tmp/<random>/escape-dir -> <dir>/real, i.e. an ancestor symlink out of /tmp.
    symlinkSync(join(dir, 'real'), '/tmp/outpost-escape-dir');
  });

  afterAll(() => {
    rmSync('/tmp/outpost-escape-file', { force: true });
    rmSync('/tmp/outpost-escape-dir', { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('denies a Write through a leaf symlink that leaves the granted prefix', () => {
    expect(a.allows('Write', { file_path: '/tmp/outpost-escape-file' })).toBe(false);
    expect(a.allows('Edit', { file_path: '/tmp/outpost-escape-file' })).toBe(false);
    expect(a.allows('MultiEdit', { file_path: '/tmp/outpost-escape-file' })).toBe(false);
  });

  it('denies a Write through an ancestor symlink that leaves the granted prefix', () => {
    expect(a.allows('Write', { file_path: '/tmp/outpost-escape-dir/secret.txt' })).toBe(false);
    // …including a leaf that does not exist yet, which is the Write case that matters.
    expect(a.allows('Write', { file_path: '/tmp/outpost-escape-dir/planted.txt' })).toBe(false);
  });

  it('denies the same escape through a shell redirect, which inherits the Write check', () => {
    expect(bash(a, 'cat /etc/hosts > /tmp/outpost-escape-file')).toBe(false);
    expect(bash(a, 'cat /etc/hosts > /tmp/outpost-escape-dir/planted.txt')).toBe(false);
  });

  it('still allows an ordinary /tmp target', () => {
    // On macOS /tmp is itself a symlink to /private/tmp. Resolving symlinks must not turn
    // every rule written in the user-visible spelling into a denial.
    expect(a.allows('Write', { file_path: '/tmp/outpost-review-7.json' })).toBe(true);
    expect(a.allows('Write', { file_path: '/tmp/nested/dir/out.json' })).toBe(true);
    expect(a.allows('Edit', { file_path: '/tmp/outpost-review-7.json' })).toBe(true);
    expect(bash(a, 'ls > /tmp/out.txt')).toBe(true);
  });

  it('keeps refusing plain .. traversal', () => {
    expect(a.allows('Write', { file_path: '/tmp/../etc/crontab' })).toBe(false);
  });
});
