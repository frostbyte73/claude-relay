import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { Allowlist, PATH_INPUT_FIELDS } from '../../src/permissions/allowlist.js';
import {
  assertNotWriteShaped, backtrackingDegree, classifyPathShape, classifyRuleShape,
  lintPermissionRule, MCP_WRITE_PROBES, PATH_SCOPED_TOOLS, PATH_WRITE_TOOLS,
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
    // The survivor is refused twice over — its `(?:…+)+` also fails the backtracking bound,
    // which runs first — so pin the mid-segment reason on the group-free spelling.
    expect(classifyPathShape('Write:^/tmp').reason).toMatch(/mid-segment/);
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
    for (const v of ['Read:^/', 'Read:.*', 'Glob:^/Users/', 'Grep:^/etc/']) {
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

interface RuleSet {
  alwaysAllow?: string[];
  alwaysAllowBashPatterns?: string[];
  alwaysAllowMcpPatterns?: string[];
  alwaysAllowPathPatterns?: string[];
}

type ShippedRule = { where: string; kind: 'tool' | 'bash' | 'mcp' | 'path'; rule: string; gated: boolean };

// Every rule the product actually ships, from both places one can live: the tracked permission
// groups and the colocated action allowlists the registry merges in at load.
function shippedRules(): ShippedRule[] {
  const sources: [string, RuleSet, boolean][] = [];
  const groups = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8')) as
    Record<string, RuleSet>;
  for (const [name, g] of Object.entries(groups)) sources.push([name, g, name === 'push']);
  for (const category of readdirSync('actions')) {
    const dir = `actions/${category}`;
    if (!statSync(dir).isDirectory()) continue;
    for (const action of readdirSync(dir)) {
      const file = `${dir}/${action}/allowlist.json`;
      // A colocated allowlist is merged into the plain allowlist only, never `gated`.
      if (existsSync(file)) sources.push([file, JSON.parse(readFileSync(file, 'utf8')) as RuleSet, false]);
    }
  }
  const out: ShippedRule[] = [];
  for (const [where, set, gated] of sources) {
    for (const rule of set.alwaysAllow ?? []) out.push({ where, kind: 'tool', rule, gated });
    for (const rule of set.alwaysAllowBashPatterns ?? []) out.push({ where, kind: 'bash', rule, gated });
    for (const rule of set.alwaysAllowMcpPatterns ?? []) out.push({ where, kind: 'mcp', rule, gated });
    for (const rule of set.alwaysAllowPathPatterns ?? []) out.push({ where, kind: 'path', rule, gated });
  }
  return out;
}

// The lint that refuses a rule the shipped config already contains breaks the product on the
// next group save, silently, for a user who changed nothing. Pin the real files rather than a
// copy of their contents, so an added rule has to face this test.
describe('the shipped permission groups still lint clean', () => {
  it('passes every rule of every kind, in the groups and in the action allowlists', () => {
    const rules = shippedRules();
    // Dropped from ~116 when `push` traded nineteen flag enumerations for eight verb anchors;
    // the bar is a "this sweep still covers the real config" guard, not a target.
    expect(rules.length).toBeGreaterThan(100);
    for (const { where, kind, rule, gated } of rules) {
      expect(lintPermissionRule(kind, rule, gated).ok, `${where} (${kind}): ${rule}`).toBe(true);
    }
    expect(rules.filter((r) => r.kind === 'path').map((r) => r.rule)).toContain('Write:^/tmp/');
    // The `tool` kind was the one this sweep used to skip. It reads clean today, and the point
    // of walking it is that a future tightening of the tool classifier — a new entry in
    // MCP_WRITE_TOOLS, another whole-tool refusal — meets the real corpus rather than a copy.
    const tools = rules.filter((r) => r.kind === 'tool');
    expect(tools.length).toBeGreaterThan(14);
    expect(tools.map((r) => r.rule)).toContain('Read');
  });
});

// The lint keys on the tool half of the rule, and so does the checker: `rulesAllow` compares
// `r.tool === toolName` exactly, and the redirect/file-op gates ask for the literal `'Write'`.
// A rule whose tool half is misspelled therefore grants nothing — it fails closed, but it also
// answers 200 to a user who believes they made a grant, so it is refused rather than accepted.
describe('a tool name the checker will never match is refused, not silently dead', () => {
  it('refuses every near-spelling of a real tool', () => {
    for (const v of ['write:^/tmp/', 'WRITE:^/tmp/', ' Write:^/tmp/', 'Write :^/tmp/',
      'Bash:^/', 'LS:^/', 'NotebookEdits:^/tmp/']) {
      expect(classifyPathShape(v).structural, v).toBe(true);
      expect(lintPermissionRule('path', v, true).ok, v).toBe(false);
    }
  });

  it('proves the dead-rule claim those refusals rest on', () => {
    const al = new Allowlist({
      alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: ['write:^/'],
    });
    expect(al.allows('Write', { file_path: '/Users/you/.zshrc' })).toBe(false);
  });

  it('accepts exactly the tools the checker path-scopes', () => {
    // The two lists live in different modules — allowlist.ts imports this one, so importing
    // back would cycle. This is the pin that keeps them from drifting apart.
    expect([...PATH_SCOPED_TOOLS].sort()).toEqual(Object.keys(PATH_INPUT_FIELDS).sort());
    for (const tool of PATH_WRITE_TOOLS) expect(PATH_SCOPED_TOOLS.has(tool)).toBe(true);
  });
});

// `alwaysAllow: ['Write']` is `Write:^/` in five characters, through the same four doors the
// path lint guards. It reaches further than the path rule, too: `rulesAllow` answers on the
// tool name before it looks at a path, so a whole-tool grant also satisfies the redirect and
// file-op gates, which ask whether the caller could have written that path with `Write`.
describe('a whole-tool write grant is refused like the path rule it stands in for', () => {
  const wholeTool = (tool: string) => new Allowlist({
    alwaysAllow: [tool], alwaysAllowBashPatterns: ['^echo '],
    alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  });

  it('refuses every path-write tool, not just Bash', () => {
    expect(classifyRuleShape('tool', 'Bash').writeShaped).toBe(true);
    // Failing here means a tool was dropped from PATH_WRITE_TOOLS: the set drives both this
    // refusal and the path lint's confinement, so neither can be narrowed on its own.
    for (const tool of PATH_WRITE_TOOLS) {
      expect(classifyRuleShape('tool', tool).writeShaped, tool).toBe(true);
      expect(lintPermissionRule('tool', tool, false).ok, tool).toBe(false);
      expect(() => assertNotWriteShaped('tool', tool)).toThrow();
      // Gated is still gated: `push` may hold one, the pin decides per call.
      expect(lintPermissionRule('tool', tool, true).ok, tool).toBe(true);
    }
  });

  it('refuses a whole-tool grant of an MCP write tool, the same as its `^name$` rule', () => {
    // `rulesAllow` answers `alwaysAllow.has(toolName)` before it ever reaches the `mcp__`
    // branch, so this spelling never met the probe corpus that refuses the rule form. The
    // corpus is the shared constant, so a tool added to it later is covered here on the day it
    // lands — this loop is what makes that true rather than hopeful.
    expect(MCP_WRITE_PROBES.length).toBeGreaterThan(50);
    for (const tool of MCP_WRITE_PROBES) {
      const asTool = lintPermissionRule('tool', tool, false);
      expect(asTool.ok, tool).toBe(false);
      expect(asTool.ungatedWrite, tool).toBe(true);
      // The invariant: the whole-tool spelling is exactly as hard to install as the narrowest
      // rule naming the same tool, in both directions.
      expect(asTool.ok, tool).toBe(lintPermissionRule('mcp', `^${tool}$`, false).ok);
      expect(lintPermissionRule('tool', tool, true).ok, tool).toBe(true);
    }
  });

  it('leaves an MCP read tool installable in either spelling', () => {
    for (const tool of ['mcp__github__get_file_contents', 'mcp__github__list_issues',
      'mcp__claude_ai_Linear__get_issue', 'mcp__grafana__query_prometheus']) {
      expect(lintPermissionRule('tool', tool, false).ok, tool).toBe(true);
      expect(lintPermissionRule('mcp', `^${tool}$`, false).ok, tool).toBe(true);
    }
  });

  it('is refusing an MCP grant that really does reach the write', () => {
    const installed = new Allowlist({
      alwaysAllow: ['mcp__github__push_files'], alwaysAllowBashPatterns: [],
      alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
    });
    expect(installed.allows('mcp__github__push_files', {})).toBe(true);

    const fresh = new Allowlist({
      alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [],
      alwaysAllowPathPatterns: [],
    });
    expect(() => fresh.addRule('tool', 'mcp__github__push_files')).toThrow(/external write/);
    expect(fresh.allows('mcp__github__push_files', {})).toBe(false);
  });

  it('leaves the read tools and the rest of the catalog alone', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch',
      'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']) {
      expect(classifyRuleShape('tool', tool).writeShaped, tool).toBe(false);
    }
  });

  it('is refusing a grant that really does reach outside any scratch root', () => {
    const al = wholeTool('Write');
    for (const p of ['/Users/testuser/.ssh/authorized_keys', '/Users/testuser/Library/LaunchAgents/evil.plist',
      '/etc/crontab']) {
      expect(al.allows('Write', { file_path: p }), p).toBe(true);
    }
    // The half a path-only lint would never have seen: the redirect gate resolves through the
    // same whole-tool grant.
    expect(al.allows('Bash', { command: 'echo x > /Users/testuser/.zshrc' })).toBe(true);
  });
});

