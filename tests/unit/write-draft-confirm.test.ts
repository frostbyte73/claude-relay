import { describe, expect, it } from 'vitest';
import { confirmationsRequired, writeFindings } from '../../src/permissions/dangerous-writes.js';
import { parseDraftCalls } from '../../src/work/write-draft.js';

// The `confirm` tier only means something if the acknowledgement is checked SERVER-SIDE against
// the command actually submitted. A checkbox the client could omit, or one validated against the
// command as originally drafted, is theatre: the user edits the command in a textarea, so
// `--force` can be typed in after the draft was raised.
//
// acceptDraft owns that check (see the confirmationsRequired loop there). These cases pin the
// two halves it depends on — what needs acknowledging, and that `ack` survives the wire only on
// a decision payload.

describe('which writes require an acknowledgement', () => {
  it('names the force-push, mirror and admin cases and nothing else', () => {
    expect(confirmationsRequired('git push --force origin main').map((f) => f.code)).toEqual(['force-push']);
    expect(confirmationsRequired('git push -fu origin main').map((f) => f.code)).toEqual(['force-push']);
    expect(confirmationsRequired('git push --mirror origin').map((f) => f.code)).toEqual(['mirror-push']);
    expect(confirmationsRequired('gh pr merge 4 --squash --admin').map((f) => f.code)).toEqual(['gh-admin']);
  });

  it('asks for nothing on an ordinary write, however many warnings it carries', () => {
    // Three warnings, no confirmation: every one of them is legible in the command text.
    expect(writeFindings('gh pr merge 42 --squash --repo other/org --auto').length).toBeGreaterThan(1);
    expect(confirmationsRequired('gh pr merge 42 --squash --repo other/org --auto')).toEqual([]);
    expect(confirmationsRequired('git push origin main')).toEqual([]);
    expect(confirmationsRequired('git push origin --delete feature/x')).toEqual([]);
  });

  it('asks for nothing on a write that is refused outright — there is nothing to confirm', () => {
    expect(confirmationsRequired('gh pr merge 12 --squash --delete-branch')).toEqual([]);
    expect(confirmationsRequired('gh pr comment 12 --body "$(cat /etc/passwd)"')).toEqual([]);
  });

  it('asks for both when one command carries two', () => {
    const codes = confirmationsRequired('git push --force --mirror origin').map((f) => f.code);
    expect(codes).toContain('force-push');
    expect(codes).toContain('mirror-push');
  });
});

describe('ack rides the wire only as a decision', () => {
  const forced = 'git push --force origin main';

  it('is accepted on an accept payload', () => {
    const calls = parseDraftCalls([{ bash: forced, ack: ['force-push'] }], { allowSkip: true });
    expect(calls?.[0]?.ack).toEqual(['force-push']);
  });

  // Same reasoning as `skip`: a session drafting its own write must not be able to
  // pre-acknowledge the confirmation the USER is supposed to give. `allowSkip` is what marks a
  // payload as the user's decision rather than the session's proposal.
  it('is dropped from a session\'s own draft submission', () => {
    expect(parseDraftCalls([{ bash: forced, ack: ['force-push'] }])?.[0]?.ack).toBeUndefined();
  });

  it('keeps only string entries, so a malformed ack cannot satisfy a code', () => {
    const calls = parseDraftCalls(
      [{ bash: forced, ack: ['force-push', 42, null, { code: 'mirror-push' }] }],
      { allowSkip: true },
    );
    expect(calls?.[0]?.ack).toEqual(['force-push']);
  });

  it('is absent when the user ticked nothing', () => {
    expect(parseDraftCalls([{ bash: forced }], { allowSkip: true })?.[0]?.ack).toBeUndefined();
  });

  // The pin is rebuilt by explicit field pick in acceptDraft, so the acknowledgement governs
  // whether a pin is created and is never persisted onto it — nothing downstream can mistake a
  // recorded ack for a standing permission.
  it('is not a field the classifier findings carry back out', () => {
    const drafted = parseDraftCalls([{ bash: forced }]);
    expect(drafted?.[0]?.findings?.[0]?.risk).toBe('confirm');
    expect(drafted?.[0]).not.toHaveProperty('ack');
  });
});
