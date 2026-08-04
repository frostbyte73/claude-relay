import type { Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';

async function gotoSchedules(page: Page): Promise<void> {
  await page.locator('.o-sidebar-item[data-surface="schedules"]').click();
}

// "+ New schedule" now opens a prompt box (prompt-first authoring); manual
// card-by-card authoring lives behind its "Start blank" affordance.
async function startBlankDraft(page: Page): Promise<void> {
  await page.locator('.sched-new-btn').click();
  await page.locator('.sched-new-blank').click();
}

test('creating a new schedule opens a draft with a disabled enable switch', async ({ outpostPage }) => {
  await gotoSchedules(outpostPage);
  await startBlankDraft(outpostPage);

  await expect(outpostPage.locator('.sched-detail-state.draft')).toHaveText('Draft');
  await expect(outpostPage.locator('input.sched-detail-title-input')).toHaveValue('');
  await expect(outpostPage.locator('.sched-draft-enable-slot .sched-switch')).toBeDisabled();
  await expect(outpostPage.locator('.sched-draft-save-paused')).toBeDisabled();
  await expect(outpostPage.locator('.sched-draft-hint')).toBeVisible();
});

test('completing name + trigger + what enables the switch, and Save paused persists a paused schedule', async ({ daemon, outpostPage }) => {
  await gotoSchedules(outpostPage);
  await startBlankDraft(outpostPage);

  await outpostPage.locator('input.sched-detail-title-input').fill('Weekly report');

  const triggerCard = outpostPage.locator('.sched-card-detail', { hasText: 'Trigger' });
  await triggerCard.locator('.t-expr').fill('0 9 * * 0');
  await triggerCard.locator('.sched-save').click();

  const whatCard = outpostPage.locator('.sched-card-detail', { hasText: 'What to run' });
  await whatCard.locator('.w-kind').selectOption('prompt');
  await whatCard.locator('.w-prompt').fill('Summarize the week');
  await whatCard.locator('.w-cwd').fill('/tmp/outpost-e2e-schedules');
  await whatCard.locator('.sched-save').click();

  await expect(outpostPage.locator('.sched-draft-hint')).toBeHidden();
  await expect(outpostPage.locator('.sched-draft-save-paused')).toBeEnabled();
  await expect(outpostPage.locator('.sched-draft-enable-slot .sched-switch')).toBeEnabled();

  await outpostPage.locator('.sched-draft-save-paused').click();

  await expect(outpostPage.locator('.sched-detail-state.paused')).toHaveText('Paused');
  await expect(outpostPage.locator('.sched-run-now')).toBeVisible();

  // Builtins are seeded at daemon startup (setup-schedules.ts) alongside this
  // user-created row, so scope the assertion to the non-builtin ones.
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/schedules`);
  const body = await res.json();
  const userSchedules = body.schedules.filter((s: { builtin?: boolean }) => !s.builtin);
  expect(userSchedules).toHaveLength(1);
  expect(userSchedules[0].name).toBe('Weekly report');
  expect(userSchedules[0].enabled).toBe(false);
});

test('clicking + New again while a draft is open resets to a fresh draft', async ({ outpostPage }) => {
  await gotoSchedules(outpostPage);
  await startBlankDraft(outpostPage);
  await outpostPage.locator('input.sched-detail-title-input').fill('First attempt');

  // The list column stays visible beside the draft; a second "+ New" must not
  // resurrect the half-filled draft (each launch gets a unique sentinel id).
  await startBlankDraft(outpostPage);
  await expect(outpostPage.locator('.sched-detail-state.draft')).toBeVisible();
  await expect(outpostPage.locator('input.sched-detail-title-input')).toHaveValue('');
});

test('navigating away from an incomplete draft persists nothing', async ({ daemon, outpostPage }) => {
  await gotoSchedules(outpostPage);
  await startBlankDraft(outpostPage);
  await outpostPage.locator('input.sched-detail-title-input').fill('Abandoned draft');

  // Only the name was filled — trigger and what are still missing, so leaving
  // the surface (and coming back) must not have persisted anything.
  await outpostPage.locator('.o-sidebar-item[data-surface="sessions"]').click();
  await gotoSchedules(outpostPage);

  // The frame tears down and rebuilds the detail pane on a surface switch, so
  // coming back to the (still-selected) draft sentinel repaints a fresh, empty draft.
  await expect(outpostPage.locator('.sched-detail-state.draft')).toBeVisible();
  await expect(outpostPage.locator('input.sched-detail-title-input')).toHaveValue('');

  // Builtins are seeded at daemon startup (setup-schedules.ts) — only the
  // user-created (non-builtin) count should stay at zero here.
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/schedules`);
  const body = await res.json();
  const userSchedules = body.schedules.filter((s: { builtin?: boolean }) => !s.builtin);
  expect(userSchedules).toHaveLength(0);
});

test('renaming an existing schedule via the header input persists across a reload', async ({ daemon, outpostPage }) => {
  const createRes = await outpostPage.request.post(`${daemon.baseUrl}/api/schedules`, {
    data: {
      name: 'Original name',
      enabled: false,
      trigger: { kind: 'cron', expr: '0 9 * * 0' },
      what: { kind: 'prompt', prompt: 'do the thing', cwd: '/tmp/outpost-e2e-schedules' },
    },
  });
  expect(createRes.ok()).toBe(true);

  await gotoSchedules(outpostPage);
  await outpostPage.locator('.sched-card', { hasText: 'Original name' }).click();

  const nameInput = outpostPage.locator('input.sched-detail-title-input');
  await expect(nameInput).toHaveValue('Original name');
  await nameInput.fill('Renamed schedule');
  await nameInput.press('Enter'); // blurs, firing the native `change` that commits the rename

  await expect(outpostPage.locator('.sched-card', { hasText: 'Renamed schedule' })).toBeVisible();

  await outpostPage.reload();
  await gotoSchedules(outpostPage);
  await outpostPage.locator('.sched-card', { hasText: 'Renamed schedule' }).click();
  await expect(outpostPage.locator('input.sched-detail-title-input')).toHaveValue('Renamed schedule');
});
