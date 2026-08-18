import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Every tool call an action session had blocked by allowlist-miss, with the rule that
// would have let it through. A denial that keeps recurring is direct evidence the
// action's permissions or its instructions are wrong, so these outlive the process
// that observed them — they used to be a Map that died with every daemon restart.

export type DenialDisposition = 'promote' | 'never' | 'fix-action';

// What we decided to do about a denial, once. `never` is why this is a stored verdict
// rather than a deletion — "we decided no" has to survive so the next improvement cycle
// does not re-propose the same grant.
export interface DenialVerdict {
  disposition: DenialDisposition;
  group?: string;                                                    // set when disposition === 'promote'
  rule?: { kind: 'tool' | 'bash' | 'mcp' | 'path'; value: string };  // ditto
  reason: string;
  decidedAt: number;
  decidedBy: 'user' | 'improver';
}

export interface ActionDenial {
  id: string;
  actionName: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  // `none` is the honest answer for a call no rule could unblock (an unresolvable redirect
  // target, an unquoted expansion): `value` is then the reason, and the Allow button on that
  // row is refused by POST /api/allowlist/rules — the fix belongs in the action's command.
  suggested: { kind: 'tool' | 'bash' | 'mcp' | 'path' | 'none'; value: string };
  at: number;
  count: number;
  runId?: string;
  verdict?: DenialVerdict;
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

  // Denials with no verdict yet — what an improvement cycle or the user still has to act on.
  // Keyed on verdict PRESENCE, not disposition: an applied `promote` is just as resolved as a
  // `never`, and keying on disposition would have the model re-propose a grant that already
  // exists every cycle.
  unresolved(action: string): ActionDenial[] { return this.list(action).filter((d) => !d.verdict); }

  setVerdict(action: string, id: string, verdict: DenialVerdict): boolean {
    const denial = this.byAction.get(action)?.find((d) => d.id === id);
    if (!denial) return false;
    denial.verdict = verdict;
    this.persist();
    return true;
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify({ byAction: Object.fromEntries(this.byAction) }, null, 2) + '\n');
  }
}
