import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');

let testRepo: string;
let nonRepo: string;

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeEach(() => {
  testRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-uirepo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', testRepo]);
  execFileSync('git', ['-C', testRepo, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', testRepo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', testRepo, 'commit', '--allow-empty', '-q', '-m', 'init']);
  execFileSync('git', ['-C', testRepo, 'branch', 'feature-x']);
  nonRepo = mkdtempSync(join(tmpdir(), 'outpost-e2e-uinotrepo-'));
});

async function registerProject(outpostPage: import('@playwright/test').Page, daemon: DaemonHandle, cwd: string): Promise<void> {
  await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd } });
  await outpostPage.evaluate(async () => {
    // @ts-expect-error
    await globalThis.__outpostRefreshSessions?.();
  });
}

// Drives the real ⌘K palette: open it, search for `cwd`, and pick the one
// matching row — leaves the palette on step 2 ("What") with that cwd selected.
// The persistent topbar (and its #tb-cmdbar trigger) was removed by the shell
// redesign (see css/shell-desktop.css's header comment) — ⌘K is the only way
// to open the palette on desktop now, so drive it via the real shortcut
// (shell.togglePalette, default binding mod+k) rather than a click.
async function openPaletteToCwd(outpostPage: import('@playwright/test').Page, cwd: string): Promise<void> {
  await outpostPage.keyboard.press('Meta+k');
  await expect(outpostPage.locator('.o-palette')).toBeVisible();
  await outpostPage.locator('#p-search-input').fill(cwd);
  const row = outpostPage.locator('.search-row', { hasText: cwd });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(outpostPage.locator('#p-cwd-chip')).toBeVisible();
}

// Desktop hides the step-2 Send/Track/Schedule buttons (palette.css: `.p-launch-row
// { display: none; }`, only shown on `data-layout="mobile"`) — desktop drives launch
// via the ⌘↵ / ⌘⇧↵ / ⇧⌘S keyboard shortcuts instead, so that's what a desktop-viewport
// test has to press. palette.launchSession's default binding is mod+enter, which
// normalizes to metaKey (not ctrlKey) on a Mac platform — Playwright's Chromium
// reports navigator.platform as "MacIntel" here, so this must be Meta, not Control.
async function launchSessionViaKeyboard(outpostPage: import('@playwright/test').Page): Promise<void> {
  await outpostPage.locator('#p-prompt').focus();
  await outpostPage.keyboard.press('Meta+Enter');
}

