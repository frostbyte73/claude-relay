import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionGroupRevisionsStore } from '../../src/storage/permission-group-revisions-store.js';

const G = (patterns: string[]) => ({
  description: 'd',
  alwaysAllow: [], alwaysAllowBashPatterns: patterns,
  alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
});

function store() {
  let t = 1000;
  const path = join(mkdtempSync(join(tmpdir(), 'pgr-')), 'revisions.jsonl');
  return { s: new PermissionGroupRevisionsStore(path, () => (t += 10)), path };
}

describe('PermissionGroupRevisionsStore', () => {
  it('records a revision and lists it newest first', () => {
    const { s } = store();
    s.record({ group: 'read', author: 'user', before: null, after: G(['^ls']) });
    s.record({ group: 'read', author: 'user', before: G(['^ls']), after: G(['^ls', '^sed']) });
    const list = s.list('read');
    expect(list).toHaveLength(2);
    expect(list[0]!.after.alwaysAllowBashPatterns).toEqual(['^ls', '^sed']);
    expect(list[1]!.before).toBeNull();
  });

  it('keeps groups separate', () => {
    const { s } = store();
    s.record({ group: 'read', author: 'user', before: null, after: G(['^ls']) });
    s.record({ group: 'pull', author: 'user', before: null, after: G(['^curl']) });
    expect(s.list('read')).toHaveLength(1);
    expect(s.list('pull')).toHaveLength(1);
  });

  it('survives a reload from disk', () => {
    const { s, path } = store();
    const rec = s.record({ group: 'read', author: 'improver', before: null, after: G(['^ls']) });
    const reopened = new PermissionGroupRevisionsStore(path);
    expect(reopened.get(rec.id)?.author).toBe('improver');
    expect(reopened.list('read')).toHaveLength(1);
  });

  it('tolerates a corrupt line without losing the rest', () => {
    const { s, path } = store();
    s.record({ group: 'read', author: 'user', before: null, after: G(['^ls']) });
    appendFileSync(path, 'not json\n');
    expect(new PermissionGroupRevisionsStore(path).list('read')).toHaveLength(1);
  });
});