// Undecidable in general, so this is a bound: score how many ways a failed match can be varied
// and cap it. The pattern runs synchronously inside the PreToolUse gate, against a path the
// session chose.
describe('a path pattern that can backtrack exponentially is refused', () => {
  it('refuses a repeated group whose body also repeats', () => {
    for (const v of ['Write:^/tmp/(?:a+)+$', 'Write:^/tmp/(a*)*', 'Write:^/tmp/(a+)*',
      'Read:^/tmp/(?:a?b?)+$', 'Write:^/tmp/((x+))+', 'Write:^/tmp/(?:[^/]+/)+x']) {
      expect(classifyPathShape(v).structural, v).toBe(true);
      expect(lintPermissionRule('path', v, true).ok, v).toBe(false);
    }
  });

  it('refuses a repeated group that matches the same text two ways', () => {
    // `(a|a)+` carries no quantifier inside the group, so the first version of this bound let
    // it through: 19 characters, `^`-anchored, prefix `/tmp/` — and 1452ms through `allows()`
    // at a 28-character path, doubling per character.
    for (const v of ['Write:^/tmp/(a|a)+$', 'Read:^/tmp/(a|a)+$', 'Write:^/tmp/(?:x|x)*',
      'Write:^/tmp/(a|ab|a)+']) {
      expect(classifyPathShape(v).structural, v).toBe(true);
      expect(lintPermissionRule('path', v, true).ok, v).toBe(false);
    }
  });

  it('still accepts an alternation that is not repeated', () => {
    // The tightening is on *quantified* groups only. An alternation that matches at most once
    // costs nothing, and it is the one legitimate use of a group in a path rule.
    for (const v of ['Write:^/tmp/(a|b)', 'Write:^/tmp/(?:outpost|scratch)/', 'Read:^/tmp/(a|b)?',
      'Read:^/Users/(dc|other)/code/']) {
      expect(lintPermissionRule('path', v, false).ok, v).toBe(true);
    }
  });

  it('leaves an ordinary group or a single quantifier alone', () => {
    for (const v of ['Write:^/tmp/(a|b)', 'Write:^/tmp/[^/]+\\.json$', 'Write:^/tmp/.*',
      'Write:^/tmp/(?:outpost)?', 'Write:^/tmp/(x)+']) {
      expect(shaped(v), v).toBe(false);
    }
  });

  it('caps the pattern length', () => {
    const long = `Write:^/tmp/${'a'.repeat(300)}/`;
    expect(classifyPathShape(long).structural).toBe(true);
    expect(shaped(`Write:^/tmp/${'a'.repeat(150)}/`)).toBe(false);
  });

  it('answers in bounded time for the pattern that used to hang', () => {
    // 26 characters took 216ms before the refusal; 40 did not return in 300s.
    expect(() => assertNotWriteShaped('path', 'Write:^/tmp/(?:a+)+$')).toThrow(/backtrack/);
    const started = Date.now();
    classifyPathShape('Write:^/tmp/(?:a+)+$');
    expect(Date.now() - started).toBeLessThan(100);
  });
});

