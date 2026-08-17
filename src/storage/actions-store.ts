import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AllowlistConfig } from '../permissions/allowlist.js';
import { assertNotWriteShaped, classifyInterpreterShape, classifyRuleShape } from '../permissions/write-shape.js';

export interface ActionConfig {
  allowlist: AllowlistConfig;
}

function emptyAllowlist(): AllowlistConfig {
  return { alwaysAllow: [], alwaysAllowBashPatterns: [], alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [] };
}

function defaultConfig(): ActionConfig {
  return { allowlist: emptyAllowlist() };
}

interface Persisted {
  actions?: Record<string, Partial<ActionConfig>>;
}

type RuleKey = keyof AllowlistConfig;

function keyForKind(kind: 'tool' | 'bash' | 'mcp' | 'path'): RuleKey {
  return kind === 'tool' ? 'alwaysAllow'
    : kind === 'bash' ? 'alwaysAllowBashPatterns'
    : kind === 'mcp' ? 'alwaysAllowMcpPatterns'
    : 'alwaysAllowPathPatterns';
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

// addRule guards every rule added from here on, but rules persisted before that guard
// existed never passed through it — a stale `^gh workflow run ` from before this lint
// shipped still loads and still runs ungated. Observability only: never throws, never
// changes what loads, just names the debt so it's visible instead of silent.
function auditPersistedRules(byName: ReadonlyMap<string, ActionConfig>): string[] {
  const hits: string[] = [];
  for (const [name, cfg] of byName) {
    const checks: Array<['tool' | 'bash' | 'mcp', string[]]> = [
      ['tool', cfg.allowlist.alwaysAllow],
      ['bash', cfg.allowlist.alwaysAllowBashPatterns],
      ['mcp', cfg.allowlist.alwaysAllowMcpPatterns],
    ];
    for (const [kind, values] of checks) {
      for (const value of values) {
        const writeShaped = classifyRuleShape(kind, value).writeShaped
          || classifyInterpreterShape(kind, value).writeShaped;
        if (writeShaped) hits.push(`${name} ${kind}=${value}`);
      }
    }
  }
  return hits;
}

export class ActionsStore {
  private byName = new Map<string, ActionConfig>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    let parsed: Persisted;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Persisted; }
    catch { return; }
    for (const [name, raw] of Object.entries(parsed.actions ?? {})) {
      const al = (raw.allowlist ?? {}) as Partial<AllowlistConfig>;
      this.byName.set(name, {
        allowlist: {
          alwaysAllow: Array.isArray(al.alwaysAllow) ? [...al.alwaysAllow] : [],
          alwaysAllowBashPatterns: Array.isArray(al.alwaysAllowBashPatterns) ? [...al.alwaysAllowBashPatterns] : [],
          alwaysAllowMcpPatterns: Array.isArray(al.alwaysAllowMcpPatterns) ? [...al.alwaysAllowMcpPatterns] : [],
          alwaysAllowPathPatterns: Array.isArray(al.alwaysAllowPathPatterns) ? [...al.alwaysAllowPathPatterns] : [],
        },
      });
    }
    const hits = auditPersistedRules(this.byName);
    if (hits.length > 0) {
      console.warn(
        `[actions] ${hits.length} persisted action-scoped rule(s) grant external writes `
        + `that no write-draft gates: ${hits.join('; ')}`);
    }
  }

  get(name: string): ActionConfig {
    const v = this.byName.get(name);
    return v ?? defaultConfig();
  }

  list(): Record<string, ActionConfig> {
    return Object.fromEntries(this.byName);
  }

  addRule(name: string, kind: 'tool' | 'bash' | 'mcp' | 'path', value: string): boolean {
    assertNotWriteShaped(kind, value);
    const cur = this.byName.get(name) ?? defaultConfig();
    const al = cur.allowlist;
    const key = keyForKind(kind);
    const list = (al[key] ?? []) as string[];
    if (list.includes(value)) return false;
    if (kind === 'bash' || kind === 'mcp') new RegExp(value);
    if (kind === 'path') {
      const idx = value.indexOf(':');
      if (idx <= 0 || idx === value.length - 1) throw new Error('path rule must be "<ToolName>:<regex>"');
      new RegExp(value.slice(idx + 1));
    }
    const next: ActionConfig = {
      allowlist: { ...al, [key]: [...list, value] },
    };
    this.byName.set(name, next);
    this.persist();
    return true;
  }

  removeRule(name: string, kind: 'tool' | 'bash' | 'mcp' | 'path', value: string): boolean {
    const cur = this.byName.get(name);
    if (!cur) return false;
    const key = keyForKind(kind);
    const list = (cur.allowlist[key] ?? []) as string[];
    const next = list.filter((v) => v !== value);
    if (next.length === list.length) return false;
    this.byName.set(name, { allowlist: { ...cur.allowlist, [key]: next } });
    this.persist();
    return true;
  }

  deleteAction(name: string): boolean {
    if (!this.byName.has(name)) return false;
    this.byName.delete(name);
    this.persist();
    return true;
  }

  private persist(): void {
    const out: Persisted = { actions: Object.fromEntries(this.byName) };
    atomicWrite(this.path, JSON.stringify(out, null, 2) + '\n');
  }
}
