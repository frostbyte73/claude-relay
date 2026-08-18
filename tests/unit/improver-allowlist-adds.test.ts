import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAllowlistAdds } from '../../src/routes/actions.js';
import { ActionsStore } from '../../src/storage/actions-store.js';

// The channel `output.schema.json` merely stopped describing (Task 6) is still open in code:
// the generic submit_action_proposal MCP tool still declares allowlistAdds, and
// proposal-intake.ts still parses it. This is what actually enforces the SKILL.md's
// "never propose allowlistAdds as the answer to a denial" for the improvement loop
// specifically — a user-authored proposal is untouched.

let root: string;
let path: string;
let store: ActionsStore;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outpost-improver-allowlist-'));
  path = join(root, 'actions.json');
  store = new ActionsStore(path);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('applyAllowlistAdds', () => {
  it('installs nothing for an improver-authored proposal and logs the skip', () => {
    const applied = applyAllowlistAdds(store, 'improver', 'read.thing', [
      { kind: 'bash', value: '^sed(\\s|$)' },
    ]);
    expect(applied).toEqual([]);
    expect(store.get('read.thing').allowlist.alwaysAllowBashPatterns).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping improver-proposed allowlistAdds bash=^sed(\\s|$)'));
  });

  it('still installs a benign rule for a user-authored proposal', () => {
    const applied = applyAllowlistAdds(store, 'user', 'read.thing', [
      { kind: 'bash', value: '^sed(\\s|$)' },
    ]);
    expect(applied).toEqual([{ kind: 'bash', value: '^sed(\\s|$)' }]);
    expect(store.get('read.thing').allowlist.alwaysAllowBashPatterns).toEqual(['^sed(\\s|$)']);
  });

  it('refuses a write-shaped rule for the improver via the new skip, installing nothing', () => {
    const applied = applyAllowlistAdds(store, 'improver', 'read.thing', [
      { kind: 'bash', value: '^gh(\\s|$)' },
    ]);
    expect(applied).toEqual([]);
    expect(store.get('read.thing').allowlist.alwaysAllowBashPatterns).toEqual([]);
    // Skipped by the improver gate before ever reaching addRule/assertNotWriteShaped — the
    // log still names it, just via the improver-skip message rather than the lint's.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping improver-proposed allowlistAdds bash=^gh(\\s|$)'));
  });

  it('still refuses a write-shaped rule for a user-authored proposal via the unchanged lint path', () => {
    const applied = applyAllowlistAdds(store, 'user', 'read.thing', [
      { kind: 'bash', value: '^gh(\\s|$)' },
    ]);
    expect(applied).toEqual([]);
    expect(store.get('read.thing').allowlist.alwaysAllowBashPatterns).toEqual([]);
    // Reached addRule, which threw via assertNotWriteShaped and was caught by the
    // pre-existing "skipping invalid rule" path — proving that path is unchanged.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping invalid rule bash=^gh(\\s|$)'));
  });

  it('tolerates an absent rules array', () => {
    expect(applyAllowlistAdds(store, 'improver', 'read.thing', undefined)).toEqual([]);
    expect(applyAllowlistAdds(store, 'user', 'read.thing', undefined)).toEqual([]);
  });
});
