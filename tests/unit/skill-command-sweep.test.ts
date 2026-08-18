import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Allowlist } from '../../src/permissions/allowlist.js';
import { ActionRegistry } from '../../src/actions/index.js';
import groups from '../../config/permission-groups.default.json' with { type: 'json' };
import globalAllowlist from '../../config/allowlist.default.json' with { type: 'json' };

const root = join(import.meta.dirname, '../..');
const registry = new ActionRegistry(join(root, 'actions'), { permissionGroups: groups });
const load = registry.load();
const al = new Allowlist(globalAllowlist, { actionRegistry: registry });

// A rule that denies what its own SKILL.md instructs stalls that action forever: an
// action-bound session gets no approval prompt, it just fails and journals a blocker. These
// are the real, placeholder-substituted forms of the commands the shipped SKILLs document.
const CASES: Array<[string, string]> = [
  ['code.fix-ci', 'gh run view 8123456 --log-failed'],
  ['code.merge-pr', 'gh pr merge 12 --squash'],
  ['code.orchestrate-review', 'git fetch origin main'],
  ['code.post-pr-review', 'gh api --method POST "repos/{owner}/{repo}/pulls/12/reviews" --input /tmp/outpost-review-12.json'],
  ['code.reply-pr-comments', 'gh api "repos/{owner}/{repo}/pulls/12/comments" --paginate --jq \'.[] | "\\(.node_id)"\''],
  ['code.reply-pr-comments', 'gh pr comment 12 --body-file /tmp/outpost-reply-9.md'],
  ['code.fix-ci', 'gh pr checks 12 --watch=false  # one shot, no polling'],
  ['code.resolve-conflicts', 'git fetch origin'],
  // Ship 5 re-review: the SKILL.md was rewritten to write the base ref literally into the
  // merge command rather than through a shell variable — `git merge "$BASE"` let a
  // flag-shaped `boundNote` override (`-s ours`, `-Xtheirs`) reach git as a merge option,
  // which quoting the variable does nothing to stop. This is the corrected literal form.
  ['code.resolve-conflicts', 'git merge origin/main'],
  ['code.submit-pr-verdict', 'gh pr review 12 --approve --body-file /tmp/outpost-verdict-12.md'],
  ['write.add-project', 'gh repo clone acme/example /Users/dc/acme/example'],
  ['write.add-project', 'git clone https://github.com/acme/example.git /Users/dc/acme/example'],
  ['write.add-project', 'mkdir -p /Users/dc/acme'],
  ['write.add-project', 'git -C /Users/dc/acme/example log -1 --oneline'],
  ['write.run-github-workflow', 'gh workflow run "deploy.yml" --ref "main"'],
  ['write.run-github-workflow', 'gh run watch 8123456 --interval 60 --exit-status'],
];

describe('the real substituted form of every documented SKILL command', () => {
  it('is permitted by its own action grant', async () => {
    await load;
    const denied = CASES.filter(([a, c]) => !al.allows('Bash', { command: c }, undefined, a));
    expect(denied.map(([a, c]) => `${a}: ${c}`)).toEqual([]);
  });
});
