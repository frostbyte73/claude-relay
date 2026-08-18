import { test, expect } from './harness/browser.js';
import type { Page } from '@playwright/test';

// The Grants block's inline edit is the honest half of its scope promise: a grant here is a
// real, persisted rule, but re-keying on edit (the id encodes the value) has to actually happen
// or the row silently starts addressing a dead id. The subtitle is the single most load-bearing
// sentence on the page — pinning its presence here, not just reading the source, is what stops
// a later refactor from quietly dropping it into a tooltip.
//
// It must also name the action-scope exception. The first version said "sessions and skills
// only" full stop, which was false about the `action · <name>` rows listed directly beneath it
// (scopesFor still consults actionsStore for an action-bound call) — so both halves are pinned.

async function openPermissions(page: Page): Promise<void> {
  await page.locator('.o-sidebar-item[data-surface="settings"]').click();
  await page.locator('.settings-nav-item[data-key="permissions"]').click();
  await expect(page.locator('.perm-grants-list')).toBeVisible({ timeout: 10_000 });
}

test('the grants block states its scope up front, including the action-scope exception', async ({ outpostPage }) => {
  await openPermissions(outpostPage);
  const subtitle = outpostPage.locator('.perm-grants-subtitle');
  await expect(subtitle).toContainText('sessions and skills only', { ignoreCase: true });
  await expect(subtitle).toContainText('does reach that one action', { ignoreCase: true });
});

test('editing a global grant inline re-keys the row and survives a reload', async ({ outpostPage }) => {
  await openPermissions(outpostPage);

  const row = outpostPage.locator('.allow-row[data-kind="bash"][data-editable="true"]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const originalId = await row.getAttribute('data-id');
  expect(originalId).toBeTruthy();

  const NEW_PATTERN = '^cowsay( .*)?$';
  await row.locator('.allow-edit').click();
  const input = row.locator('.allow-edit-input');
  await input.fill(NEW_PATTERN);
  await row.locator('.allow-save').click();

  const updated = outpostPage.locator('.allow-row', { hasText: NEW_PATTERN });
  await expect(updated).toBeVisible({ timeout: 10_000 });
  const newId = await updated.getAttribute('data-id');
  expect(newId).toBeTruthy();
  expect(newId).not.toBe(originalId);
  // The old id is dead — nothing on the page should still be addressing it.
  await expect(outpostPage.locator(`.allow-row[data-id="${originalId}"]`)).toHaveCount(0);

  await outpostPage.reload();
  await openPermissions(outpostPage);
  const reloaded = outpostPage.locator('.allow-row', { hasText: NEW_PATTERN });
  await expect(reloaded).toBeVisible({ timeout: 10_000 });
  await expect(reloaded).toHaveAttribute('data-id', newId!);
});

test('a refused edit renders the lint message on the row and leaves the original value', async ({ outpostPage }) => {
  await openPermissions(outpostPage);

  const row = outpostPage.locator('.allow-row[data-kind="bash"][data-editable="true"]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const original = ((await row.locator('.allow-row-pattern').textContent()) ?? '').trim();
  expect(original.length).toBeGreaterThan(0);

  await row.locator('.allow-edit').click();
  await row.locator('.allow-edit-input').fill('^git push ');
  await row.locator('.allow-save').click();

  const err = row.locator('.permgroup-rule-error');
  await expect(err).toBeVisible({ timeout: 10_000 });
  await expect(err).toContainText('permits the external write');

  await row.locator('.allow-cancel').click();
  await expect(row.locator('.allow-row-pattern')).toHaveText(original);
});
