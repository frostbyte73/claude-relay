import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PreferencesBlob = Record<string, unknown>;

// Schema-light client-preferences store synced across devices. The daemon does
// not enumerate individual preferences — it stores an opaque JSON object and
// only guarantees it is a plain object. Per-key validation lives on the client.
export class PreferencesStore {
  private prefs: PreferencesBlob = {};

  constructor(private readonly path: string) {
    this.load();
  }

  get(): PreferencesBlob {
    return { ...this.prefs };
  }

  // Shallow-merges patch into the blob, persists, returns the merged result.
  merge(patch: PreferencesBlob): PreferencesBlob {
    this.prefs = { ...this.prefs, ...patch };
    this.persist();
    return this.get();
  }

  // Typed accessors for the preferences the daemon itself acts on (the token-launch
  // queue's concurrency; the editor the git view opens on this host) — everything else
  // stays opaque.
  getLaunchConcurrency(): number {
    const raw = (this.get() as { launchConcurrency?: unknown }).launchConcurrency;
    return Number.isInteger(raw) && (raw as number) >= 1 ? (raw as number) : 1;
  }

  // Undefined rather than a default, so the fallback lives with the code that spawns it.
  getEditorCommand(): string | undefined {
    const raw = (this.get() as { editorCommand?: unknown }).editorCommand;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.prefs = parsed as PreferencesBlob;
      }
    } catch {
      // Malformed → treat as empty; overwritten on next merge().
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.prefs, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
