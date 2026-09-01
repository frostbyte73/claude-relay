import { describe, it, expect } from 'vitest';
import { classifyRuleShape, classifyInterpreterShape, classifyHttpWriteShape, assertNotWriteShaped, MCP_WRITE_PROBES } from '../../src/permissions/write-shape.js';
import { classifyTool } from '../../src/permissions/tool-classify.js';

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

  it('still refuses eval-shaped or arbitrary-content alternations, even unidentified (gap narrowed)', () => {
    // The anchoring check above is still a known gap — a bare, unidentified binary alternation
    // slips past it — but an alternation that also hands over an eval flag or arbitrary
    // trailing content doesn't need the binary identified to be refused.
    expect(interp('^(bash) -c .*$')).toBe(true);
    expect(interp('^(node) -e .*$')).toBe(true);
    expect(interp('^(python3) -c "x"$')).toBe(true);
    expect(interp('^(node|python3) .*$')).toBe(true);
  });
});

describe('classifyRuleShape — gh write verbs the probe corpus was missing', () => {
  // A rule scoped to one exact write endpoint never matches a probe corpus by shape alone
  // unless the corpus names that exact endpoint. These five close the `gh workflow`/`secret`/
  // `repo`/`cache` gap the load-time audit found in real, persisted actions.json rules.
  it('refuses the five new gh write probes at their own bare grant', () => {
    for (const v of ['^gh workflow run(\\s|$)', '^gh secret set(\\s|$)',
                     '^gh repo create(\\s|$)', '^gh repo delete(\\s|$)', '^gh cache delete(\\s|$)']) {
      expect(shaped('bash', v), v).toBe(true);
    }
  });

  it('refuses the narrow persisted rules the load-time audit flagged', () => {
    expect(shaped('bash', '^gh workflow (run|view|list)(\\s|$)')).toBe(true);
    expect(shaped('bash', '^gh workflow (run|view|list)\\b')).toBe(true);
    expect(shaped('bash', '^gh workflow run ')).toBe(true);
  });

  it('still permits the read-only workflow/cache verbs', () => {
    expect(shaped('bash', '^gh workflow view(\\s|$)')).toBe(false);
    expect(shaped('bash', '^gh cache list(\\s|$)')).toBe(false);
  });

  it('catches a regex-obfuscated gh api write by compiling it, not by reading it', () => {
    // The sound half of the net: each of these permits the literal probe string
    // `gh api --method POST repos/o/r/issues`, so compiling the candidate and testing it
    // decides the question that scanning its source text cannot.
    for (const v of ['^gh api --method P.ST repos/o/r/issues$',
                     '^gh api --method P(O)ST repos/o/r/issues$',
                     '^gh api --method PO*ST repos/o/r/issues$',
                     '^gh api --method [P][O][S][T] repos/o/r/issues$']) {
      expect(shaped('bash', v), v).toBe(true);
    }
    expect(shaped('bash', '^gh api -X POST repos/o/r/issues$')).toBe(true);
    expect(shaped('bash', '^gh api --method PATCH repos/o/r/issues/[0-9]+$')).toBe(true);
    expect(shaped('bash', '^gh api --input /tmp/body\\.json --method POST repos/o/r/issues$'))
      .toBe(true);
  });

  it('still permits a GET-only gh api rule against the widened corpus', () => {
    expect(shaped('bash', '^gh api --method GET repos/o/r/issues$')).toBe(false);
    expect(shaped('bash', '^gh api repos/o/r/issues$')).toBe(false);
  });
});

