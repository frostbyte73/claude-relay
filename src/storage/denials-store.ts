import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Every tool call an action session had blocked by allowlist-miss, with the rule that
// would have let it through. A denial that keeps recurring is direct evidence the
// action's permissions or its instructions are wrong, so these outlive the process
// that observed them — they used to be a Map that died with every daemon restart.

export interface ActionDenial {
  id: string;
  actionName: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  suggested: { kind: 'tool' | 'bash' | 'mcp' | 'path'; value: string };
  at: number;
  count: number;
  runId?: string;
}

interface Persisted {
  byAction?: Record<string, ActionDenial[]>;
}

const DENIALS_PER_ACTION = 50;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class DenialsStore {
  private byAction = new Map<string, ActionDenial[]>();

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!existsSync(path)) return;
    let parsed: Persisted;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Persisted; }
    catch { return; }
    const cutoff = this.now() - MAX_AGE_MS;
    for (const [name, list] of Object.entries(parsed.byAction ?? {})) {
      const kept = (Array.isArray(list) ? list : []).filter((d) => d?.at >= cutoff);
      if (kept.length) this.byAction.set(name, kept.slice(0, DENIALS_PER_ACTION));
    }
  }

  record(input: Omit<ActionDenial, 'id' | 'at' | 'count'>): ActionDenial {
    const list = this.byAction.get(input.actionName) ?? [];
    const existing = list.find((d) =>
      d.toolName === input.toolName
      && d.suggested.kind === input.suggested.kind
      && d.suggested.value === input.suggested.value);
    let denial: ActionDenial;
    if (existing) {
      existing.count += 1;
      existing.at = this.now();
      existing.sessionId = input.sessionId;
      if (input.runId) existing.runId = input.runId;
      denial = existing;
    } else {
      denial = { ...input, id: randomUUID(), at: this.now(), count: 1 };
      list.unshift(denial);
      if (list.length > DENIALS_PER_ACTION) list.length = DENIALS_PER_ACTION;
    }
    this.byAction.set(input.actionName, list);
    this.persist();
    return denial;
  }

  list(action: string): ActionDenial[] { return this.byAction.get(action) ?? []; }

  all(): Record<string, ActionDenial[]> { return Object.fromEntries(this.byAction); }

  dismiss(action: string, id: string): boolean {
    const list = this.byAction.get(action);
    if (!list) return false;
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    if (next.length === 0) this.byAction.delete(action);
    else this.byAction.set(action, next);
    this.persist();
    return true;
  }

  clear(action: string): boolean {
    if (!this.byAction.delete(action)) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify({ byAction: Object.fromEntries(this.byAction) }, null, 2) + '\n');
  }
}
