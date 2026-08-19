import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ActionRegistry } from '../../src/actions/index.js';
import { buildActionCatalog } from '../../src/work/envelope.js';
import groups from '../../config/permission-groups.default.json' with { type: 'json' };

// The catalog used to ship every action to every reader. That put a controller's internal
// rounds (code.implement, code.fix-ci, …) in front of meta.orchestrate as if they were job
// steps it could plan, and put both controllers' rosters in front of each other. These pin
// the two slices against the real bundled catalog.

const registry = new ActionRegistry(join(import.meta.dirname, '../../actions'), {
  permissionGroups: groups,
});
registry.load();

const names = (scope: Parameters<typeof buildActionCatalog>[1]) =>
  (buildActionCatalog(registry, scope) ?? []).map((e) => e.name).sort();

describe('plannable scope', () => {
  it('offers the orchestrator only what it may emit as a step', () => {
    expect(names({ kind: 'plannable' })).toEqual([
      'code.orchestrate-pr',
      'code.orchestrate-review',
      'code.review-diff',
      'code.review-ui',
      'code.security-review',
      'meta.wait',
      'read.investigate',
      'write.add-project',
      'write.linear-comment',
      'write.linear-issue',
      'write.run-github-workflow',
    ]);
  });

  it('defaults to plannable, so a new action is visible without opting in', () => {
    const undeclared = registry.listActions()
      .filter((a) => a.frontmatter.outpost.plannable === undefined);
    expect(undeclared.length).toBeGreaterThan(0);
    const planned = new Set(names({ kind: 'plannable' }));
    for (const a of undeclared) expect(planned.has(a.name)).toBe(true);
  });
});

describe('controller scope', () => {
  it('gives each controller its own roster plus itself', () => {
    expect(names({ kind: 'controller', controller: 'code.orchestrate-pr' })).toEqual([
      'code.fix-ci',
      'code.fix-pr-comment',
      'code.implement',
      'code.merge-pr',
      'code.orchestrate-pr',
      'code.plan',
      'code.reply-pr-comments',
      'code.resolve-conflicts',
      'code.review-diff',
      'code.spec',
      'code.triage-pr-comments',
    ]);
    expect(names({ kind: 'controller', controller: 'code.orchestrate-review' })).toEqual([
      'code.orchestrate-review',
      'code.post-pr-review',
      'code.review-diff',
      'code.review-ui',
      'code.security-review',
      'code.submit-pr-verdict',
      'code.verify-resolutions',
    ]);
  });

  // Every row of code.orchestrate-pr's ladder binds a sub-action by name. A name the catalog
  // no longer carries is a step that strands at that row, so the ladder and the roster have
  // to move together.
  it('covers every action code.orchestrate-pr binds in its ladder', () => {
    const visible = new Set(names({ kind: 'controller', controller: 'code.orchestrate-pr' }));
    for (const bound of [
      'code.spec', 'code.plan', 'code.implement', 'code.resolve-conflicts', 'code.fix-ci',
      'code.triage-pr-comments', 'code.reply-pr-comments', 'code.fix-pr-comment', 'code.merge-pr',
    ]) expect(visible.has(bound)).toBe(true);
  });

  it('falls back to the whole catalog rather than stranding an undeclared controller', () => {
    expect(names({ kind: 'controller', controller: 'code.review-diff' }))
      .toEqual(registry.listActions().map((a) => a.name).sort());
  });
});

describe('roster integrity', () => {
  it('is declared by every controller and names only real actions', () => {
    const controllers = registry.listActions()
      .filter((a) => a.frontmatter.outpost.kind === 'step-orchestrator');
    expect(controllers.length).toBeGreaterThan(0);
    for (const c of controllers) {
      const roster = c.frontmatter.outpost.roster;
      expect(roster, `${c.name} declares no roster`).toBeDefined();
      for (const entry of roster ?? []) expect(registry.getAction(entry), entry).toBeDefined();
    }
  });
});
