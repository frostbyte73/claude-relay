import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const execFileP = promisify(execFile);

async function defaultRunGh(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gh', args, { maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
  return stdout.toString();
}

export interface UserPr {
  url: string;
  title: string;
  number: number;
  repo: string;
  isDraft: boolean;
  updatedAt: number;
  createdAt: number;
}

export interface UserPrsSnapshot {
  prs: UserPr[];
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface UserPrsWatcherOpts {
  statePath: string;
  runGh?: (args: string[]) => Promise<string>;
  onChange?: (snap: UserPrsSnapshot) => void;
}

interface GhSearchPr {
  url: string;
  title: string;
  number: number;
  repository: { nameWithOwner: string };
  isDraft: boolean;
  updatedAt: string;
  createdAt: string;
}

function hashPrs(prs: UserPr[]): string {
  const h = createHash('sha256');
  for (const p of prs) h.update(`${p.url}\0${p.updatedAt}\0${p.isDraft ? '1' : '0'}\0`);
  return h.digest('hex');
}

export class UserPrsWatcher {
  readonly id = 'user-prs';
  readonly name = 'GitHub — my open PRs';
  readonly description = 'Tracks your own open pull requests across repos.';
  private readonly runGh: (args: string[]) => Promise<string>;
  private readonly statePath: string;
  private readonly onChange: ((snap: UserPrsSnapshot) => void) | undefined;
  private snapshot: UserPrsSnapshot;
  private lastHash = '';
  private inFlight: Promise<void> | null = null;

  constructor(opts: UserPrsWatcherOpts) {
    this.runGh = opts.runGh ?? defaultRunGh;
    this.statePath = opts.statePath;
    this.onChange = opts.onChange;
    this.snapshot = this.load();
    this.lastHash = hashPrs(this.snapshot.prs);
  }

  private load(): UserPrsSnapshot {
    try {
      if (existsSync(this.statePath)) {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<UserPrsSnapshot>;
        return {
          prs: Array.isArray(raw.prs) ? raw.prs : [],
          lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : null,
          lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
        };
      }
    } catch (e) {
      console.warn(`[user-prs] failed to load ${this.statePath}: ${(e as Error).message}`);
    }
    return { prs: [], lastSyncAt: null, lastError: null };
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot, null, 2) + '\n');
      renameSync(tmp, this.statePath);
    } catch (e) {
      console.warn(`[user-prs] failed to persist: ${(e as Error).message}`);
    }
  }

  get(): UserPrsSnapshot {
    return this.snapshot;
  }

  async runOnce(): Promise<{ outcome: 'ok' | 'error' }> {
    try {
      await this.syncNow();
      return { outcome: 'ok' };
    } catch {
      return { outcome: 'error' };
    }
  }

  syncNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doSync().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doSync(): Promise<void> {
    let raw: string;
    try {
      raw = await this.runGh([
        'search', 'prs',
        '--author=@me',
        '--state=open',
        '--limit=100',
        '--json', 'url,title,number,repository,isDraft,updatedAt,createdAt',
      ]);
    } catch (e) {
      const msg = (e as Error).message;
      this.snapshot = { ...this.snapshot, lastError: msg, lastSyncAt: Date.now() };
      this.persist();
      this.onChange?.(this.snapshot);
      throw e;
    }
    let items: GhSearchPr[];
    try { items = JSON.parse(raw) as GhSearchPr[]; }
    catch (e) {
      const msg = `parse failed: ${(e as Error).message}`;
      this.snapshot = { ...this.snapshot, lastError: msg, lastSyncAt: Date.now() };
      this.persist();
      this.onChange?.(this.snapshot);
      return;
    }
    const prs: UserPr[] = items.map((p) => ({
      url: p.url,
      title: p.title,
      number: p.number,
      repo: p.repository?.nameWithOwner ?? '',
      isDraft: !!p.isDraft,
      updatedAt: new Date(p.updatedAt).getTime(),
      createdAt: new Date(p.createdAt).getTime(),
    }));
    prs.sort((a, b) => b.updatedAt - a.updatedAt);
    const nextHash = hashPrs(prs);
    this.snapshot = { prs, lastSyncAt: Date.now(), lastError: null };
    this.persist();
    if (nextHash !== this.lastHash) {
      this.lastHash = nextHash;
      this.onChange?.(this.snapshot);
    } else {
      this.onChange?.(this.snapshot);
    }
  }
}
