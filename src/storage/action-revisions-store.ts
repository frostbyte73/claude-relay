import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Every change to an action's SKILL.md, as an append-only event log. Approve used to
// writeFileSync straight over the file, and ~/.outpost/actions is untracked — so an applied
// edit had no prior snapshot, no diff and no way back. A human clicking approve occasionally
// can live with that; a cron rewriting skills cannot.
//
// Bodies are content-addressed under bodies/<sha256>.md: reverting to an earlier text, or
// reapplying an identical one, costs zero bytes. Metadata lines stay small enough to parse
// the whole index at construction, the way ActionRunsStore does.
//
// The body-changing events for one action form a contiguous chain — each event's "before" is
// the previous chain entry's body, never a separately stored copy. applyWrite holds that
// invariant by recording a `drifted` event whenever the on-disk text doesn't match the chain
// head, which is what turns writes the daemon didn't make (setup-actions' cpSync reseed, a
// hand edit, a worktree/runtime desync) into visible history rather than silent holes.

export type ActionEventKind =
  | 'created'
  | 'applied'
  | 'reverted'
  | 'drifted'
  | 'deleted'
  | 'proposed'
  | 'rejected'
  // An improver cycle that examined the action and concluded nothing was worth
  // changing. Carries no body, so it stays out of BODY_CHANGING and off the chain.
  | 'reviewed';

export type ActionAuthor = 'user' | 'improver' | 'external' | 'system';

export type AllowlistRuleKind = 'tool' | 'bash' | 'mcp' | 'path';

export const BODY_CHANGING: ReadonlySet<ActionEventKind> = new Set<ActionEventKind>([
  'created', 'applied', 'reverted', 'drifted', 'deleted',
]);

export interface ActionEvent {
  id: string;
  action: string;
  kind: ActionEventKind;
  at: number;
  author: ActionAuthor;
  bodySha?: string;
  bodyBytes?: number;
  rationale?: string;
  feedback?: string;
  allowlistAdds?: Array<{ kind: AllowlistRuleKind; value: string }>;
  allowlistRemoved?: Array<{ kind: string; value: string }>;
  sessionId?: string;
  runId?: string;
  revertOf?: string;
}

export interface RecordInput {
  action: string;
  kind: ActionEventKind;
  author: ActionAuthor;
  body?: string;
  rationale?: string;
  feedback?: string;
  allowlistAdds?: ActionEvent['allowlistAdds'];
  allowlistRemoved?: ActionEvent['allowlistRemoved'];
  sessionId?: string;
  runId?: string;
  revertOf?: string;
}

export interface ApplyWriteInput extends Omit<RecordInput, 'kind' | 'body'> {
  dir: string;
  body: string;
  kind?: 'applied' | 'reverted';
}

const MAX_EVENTS_PER_ACTION = 200;
const MAX_BODIES_PER_ACTION = 25;

function readSkillMd(dir: string): string | undefined {
  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { return undefined; }
}

export class ActionRevisionsStore {
  private readonly indexPath: string;
  private readonly bodiesDir: string;
  // Oldest-first per action — chain walking reads forward, listByAction reverses for the UI.
  private byAction = new Map<string, ActionEvent[]>();

