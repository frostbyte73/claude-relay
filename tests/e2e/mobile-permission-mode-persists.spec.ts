import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_CWD = '/tmp/outpost-e2e-mobile-mode-persist';

// Mobile reads the top-level `s.approvalMode` mirror (mobile-header.js), so this
// must run at a mobile-sized viewport to exercise the buggy path — the desktop
// session-view reads the per-tab slice and never goes through openSession().
test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('re-opening a session on mobile preserves its permission mode', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    undefined,
    { timeout: 10_000 },
  );

  // Switch this session to accept-edits via the mobile header's mode chip.
  await outpostPage.locator('#header-mode-chip').click();
  await outpostPage.locator('.mode-popover-item[data-mode="accept-edits"]').click();

  // Confirm the mode landed (optimistic mirror + daemon echo).
  await outpostPage.waitForFunction(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostGetState?.()?.approvalMode === 'accept-edits',
    undefined,
    { timeout: 10_000 },
  );

  const sessionId = await outpostPage.evaluate(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => globalThis.__outpostGetState?.()?.currentSessionId as string,
  );
  expect(sessionId).toBeTruthy();

  // Re-open the SAME session — the exact call mobile-shell makes when the user
  // taps back into a session (openSession, no cwd → existing-session path).
  await outpostPage.evaluate((id) => {
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    globalThis.__outpostOpenSession?.({ id });
  }, sessionId);

  // The mode must survive the re-open. Before the fix, openSession stamped a
  // hardcoded 'ask' onto the mirror and the reused socket never re-broadcast the
  // real mode to heal it, so this stuck on 'ask'.
  await expect.poll(
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    () => outpostPage.evaluate(() => globalThis.__outpostGetState?.()?.approvalMode),
    { timeout: 4_000 },
  ).toBe('accept-edits');
});

test('bypass-confirm refresh keeps the mode popover on-screen', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  await outpostPage.locator('#header-mode-chip').click();
  const popover = outpostPage.locator('#mode-popover');
  await expect(popover).toBeVisible();

  // Tapping Bypass rebuilds the popover into its "Tap again to confirm" state.
  // The rebuilt popover must retain its off-screen correction — before the fix
  // it snapped to `left: 0` and hung half off the right edge.
  await outpostPage.locator('.mode-popover-item[data-mode="bypass"]').click();
  await expect(
    popover.locator('.mode-popover-item[data-mode="bypass"] .mode-popover-name'),
  ).toHaveText(/Tap again to confirm/);

  const overflow = await popover.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { right: r.right, viewport: window.innerWidth };
  });
  expect(overflow.right).toBeLessThanOrEqual(overflow.viewport);
});
