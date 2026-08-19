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
      // A dependency bump is implementation work, not a privilege: these download and rewrite
      // go.mod/go.sum but run no project code — unlike `npm install` above, which runs whatever
      // postinstall script the registry hands it and has been granted all along.
      'go get github.com/livekit/server-sdk-go/v2@v2.9.0',
      'go get -u ./...',
      'go mod tidy',
      'go mod download',
      'go mod edit -require=github.com/livekit/server-sdk-go/v2@v2.9.0',
      'go mod edit -replace=example.com/a=example.com/b@v1.0.0 -go=1.24',
      'pytest',
      'pytest -k thing',
      'cargo test',
      'cargo clippy',
      'cargo add serde@1.0.200',
      'cargo add --dev tokio --features macros,rt-multi-thread',
      'cargo remove serde',
      'cargo update',
      'cargo update -p serde --precise 1.0.200',
      'cargo update --workspace --dry-run',
      // python-sdks is a uv project (uv.lock), so uv is the evidenced tool, not bare pip.
      // A PEP 508 specifier needs quoting — unquoted `>=` is a shell redirect, not an operand.
      'uv add httpx==0.27.0',
      "uv add 'httpx>=0.27,<0.29'",
      'uv add --dev pytest',
      'uv remove httpx',
      'uv lock --upgrade-package httpx',
      'uv sync',
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
      // go: run/generate execute arbitrary code, and no `go -C <dir>` reaches another module.
      'go run ./x',
      'go generate ./...',
      'go -C /repos/other mod tidy',
      'go tool nm ./x',
      // `go mod edit` takes flags only — a trailing file operand would rewrite a go.mod
      // anywhere on the machine, which nothing in the group's file bars covers.
      'go mod edit -fmt /repos/other/go.mod',
      'go mod edit',
      // the rest of `go mod` isn't evidenced; `go mod vendor` writes a whole tree.
      'go mod vendor',
      'go mod init example.com/x',
      // Every dependency-manifest escape needs a path separator, so no operand may carry one:
      // that one property is what confines cargo/uv to the manifest in their own cwd. `-C` and
      // `--directory` sit before the subcommand, so the leading anchor excludes them outright.
      'cargo add serde --manifest-path /repos/other/Cargo.toml',
      'cargo add serde --manifest-path=../../other/Cargo.toml',
      'cargo update --manifest-path ../sibling/Cargo.toml',
      'cargo add serde --target-dir /etc/ssh',
      'cargo -C /repos/other add serde',
      'uv add httpx --project /repos/other',
      'uv sync --directory ../other',
      'uv --directory ../other add httpx',
      // uv/cargo verbs that run code or install machine-wide are not part of a bump.
      'uv run python -c "import os; os.system(\'id\')"',
      'uv run pytest',
      'uv pip install --system requests',
      'uv tool install ruff',
      'cargo install cargo-audit',
      'cargo run --bin x',
      // bare pip is deliberately absent: with no venv it writes machine-wide site-packages,
      // and no registered project uses it (python-sdks is uv).
      'pip install requests',
      'pip3 install -r requirements.txt',
      'python -m pip install requests',
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
