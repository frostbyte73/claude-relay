import type { Page } from '@playwright/test';
import { test, expect } from './harness/browser.js';

// The prompt-first authoring loop drives a real meta.build-schedule Claude
// session, which can't run in the e2e daemon — so POST /api/schedules/new,
// /test and /redraft are stubbed here, and the builder's proposal (normally a
// `schedule_draft_ready` WS broadcast) is injected by driving schedulesStore
// .setDraft() directly, exactly as ws/dispatch.js would on the real frame.
// Save is NOT stubbed: it uses the real POST /api/schedules create path.

const SESSION_ID = 'sess-e2e-authoring';
const CWD = '/tmp/outpost-e2e-schedules';

const proposal1 = {
  name: 'Nightly cleanup',
  summary: 'Runs the cleanup script every Sunday at 9am.',
  trigger: { kind: 'cron', expr: '0 9 * * 0' },
  what: { kind: 'script', script: 'echo scheduled-cleanup', cwd: CWD, args: {} },
};
const proposal2 = {
  name: 'Nightly cleanup',
  summary: 'Redrafted after the test failed.',
  trigger: { kind: 'cron', expr: '0 9 * * 0' },
  what: { kind: 'script', script: 'echo fixed-cleanup', cwd: CWD, args: {} },
};

async function gotoSchedules(page: Page): Promise<void> {
  await page.locator('.o-sidebar-item[data-surface="schedules"]').click();
}

// Stand-in for the schedule_draft_ready WS broadcast: drive the same store
// mutation the dispatch handler would. Uses the app's own module instance
// (same resolved URL → same singleton store).
async function injectDraft(page: Page, sessionId: string, draft: unknown): Promise<void> {
  await page.evaluate(
    ({ sessionId, draft }) =>
      // @ts-expect-error — runtime-only served path (src/pwa is mounted at /); no TS types
      import('/state/schedules.js').then((m) => m.schedulesStore.setDraft(sessionId, draft)),
    { sessionId, draft },
  );
}

test('prompt-first authoring: prompt → draft → test → redraft → save', async ({ daemon, outpostPage }) => {
  let testFails = true;

  await outpostPage.route('**/api/schedules/new', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessionId: SESSION_ID }) }));

  await outpostPage.route('**/api/schedules/test', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(testFails ? { outcome: 'error', output: 'boom' } : { outcome: 'ok', output: 'all good' }),
    }));

  await outpostPage.route('**/redraft', (route) => route.fulfill({ status: 202, body: '' }));

  await gotoSchedules(outpostPage);

  // "+ New schedule" opens the prompt box.
  await outpostPage.locator('.sched-new-btn').click();
  await expect(outpostPage.locator('.sched-new-form')).toBeVisible();

  // Submitting the prompt spawns the (stubbed) builder and shows Drafting…
  await outpostPage.locator('.sched-new-prompt').fill('every Sunday at 9am run the cleanup script');
  await outpostPage.locator('.sched-new-create').click();
  await expect(outpostPage.locator('.sched-drafting')).toBeVisible();

  // The proposal (stubbed schedule_draft_ready) fills the trigger + what cards.
  await injectDraft(outpostPage, SESSION_ID, proposal1);
  await expect(outpostPage.locator('.sched-draft-caption')).toHaveText(proposal1.summary);
  const triggerCard = outpostPage.locator('.sched-card-detail', { hasText: 'Trigger' });
  await expect(triggerCard).toContainText('0 9 * * 0');
  const whatCard = outpostPage.locator('.sched-card-detail', { hasText: 'What to run' });
  await expect(whatCard).toContainText('echo scheduled-cleanup');

  // Test runs the script for real (stubbed to fail) → red panel + Redraft.
  await expect(whatCard.locator('.sched-test-btn')).toBeVisible();
  await whatCard.locator('.sched-test-btn').click();
  await expect(whatCard.locator('.sched-test-panel.error')).toBeVisible();
  await expect(whatCard.locator('.sched-test-out')).toHaveText('boom');
  await expect(whatCard.locator('.sched-redraft-btn')).toBeVisible();

  // Redraft feeds the error back; the builder's fresh proposal (stubbed) replaces
  // the draft — Test result clears, script updates.
  const redraftReq = outpostPage.waitForRequest('**/redraft');
  await whatCard.locator('.sched-redraft-btn').click();
  await redraftReq;
  testFails = false;
  await injectDraft(outpostPage, SESSION_ID, proposal2);
  await expect(whatCard).toContainText('echo fixed-cleanup');
  await expect(whatCard.locator('.sched-test-panel')).toBeHidden();

  // Re-test now passes → green panel, no Redraft.
  await whatCard.locator('.sched-test-btn').click();
  await expect(whatCard.locator('.sched-test-panel.ok')).toBeVisible();
  await expect(whatCard.locator('.sched-redraft-btn')).toHaveCount(0);

  // Save (real create path) persists a paused schedule and navigates to it.
  await outpostPage.locator('.sched-draft-save-paused').click();
  await expect(outpostPage.locator('.sched-detail-state.paused')).toHaveText('Paused');

  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/schedules`);
  const body = await res.json();
  const userSchedules = body.schedules.filter((s: { builtin?: boolean }) => !s.builtin);
  expect(userSchedules).toHaveLength(1);
  expect(userSchedules[0].name).toBe('Nightly cleanup');
  expect(userSchedules[0].what.script).toBe('echo fixed-cleanup');
  expect(userSchedules[0].enabled).toBe(false);
});
