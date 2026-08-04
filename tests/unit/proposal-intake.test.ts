import { describe, it, expect } from 'vitest';
import {
  intakeProposal, ledgerActionFor, netLineDelta, onSessionGone,
} from '../../src/actions/proposal-intake.js';
import type { ActionEdit, ActionProposal } from '../../src/storage/action-edits-store.js';

const NOW = 1_700_000_000_000;

function ctx(skillMdBefore = 'a\nb\n') {
  return { skillMdBefore, now: NOW };
}

function edit(overrides: Partial<ActionEdit> = {}): ActionEdit {
  return {
    actionName: 'read.investigate',
    sessionId: 's1',
    status: 'editing',
    startedAt: NOW,
    feedback: '',
    ...overrides,
  };
}

const proposal = (): ActionProposal => ({
  summary: 's', skillMdBefore: '', skillMdAfter: 'x', allowlistAdds: [], postedAt: NOW,
});

describe('intakeProposal', () => {
  it('treats noChange as a real outcome carrying its summary', () => {
    const r = intakeProposal({ noChange: true, summary: '47 runs, nothing worth changing' }, ctx());
    expect(r).toEqual({ kind: 'no-change', summary: '47 runs, nothing worth changing' });
  });

  it('lets noChange win over a body sent alongside it', () => {
    // Otherwise a confused session could apply a write while claiming it changed nothing.
    const r = intakeProposal({ noChange: true, skillMdAfter: 'rewritten\n' }, ctx());
    expect(r.kind).toBe('no-change');
  });

  it('rejects a payload carrying neither a body nor noChange', () => {
    const r = intakeProposal({ summary: 'oops' }, ctx());
    expect(r.kind).toBe('invalid');
  });

  it('builds a proposal with the before-text, posted time and a signed line delta', () => {
    const r = intakeProposal({ summary: 'tighten', skillMdAfter: 'a\nb\nc\nd\n' }, ctx('a\nb\n'));
    expect(r.kind).toBe('proposal');
    if (r.kind !== 'proposal') return;
    expect(r.proposal.skillMdBefore).toBe('a\nb\n');
    expect(r.proposal.postedAt).toBe(NOW);
    expect(r.proposal.netLineDelta).toBe(2);
  });

  it('reports a negative delta when the proposal shrinks the body', () => {
    const r = intakeProposal({ skillMdAfter: 'a\n' }, ctx('a\nb\nc\n'));
    expect(r.kind === 'proposal' && r.proposal.netLineDelta).toBe(-2);
  });

  it('keeps well-formed allowlist rules and drops malformed ones', () => {
    const r = intakeProposal({
      skillMdAfter: 'x',
      allowlistAdds: [
        { kind: 'tool', value: 'Read' },
        { kind: 'nonsense', value: 'Read' },
        { kind: 'bash', value: 42 as unknown as string },
        { kind: 'path', value: 'Read:^/tmp/' },
      ],
    }, ctx());
    expect(r.kind === 'proposal' && r.proposal.allowlistAdds).toEqual([
      { kind: 'tool', value: 'Read' },
      { kind: 'path', value: 'Read:^/tmp/' },
    ]);
  });

  it('normalizes evidence: drops non-strings and blanks, truncates, caps the list', () => {
    const r = intakeProposal({
      skillMdAfter: 'x',
      evidence: ['  cited run a  ', '', 7, 'b'.repeat(400), ...Array.from({ length: 12 }, (_, i) => `e${i}`)],
    }, ctx());
    if (r.kind !== 'proposal') throw new Error('expected a proposal');
    const ev = r.proposal.evidence!;
    expect(ev[0]).toBe('cited run a');
    expect(ev[1]).toHaveLength(300);
    expect(ev).toHaveLength(10);
  });

  it('yields an empty evidence list when the field is absent or not an array', () => {
    expect(intakeProposal({ skillMdAfter: 'x' }, ctx())).toMatchObject({ proposal: { evidence: [] } });
    expect(intakeProposal({ skillMdAfter: 'x', evidence: 'nope' }, ctx())).toMatchObject({ proposal: { evidence: [] } });
  });
});

describe('netLineDelta', () => {
  it('ignores a missing trailing newline on either side', () => {
    expect(netLineDelta('a\nb', 'a\nb\n')).toBe(0);
  });

  it('counts an empty body as zero lines', () => {
    expect(netLineDelta('', 'a\nb\n')).toBe(2);
  });
});

describe('onSessionGone', () => {
  it('keeps an edit whose proposal is already posted, leaving the verdict pending', () => {
    expect(onSessionGone(edit({ status: 'review', proposal: proposal() })))
      .toEqual({ keep: true, outcome: 'submitted' });
  });

  it('drops an edit that never posted anything', () => {
    expect(onSessionGone(edit())).toEqual({ keep: false, outcome: 'abandoned' });
  });
});

describe('ledgerActionFor', () => {
  it('defaults to meta.build-action for rows written before authorAction existed', () => {
    expect(ledgerActionFor(edit())).toBe('meta.build-action');
  });

  it('attributes an improver edit to its own action', () => {
    expect(ledgerActionFor(edit({ authorAction: 'meta.improve-actions' }))).toBe('meta.improve-actions');
  });
});
