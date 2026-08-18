import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Allowlist } from '../../src/permissions/allowlist.js';
import {
  assertNotWriteShaped, classifyPathShape, classifyRuleShape, lintPermissionRule,
} from '../../src/permissions/write-shape.js';

const shaped = (v: string) => classifyPathShape(v).writeShaped;

// A path rule is the only rule kind whose whole grant is a write — `Write:<regex>` says
// nothing about *what* is written, only where. So the lint's question is confinement, and the
// only thing it can decide from the pattern text is the mandatory literal prefix every match
// must carry. Each refusal below is a pattern whose matched set reaches outside the scratch
// roots, or one whose prefix cannot be trusted to be mandatory.
describe('classifyPathShape refuses a write rule that is not confined', () => {
  it('refuses the one-keystroke widenings of the shipped /tmp rules', () => {
    for (const v of [
      'Write:^/',
      'Write:^/Users/',
      'Write:^/Users/you/',
      'Write:.*',
      'Write:^.*',
      'Edit:^/etc/',
      'MultiEdit:^/',
      'NotebookEdit:^/Users/',
    ]) {
      expect(shaped(v), v).toBe(true);
    }
  });

  it('refuses an unanchored pattern, which matches anywhere in the path', () => {
    // `Write:/tmp/` reads like the shipped rule and admits `/Users/you/tmp/` as well.
    expect(shaped('Write:/tmp/')).toBe(true);
    expect(classifyPathShape('Write:/tmp/').reason).toMatch(/anchor/i);
  });

  it('refuses a prefix that stops mid-segment, tail or no tail', () => {
    // The shape that survived three manual narrowings in Ship 5: an unanchored tail with no
    // terminal constraint. `(?:/[^/]+)+$` happens to hold the match inside /tmp; its sibling
    // `^/tmp(?:x|/a)` does not, and telling them apart means interpreting the tail instead of
    // the prefix. Both are refused for the same reason — `^/tmp` is not `^/tmp/`.
    expect(shaped('Write:^/tmp(?:/[^/]+)+$')).toBe(true);
    expect(shaped('Write:^/tmp(?:x|/a)')).toBe(true);
    expect(shaped('Write:^/tmp')).toBe(true);
    expect(classifyPathShape('Write:^/tmp(?:/[^/]+)+$').reason).toMatch(/mid-segment/);
  });

  it('refuses a quantifier that makes the prefix’s own last character optional', () => {
    // `^/tmp/?` matches `/tmpevil/.ssh/id_rsa`: the trailing `/` the prefix appears to pin is
    // optional, so the literal prefix is not mandatory at all.
    expect(new RegExp('^/tmp/?').test('/tmpevil/x')).toBe(true);
    for (const v of ['Write:^/tmp/?', 'Write:^/tmp/*', 'Write:^/tmp/{0,1}']) {
      expect(shaped(v), v).toBe(true);
    }
  });

  it('refuses a top-level alternation, which discards the prefix on its other branch', () => {
    expect(new RegExp('^/tmp/|/').test('/Users/you/.zshrc')).toBe(true);
    for (const v of ['Write:^/tmp/|/', 'Write:^/tmp/x|^/etc/', 'Write:^/(tmp|Users)/']) {
      expect(shaped(v), v).toBe(true);
    }
  });

  it('refuses a traversal segment, in either spelling', () => {
    expect(shaped('Write:^/tmp/../')).toBe(true);
    // literalPrefix unescapes as it scans, so the escaped spelling is the same prefix.
    expect(shaped('Write:^/tmp/\\.\\./')).toBe(true);
  });

  it('refuses a pattern whose prefix is hidden behind a metacharacter or a numeric escape', () => {
    // Each of these is in fact confined to /tmp, but nothing the lint reads says so — the
    // literal prefix is empty. Fail closed and make the author write the plain spelling.
    for (const v of ['Write:^[/]tmp/', 'Write:^\\x2ftmp\\x2f', 'Write:^(?:/tmp/)']) {
      expect(shaped(v), v).toBe(true);
    }
  });

  it('refuses a root that merely starts like a scratch root', () => {
    expect(shaped('Write:^/tmpevil/')).toBe(true);
    expect(shaped('Write:^/var/log/')).toBe(true);
  });
});

