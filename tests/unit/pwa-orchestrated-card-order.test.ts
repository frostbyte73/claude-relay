// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderOrchestratedCard } from '../../src/pwa/components/work/orchestrated-card.js';

// The card's band order has been reworked twice and has no other guard: it's pure string
// concatenation, so a regression reads as a working card that simply puts the reply box
// somewhere else. What's pinned is the one property the arrangement exists for — the live
// band (feed + composer) is BELOW the record band (PR block, dispatches, trail), so the
// newest line to read and the only box to type in are both at the scroll's end.
const step = (o: Record<string, unknown> = {}) => ({
  id: 's1',
  title: 'Ship it',
  type: 'orchestrated',
  controller: 'code.orchestrate-pr',
  phase: 'implement',
  sessionId: 'ctrl-sess',
  state: 'running',
  workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'outpost/abc' },
  pr: { prUrl: 'https://github.com/acme/widgets/pull/7' },
  memo: 'Working through CI.',
  ...o,
});

const at = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  expect(i, `expected the card to render ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe('renderOrchestratedCard — band order', () => {
  it('puts the feed and composer below the PR block and trail', () => {
    const html = renderOrchestratedCard(step(), { job: { id: 'j1' } });
    const record = at(html, 'class="orc-record"');
    expect(at(html, 'class="pr-block"')).toBeGreaterThan(record);
    expect(at(html, 'class="orc-trail"')).toBeGreaterThan(record);
    expect(at(html, 'step-inline-session-mount')).toBeGreaterThan(at(html, 'class="orc-trail"'));
    expect(at(html, 'data-composer="orc-message"')).toBeGreaterThan(at(html, 'step-inline-session-mount'));
  });

  // Identity is the exception that stays on top: it names what you're looking at, so it can't
  // be the thing you scroll back up for.
  it('keeps the identity row above everything', () => {
    const html = renderOrchestratedCard(step(), { job: { id: 'j1' } });
    expect(at(html, 'class="tl-ident"')).toBeLessThan(at(html, 'class="orc-record"'));
  });

  // A gate is a decision, and decisions live with the conversation that raised them — under
  // the record, directly above the feed that explains it.
  it('puts a pending gate in the live band, under the record', () => {
    const html = renderOrchestratedCard(
      step({ gate: { question: 'Merge it?', draft: 'gh pr merge' } }),
      { job: { id: 'j1' } },
    );
    expect(at(html, 'class="tl-gate"')).toBeGreaterThan(at(html, 'class="pr-block"'));
    expect(at(html, 'class="tl-gate"')).toBeLessThan(at(html, 'step-inline-session-mount'));
  });
});
