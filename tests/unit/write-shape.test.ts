import { describe, it, expect } from 'vitest';
import { classifyRuleShape, classifyInterpreterShape } from '../../src/permissions/write-shape.js';

const shaped = (kind: 'tool' | 'bash' | 'mcp' | 'path', v: string) =>
  classifyRuleShape(kind, v).writeShaped;

describe('classifyRuleShape refuses the rules the Allow button used to offer', () => {
  // Every one of these was actually suggested by denial-suggestion.ts against a real
  // action. `^gh(\s|$)` on code.merge-pr is the traced `gh pr merge --admin` bypass.
  it('refuses bare-binary grants of write-capable tools', () => {
    for (const v of ['^git(\\s|$)', '^git ', '^gh(\\s|$)', '^gh ', '^curl(\\s|$)']) {
      expect(shaped('bash', v), v).toBe(true);
    }
  });

  it('refuses a pattern that matches a force push or an admin merge', () => {
    expect(shaped('bash', '^git push')).toBe(true);
    expect(shaped('bash', '^gh pr merge')).toBe(true);
    expect(shaped('bash', '^gh api --method DELETE ')).toBe(true);
  });

  it('refuses a whole-tool Bash grant', () => {
    expect(shaped('tool', 'Bash')).toBe(true);
  });

  it('refuses an MCP pattern spanning a write tool', () => {
    expect(shaped('mcp', '^mcp__github__')).toBe(true);
    expect(shaped('mcp', '^mcp__claude_ai_Linear__')).toBe(true);
  });

  it('still refuses the bare form of those same binaries', () => {
    for (const v of ['^npm(\\s|$)', '^npm ', '^kubectl(\\s|$)']) {
      expect(shaped('bash', v), v).toBe(true);
    }
  });

  it('refuses a subcommand-constrained rule that still spans a write', () => {
    for (const v of ['^kubectl (get|apply|delete)(\\s|$)',
                     '^terraform (plan|apply)(\\s|$)',
                     '^helm (list|install)(\\s|$)']) {
      expect(shaped('bash', v), v).toBe(true);
    }
  });

  it('refuses the unanchored yarn/pnpm grant and permits the narrowed one', () => {
    expect(shaped('bash', '^(yarn|pnpm)(\\s|$)')).toBe(true);
    expect(shaped('bash', '^(yarn|pnpm) (install|run|test|add|remove)(\\s|$)')).toBe(false);
  });
});

describe('classifyRuleShape permits the rules actions actually need', () => {
  it('permits the read and edit tooling from the denial log', () => {
    for (const v of ['^sed(\\s|$)', '^awk(\\s|$)', '^rg(\\s|$)', '^vale(\\s|$)',
                     '^protoc(\\s|$)', '^turbo(\\s|$)', '^git status', '^git log ']) {
      expect(shaped('bash', v), v).toBe(false);
    }
  });

  it('permits the anchored push rules the push group already ships', () => {
    // These live in a gated group, so the lint must not condemn them on reload —
    // Task 7 permits write-shaped rules into gated groups, but these are narrow
    // enough that they never reach that branch.
    expect(shaped('bash', '^git push origin [A-Za-z0-9._/-]+$')).toBe(false);
  });

  it('permits read-only MCP patterns', () => {
    expect(shaped('mcp', '^mcp__github__(get|list|search)')).toBe(false);
    expect(shaped('mcp', '^mcp__claude_ai_Linear__(get_|list_|search_)')).toBe(false);
  });

  it('permits non-Bash whole-tool grants and path rules', () => {
    expect(shaped('tool', 'Read')).toBe(false);
    expect(shaped('path', 'Write:^/tmp/')).toBe(false);
  });

  it('permits a binary-with-subcommand rule from a shipped group', () => {
    for (const v of ['^npm (test|run|install|ci)(\\s|$)',
                     '^git (status|log|diff|show|blame|branch)(\\s|$)',
                     '^gh (pr view|pr list|pr checks|pr diff)(\\s|$)',
                     '^kubectl (get|describe|logs|top)(\\s|$)',
                     '^cargo (build|test|check|clippy|fmt)(\\s|$)']) {
      expect(shaped('bash', v), v).toBe(false);
    }
  });
});

