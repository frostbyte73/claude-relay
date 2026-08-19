import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './harness/browser.js';

// The proposal route lives on the hook server (loopback + per-launch secret), whose
// port and secret the daemon writes to daemon-mcp.json for spawned sessions to read.
function hookAccess(runtimeDir: string): { baseUrl: string; secret: string } {
  const cfg = JSON.parse(readFileSync(join(runtimeDir, 'daemon-mcp.json'), 'utf8'));
  const server = cfg.mcpServers.outpost;
  return {
    baseUrl: String(server.url).replace(/\/mcp$/, ''),
    secret: server.headers['X-Daemon-Auth'],
  };
}

test('an action proposal appears under Decide without a reload', async ({ daemon, outpostPage }) => {
  await outpostPage.locator('.o-sidebar-item[data-surface="cockpit"]').click();
  await expect(outpostPage.locator('.cockpit-quiet')).toBeVisible();

  const start = await outpostPage.request.post(
    `${daemon.baseUrl}/api/actions/code.implement/edit`,
    { data: { feedback: 'tighten the self-review step' } },
  );
  expect(start.ok()).toBe(true);
  const { sessionId } = await start.json();

  const hook = hookAccess(daemon.runtimeDir);
  const posted = await outpostPage.request.post(`${hook.baseUrl}/work/action-proposal`, {
    headers: { 'x-daemon-auth': hook.secret, 'content-type': 'application/json' },
    data: {
      sessionId,
      actionName: 'code.implement',
      summary: 'Tighten the self-review step',
      skillMdAfter: '# code.implement\n\nRevised body.\n',
    },
  });
  expect(posted.ok()).toBe(true);

  // No reload anywhere above — the proposal has to arrive over the WS broadcast.
  const row = outpostPage.locator('[data-group="decide"] .o-row').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('code.implement');
  await expect(outpostPage.locator('.cockpit-quiet')).toBeHidden();

  await row.click();
  await expect(outpostPage.locator('.lib-wip-pill')).toHaveText('review');

  // A revision is a change: the card shows the diff, never the whole proposed SKILL.md
  // the way it used to.
  const diff = outpostPage.locator('.lib-edit-card .lib-diff');
  await expect(diff.locator('summary')).toContainText('Proposed change');
  await diff.locator('summary').click();
  await expect(diff.locator('.lib-diff-line.add').filter({ hasText: 'Revised body.' })).toBeVisible();
  await expect(diff.locator('.lib-diff-line.del').first()).toBeVisible();
});

test('a new action proposal renders the file, not an all-plus diff', async ({ daemon, outpostPage }) => {
  const start = await outpostPage.request.post(`${daemon.baseUrl}/api/actions/new`, {
    data: { feedback: 'run the nightly export', category: 'read' },
  });
  expect(start.ok()).toBe(true);
  const { sessionId } = await start.json();

  const hook = hookAccess(daemon.runtimeDir);
  const posted = await outpostPage.request.post(`${hook.baseUrl}/work/action-proposal`, {
    headers: { 'x-daemon-auth': hook.secret, 'content-type': 'application/json' },
    data: {
      sessionId,
      actionName: 'read.nightly-export',
      summary: 'Fetch the nightly export',
      skillMdAfter: '---\nname: read.nightly-export\n---\n\nFetch it.\n',
    },
  });
  expect(posted.ok()).toBe(true);

  await outpostPage.locator('.o-sidebar-item[data-surface="cockpit"]').click();
  await outpostPage.locator('[data-group="decide"] .o-row').first().click();

  const block = outpostPage.locator('.lib-edit-card .lib-diff');
  await expect(block.locator('summary')).toContainText('New SKILL.md');
  await block.locator('summary').click();
  await expect(block.locator('.lib-diff-body')).toContainText('Fetch it.');
  await expect(block.locator('.lib-diff-line')).toHaveCount(0);
});
