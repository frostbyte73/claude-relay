import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-bash-write.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-plan-mode';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('plan mode denies a Bash call without enqueuing an approval', async ({ daemon, outpostPage }) => {
  // Open a session.
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Wait for the session WebSocket to be fully open. The composer renders before the
  // WS finishes its handshake, so we poll data-conn (set by updateConnIndicator() in
  // app.js) until it shows 'connected'. This ensures state.ws.readyState === OPEN.
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    undefined,
    { timeout: 10_000 },
  );

  // Switch this session to plan mode via the in-session toolbar's mode select (the
  // actual per-session control — the Settings surface's segmented control only seeds
  // NEW sessions launched through the ⌘K palette). The select's change handler pushes
  // approval_mode_set immediately; wait for the daemon's echo before sending.
  await outpostPage.locator('.sv-mode-select').selectOption('plan');
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostGetState?.()?.approvalMode === 'plan',
    undefined,
    { timeout: 10_000 },
  );

  // Now trigger the tool call. Plan mode should deny it server-side; mock claude emits
  // a synthetic deny tool_result.
  await composer.click();
  await outpostPage.keyboard.type('please rm');
  await outpostPage.keyboard.press('Enter');

  // Verify no pending approval was ever enqueued — plan mode short-circuits before the queue.
  await outpostPage.waitForTimeout(500);
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect((await res.json()).pending).toHaveLength(0);

  // No approval button surfaced because no card was created.
  await expect(outpostPage.locator('button.approve')).toHaveCount(0);
});
