import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-allow.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-bypass-mode';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('bypass mode allows mcp__incident-io__incident_update without any approval card', async ({ daemon, outpostPage }) => {
  // Open a session.
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Wait for the WS to connect before sending (mirrors plan-mode.spec.ts).
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    { timeout: 10_000 }
  );

  // Switch this session to bypass via the in-session toolbar's mode select (the
  // actual per-session control — desktop's `<select>` applies a pick immediately,
  // no two-tap confirm; that confirm-tap dance is mobile-only, in the header chip's
  // popover). Then wait for the daemon to echo it back before sending.
  await outpostPage.locator('.sv-mode-select').selectOption('bypass');
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostGetState?.()?.approvalMode === 'bypass',
    undefined,
    { timeout: 10_000 },
  );

  // Trigger the tool call.
  await composer.click();
  await outpostPage.keyboard.type('go');
  await outpostPage.keyboard.press('Enter');

  // The fixture's "done" assistant line appears AFTER the tool result. Its presence
  // proves the bypass-allowed tool ran end-to-end with no human gate.
  await expect(outpostPage.getByText(/^done$/)).toBeVisible({ timeout: 10_000 });

  // Sanity: no approval card was ever rendered.
  await expect(outpostPage.locator('button.approve')).toHaveCount(0);

  // Pending queue is empty.
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect((await res.json()).pending).toHaveLength(0);
});
