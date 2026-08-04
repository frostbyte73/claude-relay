import { evaluateHeadroom, type TokenUsageSnapshot } from '../schedules/headroom.js';

export type LaunchPriority = 'queued' | 'immediate';

export interface LaunchRequest {
  key: string;
  jobId: string;
  stepId?: string;
  sessionId: string;
  priority: LaunchPriority;
  enqueuedAt: number;
  jobInProgress: boolean;
  label?: string;
  // Performs the actual spawn/send. Returns true if it started a turn (so the occupied slot
  // will be released by that turn's Stop hook), or false if it bailed without starting one
  // (step cancelled/invalidated while parked) — on false the governor frees the slot itself,
  // since no Stop will ever fire to release it.
  run: () => boolean;
}

export interface LaunchGovernorDeps {
  getSnapshot: () => TokenUsageSnapshot | undefined;
  getConcurrency: () => number;
  now?: () => number;
  onChange?: () => void;
}

export type LaunchState =
  | { state: 'running' }
  | { state: 'queued'; reason: string }
  | { state: 'idle' };

export class LaunchGovernor {
  private parked = new Map<string, LaunchRequest>();
  private active = new Map<string, string>();
  private evaluating = false;

  constructor(private deps: LaunchGovernorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private headroom(): { ok: boolean; reason: string } {
    const snap = this.deps.getSnapshot();
    if (!snap) return { ok: true, reason: 'No usage data — headroom gate off' };
    const d = evaluateHeadroom(snap, this.now());
    return { ok: d.launch || d.code === 'no-data', reason: d.reason };
  }

  private slotOk(): boolean {
    return this.active.size < this.deps.getConcurrency();
  }

  private canLaunchQueued(): boolean {
    return this.headroom().ok && this.slotOk();
  }

  private fire(req: LaunchRequest): void {
    this.parked.delete(req.key);
    // Occupy the slot before run() so a re-entrant gate check sees it taken.
    this.active.set(req.sessionId, req.key);
    let started = false;
    try {
      started = req.run();
    } catch (err) {
      this.active.delete(req.sessionId);
      throw err;
    }
    // A run that bailed without starting a turn (or threw) never triggers a Stop hook, so
    // turnEnded would never fire to free this slot — release it now or it leaks forever.
    if (!started) this.active.delete(req.sessionId);
    this.emit();
  }

  submit(req: LaunchRequest): void {
    if (req.priority === 'immediate') {
      this.parked.delete(req.key);
      this.fire(req);
      return;
    }
    if (this.canLaunchQueued()) {
      this.fire(req);
    } else {
      this.parked.set(req.key, req);
      this.emit();
    }
  }

  turnEnded(sessionId: string): void {
    this.active.delete(sessionId);
    this.emit();
    this.drain();
  }

  onUsageSnapshot(): void {
    this.drain();
  }

  forceFire(key: string): boolean {
    const req = this.parked.get(key);
    if (!req) return false;
    this.fire(req);
    return true;
  }

  // Force-fires every parked launch belonging to a job (used when a job is marked
  // high-priority). Returns how many fired. Snapshots the matches first — fire()
  // mutates the parked map.
  forceFireJob(jobId: string): number {
    const matches = [...this.parked.values()].filter((r) => r.jobId === jobId);
    for (const req of matches) this.fire(req);
    return matches.length;
  }

  cancel(jobId: string): void {
    let removed = false;
    for (const [key, req] of this.parked) {
      if (req.jobId === jobId) {
        this.parked.delete(key);
        removed = true;
      }
    }
    if (removed) this.emit();
  }

  describe(key: string): LaunchState {
    for (const activeKey of this.active.values()) {
      if (activeKey === key) return { state: 'running' };
    }
    if (this.parked.has(key)) return { state: 'queued', reason: this.queuedReason() };
    return { state: 'idle' };
  }

  // Bare reason — the "Queued — " prefix is added once by the PWA (vm/tracked.js).
  private queuedReason(): string {
    if (!this.slotOk()) return `${this.active.size}/${this.deps.getConcurrency()} slots busy`;
    return this.headroom().reason;
  }

  private drain(): void {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      while (this.parked.size > 0 && this.canLaunchQueued()) {
        const [next] = [...this.parked.values()].sort(
          (a, b) => (b.jobInProgress ? 1 : 0) - (a.jobInProgress ? 1 : 0) || a.enqueuedAt - b.enqueuedAt,
        );
        this.fire(next!); // guarded by parked.size > 0 above
      }
    } finally {
      this.evaluating = false;
    }
  }

  private emit(): void {
    this.deps.onChange?.();
  }
}
