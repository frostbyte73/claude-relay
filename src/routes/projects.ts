import { statSync } from 'node:fs';
import type { Server } from '../server.js';
import type { SessionStore } from '../session/session-store.js';
import type { ProjectRegistry } from '../storage/project-registry.js';
import { readJsonObject } from './util.js';

export interface ProjectsRoutesDeps {
  sessionStore: SessionStore;
  projectRegistry: ProjectRegistry;
}

export function registerProjectsRoutes(server: Server, deps: ProjectsRoutesDeps): void {
  const { sessionStore, projectRegistry } = deps;

  // Branch picker: local + remote dedup, sorted by committer-date, cached 30s per cwd.
  const branchesCache = new Map<string, { branches: string[]; defaultBranch: string | null; at: number }>();
  const BRANCHES_CACHE_MS = 30_000;

  server.route('GET', '/api/projects/:sanitized/branches', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/projects\/([\w.\-]+)\/branches$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const sanitized = m[1]!;
    const project = sessionStore.listProjects().find((p) => p.cwd.replace(/\//g, '-') === sanitized);
    if (!project) { res.statusCode = 404; res.end('project not found'); return; }
    const cached = branchesCache.get(project.cwd);
    if (cached && Date.now() - cached.at < BRANCHES_CACHE_MS) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ branches: cached.branches, defaultBranch: cached.defaultBranch }));
      return;
    }
    const { execFileSync } = await import('node:child_process');
    const branches: string[] = [];
    let defaultBranch: string | null = null;
    try {
      const local = execFileSync('git', ['-C', project.cwd, 'branch', '--format=%(refname:short)', '--sort=-committerdate'])
        .toString().split('\n').filter(Boolean);
      let remote: string[] = [];
      try {
        remote = execFileSync('git', ['-C', project.cwd, 'branch', '-r', '--format=%(refname:short)', '--sort=-committerdate'])
          .toString().split('\n').filter(Boolean)
          .filter((b) => b !== 'origin/HEAD' && !b.includes('->'))
          .map((b) => b.replace(/^origin\//, ''));
      } catch { /* no remote */ }
      const seen = new Set<string>();
      for (const b of [...local, ...remote]) {
        if (!seen.has(b)) { seen.add(b); branches.push(b); }
      }
      try {
        const head = execFileSync('git', ['-C', project.cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString().trim();
        defaultBranch = head.replace(/^refs\/remotes\/origin\//, '') || null;
      } catch {
        defaultBranch = branches.find((b) => b === 'main' || b === 'master') ?? branches[0] ?? null;
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(`git error: ${(e as Error).message}`);
      return;
    }
    branchesCache.set(project.cwd, { branches, defaultBranch, at: Date.now() });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ branches, defaultBranch }));
  });

  // Body: { cwd: <absolute path> }. Returns { added: boolean, cwd: string }.
  server.route('POST', '/api/projects', async (req, res) => {
    const payload = await readJsonObject<{ cwd?: string }>(req, res);
    if (!payload) return;
    const { cwd } = payload;
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
      res.statusCode = 400; res.end('cwd must be absolute'); return;
    }
    try {
      if (!statSync(cwd).isDirectory()) {
        res.statusCode = 400; res.end('cwd is not a directory'); return;
      }
    } catch {
      res.statusCode = 400; res.end('cwd does not exist'); return;
    }
    const added = projectRegistry.add(cwd);
    if (added) console.log(`[api] project registered: ${cwd}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ added, cwd }));
  });

  server.route('DELETE', '/api/projects', async (req, res) => {
    const payload = await readJsonObject<{ cwd?: string }>(req, res);
    if (!payload) return;
    if (typeof payload.cwd !== 'string') {
      res.statusCode = 400; res.end('cwd required'); return;
    }
    const removed = projectRegistry.remove(payload.cwd);
    if (removed) console.log(`[api] project unregistered: ${payload.cwd}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ removed }));
  });
}
