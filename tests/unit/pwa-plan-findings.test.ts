// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderFinding } from '../../src/pwa/components/work/finding.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderPlanSection } from '../../src/pwa/components/work/plan-section.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderTimelineStep } from '../../src/pwa/components/work/step-card.js';

const finding = {
  findings: 'Verified the NPE reproduces at session.go:142.',
  evidence: [{ kind: 'repo-file', source: 'session.go:142', summary: 'nil deref on close', excerpt: 'return s.conn.Close() // s.conn is nil' }],
  caveats: ['Could not check the shared config override.'],
};

describe('renderFinding', () => {
  it('returns empty string when there is no finding', () => {
    expect(renderFinding(undefined)).toBe('');
    expect(renderFinding(null)).toBe('');
  });

  it('renders the markdown writeup, evidence, and caveats', () => {
    const html = renderFinding(finding);
    expect(html).toContain('step-findings');
    expect(html).toContain('session.go:142');
    expect(html).toContain('nil deref on close');
    expect(html).toContain('shared config override');
  });

  it('renders an evidence excerpt when present', () => {
    const html = renderFinding(finding);
    expect(html).toContain('finding-evidence-excerpt');
    expect(html).toContain('s.conn is nil');
  });

  it('uses a custom label when given, defaulting to Investigation', () => {
    expect(renderFinding(finding)).toContain('>Investigation<');
    expect(renderFinding(finding, 'Findings')).toContain('>Findings<');
  });

  it('renders as a collapsible <details> when asked, open by default', () => {
    const open = renderFinding(finding, 'Investigation', { collapsible: true });
    expect(open).toMatch(/<details class="plan-findings tl-findings" open>/);
    expect(open).toContain('tl-findings-caret');
    const closed = renderFinding(finding, 'Investigation', { collapsible: true, open: false });
    expect(closed).not.toMatch(/tl-findings" open>/);
  });
});

describe('renderPlanSection findings', () => {
  const base = {
    id: 'j1', state: 'plan_pending_review',
    steps: [{ id: 's1', type: 'open-pr', title: 'Fix it', cancelled: false }],
    plan: { postedAt: 1, iterationsRejected: [] },
  };

  it('shows findings when the plan carries them', () => {
    const html = renderPlanSection({ ...base, plan: { ...base.plan, findings: finding } });
    expect(html).toContain('Investigation');
    expect(html).toContain('session.go:142');
  });

  it('omits the findings block when absent', () => {
    const html = renderPlanSection(base);
    expect(html).not.toContain('plan-findings');
  });

  it('renders the investigation as collapsible, below the live orchestrator feed', () => {
    const html = renderPlanSection({
      ...base,
      orchestratorSessionId: 'sess-1',
      plan: { ...base.plan, findings: finding },
    });
    expect(html).toContain('<details class="plan-findings tl-findings"');
    const feedAt = html.indexOf('orchestrator-inline-session-mount--replan');
    const investigationAt = html.indexOf('plan-findings tl-findings');
    expect(feedAt).toBeGreaterThanOrEqual(0);
    expect(feedAt).toBeLessThan(investigationAt);
  });
});

// Plan and Steps are one section now — a single "Plan" heading, no "Steps" label.
// Pre-approval the boxed compact index is the story; once executing the caller's
// timeline is handed in and the index is dropped so steps aren't listed twice.
describe('renderPlanSection merges plan + steps', () => {
  const executing = {
    id: 'j1', state: 'executing',
    steps: [{ id: 's1', type: 'open-pr', title: 'Fix it', cancelled: false }],
    plan: { postedAt: 1 },
  };

  it('review phase renders the boxed compact index with no timeline', () => {
    const html = renderPlanSection({ ...executing, state: 'plan_pending_review' });
    expect(html).toContain('plan-section--review');
    expect(html).toContain('plan-index');
    expect(html).not.toContain('plan-section--live');
  });

  it('executing phase drops the index and hosts the timeline under the Plan header', () => {
    const html = renderPlanSection(executing, { timelineHtml: '<div class="tl-rail">TL</div>', editing: false });
    expect(html).toContain('plan-section--live');
    expect(html).toContain('<div class="tl-rail">TL</div>');
    expect(html).not.toContain('plan-index');
    // One "Plan" label, no separate "Steps" heading.
    expect(html).toContain('>Plan<');
    expect(html).not.toContain('>Steps<');
  });

  // Regression: a step-review used to park the job in `planning`, so every completed
  // step swapped the whole timeline for the pre-execution plan card. The review now
  // rides on `executing` and only adds its own feed + caption above the timeline.
  it('keeps the timeline while the orchestrator reviews a completed step', () => {
    const html = renderPlanSection({
      ...executing,
      orchestratorSessionId: 'orch-1',
      reviewingStepId: 's1',
    }, { timelineHtml: '<div class="tl-rail">TL</div>', editing: false });
    expect(html).toContain('plan-section--live');
    expect(html).toContain('<div class="tl-rail">TL</div>');
    expect(html).not.toContain('plan-index');
    expect(html).toContain('Reviewing step 01 before continuing');
  });

  it('surfaces the Edit-plan toggle in the header while executing', () => {
    const idle = renderPlanSection(executing, { timelineHtml: '<div class="tl-rail"></div>', editing: false });
    expect(idle).toContain('data-job-action="toggle-edit-plan"');
    expect(idle).toContain('>Edit plan<');
    const editing = renderPlanSection(executing, { timelineHtml: '<div class="tl-rail"></div>', editing: true });
    expect(editing).toContain('>Done editing<');
  });
});

// Collapse moved down to each step: findings fold away once the step is done, so
// the timeline reads as name + description; live/failed steps stay expanded.
describe('renderTimelineStep findings collapse', () => {
  const job = { id: 'j1' };
  const withOutput = (state: string, extra = {}) => ({
    id: 's', type: 'action', action: 'read.investigate', title: 'Look', state, output: 'Found the bug', ...extra,
  });

  it('wraps findings in a <details> that starts open while the step runs', () => {
    const html = renderTimelineStep(job, withOutput('running', { sessionId: 'x' }), 0);
    expect(html).toContain('tl-findings');
    expect(html).toMatch(/<details class="plan-findings tl-findings" open>/);
    expect(html).toContain('Found the bug');
  });

  it('collapses findings once the step is resolved', () => {
    const html = renderTimelineStep(job, withOutput('resolved'), 0);
    expect(html).toContain('tl-findings');
    expect(html).not.toMatch(/tl-findings" open>/);
  });
});
