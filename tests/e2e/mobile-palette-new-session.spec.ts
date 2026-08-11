import { mkdirSync } from 'node:fs';
import { test, expect } from './harness/browser.js';

const TEST_CWD = '/tmp/outpost-e2e-mobile-palette';

// The ⌘K palette is the ONLY way to start a session on mobile (the FAB opens it),
// and it routes via nav.select('sessions', id) — which mobile-shell intercepts and
// re-enters through app.js's openSession() with nothing but the id. Every other
// e2e drives __outpostOpenSession({id, cwd}) directly, so that re-entry path is
// untested; this spec covers it end to end at a mobile viewport.
test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('a session launched from the mobile palette carries its cwd to the daemon', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/projects`, { data: { cwd: TEST_CWD } });
  if (!res.ok()) throw new Error(`POST /api/projects failed: ${res.status()}`);
  await outpostPage.evaluate(async () => {
    // @ts-expect-error — globalThis helper from app.js test instrumentation
    await globalThis.__outpostRefreshSessions?.();
  });

  await outpostPage.locator('#m-fab').click();
  await outpostPage.locator('.search-row', { hasText: TEST_CWD }).first().click();
  await outpostPage.locator('#p-prompt').fill('hello from the palette');
  await outpostPage.locator('.p-launch-btn[data-launch="session"]').click();

  await expect(outpostPage.locator('#composer')).toBeVisible({ timeout: 10_000 });
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    undefined,
    { timeout: 10_000 },
  );

  const transcript = outpostPage.locator('.sv-transcript-inner');
  await expect(transcript).not.toContainText('cwd required');
  // The optimistic prompt must survive: an existing-session open re-seeds the
  // transcript from disk, which for a brand-new session is empty.
  await expect(transcript).toContainText('hello from the palette');
});