describe('classifyRuleShape fails closed', () => {
  it('refuses a pattern that does not compile', () => {
    const v = classifyRuleShape('bash', '^git push (');
    expect(v.writeShaped).toBe(true);
    expect(v.reason).toMatch(/compile/i);
  });

  it('gives a reason naming the probe it matched', () => {
    expect(classifyRuleShape('bash', '^gh(\\s|$)').reason).toContain('gh pr merge');
  });

  it('classifies an escaped-metacharacter prefix the same as its unescaped equivalent', () => {
    // Escaping the path separators is a no-op for what the regex matches, but each `\/`
    // consumes two pattern characters while contributing only one to the literal prefix —
    // exactly the case that misaligns the bare-binary check's `rest` slice if unhandled.
    const escaped = '^\\/usr\\/local\\/bin\\/git(\\s|$)';
    const unescaped = '^/usr/local/bin/git(\\s|$)';
    expect(shaped('bash', escaped)).toBe(shaped('bash', unescaped));
    expect(shaped('bash', escaped)).toBe(true);
  });
});

const interp = (v: string) => classifyInterpreterShape('bash', v).writeShaped;

describe('classifyInterpreterShape', () => {
  it('permits a fully anchored exact invocation', () => {
    expect(interp('^python3 -m pytest$')).toBe(false);
    expect(interp('^python3 -m pytest tests/unit$')).toBe(false);
    expect(interp('^node scripts/build\\.js$')).toBe(false);
  });

  it('permits an anchored pattern with an enumerated tail', () => {
    expect(interp('^python3 -m pytest(\\s+[A-Za-z0-9._/-]+)*$')).toBe(false);
  });

  it('refuses an unanchored interpreter grant', () => {
    for (const v of ['^python3(\\s|$)', '^python3 ', '^node(\\s|$)', '^docker(\\s|$)']) {
      expect(interp(v), v).toBe(true);
    }
  });

  it('refuses an eval-shaped flag even when anchored', () => {
    expect(interp('^python3 -c "print\\(1\\)"$')).toBe(true);
    expect(interp('^node -e "console\\.log\\(1\\)"$')).toBe(true);
    expect(interp('^python3 --eval x$')).toBe(true);
  });

  it('refuses a bare trailing dash (read program from stdin) even when anchored', () => {
    expect(interp('^python3 -$')).toBe(true);
    expect(interp('^node -$')).toBe(true);
    // still permitted: the anchor stripping must not reopen these
    expect(interp('^python3 -m pytest$')).toBe(false);
    expect(interp('^node scripts/build\\.js$')).toBe(false);
  });

  it('refuses an anchored pattern whose tail admits arbitrary text', () => {
    expect(interp('^python3 .*$')).toBe(true);
  });

  it('refuses any construct that admits arbitrary trailing text', () => {
    for (const v of ['^python3 .*$', '^python3 [\\s\\S]*$', '^python3 (.|\\n)*$', '^python3 [^]*$']) {
      expect(interp(v), v).toBe(true);
    }
  });

  it('still permits an escaped dot and a bounded character class', () => {
    expect(interp('^node scripts/build\\.js$')).toBe(false);
    expect(interp('^python3 -m pytest(\\s+[A-Za-z0-9._/-]+)*$')).toBe(false);
  });

  it('refuses a shorthand-complement class in any spelling', () => {
    for (const v of ['^python3 [\\s\\S]*$', '^python3 [\\S\\s]*$',
                     '^python3 [\\w\\W]*$', '^python3 [\\d\\D]*$']) {
      expect(interp(v), v).toBe(true);
    }
  });

  it('still permits a shorthand outside a character class', () => {
    expect(interp('^python3 -m pytest(\\s+[A-Za-z0-9._/-]+)*$')).toBe(false);
  });

  it('ignores rules that are not interpreter invocations', () => {
    expect(interp('^sed(\\s|$)')).toBe(false);
    expect(interp('^git status')).toBe(false);
  });

  it('does not see an interpreter hidden inside a leading alternation (known gap)', () => {
    // `^(node)(\s|$)` is a working evasion of the anchoring check: the leading `(` yields an
    // empty literal prefix, so the binary is never identified. Closing this needs the `edit`
    // group's own interpreter rules narrowed first — deferred with them.
    expect(interp('^(node)(\\s|$)')).toBe(false);
    expect(interp('^(tsx|node|tsc|vitest)(\\s|$)')).toBe(false);
  });
});
