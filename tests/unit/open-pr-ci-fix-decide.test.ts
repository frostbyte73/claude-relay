import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPrHandler } from '../../src/steps/open-pr.js';
import type { JobRecord, OpenPrStep, CiCheck } from '../../src/work/work-types.js';
import type { HandlerCtx } from '../../src/steps/types.js';

function ctx(): HandlerCtx {
  return { jobsDir: mkdtempSync(join(tmpdir(), 'orch-cifix-')), newId: () => 'id', now: () => 1 };
}

function checks(...specs: [string, CiCheck['state']][]): CiCheck[] {
  return specs.map(([name, state]) => ({ name, state }));
}

function step(overrides: Partial<OpenPrStep> = {}): OpenPrStep {
  return {
    id: 's1', title: 't', description: 'd', type: 'open-pr',
    workspace: { kind: 'writable', repoCwd: '/tmp', branch: 'feat/x' },
    goal: 'g', approach: 'a', state: 'pr_open', prState: 'open',
    createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function job(s: OpenPrStep): JobRecord {
  return { id: 'j1', source: 'manual', title: 't', description: 'd', state: 'executing', steps: [s], createdAt: 0, updatedAt: 0 };
}

describe('openPrHandler.decide CI auto-fix', () => {
  it('starts a fix when a settled failure has a fresh signature under the cap', () => {
    const s = step({ ciState: 'failure', ciChecks: checks(['lint', 'failure'], ['unit', 'success']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toEqual({ kind: 'start-ci-fix', jobId: 'j1', stepId: 's1' });
  });

  it('is idle while checks are still pending (not settled)', () => {
    const s = step({ ciState: 'failure', ciChecks: checks(['lint', 'failure'], ['unit', 'pending']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('is idle while a fix round is already in flight', () => {
    const s = step({ ciState: 'failure', ciFixing: true, ciChecks: checks(['lint', 'failure']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('notes exhaustion (not another fix) when the same signature recurs', () => {
    const s = step({ ciState: 'failure', ciFixAttempts: 1, ciFixLastSignature: 'lint',
      ciChecks: checks(['lint', 'failure']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toEqual({ kind: 'note-ci-fix-exhausted', jobId: 'j1', stepId: 's1' });
  });

  it('notes exhaustion when the attempt cap is reached even for a new signature', () => {
    const s = step({ ciState: 'failure', ciFixAttempts: 3, ciFixLastSignature: 'old',
      ciChecks: checks(['newcheck', 'failure']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toEqual({ kind: 'note-ci-fix-exhausted', jobId: 'j1', stepId: 's1' });
  });

  it('stays silent once it has already given up', () => {
    const s = step({ ciState: 'failure', ciFixAttempts: 3, ciFixGaveUp: true,
      ciChecks: checks(['lint', 'failure']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toBeNull();
  });

  it('still requests merge approval on green + approved (unchanged)', () => {
    const s = step({ ciState: 'success', reviewState: 'approved', ciChecks: checks(['lint', 'success']) });
    expect(openPrHandler.decide(s, job(s), ctx())).toEqual({ kind: 'request-merge-approval', jobId: 'j1', stepId: 's1' });
  });
});