async function waitForWorktreeRecord(daemon: { runtimeDir: string }, timeoutMs = 5000): Promise<{
  sessionId: string; worktreePath: string; branch: string;
}> {
  const indexPath = join(daemon.runtimeDir, 'worktrees', 'index.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(indexPath)) {
      const { readFileSync } = await import('node:fs');
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf8'));
        const live = (data.records as Array<{ sessionId: string; worktreePath: string; branch: string; archivedAt?: number; createdAt: number }>)
          .filter((r) => !r.archivedAt && r.worktreePath)
          .sort((a, b) => b.createdAt - a.createdAt);
        if (live.length > 0) return live[0]!;
      } catch { /* in-flight write — retry */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no live worktree record found');
}

test('palette worktree toggle + branch select spawns a worktree on the selected branch', async ({ daemon, outpostPage }) => {
  await registerProject(outpostPage, daemon, testRepo);
  await openPaletteToCwd(outpostPage, testRepo);

  // "As" row only renders for a git repo — flip it to "New worktree".
  const toggle = outpostPage.locator('.worktree-toggle');
  await expect(toggle).toBeVisible();
  await outpostPage.locator('.worktree-seg[data-mode="worktree"]').click();

  const branchSelect = outpostPage.locator('.branch-select');
  await expect(branchSelect).toBeVisible();
  await expect(branchSelect).toBeEnabled();
  // Populates async via /api/projects/:sanitized/branches.
  await expect.poll(async () => branchSelect.locator('option').count(), { timeout: 5_000 }).toBeGreaterThan(1);
  await expect(branchSelect).toHaveValue('main'); // default branch preselected
  await branchSelect.selectOption('feature-x');

  await launchSessionViaKeyboard(outpostPage);
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  const rec = await waitForWorktreeRecord(daemon);
  expect(rec.worktreePath).toContain('worktrees/');
  const headBranch = execFileSync('git', ['-C', testRepo, 'worktree', 'list', '--porcelain']).toString();
  expect(headBranch).toContain(rec.branch);
  // Branch was created off feature-x — the worktree's parent rev should equal feature-x's rev.
  const featureRev = execFileSync('git', ['-C', testRepo, 'rev-parse', 'feature-x']).toString().trim();
  const wtRev = execFileSync('git', ['-C', rec.worktreePath, 'rev-parse', 'HEAD']).toString().trim();
  expect(wtRev).toBe(featureRev);
});

test('non-git project shows no worktree toggle in the palette and spawns a shared-cwd session', async ({ daemon, outpostPage }) => {
  await registerProject(outpostPage, daemon, nonRepo);
  await openPaletteToCwd(outpostPage, nonRepo);

  await expect(outpostPage.locator('.worktree-toggle')).toHaveCount(0);
  await expect(outpostPage.locator('.branch-select')).toHaveCount(0);

  await launchSessionViaKeyboard(outpostPage);
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // No worktree record should have been created.
  await outpostPage.waitForTimeout(500);
  const wtRoot = join(daemon.runtimeDir, 'worktrees');
  let entries: string[] = [];
  try { entries = readdirSync(wtRoot).filter((n) => n !== 'index.json'); } catch { /* dir absent — fine */ }
  expect(entries).toEqual([]);
});

// Build a minimal valid JSONL so the session shows up in the project list. SessionStore
// extracts the cwd from the first valid JSONL line (firstCwdInJsonl), so the line MUST
// include a `cwd` field — otherwise the project never registers.
function seedJsonl(id: string, cwd: string): string {
  return JSON.stringify({
    type: 'summary',
    sessionId: id,
    cwd,
    timestamp: new Date(Date.now()).toISOString(),
    summary: 'seeded worktree session',
  }) + '\n';
}

const SEED_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SEED_BRANCH = 'outpost/11111111';

const seededTest = test.extend<{ seedRepo: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-uirepo-seed-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const wtPath = join(seedRepo, '.outpost-e2e-wt');
    execFileSync('git', ['-C', seedRepo, 'worktree', 'add', '-b', SEED_BRANCH, wtPath, 'main']);
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [
        { cwd: wtPath, sessions: [{ id: SEED_SESSION_ID, jsonl: seedJsonl(SEED_SESSION_ID, wtPath) }] },
      ],
      initialWorktrees: [
        { sessionId: SEED_SESSION_ID, projectCwd: seedRepo, worktreePath: wtPath, branch: SEED_BRANCH, baseBranch: 'main' },
      ],
    });
    await use(handle);
    await handle.stop();
  },
});

seededTest('archiving a worktree session via the session header menu removes the worktree and the row', async ({ seedRepo, outpostPage }) => {
  const wtPath = join(seedRepo, '.outpost-e2e-wt');
  outpostPage.on('dialog', (d) => { void d.accept(); });

  await outpostPage.locator('.o-sidebar-item[data-surface="sessions"]').click();
  const row = outpostPage.locator(`.sess-card[data-session-id="${SEED_SESSION_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });

  // Archive is a top-level header button, not a ⋯ menu item — the overflow menu
  // keeps only "Open diff" + the destructive "Delete" (session-view/index.js's
  // headerMenuItemsHtml comment: "Archive is a top-level header button (see
  // .sv-header-archive), not a menu item").
  await outpostPage.locator('.sv-header-archive').click();

  await expect.poll(() => existsSync(wtPath), { timeout: 5_000 }).toBe(false);
  const branches = execFileSync('git', ['-C', seedRepo, 'branch', '--list', SEED_BRANCH]).toString();
  expect(branches).not.toContain(SEED_BRANCH);

  // Archived sessions never show in this surface's list (no show-archived
  // toggle here — that's the sessions list's job, unlike the pre-redesign
  // per-project accordion) — the row just disappears.
  await outpostPage.locator('.o-sidebar-item[data-surface="sessions"]').click();
  await expect(row).toHaveCount(0);
});
