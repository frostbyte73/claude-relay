import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderWriteDraft } from '../../src/pwa/components/work/write-draft-card.js';

const PAYLOAD = '<img src=x onerror=alert(1)>';

function draft(overrides = {}) {
  return {
    id: 'd1', action: 'code.fix-ci', raisedBy: { kind: 'step' }, summary: 'push a fix',
    calls: [{ tool: { name: 'mcp__x__y', args: {} } }],
    requestedAt: 1,
    ...overrides,
  };
}

describe('renderWriteDraft — untrusted-content escaping', () => {
  // `tool.name` is attacker-reachable: parseDraftCalls (write-draft.ts) accepts any
  // non-empty string and stores it verbatim, and it arrives over MCP from a session whose
  // whole premise is that it may have read untrusted content (a PR body, a fetched page).
  // This exact payload previously escaped `label` (used for the visible .wd-call-label) but
  // NOT the duplicate copy rendered into the new <legend> — regression guard for that.
  it('escapes an attacker-controlled tool.name wherever it appears, including the <legend>', () => {
    const html = renderWriteDraft(draft({
      calls: [{ tool: { name: PAYLOAD, args: {} } }],
    }));
    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes an attacker-controlled arg KEY (not just its value)', () => {
    const html = renderWriteDraft(draft({
      calls: [{ tool: { name: 'mcp__x__y', args: { [PAYLOAD]: 'v' } } }],
    }));
    expect(html).not.toContain(PAYLOAD);
  });

  it('escapes summary, evidence markdown, and feedback', () => {
    const html = renderWriteDraft(draft({
      summary: PAYLOAD,
      evidence: PAYLOAD,
      feedback: [PAYLOAD],
    }));
    expect(html).not.toContain(PAYLOAD);
  });

  it('escapes an attacker-controlled files path and its body', () => {
    const html = renderWriteDraft(draft({
      calls: [{ bash: 'gh api --input /tmp/x.json', files: { [PAYLOAD]: PAYLOAD } }],
    }));
    expect(html).not.toContain(PAYLOAD);
  });
});

// A `files` entry is drafted content the user can edit before accepting — it must render as its
// own textarea, keyed so detail.js's generic `.wd-card [id^="wd-f-"]` snapshotUi/restoreUi
// (keyed on data-call-idx + data-arg-key) preserves an in-progress edit across a store-driven
// repaint, exactly like every other draft field. Without the right id/data-* shape here, an
// edit silently reverts the next time the surrounding step repaints — the same class of bug
// this branch already hit once for the bash textarea and the tool-args fields.
describe('renderWriteDraft — files entries render as editable, repaint-safe textareas', () => {
  it('renders one textarea per files entry, with the drafted content as its value', () => {
    const html = renderWriteDraft(draft({
      calls: [{ bash: 'gh api --input /tmp/review.json', files: { '/tmp/review.json': '{"body":"drafted"}' } }],
    }));
    expect(html).toContain('{&quot;body&quot;:&quot;drafted&quot;}');
  });

  it('gives the files textarea an id matching the wd-f- repaint-preservation contract', () => {
    const html = renderWriteDraft(draft({
      id: 'd7',
      calls: [{ bash: 'gh api --input /tmp/review.json', files: { '/tmp/review.json': 'x' } }],
    }));
    expect(html).toMatch(/<textarea[^>]*id="wd-f-d7-0-file-_tmp_review_json"/);
  });

  it('tags the files textarea with data-call-idx and a data-arg-key distinct from the bash sentinel', () => {
    const html = renderWriteDraft(draft({
      calls: [{ bash: 'gh api --input /tmp/review.json', files: { '/tmp/review.json': 'x' } }],
    }));
    const m = html.match(/<textarea[^>]*data-kind="file"[^>]*>/);
    expect(m?.[0]).toContain('data-call-idx="0"');
    expect(m?.[0]).toContain('data-arg-key="/tmp/review.json"');
  });

  it('renders no files textarea when the call has no files entry', () => {
    const html = renderWriteDraft(draft({ calls: [{ bash: 'git push origin fix' }] }));
    expect(html).not.toMatch(/data-kind="file"/);
  });
});