// The guard this replaced scored a pattern's *shape* — a nested or ambiguous group — and the
// worst blowup available needs no group at all. `Write:^/tmp/.*.*.*.*.*.*.*.*.*.*.*.*x$` is 32
// characters against a 200-character cap, `^`-anchored, confined to /tmp/, group-free,
// alternation-free — and 11.5s through `allows()` on a 24-character path, 27.7s on a
// 30-character one. Cost, not shape, is the property worth bounding.
describe('a path pattern that backtracks polynomially is refused', () => {
  const poly = (k: number) => `Write:^/tmp/${'.*'.repeat(k)}x$`;

  it('refuses the group-free stack of wildcards the shape guard waved through', () => {
    // Both ends of the range the length cap never saw: 32 characters, and the largest k that
    // still fits under it.
    expect(poly(12).length - 'Write:'.length).toBe(32);
    expect(poly(96).length - 'Write:'.length).toBe(200);
    for (const k of [3, 8, 10, 12, 96]) {
      const v = poly(k);
      expect(classifyPathShape(v).structural, v).toBe(true);
      expect(lintPermissionRule('path', v, true).ok, v).toBe(false);
      expect(() => assertNotWriteShaped('path', v)).toThrow(/backtrack/);
    }
  });

  it('is scoring cost, so the spellings that dodge a top-level quantifier count too', () => {
    // A guard that counted only quantifiers outside every group would read each of these as
    // zero. Degrees add along a concatenation and max across alternation branches, at depth.
    for (const v of [
      'Write:^/tmp/(?:.*)(?:.*)(?:.*)x$',
      'Write:^/tmp/(.*.*.*.*x)$',
      'Write:^/tmp/[^/]*[^/]*[^/]*x$',
      'Write:^/tmp/(a|.*.*.*)x$',
      'Write:^/tmp/.{0,}.{0,}.{0,}x$',
      'Read:^/tmp/(?:.*)(?:.*)(?:.*)x$',
    ]) {
      expect(classifyPathShape(v).structural, v).toBe(true);
    }
  });

  it('scores the two shapes the old guard named as unbounded, not merely high', () => {
    for (const v of ['^/tmp/(?:a+)+$', '^/tmp/(a*)*', '^/tmp/(?:a?b?)+$', '^/tmp/(a|a)+$']) {
      expect(backtrackingDegree(v), v).toBe(Infinity);
    }
  });

  it('leaves every legitimate path rule at or under the cap', () => {
    // Measured through `allows()` at a 1024-character path: degree 1 is 0.01ms, degree 2 is
    // 0.89ms, degree 3 is 228ms. The cap sits between the last two.
    for (const [v, degree] of [
      ['Write:^/tmp/', 0], ['Write:^/tmp/.*', 1], ['Write:^/tmp/[^/]+\\.json$', 1],
      ['Write:^/tmp/(x)+', 1], ['Write:^/tmp/(?:outpost)?', 0], ['Read:^/tmp/(a|b)?', 0],
      ['Write:^/tmp/(?:outpost|scratch)/', 0], ['Write:^/tmp/.*/.*', 2],
    ] as [string, number][]) {
      expect(backtrackingDegree(v.slice(v.indexOf(':') + 1)), v).toBe(degree);
      expect(lintPermissionRule('path', v, false).ok, v).toBe(true);
    }
  });

  it('answers in bounded time on the pattern it now refuses', () => {
    const started = Date.now();
    for (const k of [12, 96]) classifyPathShape(poly(k));
    expect(Date.now() - started).toBeLessThan(100);
  });
});

