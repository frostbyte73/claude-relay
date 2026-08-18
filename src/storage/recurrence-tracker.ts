import { createHash } from 'node:crypto';
import { lintPermissionRule } from '../permissions/write-shape.js';

export interface ResolutionRecord {
  cwd: string;
  toolName: string;
  toolInput: unknown;
  decision: 'allow' | 'deny';
}

export interface Suggestion {
  kind: 'tool' | 'bash' | 'mcp';
  suggestedValue: string;
  matchCount: number;
  triggerWindow: '24h' | '7d';
}

interface Entry {
  signature: string;
  cwd: string;
  toolName: string;
  toolInput: unknown;
  decision: 'allow' | 'deny';
  decidedAt: number;
}

const MAX_ENTRIES = 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const TRIGGER_24H = 3;
const TRIGGER_7D = 5;

// Stable JSON for hashing tool inputs. Sorts object keys recursively so that
// {a:1, b:2} and {b:2, a:1} produce the same signature.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

function signatureOf(toolName: string, toolInput: unknown): string {
  return createHash('sha256').update(`${toolName}\0${stableStringify(toolInput)}`).digest('hex');
}

// "kubectl delete pod x --grace-period=0" → "^kubectl delete(\\s|$)".
// Picks up to two leading word-shaped tokens (alphanumeric/dash, no flag/arg shapes).
function deriveBashRegex(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens: string[] = [];
  for (const t of trimmed.split(/\s+/)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(t)) break;
    tokens.push(t);
    if (tokens.length === 2) break;
  }
  if (tokens.length === 0) return null;
  return `^${tokens.join(' ')}(\\s|$)`;
}

export class RecurrenceTracker {
  private entries: Entry[] = [];

  record(r: ResolutionRecord): void {
    const entry: Entry = {
      signature: signatureOf(r.toolName, r.toolInput),
      cwd: r.cwd,
      toolName: r.toolName,
      toolInput: r.toolInput,
      decision: r.decision,
      decidedAt: Date.now(),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  countMatches(cwd: string, toolName: string, toolInput: unknown): { last24h: number; last7d: number } {
    const sig = signatureOf(toolName, toolInput);
    const now = Date.now();
    let last24h = 0, last7d = 0;
    for (const e of this.entries) {
      if (e.decision !== 'allow') continue;
      if (e.cwd !== cwd) continue;
      if (e.signature !== sig) continue;
      const age = now - e.decidedAt;
      if (age <= WINDOW_24H_MS) last24h++;
      if (age <= WINDOW_7D_MS) last7d++;
    }
    return { last24h, last7d };
  }

  suggestionFor(cwd: string, toolName: string, toolInput: unknown): Suggestion | null {
    const counts = this.countMatches(cwd, toolName, toolInput);
    let triggerWindow: '24h' | '7d' | null = null;
    let matchCount = 0;
    if (counts.last24h >= TRIGGER_24H) { triggerWindow = '24h'; matchCount = counts.last24h; }
    else if (counts.last7d >= TRIGGER_7D) { triggerWindow = '7d'; matchCount = counts.last7d; }
    if (!triggerWindow) return null;

    const suggestion = ((): Suggestion | null => {
      if (toolName === 'Bash') {
        const cmd = (toolInput as { command?: string })?.command;
        const re = typeof cmd === 'string' ? deriveBashRegex(cmd) : null;
        if (!re) return null;
        return { kind: 'bash', suggestedValue: re, matchCount, triggerWindow };
      }
      if (toolName.startsWith('mcp__')) {
        return { kind: 'mcp', suggestedValue: `^${toolName}$`, matchCount, triggerWindow };
      }
      return { kind: 'tool', suggestedValue: toolName, matchCount, triggerWindow };
    })();
    if (!suggestion) return null;

    // A rule `addRule` would refuse can never be installed — offering it anyway is what
    // surfaced as "Promotion failed — try again" with no explanation. This suggestion always
    // targets a non-gated destination, so `gated: false` here is not a guess.
    if (!lintPermissionRule(suggestion.kind, suggestion.suggestedValue, false).ok) return null;
    return suggestion;
  }
}
