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

const PROBE_RULE = '^cowsay( .*)?$';

// Unlike the runtime dir, config/permission-groups.json is the checkout's own file and an
// accepted save really writes it — so this test cleans up after itself even when it fails,
// or a leftover probe rule would follow the checkout around forever.
async function dropProbeRule(daemon: { baseUrl: string }, page: Page): Promise<void> {
  const res = await page.request.get(`${daemon.baseUrl}/api/permission-groups`);
  const group = (await res.json()).groups.find((g: { name: string }) => g.name === 'read');
  if (!group?.alwaysAllowBashPatterns.some((p: string) => p.includes('cowsay'))) return;
  await page.request.put(`${daemon.baseUrl}/api/permission-groups/read`, {
    data: {
      group: { ...group, alwaysAllowBashPatterns: group.alwaysAllowBashPatterns.filter((p: string) => !p.includes('cowsay')) },
      rationale: 'e2e cleanup',
    },
  });
}

// The other half of the door: an accepted rule has to land, and the page has to repaint from
// what the daemon persisted rather than from the body it just sent.
test('an accepted rule is added and removed through the group editor', async ({ daemon, outpostPage }) => {
  outpostPage.on('dialog', (d) => void d.accept());
  await dropProbeRule(daemon, outpostPage);
  try {
    await openPermissions(outpostPage);
    const card = await expandRead(outpostPage);

    await card.locator('.permgroup-kind[data-kind="bash"] .permgroup-add').click();
    await card.locator('.permgroup-rule-input').fill(PROBE_RULE);
    await card.locator('.permgroup-rule-reason').fill('e2e round-trip');
    await card.locator('.permgroup-save').click();

    const added = card.locator('.permgroup-rule', { hasText: PROBE_RULE });
    await expect(added).toHaveCount(1, { timeout: 10_000 });

    // It came back from GET /api/permission-groups, not from local state.
    const groups = await (await outpostPage.request.get(`${daemon.baseUrl}/api/permission-groups`)).json();
    const read = groups.groups.find((g: { name: string }) => g.name === 'read');
    expect(read.alwaysAllowBashPatterns).toContain(PROBE_RULE);

    await added.locator('.permgroup-remove').click();
    await expect(card.locator('.permgroup-rule', { hasText: PROBE_RULE })).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await dropProbeRule(daemon, outpostPage);
  }
});

test('only the gated group is marked gated', async ({ outpostPage }) => {
  await openPermissions(outpostPage);
  await expect(outpostPage.locator('.permgroup-card[data-group="push"] .permgroup-gated')).toBeVisible();
  await expect(outpostPage.locator('.permgroup-card[data-group="read"] .permgroup-gated')).toHaveCount(0);
});
