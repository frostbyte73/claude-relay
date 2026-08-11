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
// `gate_pending_approval` — where a controller lands after a voluntary `gate` move (it's
// asking the user a question, not being forced to by policy). The step carries a
// sessionId so the engine treats the controller as already spawned and leaves it parked
// (orchestratedHandler.decide only spawns when there's no session, and shouldDeliver
// keeps a gated step the user's turn while its inbox is empty). Approving or declining
// does not replay any held move — it just delivers the verdict and resumes the controller,
// which decides its own next move from there.
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
  const step = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"]`);
  const card = step.locator('.orc-card');
  await expect(card).toBeVisible();

  // Row 1: the controller as a category-colored action chip + the phase chip — never
  // crammed onto the step's header line, and never printed twice (the header's
  // `.tl-skill` slot stays empty for an orchestrated step).
  await expect(card.locator('.orc-chips .type-mono')).toHaveText('orchestrate-pr');
  await expect(card.locator('.orc-chips .o-pill')).toHaveText('PR open');
  await expect(step.locator('.tl-skill')).toHaveCount(0);

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

seededTest('Approve clears the gate, records the verdict, and resumes the controller', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);

  await card.locator('[data-orc-action="approve-gate"]').click();

  // Approving a voluntary gate no longer replays a held move — the daemon's own next moves
  // are: clear the gate, mark it durably approved, deliver the verdict, and hand the turn
  // back to the controller. The controller then decides what to do next; the mock session
  // here just returns a plain text reply, so `running` (not `resolved`) is where it settles.
  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).state, { timeout: 5_000 }).toBe('running');
  const step = await fetchStep(outpostPage, daemon);
  expect(step.gate).toBeUndefined();
  expect(step.gateApproved).toBe(true);
  expect(step.lastDelivered?.some((i: any) => i.kind === 'gate-resolved' && i.approved === true)).toBe(true);
  // The gate controls disappear once the step has moved on.
  await expect(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] [data-orc-action="approve-gate"]`)).toHaveCount(0);
});

seededTest('Respond → Request changes declines the gate with feedback', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);

  const composer = card.locator('[data-composer="orc-gate-feedback"]');
  await expect(composer).toBeHidden();
  await card.locator('[data-orc-action="toggle-gate-feedback"]').click();
  await expect(composer).toBeVisible();
  // Neither verdict is reachable until there's something to say.
  await expect(composer.locator('[data-orc-action="submit-gate-feedback"]')).toBeDisabled();
  await expect(composer.locator('[data-orc-action="approve-gate-note"]')).toBeDisabled();

  await composer.locator('textarea').fill('Wait for the release branch to cut.');
  await composer.locator('[data-orc-action="submit-gate-feedback"]').click();

  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).gateFeedback, { timeout: 5_000 })
    .toEqual(['Wait for the release branch to cut.']);
  const step = await fetchStep(outpostPage, daemon);
  expect(step.gate).toBeUndefined();
  expect(step.gateApproved).toBeUndefined();
  await expect(outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] [data-orc-action="approve-gate"]`)).toHaveCount(0);
});

// The composer's only submit used to send `approved: false`, so approving words typed into it
// ("go ahead and run it") were recorded as a veto and the controller had to guess which half of
// the contradiction to believe. The verdict now comes from which button you press.
seededTest('Respond → Approve with this note approves AND keeps the note', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  const card = outpostPage.locator(`.tl-step[data-step-id="${STEP_ID}"] .orc-card`);

  await card.locator('[data-orc-action="toggle-gate-feedback"]').click();
  const composer = card.locator('[data-composer="orc-gate-feedback"]');
  await composer.locator('textarea').fill('go ahead and run it');
  await composer.locator('[data-orc-action="approve-gate-note"]').click();

  await expect.poll(async () => (await fetchStep(outpostPage, daemon)).gateApproved, { timeout: 5_000 }).toBe(true);
  const step = await fetchStep(outpostPage, daemon);
  expect(step.gateFeedback).toEqual(['go ahead and run it']);
  expect(step.gate).toBeUndefined();
  expect(step.lastDelivered?.some((i: any) => i.kind === 'gate-resolved' && i.approved === true)).toBe(true);
});

// The picker decides orchestrated-vs-action from the action's `kind`, which only the
// ActionRegistry catalog carries — reading the on-disk `actions` list instead silently
// produced an ordinary action step named after the controller, with no error.
seededTest('the action picker builds an orchestrated step when the picked action is a controller', async ({ outpostPage, daemon }) => {
  await openJob(outpostPage);
  await outpostPage.locator('[data-job-action="add-step-end"]').click();

  const dialog = outpostPage.locator('#action-picker-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#ap-search').fill('orchestrate-pr');
  await dialog.locator('.ap-row[data-name="code.orchestrate-pr"]').click();

  await dialog.locator('#ap-title').fill('Second PR');
  await dialog.locator('#ap-in-goal').fill('Ship the follow-up');
  await dialog.locator('[data-action="add"]').click();
  await expect(dialog).toHaveCount(0);

  const added = await outpostPage.request.get(`${daemon.baseUrl}/api/work/jobs/${JOB_ID}`)
    .then((r) => r.json())
    .then((d) => d.job.steps.find((s: any) => s.title === 'Second PR'));
  expect(added).toBeTruthy();
  expect(added.type).toBe('orchestrated');
  expect(added.controller).toBe('code.orchestrate-pr');
  expect(added.goal).toBe('Ship the follow-up');
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
