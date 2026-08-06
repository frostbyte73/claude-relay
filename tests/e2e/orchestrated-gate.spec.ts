import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';
import { startDaemon, type DaemonHandle } from './harness/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'simple-text-response.jsonl');
const SEED_JSONL = readFileSync(resolvePath(__dirname, 'fixtures', 'seeded-session.jsonl'), 'utf8');

const JOB_ID = 'orc-job-1';
const STEP_ID = 'orc-step-1';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const DRAFT = '## Merge plan\n\nRun `gh pr merge --squash` on **PR #12**.\n';
const QUESTION = 'Merge this PR now?';

// A JobRecord (src/work/work-types.ts) with one orchestrated step parked in
// `gate_pending_approval` — where a controller lands after a `gate` move, holding the
// move it wants to make until the user approves or declines. The step carries a
// sessionId so the engine treats the controller as already spawned and leaves it parked
// (orchestratedHandler.decide only spawns when there's no session, and shouldDeliver
// keeps a gated step the user's turn while its inbox is empty).
function seedJob(repoCwd: string, branch: string) {
  const now = Date.now();
  return {
    id: JOB_ID,
    source: 'manual',
    title: 'Ship the homepage widget',
    description: '',
    state: 'executing',
    steps: [
      {
        id: STEP_ID,
        type: 'orchestrated',
        controller: 'code.orchestrate-pr',
        title: 'Implement homepage widget',
        description: '',
        workspace: { kind: 'writable', repoCwd, branch },
        goal: 'Add a widget to the homepage',
        inputs: { approach: 'Add a component and wire it into the layout.' },
        phase: 'pr_open',
        state: 'gate_pending_approval',
        gate: {
          draft: DRAFT,
          question: QUESTION,
          requestedAt: now,
          deferredMove: { kind: 'resolve', output: 'Merged PR #12.' },
        },
        sessionId: SESSION_ID,
        dispatches: [
          { id: 'd1', action: 'code.implement', brief: 'Build the widget', status: 'done', attempts: 1 },
        ],
        inbox: [],
        roundsSpent: 3,
        consecutiveSelfRounds: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

const seededTest = test.extend<{ seedRepo: string; daemon: DaemonHandle }>({
  seedRepo: async ({}, use) => {
    const repo = mkdtempSync(join(tmpdir(), 'outpost-e2e-orcgate-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await use(repo);
  },
  daemon: async ({ seedRepo }, use) => {
    const handle = await startDaemon({
      fixturePath: FIXTURE,
      initialProjects: [{ cwd: seedRepo, sessions: [{ id: SESSION_ID, jsonl: SEED_JSONL }] }],
      initialJobs: [seedJob(seedRepo, 'outpost/orc-step-1')],
    });
    await use(handle);
    await handle.stop();
  },
});

async function openJob(outpostPage: import('@playwright/test').Page): Promise<void> {
  await outpostPage.locator('.o-sidebar-item[data-surface="tracked"]').click();
  await outpostPage.locator(`.lr-row[data-job-id="${JOB_ID}"]`).click();
  await expect(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`)).toBeVisible({ timeout: 10_000 });
}

async function fetchStep(outpostPage: import('@playwright/test').Page, daemon: DaemonHandle): Promise<any> {
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/work/jobs/${JOB_ID}`);
  const data = await res.json();
  return data.job.steps.find((s: any) => s.id === STEP_ID);
}

seededTest('renders the controller, phase, dispatches and the gate draft as separate rows', async ({ outpostPage }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);
  await expect(card).toBeVisible();

  // Row 1: controller chip + phase chip — never crammed onto the step's header line.
  await expect(card.locator('.orc-chips .type-mono')).toHaveText('orchestrate-pr');
  await expect(card.locator('.orc-chips .o-pill')).toHaveText('PR open');

  // Dispatch list, with the child action's own name and status.
  const dispatch = card.locator('.orc-dispatch');
  await expect(dispatch).toHaveCount(1);
  await expect(dispatch.locator('.type-mono')).toHaveText('implement');
  await expect(dispatch.locator('.o-pill')).toHaveText('done');
  await expect(dispatch.locator('.orc-dispatch-brief')).toHaveText('Build the widget');

  // Gate row: the question heads it, the drafted move renders as markdown below.
  await expect(card.locator('.tl-gate-head')).toContainText(QUESTION);
  await expect(card.locator('.tl-gate-body')).toContainText('Merge plan');
  await expect(card.locator('.tl-gate-body strong')).toHaveText('PR #12');
});

seededTest('Approve runs the move the controller gated', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);

  await card.locator('[data-orc-action="approve-gate"]').click();

  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).state, { timeout: 5_000 }).toBe('resolved');
  expect((await fetchStep(outpostPage, daemon)).gate).toBeUndefined();
  // The gate controls disappear once the step has moved on.
  await expect(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] [data-orc-action="approve-gate"]`)).toHaveCount(0);
});

seededTest('Propose changes reveals a composer and declines the gate with feedback', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);

  const composer = card.locator('[data-composer="orc-gate-feedback"]');
  await expect(composer).toBeHidden();
  await card.locator('[data-orc-action="toggle-gate-feedback"]').click();
  await expect(composer).toBeVisible();

  await composer.locator('textarea').fill('Wait for the release branch to cut.');
  await composer.locator('[data-orc-action="submit-gate-feedback"]').click();

  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).gateFeedback, { timeout: 5_000 })
    .toEqual(['Wait for the release branch to cut.']);
  const step = await fetchStep(outpostPage, daemon);
  expect(step.gate).toBeUndefined();
  expect(step.gateApproved).toBeUndefined();
  await expect(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] [data-orc-action="approve-gate"]`)).toHaveCount(0);
});

seededTest('the message composer wakes the controller with a user message', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);

  const composer = card.locator('[data-composer="orc-message"]');
  await composer.locator('textarea').fill('Rebase onto main first.');
  await composer.locator('[data-orc-action="send-message"]').click();

  // A message to a gated step is delivered rather than queued (shouldDeliver treats a
  // user message as permission to take the turn back), so it lands in lastDelivered.
  await expect.poll(async () => {
    const s = await fetchStep(outpostPage, daemon);
    return [...(s.inbox ?? []), ...(s.lastDelivered ?? [])]
      .filter((i: any) => i.kind === 'user-message').map((i: any) => i.body);
  }, { timeout: 5_000 }).toEqual(['Rebase onto main first.']);
});
