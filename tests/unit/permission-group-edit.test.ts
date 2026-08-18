import { describe, it, expect } from 'vitest';
import { Allowlist, type AllowlistConfig } from '../../src/permissions/allowlist.js';
import { validateGroupUpdate } from '../../src/routes/meta.js';
import type { PermissionGroupMap } from '../../src/actions/types.js';
import groupsJson from '../../config/permission-groups.default.json' with { type: 'json' };

const groups = groupsJson as unknown as PermissionGroupMap;

// `edit` shipped five interpreter/build-tool entries unanchored: `^npx(\s|$)`,
// `^(tsx|node|tsc|vitest|jest|playwright|eslint|prettier)(\s|$)`, `^go(\s|$)`, `^make(\s|$)`,
// `^mage(\s|$)`. `node -e "…"` (arbitrary code), `go run ./x` (compiles and runs anything),
// and a bare `npx <package>` (downloads and executes anything) were all auto-approved for
// every action inheriting the group — this file is the enforcement that they no longer are.
function editGroupChecker(): AllowlistConfig {
  const merged: AllowlistConfig = {
    alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  for (const name of ['core', 'read', 'edit'] as const) {
    const g = groups[name] as AllowlistConfig;
    for (const x of g.alwaysAllow) merged.alwaysAllow.push(x);
    for (const x of g.alwaysAllowBashPatterns) merged.alwaysAllowBashPatterns.push(x);
    for (const x of g.alwaysAllowMcpPatterns) merged.alwaysAllowMcpPatterns.push(x);
    for (const x of g.alwaysAllowPathPatterns ?? []) merged.alwaysAllowPathPatterns!.push(x);
  }
  return merged;
}

const al = new Allowlist(editGroupChecker());
const allows = (command: string) => al.allows('Bash', { command });

describe('the edit group anchors every interpreter it grants', () => {
  it('allows the evidenced build/test invocations', () => {
    for (const c of [
      'mage',
      'mage proto',
      'npm test',
      'npm run build',
      'yarn test',
      'pnpm install',
      'go test ./...',
      'go build ./...',
      'go vet ./...',
      'pytest',
      'pytest -k thing',
      'cargo test',
      'cargo clippy',
      'turbo test',
      'turbo build --filter=docs',
      'docker info',
      'gofmt -l .',
      'golangci-lint run',
      // npx: no bare grant, but the one documented typecheck invocation is exactly enumerated —
      // all four edit-inheriting actions' SKILL.md say "run linting/type-checking too".
      'npx tsc --noEmit',
    ]) expect(allows(c), c).toBe(true);
  });

  it('denies every arbitrary-code-execution shape the old patterns admitted', () => {
    for (const c of [
      // node/tsx/tsc/vitest/jest/playwright/eslint/prettier: dropped entirely, no evidence.
      'node -e "require(\'fs\').writeFileSync(process.env.HOME+\'/.zshrc\', \'pwned\')"',
      'node script.js',
      'tsx -e "console.log(1)"',
      'tsx watch src/daemon.ts',
      'tsc --noEmit',
      'vitest run',
      'jest',
      'playwright test',
      'eslint .',
      'prettier --write .',
      // npx: no bare grant at all — arbitrary package execution.
      'npx cowsay hi',
      'npx tsc',
      'npx tsc --watch',
      // make: dropped entirely — the danger is in the target, not the command line.
      'make',
      'make anything',
      'make deploy',
      // go: only test/build/vet are named; run/generate execute arbitrary code.
      'go run ./x',
      'go generate ./...',
      // mage: only its two evidenced targets are named.
      'mage clean',
      'mage deploy',
      // docker: only the read-only status check is named.
      'docker run -v /:/host alpine',
      'docker exec -it x sh',
    ]) expect(allows(c), c).toBe(false);
  });
});

describe('the edit group still survives its own editor with interpreters anchored', () => {
  it('validateGroupUpdate accepts the shipped edit group', () => {
    const r = validateGroupUpdate('edit', groups.edit!);
    expect(r.ok === false ? r.error : 'ok').toBe('ok');
  });
});
