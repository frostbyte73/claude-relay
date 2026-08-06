import { describe, it, expect } from 'vitest';
import { expectRepoOf, PR_URL_RE, parsePrUrl } from '../../src/work/pr-url.js';

// expectRepoOf is what wires a step's planner-supplied prUrl into provision()'s origin
// assertion. A url it declines to parse means no assertion runs at all, so the strictness
// here is what decides whether the wrong-repo check actually fires.
describe('expectRepoOf', () => {
  it('derives owner/repo from a well-formed prUrl', () => {
    expect(expectRepoOf({ prUrl: 'https://github.com/acme/example/pull/12' })).toBe('acme/example');
  });

  it('declines anything that would not survive the watcher check', () => {
    for (const prUrl of [
      'https://github.com/../example/pull/12',
      'https://github.com/acme/../pull/12',
      'https://github.com/acme/example/pull/12/files',
      'http://github.com/acme/example/pull/12',
      'https://gitlab.com/acme/example/pull/12',
      'https://github.com/acme/example/pull/abc',
      '',
    ]) expect(expectRepoOf({ prUrl }), prUrl).toBeUndefined();
    expect(expectRepoOf({ prUrl: 42 as unknown as string })).toBeUndefined();
    expect(expectRepoOf(undefined)).toBeUndefined();
    expect(expectRepoOf({})).toBeUndefined();
  });

  it('agrees with the regex the watcher gates subprocess arguments on', () => {
    const ok = 'https://github.com/acme/example/pull/12';
    expect(PR_URL_RE.test(ok)).toBe(true);
    expect(parsePrUrl(ok)).toEqual({ owner: 'acme', repo: 'example', number: '12' });
  });
});