// The cost function's first version scored quantifier *stacking*, so the same ambiguity it
// refuses as `(a|a)+` walked past when spelled as concatenation: `(a|a)` written out 30 times is
// 158 characters, under the length cap, with no quantified group anywhere — and 26.0s through
// `allows()` for a 38-character path (k=20 → 35ms, k=24 → 302ms, k=30 → 26s: doubling, not
// polynomial). Ambiguity is the property worth scoring; quantification is only one way to repeat
// something.
describe('an ambiguous alternation costs the same repeated by concatenation as by a quantifier', () => {
  const unrolled = (frag: string, k: number) => `Write:^/tmp/${frag.repeat(k)}x$`;

  it('refuses the unrolled spelling of the group it already refuses quantified', () => {
    expect(backtrackingDegree('^/tmp/(a|a)+$')).toBe(Infinity);
    expect(unrolled('(a|a)', 30).length - 'Write:'.length).toBe(158);
    for (const k of [3, 8, 20, 30]) {
      const v = unrolled('(a|a)', k);
      expect(backtrackingDegree(v.slice(v.indexOf(':') + 1)), v).toBe(k);
      expect(classifyPathShape(v).structural, v).toBe(true);
      expect(lintPermissionRule('path', v, true).ok, v).toBe(false);
      expect(() => assertNotWriteShaped('path', v)).toThrow(/backtrack/);
    }
  });

  it('refuses the neighbouring spellings of the same cost', () => {
    // Each of these scored 0 under the stacking model and each is measurably slow through
    // `allows()` at k=20-25: nested alternation (38.2s), an ambiguous alternation made optional
    // rather than repeated (48.5s), a class overlapping its alternative (35.8ms), an optional
    // repeated by concatenation (479ms), a class overlapping the literal beside it (14.6ms).
    // `(a|b|a)` and `(a|ab)` are fast on the inputs tried and refused anyway — the bound is over
    // the pattern, not over the one input someone happened to measure.
    for (const [frag, k] of [
      ['((a|a)|a)', 20], ['(?:a|a)?', 20], ['(a|[ab])', 20], ['(?:a)?', 25],
      ['[ab]?a', 20], ['(a|b|a)', 20], ['(a|ab)', 25], ['(a|)', 20],
    ] as [string, number][]) {
      const v = unrolled(frag, k);
      expect(classifyPathShape(v).structural, v).toBe(true);
    }
  });

  it('leaves a disjoint alternation alone however many times it is repeated', () => {
    // The whole risk of scoring alternation: over-approximating overlap refuses the shipped
    // whitelists. Branches that cannot match the same text are free, at any count.
    for (const v of [
      `Write:^/tmp/${'(a|b)'.repeat(30)}x$`,
      'Write:^/tmp/(?:outpost|scratch)/',
      'Write:^/tmp/(?:list_issues|list_issue_labels)/',
    ]) {
      expect(backtrackingDegree(v.slice(v.indexOf(':') + 1)), v).toBe(0);
      expect(lintPermissionRule('path', v, false).ok, v).toBe(true);
    }
  });

  it('is exact for literal branches and over-approximates for the rest', () => {
    // A first-character test would call `list_teams` and `load_data` ambiguous and refuse the
    // shipped DataDog rule. Literal branches get compared as strings; a prefix relation still
    // counts, because the alternation sits inside a concatenation (`(a|ab)(a|ab)` parses `aab`
    // two ways). Anything not a plain literal falls back to first characters and fails closed.
    expect(backtrackingDegree('^x(list_teams|load_data)$')).toBe(0);
    expect(backtrackingDegree('^x(update_pr|update_pr_branch)$')).toBe(1);
    expect(backtrackingDegree('^x(a|[ab])$')).toBe(1);
    expect(backtrackingDegree('^x(a|\\w)$')).toBe(1);
  });

  it('scores the shipped mcp alternations, including the widest one', () => {
    const incidentIo = '^mcp__incident-io__(.*_show|.*_list|alert_stats|incident_stats'
      + '|follow_up_stats|escalation_stats|ask|ask_incident|ask_telemetry|investigation_sync)$';
    // `ask` is a prefix of `ask_incident`, and `.*_show` can match either — so this really is an
    // ambiguous alternation, and it sits exactly at the cap: one wildcard branch (1) plus the
    // ambiguity (1). Two four-way choices is four paths, not 2^30.
    expect(backtrackingDegree(incidentIo)).toBe(2);
    expect(lintPermissionRule('mcp', incidentIo, false).ok).toBe(true);
  });

  it('bounds `mcp`, where no length cap limits how many times the fragment repeats', () => {
    for (const k of [30, 60, 200]) {
      const v = `^mcp__x__${'(a|a)'.repeat(k)}$`;
      expect(lintPermissionRule('mcp', v, true).ok, v).toBe(false);
    }
  });

  it('answers fast on the patterns it now refuses', () => {
    const started = Date.now();
    for (const frag of ['(a|a)', '((a|a)|a)', '(?:a|a)?']) {
      backtrackingDegree(`^mcp__x__${frag.repeat(200)}$`);
    }
    expect(Date.now() - started).toBeLessThan(100);
  });
});