describe('classifyPathShape accepts what the product actually ships', () => {
  it('accepts the three live rules in the edit group', () => {
    for (const v of ['Write:^/tmp/', 'Edit:^/tmp/', 'MultiEdit:^/tmp/']) {
      expect(shaped(v), v).toBe(false);
    }
  });

  it('accepts a narrower rule under a scratch root, with or without a tail', () => {
    for (const v of [
      'Write:^/tmp/outpost/',
      'Write:^\\/tmp\\/',
      'Write:^/tmp/[^/]+\\.json$',
      'Write:^/private/tmp/',
      'Write:^/var/folders/',
      'NotebookEdit:^/tmp/',
    ]) {
      expect(shaped(v), v).toBe(false);
    }
  });

  it('accepts every read-tool pattern, however broad', () => {
    for (const v of ['Read:^/', 'Read:.*', 'Glob:^/Users/', 'Grep:^/etc/', 'LS:^/']) {
      expect(shaped(v), v).toBe(false);
    }
  });
});

describe('classifyPathShape refuses a malformed rule regardless of gating', () => {
  it('refuses a rule with no Tool: prefix and one with an empty half', () => {
    for (const v of ['^/tmp/', 'Write:', ':^/tmp/']) {
      expect(classifyPathShape(v).structural, v).toBe(true);
      expect(lintPermissionRule('path', v, true).ok, v).toBe(false);
    }
  });

  it('refuses a pattern that does not compile, in a gated group too', () => {
    const v = 'Write:^/tmp/(';
    expect(classifyPathShape(v).structural).toBe(true);
    expect(lintPermissionRule('path', v, true).ok).toBe(false);
    expect(lintPermissionRule('path', v, false).ok).toBe(false);
  });
});

describe('the lint reaches every rule-entry path', () => {
  it('classifyRuleShape delegates the path kind instead of waving it through', () => {
    expect(classifyRuleShape('path', 'Write:^/').writeShaped).toBe(true);
    expect(classifyRuleShape('path', 'Write:^/tmp/').writeShaped).toBe(false);
  });

  it('addRule refuses to persist an unconfined write grant', () => {
    const al = new Allowlist({
      alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: ['Write:^/tmp/'],
    });
    expect(() => al.addRule('path', 'Write:^/')).toThrow(/gated permission group/);
    expect(() => assertNotWriteShaped('path', 'Write:^/Users/')).toThrow();
    expect(() => assertNotWriteShaped('path', 'Write:^/tmp/')).not.toThrow();
  });

  it('a gated group may hold an unconfined write rule; a non-gated one may not', () => {
    expect(lintPermissionRule('path', 'Write:^/Users/', false).ok).toBe(false);
    expect(lintPermissionRule('path', 'Write:^/Users/', false).ungatedWrite).toBe(true);
    expect(lintPermissionRule('path', 'Write:^/Users/', true).ok).toBe(true);
    expect(lintPermissionRule('path', 'Write:^/tmp/', false).ok).toBe(true);
  });
});

// The lint that refuses a rule the shipped config already contains breaks the product on the
// next group save, silently, for a user who changed nothing. Pin the real file rather than a
// copy of its contents, so an added rule has to face this test.
describe('the shipped permission groups still lint clean', () => {
  it('passes every alwaysAllowPathPatterns entry in permission-groups.default.json', () => {
    const groups = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8')) as
      Record<string, { alwaysAllowPathPatterns?: string[] }>;
    const seen: string[] = [];
    for (const [name, group] of Object.entries(groups)) {
      for (const rule of group.alwaysAllowPathPatterns ?? []) {
        seen.push(rule);
        expect(lintPermissionRule('path', rule, false).ok, `${name}: ${rule}`).toBe(true);
      }
    }
    expect(seen).toContain('Write:^/tmp/');
  });
});

// The lint keys on the tool half of the rule, and so does the checker. If they ever disagreed
// on what counts as `Write`, the disagreement would be a grant nobody linted.
describe('a casing dodge past the lint grants nothing either', () => {
  it('leaves a lowercase tool name dead at the checker', () => {
    expect(shaped('write:^/')).toBe(false);
    const al = new Allowlist({
      alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: ['write:^/'],
    });
    expect(al.allows('Write', { file_path: '/Users/you/.zshrc' })).toBe(false);
  });
});
