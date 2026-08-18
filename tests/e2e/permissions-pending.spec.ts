import { test, expect, DEFAULT_FIXTURE } from './harness/browser.js';

// The Pending classifications panel closes the "missing middle" from Ship 6: the improver (or
// an allowlist miss) proposes a verdict, but until now a human had to transcribe the denial's
// `id` by hand to act on it. What's worth pinning here is the whole loop — a seeded unresolved
// denial surfaces under its action with its command/suggestion/recurrence, the nav dot signals
// it before the panel is even open, and `never` (the one verdict that is purely a record)
// removes it from the panel and clears the dot in one click.
//
// The other two verdicts both have a side effect, and each gets its own test. `fix-action` is
// NOT a one-click dismissal — it opens a meta.build-action edit session and navigates there,
// which is the whole difference between it and the "Dismiss" button Ship 6 retired. `promote` is
// the one that grants something, so it's gated behind a group picker offering only the groups
// the action inherits (see components/permissions/pending.js).

const SEEDED_ACTION = 'write.linear-comment';

test.use({
  daemonOpts: {
    fixturePath: DEFAULT_FIXTURE,
    initialDenials: [
      {
        actionName: SEEDED_ACTION,
        toolName: 'Bash',
        toolInput: { command: 'echo seeded-denial' },
        suggested: { kind: 'bash', value: '^echo seeded-denial$' },
        count: 2,
      },
    ],
  },
});

// The failure mode this panel cannot afford: the fetch fails, nothing ever sets `pendingLoaded`,
// and the panel spins forever — on the only front door to a denial, with no error text and a
// dark nav dot to say anything is wrong. A failed load is itself a warning state.
test('a failed denials fetch renders the error and still lights the nav dot', async ({ outpostPage }) => {
  await outpostPage.route('**/api/permissions/pending', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'denials store unavailable' }));

  await outpostPage.locator('.o-sidebar-item[data-surface="settings"]').click();
  await expect(outpostPage.locator('.settings-nav-item[data-key="permissions"] .settings-warn-dot'))
    .toBeVisible({ timeout: 10_000 });

  await outpostPage.locator('.settings-nav-item[data-key="permissions"]').click();
  await expect(outpostPage.locator('.perm-pending-load-error')).toContainText('denials store unavailable',
    { timeout: 10_000 });
  await expect(outpostPage.locator('.settings-loading')).toHaveCount(0);
});

async function openPending(page: import('@playwright/test').Page) {
  await page.locator('.o-sidebar-item[data-surface="settings"]').click();

  // The dot lights up from the seeded denial before Permissions is even opened.
  await expect(page.locator('.settings-nav-item[data-key="permissions"] .settings-warn-dot'))
    .toBeVisible({ timeout: 10_000 });

  await page.locator('.settings-nav-item[data-key="permissions"]').click();
  const batch = page.locator(`.perm-pending-batch[data-action="${SEEDED_ACTION}"]`);
  await expect(batch).toBeVisible({ timeout: 10_000 });
  return batch;
}

test('a seeded unresolved denial appears under its action; Never clears it and the nav dot', async ({ outpostPage }) => {
  const batch = await openPending(outpostPage);

  const row = batch.locator('.perm-pending-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('echo seeded-denial');
  await expect(row).toContainText('^echo seeded-denial$');
  await expect(row).toContainText('× 2');

  await row.locator('.perm-pending-never').click();

  await expect(outpostPage.locator('.perm-pending-batch')).toHaveCount(0, { timeout: 10_000 });
  await expect(outpostPage.locator('.perm-pending-denials')).toContainText('No unresolved denials.');
  await expect(outpostPage.locator('.settings-nav-item[data-key="permissions"] .settings-warn-dot'))
    .toHaveCount(0, { timeout: 10_000 });
});

// "Fix the action" grants nothing, so its only justification for resolving the denial — which
// deletes it from the evidence meta.improve-actions reads — is that it queues the fix. If this
// click ever silently stays on the Permissions page again, it's a Dismiss button.
test('Fix the action opens the builder for that action instead of silently dismissing', async ({ outpostPage }) => {
  const batch = await openPending(outpostPage);
  await batch.locator('.perm-pending-row .perm-pending-fix').click();

  // Landed on the Library, on that action, with an edit session in flight.
  await expect(outpostPage.locator('.lib-wip-pill')).toBeVisible({ timeout: 20_000 });
  await expect(outpostPage.locator('.o-frame')).toContainText(SEEDED_ACTION);

  // And the denial really is resolved when we come back.
  await outpostPage.locator('.o-sidebar-item[data-surface="settings"]').click();
  await outpostPage.locator('.settings-nav-item[data-key="permissions"]').click();
  await expect(outpostPage.locator('.perm-pending-denials'))
    .toContainText('No unresolved denials.', { timeout: 10_000 });
});

// The picker must not offer a group the action doesn't inherit: promoting there widens that group
// for every action that does, resolves the denial, and leaves this call blocked.
test('the promote picker offers only the groups the action inherits', async ({ outpostPage }) => {
  const batch = await openPending(outpostPage);
  await batch.locator('.perm-pending-row .perm-pending-promote-btn').click();

  const select = batch.locator('.perm-pending-group-select');
  await expect(select).toBeVisible({ timeout: 10_000 });
  const offered = await select.locator('option:not([value=""])').evaluateAll(
    (els) => els.map((e) => (e as HTMLOptionElement).value));

  // write.linear-comment declares core + pull + push (its SKILL.md frontmatter).
  expect(offered.length).toBeGreaterThan(0);
  expect(offered).not.toContain('edit');
  await expect(batch.locator('.perm-pending-inherit-note')).toContainText(SEEDED_ACTION);
});
