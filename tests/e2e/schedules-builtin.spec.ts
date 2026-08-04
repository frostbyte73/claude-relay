import type { Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';

// Builtin schedules are seeded by seedBuiltinSchedules() at daemon startup
// (src/schedules/setup-schedules.ts), so every e2e daemon already has them —
// no fixture seeding needed here.

async function gotoSchedules(page: Page): Promise<void> {
  await page.locator('.o-sidebar-item[data-surface="schedules"]').click();
}

test('a builtin schedule renders as a normal clickable card with a builtin badge', async ({ outpostPage }) => {
  await gotoSchedules(outpostPage);

  const card = outpostPage.locator('.sched-card', { hasText: 'Linear — assigned issues' });
  await expect(card).toBeVisible();
  await expect(card.locator('.sched-builtin-pill')).toHaveText('builtin');

  await card.click();
  await expect(outpostPage.locator('input.sched-detail-title-input')).toHaveValue('Linear — assigned issues');
});

test('a builtin schedule\'s trigger stays editable but its header has no Delete button', async ({ outpostPage }) => {
  await gotoSchedules(outpostPage);
  await outpostPage.locator('.sched-card', { hasText: 'Linear — assigned issues' }).click();

  const triggerCard = outpostPage.locator('.sched-card-detail', { hasText: 'Trigger' });
  await triggerCard.locator('.sched-edit-link').click();
  await expect(triggerCard.locator('.t-expr')).toBeVisible();

  // Desktop renders `.o-menu-body`'s buttons inline (display: contents) rather
  // than behind the `⋯` toggle, so Delete's absence is checkable directly.
  await expect(outpostPage.locator('.sched-delete')).toHaveCount(0);
  await expect(outpostPage.locator('.sched-toggle-pause')).toBeVisible();
});

test('a native-handler builtin renders its handler read-only, with no edit affordance', async ({ outpostPage }) => {
  await gotoSchedules(outpostPage);
  await outpostPage.locator('.sched-card', { hasText: 'PR watcher' }).click();

  const whatCard = outpostPage.locator('.sched-card-detail', { hasText: 'What to run' });
  await expect(whatCard.locator('.sched-edit-link')).toHaveCount(0);
  await expect(whatCard).toContainText('pr-watcher');
  await expect(whatCard.locator('select')).toHaveCount(0);
});

test('GET /api/schedules returns builtins inline under `schedules` with no `system` key', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/schedules`);
  const body = await res.json();
  expect(body.system).toBeUndefined();
  expect(Array.isArray(body.schedules)).toBe(true);
  expect(body.schedules.some((s: { builtin?: boolean }) => s.builtin)).toBe(true);
});
