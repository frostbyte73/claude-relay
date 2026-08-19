import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

// Permission rules are about paths, so their tests are written as path assertions — and the
// easy path to reach for is the one on the machine you're on. That's how 60+ literal
// `/Users/<real-name>/…` strings (home dir, `~/.ssh/id_rsa`, personal repo layout, GitHub
// handle) ended up committed across a dozen files: each one was individually harmless and
// nothing was checking. The rules themselves take a `/Users/[^/]+/` wildcard, so a placeholder
// asserts exactly the same thing — a real home buys nothing and publishes where the author
// keeps their keys. This lint is the thing that was missing, not a rewrite of those tests.
// Generous on purpose — `x`/`alice`/`you` were already in use and are obviously fictional, and
// a set this permissive is still sound because the second test below pins the half that
// actually protects anyone: whoever's machine is running this cannot be a placeholder. Add a
// name here only when it names nobody. (`Shared` is macOS's own directory, not a user.)
const PLACEHOLDER_USERS = new Set([
  'testuser', 'someone', 'user', 'runner', 'alice', 'bob', 'you', 'x', 'Shared',
]);

// `[^/]+` would swallow a `/Users/[^/]+/` regex *source* out of a rule under test and report
// the class as a username, so match only what a real home segment can look like.
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z][A-Za-z0-9._-]*)/g;

describe('no real home paths in tracked files', () => {
  it('every /Users/<name> or /home/<name> literal names a placeholder', () => {
    const self = basename(import.meta.filename);
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const offenders: string[] = [];

    for (const file of files) {
      if (file.endsWith(self)) continue;
      let body: string;
      try { body = readFileSync(file, 'utf8'); } catch { continue; }
      for (const [match, user] of body.matchAll(HOME_PATH)) {
        if (PLACEHOLDER_USERS.has(user!)) continue;
        const line = body.slice(0, body.indexOf(match)).split('\n').length;
        offenders.push(`${file}:${line}: ${match}`);
      }
    }

    expect(offenders, `use a placeholder home (${[...PLACEHOLDER_USERS].join(' / ')}) instead`)
      .toEqual([]);
  });

  it("catches the machine's own home, whatever it is called", () => {
    const [, user] = homedir().match(/\/(?:Users|home)\/([^/]+)/) ?? [];
    expect(user, 'homedir() gave no username to check against').toBeTruthy();
    expect(PLACEHOLDER_USERS.has(user!), `${user} must not be treated as a placeholder`).toBe(false);
  });
});
