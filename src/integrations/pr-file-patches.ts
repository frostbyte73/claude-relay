import { parsePrUrl } from '../work/pr-url.js';
import { runGh as defaultRunGh, type RunGh } from './gh-cli.js';

// Per-file unified diffs for a PR, so the PWA can show an inline review comment in the middle
// of its hunk instead of at the end of one.
//
// A comment's own `diff_hunk` runs from the hunk's start to the commented line — no trailing
// context at all, and on an added file that's the whole file so far. `pulls/:n/files` carries
// the real per-file `patch`, which is what the Files-changed tab renders against.
//
// Fetched on demand (when the user is looking at the threads), NOT on the watcher's sweep:
// patches are far larger than the facts the watcher persists, and they'd bloat every job
// record on disk for a view that is usually closed.

// Patches for a big PR dwarf the default gh budget, and this is one call rather than a sweep.
const MAX_BUFFER = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
// Only consulted when the PR's head sha is unknown; a known sha is the real cache key.
const TTL_MS = 5 * 60_000;
const MAX_PRS_CACHED = 32;

interface GhPrFile {
  filename: string;
  patch?: string;
  previous_filename?: string;
}

interface Entry {
  sha: string | undefined;
  at: number;
  patches: Record<string, string>;
}

export class PrFilePatches {
  private readonly runGh: RunGh;
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry | null>>();

  constructor(opts: { runGh?: RunGh } = {}) {
    this.runGh = opts.runGh ?? defaultRunGh;
  }

  // Patches for `paths` only. Filtering here rather than in the route keeps the response
  // proportional to what's actually commented on — a 200-file PR with three review threads
  // sends three patches. A path GitHub omitted a patch for (too large, binary, or renamed
  // with no content change) is simply absent; the caller falls back to the comment's own hunk.
  async forPaths(
    cwd: string,
    prUrl: string,
    headSha: string | undefined,
    paths: string[],
  ): Promise<Record<string, string>> {
    if (!paths.length) return {};
    const entry = await this.load(cwd, prUrl, headSha);
    if (!entry) return {};
    const out: Record<string, string> = {};
    for (const p of paths) {
      const patch = entry.patches[p];
      if (patch) out[p] = patch;
    }
    return out;
  }

  private async load(cwd: string, prUrl: string, headSha: string | undefined): Promise<Entry | null> {
    const hit = this.cache.get(prUrl);
    if (hit && this.isFresh(hit, headSha)) return hit;

    // Collapse concurrent requests for the same PR — the PR block renders every thread at
    // once, and without this a five-thread repaint would fire five `gh api --paginate` calls.
    const pending = this.inflight.get(prUrl);
    if (pending) return pending;

    const task = this.fetch(cwd, prUrl, headSha).finally(() => this.inflight.delete(prUrl));
    this.inflight.set(prUrl, task);
    return task;
  }

  private isFresh(entry: Entry, headSha: string | undefined): boolean {
    // A known head sha is exact: same sha, same diff, cache forever. Without one (the watcher
    // hasn't polled this PR yet) fall back to a short TTL rather than serving a stale diff
    // for the life of the daemon.
    if (headSha && entry.sha) return entry.sha === headSha;
    return Date.now() - entry.at < TTL_MS;
  }

  private async fetch(cwd: string, prUrl: string, headSha: string | undefined): Promise<Entry | null> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return null;
    let files: GhPrFile[];
    try {
      const out = await this.runGh(
        cwd,
        ['api', `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/files`, '--paginate'],
        { maxBuffer: MAX_BUFFER, timeout: FETCH_TIMEOUT_MS },
      );
      files = JSON.parse(out) as GhPrFile[];
    } catch (e) {
      // Not fatal: the caller degrades to the comment's own `diff_hunk`.
      console.error(`[pr-file-patches] fetch ${prUrl}: ${(e as Error).message}`);
      return null;
    }
    const patches: Record<string, string> = {};
    for (const f of files) {
      if (f.patch) patches[f.filename] = f.patch;
    }
    const entry: Entry = { sha: headSha, at: Date.now(), patches };
    this.cache.set(prUrl, entry);
    this.evictOldest();
    return entry;
  }

  private evictOldest(): void {
    while (this.cache.size > MAX_PRS_CACHED) {
      // Map iterates in insertion order and `set` on a fresh key appends, so the first key
      // is the least recently *fetched*.
      const oldest = this.cache.keys().next();
      if (oldest.done) return;
      this.cache.delete(oldest.value);
    }
  }
}
