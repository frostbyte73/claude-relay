import type { RunVerdict } from './types.js';

export type NativeHandler = () => Promise<{ outcome: 'ok' | 'error'; verdict?: RunVerdict }>;

// id → handler fn, populated at boot in daemon.ts (pr-watcher, user-prs-watcher). The scheduler
// resolves a `native` what's `handler` against this at fire time.
export class NativeHandlerRegistry {
  private handlers = new Map<string, NativeHandler>();
  register(id: string, fn: NativeHandler): void { this.handlers.set(id, fn); }
  get(id: string): NativeHandler | undefined { return this.handlers.get(id); }
}
