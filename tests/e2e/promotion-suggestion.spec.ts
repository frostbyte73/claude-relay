import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openSessionAtCwd } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A read-shaped tool, deliberately: mcp__incident-io__incident_update is a genuine external
// write and Allowlist.addRule (assertNotWriteShaped, write-shape.ts) now refuses to persist it
// as an ungated rule. This spec is about the recurrence tracker's suggest-then-promote
// mechanic (any repeated call, regardless of shape) — RecurrenceTracker.suggestionFor has no
// write-shape awareness — so it needs a fixture tool addRule will actually accept once the
// suggestion is confirmed. Not mcp__incident-io__incident_show either: it's globally
// always-allowed by config/allowlist.default.json, so it would never reach the approval queue
// at all and no suggestion would ever form. docs_search isn't covered by any default
// always-allow pattern. Renamed repeat-mcp-write.jsonl -> repeat-mcp-read.jsonl to match.
const FIXTURE = resolvePath(__dirname, 'fixtures', 'repeat-mcp-read.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-promotion';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('3rd identical approval carries a suggestion in the approval_pending payload', async ({ daemon, outpostPage }) => {
  // Open session.
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    { timeout: 10_000 }
  );

  // Helper: send a user message and wait for the approval card to surface.
  async function triggerAndWaitForCard() {
    await composer.click();
    await outpostPage.keyboard.type('go');
    await outpostPage.keyboard.press('Enter');
    await expect(outpostPage.locator('button.approve')).toBeVisible({ timeout: 10_000 });
  }

  // Approval #1 — under threshold, suggestion should be null.
  await triggerAndWaitForCard();
  let body = await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json();
  expect(body.pending).toHaveLength(1);
  expect(body.pending[0].suggestion).toBeNull();
  await outpostPage.locator('button.approve').first().click();
  await expect.poll(
    async () => (await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json()).pending.length,
    { timeout: 5_000 }
  ).toBe(0);

  // Approval #2 — still under threshold.
  await triggerAndWaitForCard();
  body = await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json();
  expect(body.pending[0].suggestion).toBeNull();
  await outpostPage.locator('button.approve').first().click();
  await expect.poll(
    async () => (await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json()).pending.length,
    { timeout: 5_000 }
  ).toBe(0);

  // Approval #3 — still under threshold (need 3 prior approvals recorded to trigger suggestion).
  await triggerAndWaitForCard();
  body = await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json();
  expect(body.pending[0].suggestion).toBeNull();
  await outpostPage.locator('button.approve').first().click();
  await expect.poll(
    async () => (await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json()).pending.length,
    { timeout: 5_000 }
  ).toBe(0);

  // Approval #4 — at threshold (3-in-24h recorded). Suggestion should be present.
  await triggerAndWaitForCard();
  body = await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json();
  expect(body.pending[0].suggestion).not.toBeNull();
  expect(body.pending[0].suggestion.kind).toBe('mcp');
  expect(body.pending[0].suggestion.suggestedValue).toBe('^mcp__livekit-docs__docs_search$');
  expect(body.pending[0].suggestion.matchCount).toBeGreaterThanOrEqual(3);
  expect(body.pending[0].suggestion.triggerWindow).toBe('24h');
});

// The "Always allow" suggestion block is mobile-only (approval-card.js gates
// suggestionHtml on `mobile` — D7 ported it from the legacy mobile singleton
// without a desktop equivalent). Playwright's default viewport is desktop-sized
// (>1024px, see layout/index.js's DESKTOP_QUERY), so this test needs its own
// mobile-sized viewport to reach the feature it's exercising at all.
test.use({ viewport: { width: 390, height: 844 } });

test('clicking Always allow in the footer promotes the rule and approves the call', async ({ daemon, outpostPage }) => {
  await openSessionAtCwd(outpostPage, daemon, TEST_CWD);
  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    { timeout: 10_000 }
  );

  // Approve 3 times to seed the recurrence tracker (each approval is below threshold).
  for (let i = 0; i < 3; i++) {
    await composer.click();
    await outpostPage.keyboard.type('go');
    await outpostPage.keyboard.press('Enter');
    await expect(outpostPage.locator('button.approve')).toBeVisible({ timeout: 10_000 });
    await outpostPage.locator('button.approve').first().click();
    await expect.poll(
      async () => (await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json()).pending.length,
      { timeout: 5_000 }
    ).toBe(0);
  }

  // 4th approval should show the suggestion footer.
  await composer.click();
  await outpostPage.keyboard.type('go');
  await outpostPage.keyboard.press('Enter');
  await expect(outpostPage.locator('.suggestion-confirm')).toBeVisible({ timeout: 10_000 });

  // Click "Always allow" with the default scope (this project).
  await outpostPage.locator('.suggestion-confirm').first().click();

  // The current approval resolves automatically (pending queue empties).
  await expect.poll(
    async () => (await (await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`)).json()).pending.length,
    { timeout: 5_000 }
  ).toBe(0);

  // The project allowlist file was written with the suggested pattern.
  const expectedFile = join(daemon.runtimeDir, 'allowlists', `${TEST_CWD.replace(/\//g, '-')}.json`);
  expect(existsSync(expectedFile)).toBe(true);
  const cfg = JSON.parse(readFileSync(expectedFile, 'utf8'));
  expect(cfg.alwaysAllowMcpPatterns).toContain('^mcp__livekit-docs__docs_search$');
});
