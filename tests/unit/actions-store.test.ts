import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionsStore } from '../../src/storage/actions-store.js';

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'act-store-')), 'actions.json');
}

describe('ActionsStore', () => {
  it('returns defaults for unknown action', () => {
    const s = new ActionsStore(tmpPath());
    expect(s.get('foo')).toEqual({
      allowlist: { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] },
    });
  });

  it('persists allowlist rules across instances', () => {
    const path = tmpPath();
    const s1 = new ActionsStore(path);
    // Any addable rule will do — the subject is persistence and dedupe. A whole-tool `Edit`
    // (what this used to say) is a write grant the lint now refuses at addRule.
    expect(s1.addRule('meta.orchestrate', 'tool', 'NotebookRead')).toBe(true);
    expect(s1.addRule('meta.orchestrate', 'tool', 'NotebookRead')).toBe(false);

    const s2 = new ActionsStore(path);
    const w = s2.get('meta.orchestrate');
    expect(w.allowlist.alwaysAllow).toContain('NotebookRead');
  });

  it('persists path rules across instances', () => {
    const path = tmpPath();
    const s1 = new ActionsStore(path);
    expect(s1.addRule('meta.orchestrate', 'path', 'Write:^/tmp/')).toBe(true);

    const s2 = new ActionsStore(path);
    expect(s2.get('meta.orchestrate').allowlist.alwaysAllowPathPatterns).toContain('Write:^/tmp/');
  });

  it('starts empty on malformed json', () => {
    const path = tmpPath();
    writeFileSync(path, '{not json');
    const s = new ActionsStore(path);
    expect(s.list()).toEqual({});
    s.addRule('x', 'tool', 'Read');
    const reloaded = JSON.parse(readFileSync(path, 'utf8'));
    expect(reloaded.actions.x.allowlist.alwaysAllow).toContain('Read');
  });

  it('deleteAction removes the entry', () => {
    const s = new ActionsStore(tmpPath());
    s.addRule('foo', 'tool', 'Read');
    expect(s.deleteAction('foo')).toBe(true);
    expect(s.deleteAction('foo')).toBe(false);
    expect(s.get('foo').allowlist.alwaysAllow).toEqual([]);
  });

  it('removeRule drops an exact value and persists', () => {
    const path = tmpPath();
    const s1 = new ActionsStore(path);
    s1.addRule('foo', 'bash', '^ls ');
    s1.addRule('foo', 'bash', '^rg ');
    expect(s1.removeRule('foo', 'bash', '^ls ')).toBe(true);

    const s2 = new ActionsStore(path);
    expect(s2.get('foo').allowlist.alwaysAllowBashPatterns).toEqual(['^rg ']);
  });

  it('removeRule reports false for absent values, unknown actions and the wrong kind', () => {
    const s = new ActionsStore(tmpPath());
    s.addRule('foo', 'tool', 'Read');
    expect(s.removeRule('foo', 'tool', 'Write')).toBe(false);
    expect(s.removeRule('nope', 'tool', 'Read')).toBe(false);
    expect(s.removeRule('foo', 'bash', 'Read')).toBe(false);
    expect(s.get('foo').allowlist.alwaysAllow).toEqual(['Read']);
  });
});