describe('classifyHttpWriteShape', () => {
  const httpShaped = (v: string) => classifyHttpWriteShape('bash', v).writeShaped;

  it('refuses -T/--upload-file and -o/--output on any tool, not just gh api', () => {
    expect(httpShaped('^curl -T /tmp/x https://example\\.com/upload$')).toBe(true);
    expect(httpShaped('^curl --upload-file /tmp/x https://example\\.com/upload$')).toBe(true);
    expect(httpShaped('^curl -o /tmp/x https://example\\.com/x$')).toBe(true);
    expect(httpShaped('^wget --output /tmp/x https://example\\.com/x$')).toBe(true);
  });

  it('does not false-positive the unconditional flags on unrelated tokens', () => {
    // `-fsS` (a read-only curl cluster) and `--connect-timeout` both contain a `-` immediately
    // before a letter that is not `T`/`o` on its own — the (?![A-Za-z-]) guard must not fire.
    expect(httpShaped('^curl -fsS https://example\\.com$')).toBe(false);
    expect(httpShaped('^curl --connect-timeout 5 https://example\\.com$')).toBe(false);
  });

  it('refuses a non-GET method or a body-sending flag on gh api', () => {
    expect(httpShaped('^gh api --method POST repos/o/r/issues$')).toBe(true);
    expect(httpShaped('^gh api -X PUT repos/o/r/x$')).toBe(true);
    expect(httpShaped('^gh api repos/o/r/issues -f title=x$')).toBe(true);
    expect(httpShaped('^gh api repos/o/r/issues --field title=x$')).toBe(true);
    expect(httpShaped('^gh api repos/o/r/issues --input /tmp/body\\.json$')).toBe(true);
  });

  it('permits GET on gh api and ignores POST/-f entirely on curl', () => {
    expect(httpShaped('^gh api --method GET repos/o/r/issues$')).toBe(false);
    expect(httpShaped('^gh api repos/o/r/issues$')).toBe(false);
    // curl is not method-semantic the way gh api is — GraphQL, RPC, and search APIs all read
    // over POST, and `-f` is not even a curl flag with a body-sending meaning.
    expect(httpShaped('^curl -X POST https://api\\.example\\.com/graphql$')).toBe(false);
  });

  it('the six cases the coordinator asked to be pinned', () => {
    const replies = '^gh api[ \\t]+(?:--method|-X)(?:[ \\t]+|=)POST[ \\t]+["\']?repos/\\{owner\\}/\\{repo\\}/pulls/[0-9]+/comments/[0-9]+/replies["\']?[ \\t]+(?:-f(?:[ \\t]+|=)body=(?:"[^"$`\\n]*"|\'[^\'\\n]*\'|[A-Za-z0-9_./][^\\s"\'$`\\n]*)|--input(?:[ \\t]+|=)["\']?/tmp/[A-Za-z0-9_][A-Za-z0-9._-]*["\']?)[ \\t]*$';
    const broadCurlPost = '^curl -X POST ';
    const metaOrchestrateLinear = '^curl(?:(?:\\s|\\\\\\n)+(?:-[fsSL]+|--(?:silent|fail|show-error|location|compressed)|(?:--max-time|--connect-timeout|-H|--header)(?:(?:\\s|\\\\\\n)+|=)(?:"(?![^"\\n]*\\$\\()[^-"\\n`][^"\\n`]*"|\'[^-\'\\n][^\'\\n]*\'|[A-Za-z0-9_$./][^\\s"\'()`<>&|;\\\\]*)|(?:-X|--request)(?:(?:\\s|\\\\\\n)+|=)POST|(?:-d|--data)(?:(?:\\s|\\\\\\n)+|=)\'(?![^\']*(?:mutation|subscription))\\{\\s*"query"\\s*:\\s*"\\s*(?:query\\b|\\{)[^\']*\'))*(?:\\s|\\\\\\n)+["\']?https://api\\.linear\\.app/graphql["\']?(?:(?:\\s|\\\\\\n)+(?:-[fsSL]+|--(?:silent|fail|show-error|location|compressed)|(?:--max-time|--connect-timeout|-H|--header)(?:(?:\\s|\\\\\\n)+|=)(?:"(?![^"\\n]*\\$\\()[^-"\\n`][^"\\n`]*"|\'[^-\'\\n][^\'\\n]*\'|[A-Za-z0-9_$./][^\\s"\'()`<>&|;\\\\]*)|(?:-X|--request)(?:(?:\\s|\\\\\\n)+|=)POST|(?:-d|--data)(?:(?:\\s|\\\\\\n)+|=)\'(?![^\']*(?:mutation|subscription))\\{\\s*"query"\\s*:\\s*"\\s*(?:query\\b|\\{)[^\']*\'))*(?:\\s|\\\\\\n)*$';
    const addProjectLoopback = '^curl -fsS -X POST ("\\$OUTPOST_API_URL"|\\$OUTPOST_API_URL|http://127\\.0\\.0\\.1:[0-9]+)/api/projects\\b';
    const pullCurl = '^curl(?:(?:\\s|\\\\\\n)+(?:-[fsSL]+|--(?:silent|fail|show-error|location|compressed)|(?:--max-time|--connect-timeout|-H|--header)(?:(?:\\s|\\\\\\n)+|=)(?:"[^-"\\n][^"\\n]*"|\'[^-\'\\n][^\'\\n]*\'|[A-Za-z0-9_$./][^\\s"\'<>&|;\\\\]*)|["\']?(?:https?://|\\$\\{?[A-Za-z_])[^\\s"\'<>&|;\\\\]*["\']?))*(?:\\s|\\\\\\n)*$';
    const pullGhApi = '^gh api(?:(?:\\s|\\\\\\n)+(?:--paginate|--slurp|(?:--cache|--hostname|-H|--header|-q|--jq|-t|--template)(?:(?:\\s|\\\\\\n)+|=)(?:"[^-"\\n][^"\\n]*"|\'[^-\'\\n][^\'\\n]*\'|[A-Za-z0-9_$./][^\\s"\'<>&|;\\\\]*)|(?:--method|-X)(?:(?:\\s|\\\\\\n)+|=)GET|(?:"[^-"\\n][^"\\n]*"|\'[^-\'\\n][^\'\\n]*\'|[A-Za-z0-9_$./][^\\s"\'<>&|;\\\\]*)))*(?:\\s|\\\\\\n)*$';
    const ghWorkflowProbe = '^gh workflow (run|view|list)(\\s|$)';

    const refused = (v: string) =>
      classifyRuleShape('bash', v).writeShaped
      || classifyInterpreterShape('bash', v).writeShaped
      || classifyHttpWriteShape('bash', v).writeShaped;

    expect(refused(replies)).toBe(true);
    expect(refused(broadCurlPost)).toBe(true);
    expect(refused(metaOrchestrateLinear)).toBe(false);
    expect(refused(addProjectLoopback)).toBe(false);
    expect(refused(pullCurl)).toBe(false);
    expect(refused(pullGhApi)).toBe(false);
    expect(refused(ghWorkflowProbe)).toBe(true);
  });

  it('refuses a gh api write however the invocation is spelled', () => {
    // classifyRuleShape's probe corpus doesn't name any of these exact invocations, so the
    // catch is entirely classifyHttpWriteShape's — check it directly rather than through
    // `shaped` (classifyRuleShape only), the same way assertNotWriteShaped combines all three.
    for (const v of ['^gh  api --method POST repos/o/r/issues$',
                     '^gh (api|pr) --method POST repos/o/r/issues$',
                     '^/usr/bin/gh api --method POST repos/o/r/issues$',
                     '^(gh|git) api --method POST repos/o/r/issues$']) {
      expect(httpShaped(v), v).toBe(true);
    }
  });

  it('folds case and strips wrappers/quotes off the binary and the method', () => {
    for (const v of ['^gh api --method post repos/o/r/issues$',
                     '^gh api -X Post repos/o/r/issues$',
                     '^"gh" api --method POST repos/o/r/issues$',
                     "^'gh' api --method POST repos/o/r/issues$",
                     '^GH api --method POST repos/o/r/issues$',
                     '^env gh api --method POST repos/o/r/issues$',
                     '^xargs gh api --method POST repos/o/r/issues$',
                     '^nohup gh api --method POST repos/o/r/issues$',
                     '^time gh api --method POST repos/o/r/issues$',
                     '^sudo gh api --method POST repos/o/r/issues$',
                     '^command gh api --method POST repos/o/r/issues$',
                     '^env sudo gh api --method POST repos/o/r/issues$']) {
      expect(httpShaped(v), v).toBe(true);
    }
  });

  it('does not see a metacharacter spliced into a flag name (known gap)', () => {
    // `--fie[l]d` and `-[f]` compile to exactly the flags `--field` and `-f`, but neither
    // appears in the pattern's source text, and no fixed probe corpus can name the arbitrary
    // endpoint each of these pins. Text scanning cannot decide what a regex permits, and
    // trying harder there just moves the evasion one spelling along. `assertNotWriteShaped`
    // permits a rule shaped this way at every non-gated scope — action, colocated
    // `allowlist.json`, global, project — so it is a live gap, not one the gate closes.
    expect(httpShaped('^gh api --fie[l]d title=x repos/o/r/issues$')).toBe(false);
    expect(httpShaped('^gh api -[f] title=x repos/o/r/issues$')).toBe(false);
  });

  it('still permits the pull group\'s gh rule verbatim, breadth pinned in both directions', () => {
    expect(httpShaped(
      '^gh (pr view|pr list|pr checks|pr diff|pr status|run view|run list|run watch|'
      + 'workflow view|workflow list|repo view|issue view|issue list|search|release view|'
      + 'release list|label list|cache list|browse)(\\s|$)')).toBe(false);
  });
});

