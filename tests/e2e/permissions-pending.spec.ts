import { test, expect, DEFAULT_FIXTURE } from './harness/browser.js';

// The Pending classifications panel closes the "missing middle" from Ship 6: the improver (or
// an allowlist miss) proposes a verdict, but until now a human had to transcribe the denial's
// `id` by hand to act on it. What's worth pinning here is the whole loop — a seeded unresolved
// denial surfaces under its action with its command/suggestion/recurrence, the nav dot signals
// it before the panel is even open, and one of the two one-click verdicts (`fix-action`) both
// removes it from the panel and clears the dot. The other verdict, `promote`, is deliberately
// NOT exercised the same way here — it's the one that grants something, so it's gated behind a
// group picker rather than a single click (see components/permissions/pending.js).

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

test('a seeded unresolved denial appears under its action; Fix the action clears it and the nav dot', async ({ outpostPage }) => {
  await outpostPage.locator('.o-sidebar-item[data-surface="settings"]').click();

  // The dot lights up from the seeded denial before Permissions is even opened.
  await expect(outpostPage.locator('.settings-nav-item[data-key="permissions"] .settings-warn-dot'))
    .toBeVisible({ timeout: 10_000 });

  await outpostPage.locator('.settings-nav-item[data-key="permissions"]').click();

  const batch = outpostPage.locator(`.perm-pending-batch[data-action="${SEEDED_ACTION}"]`);
  await expect(batch).toBeVisible({ timeout: 10_000 });

  const row = batch.locator('.perm-pending-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('echo seeded-denial');
  await expect(row).toContainText('^echo seeded-denial$');
  await expect(row).toContainText('× 2');

  await row.locator('.perm-pending-fix').click();

  await expect(outpostPage.locator('.perm-pending-batch')).toHaveCount(0, { timeout: 10_000 });
  await expect(outpostPage.locator('.perm-pending-denials')).toContainText('No unresolved denials.');
  await expect(outpostPage.locator('.settings-nav-item[data-key="permissions"] .settings-warn-dot'))
    .toHaveCount(0, { timeout: 10_000 });
});
