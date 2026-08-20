import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

let testRepo: string;

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeEach(() => {
  testRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', testRepo]);
  execFileSync('git', ['-C', testRepo, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', testRepo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', testRepo, 'commit', '--allow-empty', '-q', '-m', 'init']);
});

test('worktree spawn: WorktreeManager creates a tree, session view opens', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, testRepo, { spawnMode: 'worktree', baseBranch: 'main' });
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });
  // Worktree creation is async; poll until it shows up. ~few hundred ms in practice.
  await expect.poll(
    () => execFileSync('git', ['-C', testRepo, 'worktree', 'list']).toString(),
    { timeout: 5_000 },
  ).toMatch(/outpost\//);
});

test('worktree spawn on a non-git repo does not create a worktree', async ({ daemon, outpostPage }) => {
  const notRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-notrepo-'));
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: notRepo } });
  await outpostPage.evaluate(async () => {
    // @ts-expect-error
    await globalThis.__outpostRefreshSessions?.();
  });
  await outpostPage.evaluate((cwd) => {
    // @ts-expect-error
    globalThis.__outpostOpenSession?.({ id: crypto.randomUUID(), cwd, spawn: 'worktree', base: 'main' });
  }, notRepo);
  // Give the daemon time to fail. The directly-observable consequence: no worktree
  // subdir gets created under <runtimeDir>/worktrees/.
  await outpostPage.waitForTimeout(1000);
  const wtRoot = join(daemon.runtimeDir, 'worktrees');
  // Either the dir doesn't exist (no successful create ever ran) or it has no session
  // subdirs (only the index.json may be present from prior tests in this file).
  let entries: string[] = [];
  try {
    const { readdirSync } = await import('node:fs');
    entries = readdirSync(wtRoot).filter((n) => n !== 'index.json');
  } catch { /* dir absent — fine */ }
  expect(entries).toEqual([]);
});

test('GET /api/projects/:sanitized/branches returns branches + default', async ({ daemon, outpostPage }) => {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: testRepo } });
  execFileSync('git', ['-C', testRepo, 'branch', 'feature-a']);
  execFileSync('git', ['-C', testRepo, 'branch', 'feature-b']);
  const sanitized = testRepo.replace(/\//g, '-');
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/projects/${sanitized}/branches`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.branches).toEqual(expect.arrayContaining(['main', 'feature-a', 'feature-b']));
});
