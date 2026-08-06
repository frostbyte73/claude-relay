import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-edit.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-accept-edits';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('accept-edits ON: Edit tool flows through without manual approval', async ({ daemon, outpostPage }) => {
  // Open a new session.
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Wait for the WS to come up, then switch this session to accept-edits via the
  // in-session toolbar's mode select (the actual per-session control — the Settings
  // surface's "Model defaults" segmented control only seeds NEW sessions launched
  // through the ⌘K palette, not a session opened directly via the test harness).
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    undefined,
    { timeout: 10_000 },
  );
  await outpostPage.locator('.sv-mode-select').selectOption('accept-edits');
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostGetState?.()?.approvalMode === 'accept-edits',
    undefined,
    { timeout: 10_000 },
  );

  await composer.click();
  await outpostPage.keyboard.type('rename foo to bar in a.txt');
  await outpostPage.keyboard.press('Enter');

  // Final text appears (means Edit was auto-allowed and fixture continued past tool_result).
  await expect(outpostPage.getByText('edit applied')).toBeVisible({ timeout: 10_000 });

  // No leftover pending approvals.
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect((await res.json()).pending).toHaveLength(0);
});