// A previous round's own report named the consequence of bounding only `path`: "this is now the
// one place where the narrowest rule is not the hardest to install." An `mcp` pattern runs in
// the same synchronous gate, so it takes the same bound. `bash` cannot — see below.
describe('the backtracking bound reaches mcp rules too', () => {
  it('refuses an mcp pattern that backtracks, in a gated group as well', () => {
    for (const v of ['^mcp__github__(?:a+)+$', '^mcp__github__.*.*.*.*x$', '^mcp__(a|a)+push$']) {
      expect(classifyRuleShape('mcp', v).structural, v).toBe(true);
      expect(lintPermissionRule('mcp', v, false).ok, v).toBe(false);
      expect(lintPermissionRule('mcp', v, true).ok, v).toBe(false);
      expect(() => assertNotWriteShaped('mcp', v)).toThrow(/backtrack/);
    }
  });

  it('costs the shipped mcp rules nothing — the widest scores 1 against a cap of 2', () => {
    const mcp = shippedRules().filter((r) => r.kind === 'mcp');
    expect(mcp.length).toBeGreaterThan(10);
    for (const { where, rule } of mcp) {
      expect(backtrackingDegree(rule), `${where}: ${rule}`).toBeLessThanOrEqual(2);
    }
  });
});

// The honest half of that symmetry: `bash` takes neither the length cap nor the degree bound,
// and the reason is measured rather than asserted. The shipped `pull`/`push`/`read` whitelists
// are long and deliberately intricate — and empirically fast, because each iteration of their
// repeated groups is pinned to a mandatory literal that a degree count cannot see. A bound that
// refuses a third of them to close a cost nobody can make bite is the wrong bound. This test
// exists so that claim stays true rather than becoming folklore.
describe('the bash whitelists are why the bound stops where it does', () => {
  const bash = () => shippedRules().filter((r) => r.kind === 'bash');

  it('records how badly the path bound would misfire on them', () => {
    const rules = bash();
    expect(rules.length).toBeGreaterThan(60);
    const overLength = rules.filter((r) => r.rule.length > 200);
    const unbounded = rules.filter((r) => backtrackingDegree(r.rule) === Infinity);
    // Smaller than it was: `push` used to contribute most of these and now contributes none.
    // What remains is `pull` plus the action-local curl whitelists, which are still pinned to a
    // host and still legitimately intricate — so the argument the bound would misfire on real
    // rules is unchanged, it just rests on fewer of them.
    expect(overLength.length).toBeGreaterThan(5);
    expect(unbounded.length).toBeGreaterThan(5);
    expect(Math.max(...rules.map((r) => r.rule.length))).toBeGreaterThan(800);
  });

  it('shows those same rules answering fast on input built to make them backtrack', () => {
    // Probes are grown from each rule's own literal head, then padded with the separators and
    // flag-shaped fragments its groups are written to chew on, and terminated so the match
    // fails — the condition under which a backtracking regex does its worst.
    const fillers = [' ', ' -', ' a', ' -a', ' -fsSL', ' --header x', '/a', ' https://x/'];
    let worst = 0;
    for (const { rule } of bash()) {
      const re = new RegExp(rule);
      const head = (/^\^([A-Za-z0-9 _/.-]*)/.exec(rule)?.[1] ?? '').trimEnd();
      for (const filler of fillers) {
        for (const reps of [20, 40, 80]) {
          const started = performance.now();
          re.test(`${head}${filler.repeat(reps)}`);
          worst = Math.max(worst, performance.now() - started);
        }
      }
    }
    // Measured at 0.32ms for the slowest of the 76; the assertion is loose enough to survive a
    // loaded CI box and still fail on a genuine regression.
    expect(worst).toBeLessThan(50);
  });
});