  constructor(
    dir: string,
    private readonly newId: () => string = () => randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly maxEventsPerAction: number = MAX_EVENTS_PER_ACTION,
    private readonly maxBodiesPerAction: number = MAX_BODIES_PER_ACTION,
  ) {
    this.indexPath = join(dir, 'index.jsonl');
    this.bodiesDir = join(dir, 'bodies');
    mkdirSync(this.bodiesDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  private load(): void {
    if (existsSync(this.indexPath)) {
      let dropped = 0;
      for (const raw of readFileSync(this.indexPath, 'utf8').split('\n')) {
        if (!raw) continue;
        let ev: ActionEvent | undefined;
        try { ev = JSON.parse(raw) as ActionEvent; } catch { dropped += 1; continue; }
        if (!ev?.id || !ev.action || !ev.kind) { dropped += 1; continue; }
        const list = this.byAction.get(ev.action);
        if (list) list.push(ev);
        else this.byAction.set(ev.action, [ev]);
      }
      for (const [action, list] of this.byAction) {
        if (list.length <= this.maxEventsPerAction) continue;
        dropped += list.length - this.maxEventsPerAction;
        this.byAction.set(action, list.slice(-this.maxEventsPerAction));
      }
      if (dropped > 0) this.compact();
    }
    this.gcBodies();
  }

  // Bodies referenced by the newest events, with a separate quota for the chain: a burst of
  // rejected proposals must not evict the chain head, or applyWrite's drift check would see a
  // missing body and record a bogus `drifted` on the next apply.
  private retainedShas(): Set<string> {
    const keep = new Set<string>();
    for (const list of this.byAction.values()) {
      const withBody = list.filter((e) => e.bodySha);
      const chain = withBody.filter((e) => BODY_CHANGING.has(e.kind));
      for (const e of withBody.slice(-this.maxBodiesPerAction)) keep.add(e.bodySha!);
      for (const e of chain.slice(-this.maxBodiesPerAction)) keep.add(e.bodySha!);
    }
    return keep;
  }

  private gcBodies(): void {
    const keep = this.retainedShas();
    let names: string[];
    try { names = readdirSync(this.bodiesDir); } catch { return; }
    for (const name of names) {
      if (keep.has(name.replace(/\.md$/, ''))) continue;
      try { rmSync(join(this.bodiesDir, name)); } catch { /* tolerate */ }
    }
  }

  private compact(): void {
    const all = [...this.byAction.values()].flat().sort((a, b) => a.at - b.at);
    const body = all.map((e) => JSON.stringify(e)).join('\n');
    const tmp = `${this.indexPath}.tmp`;
    writeFileSync(tmp, all.length > 0 ? `${body}\n` : '', { mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  private writeBody(text: string): string {
    const sha = createHash('sha256').update(text).digest('hex');
    const path = join(this.bodiesDir, `${sha}.md`);
    if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600 });
    return sha;
  }

  private chainOf(action: string): ActionEvent[] {
    return (this.byAction.get(action) ?? []).filter((e) => BODY_CHANGING.has(e.kind) && e.bodySha);
  }

  record(input: RecordInput): ActionEvent {
    const event: ActionEvent = {
      id: this.newId(),
      action: input.action,
      kind: input.kind,
      at: this.now(),
      author: input.author,
    };
    if (input.body !== undefined) {
      event.bodySha = this.writeBody(input.body);
      event.bodyBytes = Buffer.byteLength(input.body);
    }
    if (input.rationale) event.rationale = input.rationale;
    if (input.feedback) event.feedback = input.feedback;
    if (input.allowlistAdds?.length) event.allowlistAdds = input.allowlistAdds;
    if (input.allowlistRemoved?.length) event.allowlistRemoved = input.allowlistRemoved;
    if (input.sessionId) event.sessionId = input.sessionId;
    if (input.runId) event.runId = input.runId;
    if (input.revertOf) event.revertOf = input.revertOf;

    // Blob first, then metadata: a line must never reference a body that isn't on disk.
    appendFileSync(this.indexPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    const list = this.byAction.get(event.action);
    if (list) list.push(event);
    else this.byAction.set(event.action, [event]);
    return event;
  }

  // The only sanctioned way to change an action's SKILL.md.
  applyWrite(input: ApplyWriteInput): ActionEvent {
    const { action, dir, body, kind, ...meta } = input;
    const chain = this.chainOf(action);
    const last = chain[chain.length - 1];
    // A deleted action starts a fresh chain — recreating it is a `created`, not drift off the
    // body it had before deletion.
    const head = last && last.kind !== 'deleted' ? last : undefined;
    const onDisk = readSkillMd(dir);

    // Genesis and drift describe on-disk state already observed, so they hold whether or not
    // the write below then succeeds. A failed write leaves no phantom `applied`.
    if (!head) {
      if (onDisk !== undefined) {
        this.record({
          action, kind: 'created', author: 'system', body: onDisk,
          rationale: 'genesis snapshot of the pre-existing SKILL.md',
        });
      }
    } else if (this.bodyFor(head.bodySha) !== onDisk) {
      this.record({ action, kind: 'drifted', author: 'external', body: onDisk ?? '' });
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body);

    const terminal: ActionEventKind = kind ?? (!head && onDisk === undefined ? 'created' : 'applied');
    return this.record({ ...meta, action, kind: terminal, body });
  }

  noteDeleted(action: string, dir: string): ActionEvent | undefined {
    const body = readSkillMd(dir);
    if (body === undefined) return undefined;
    return this.record({ action, kind: 'deleted', author: 'user', body });
  }

  bodyFor(sha: string | undefined): string | undefined {
    if (!sha) return undefined;
    try { return readFileSync(join(this.bodiesDir, `${sha}.md`), 'utf8'); } catch { return undefined; }
  }

  listByAction(action: string, opts: { limit?: number } = {}): ActionEvent[] {
    const rows = [...(this.byAction.get(action) ?? [])].reverse();
    return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  eventById(action: string, id: string): ActionEvent | undefined {
    return (this.byAction.get(action) ?? []).find((e) => e.id === id);
  }

  previousBodyOf(action: string, eventId: string): string | undefined {
    const chain = this.chainOf(action);
    const idx = chain.findIndex((e) => e.id === eventId);
    if (idx <= 0) return undefined;
    return this.bodyFor(chain[idx - 1]!.bodySha);
  }

  headBodyAt(action: string, at: number): string | undefined {
    const upTo = this.chainOf(action).filter((e) => e.at <= at);
    return this.bodyFor(upTo[upTo.length - 1]?.bodySha);
  }
}