describe('MCP_WRITE_PROBES pins the Grafana proxy', () => {
  // Verb-agnostic HTTP proxy to the Grafana API — reaches every Grafana write behind one
  // tool name. Pin it so deleting the MCP_WRITE_PROBES entry fails this test rather than
  // silently re-opening the hole (see write-shape.ts's module header on that ruling).
  it('refuses a grant of the raw Grafana API request tool', () => {
    expect(() => assertNotWriteShaped('mcp', '^mcp__grafana__grafana_api_request$')).toThrow();
  });
});

// MCP_WRITE_PROBES is now literally `MCP_WRITE_TOOLS` (write-shape.ts), so a test that compared
// the two arrays would be an identity check — always true regardless of what either list
// contains, and pinning nothing. This frozen list is the pre-derivation Ship 2 probe corpus:
// removing any of these from MCP_WRITE_TOOLS (and so from MCP_WRITE_PROBES, since they're the
// same array) fails this test, which is a real regression to catch — the derivation only
// guarantees the two lists agree with EACH OTHER, not that either still names these writes.
const MUST_ALWAYS_BE_PROBED: readonly string[] = [
  'mcp__github__merge_pull_request',
  'mcp__github__create_pull_request',
  'mcp__github__create_or_update_file',
  'mcp__github__delete_file',
  'mcp__github__push_files',
  'mcp__github__create_branch',
  'mcp__github__create_repository',
  'mcp__claude_ai_Linear__save_issue',
  'mcp__claude_ai_Linear__save_comment',
  'mcp__claude_ai_Linear__save_document',
  'mcp__claude_ai_Linear__save_project',
  'mcp__claude_ai_Linear__delete_comment',
  'mcp__grafana__grafana_api_request',
];

describe('the probe corpus always covers these writes, drift or no drift', () => {
  it('never drops one of the writes Ship 2 ruled must always be probed', () => {
    for (const t of MUST_ALWAYS_BE_PROBED) expect(MCP_WRITE_PROBES, t).toContain(t);
  });

  it('classifies every MCP probe as an external write', () => {
    for (const p of MCP_WRITE_PROBES) expect(classifyTool(p).effect, p).toBe('external-write');
  });
});
