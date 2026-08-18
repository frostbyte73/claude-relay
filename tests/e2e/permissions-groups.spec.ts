import { test, expect } from './harness/browser.js';
import type { Page } from '@playwright/test';

// The Permissions page is the sanctioned door that replaced the deleted "Allow" button, so
// the behaviour worth pinning is the refusal: a write-shaped rule aimed at a non-gated group
// must come back with the lint's OWN explanation attached to the row the user was editing,
// and must leave the group untouched on disk. A generic failure message here is what pushes
// people back to hand-editing config, which is how the holes this overhaul closed got in.

async function openPermissions(page: Page): Promise<void> {
  await page.locator('.o-sidebar-item[data-surface="settings"]').click();
  await page.locator('.settings-nav-item[data-key="permissions"]').click();
  await expect(page.locator('.permgroup-card[data-group="read"]')).toBeVisible({ timeout: 10_000 });
}

async function expandRead(page: Page) {
  const card = page.locator('.permgroup-card[data-group="read"]');
  if ((await card.getAttribute('data-expanded')) !== 'true') {
    await card.locator('.permgroup-hdr').click();
  }
  await expect(card.locator('.permgroup-body')).toBeVisible();
  return card;
}

test('a write-shaped edit to a non-gated group is refused with the lint message on the row', async ({ outpostPage }) => {
  await openPermissions(outpostPage);
  const card = await expandRead(outpostPage);

  const row = card.locator('.permgroup-rule[data-kind="bash"][data-index="0"]');
  const original = ((await row.locator('.permgroup-rule-value').textContent()) ?? '').trim();
  expect(original.length).toBeGreaterThan(0);

  await row.locator('.permgroup-edit').click();
  await row.locator('.permgroup-rule-input').fill('^git push ');
  await row.locator('.permgroup-save').click();

  const err = row.locator('.permgroup-rule-error');
  await expect(err).toBeVisible({ timeout: 10_000 });
  // Verbatim server text: "<rule>: permits the external write `git push ...` — a write rule
  // may only live in a gated group (push)".
  await expect(err).toContainText('^git push ');
  await expect(err).toContainText('permits the external write');
  await expect(err).toContainText('may only live in a gated group');

  // A refused rule reaches neither memory nor disk: after a full reload the group still
  // shows what it had before.
  await outpostPage.reload();
  await openPermissions(outpostPage);
  const reloaded = await expandRead(outpostPage);
  await expect(reloaded.locator('.permgroup-rule[data-kind="bash"][data-index="0"] .permgroup-rule-value'))
    .toHaveText(original);
  await expect(reloaded.locator('.permgroup-body')).not.toContainText('^git push ');
});

test('only the gated group is marked gated', async ({ outpostPage }) => {
  await openPermissions(outpostPage);
  await expect(outpostPage.locator('.permgroup-card[data-group="push"] .permgroup-gated')).toBeVisible();
  await expect(outpostPage.locator('.permgroup-card[data-group="read"] .permgroup-gated')).toHaveCount(0);
});
