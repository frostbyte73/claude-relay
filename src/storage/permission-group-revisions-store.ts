import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionGroup } from '../actions/types.js';

// Permission groups are the only thing that grants an action anything, so an edit to one
// is a security change and needs the audit trail actions already get. Groups are small
// JSON, so full before/after snapshots are cheaper than the content-addressed bodies
// action-revisions-store.ts needs — a revision is directly revertable with no chain to walk.

export type GroupAuthor = 'user' | 'improver' | 'system';

export interface GroupRevision {
  id: string;
  group: string;
  at: number;
  author: GroupAuthor;
  rationale?: string;
  before: PermissionGroup | null;
  after: PermissionGroup;
  revertOf?: string;
}

const MAX_PER_GROUP = 200;

export class PermissionGroupRevisionsStore {
  private readonly byGroup = new Map<string, GroupRevision[]>();
  private readonly byId = new Map<string, GroupRevision>();

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rev: GroupRevision;
      try { rev = JSON.parse(line) as GroupRevision; } catch { continue; }
      if (!rev?.id || !rev.group) continue;
      this.index(rev);
    }
  }

  record(input: Omit<GroupRevision, 'id' | 'at'>): GroupRevision {
    const rev: GroupRevision = { ...input, id: randomUUID(), at: this.now() };
    this.index(rev);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(rev) + '\n', { mode: 0o600 });
    return rev;
  }

  list(group: string): GroupRevision[] {
    return [...(this.byGroup.get(group) ?? [])].reverse();
  }

  get(id: string): GroupRevision | undefined {
    return this.byId.get(id);
  }

  private index(rev: GroupRevision): void {
    const list = this.byGroup.get(rev.group) ?? [];
    list.push(rev);
    if (list.length > MAX_PER_GROUP) list.splice(0, list.length - MAX_PER_GROUP);
    this.byGroup.set(rev.group, list);
    this.byId.set(rev.id, rev);
  }
}
