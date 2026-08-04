import type { Server } from '../server.js';
import type { RunFilters, RunKind, RunsStore } from '../storage/runs-store.js';
import type { UsageLedger } from '../integrations/usage-ledger.js';
import type { AccountUsageSnapshot } from '../integrations/usage-poller.js';
import { parseWindowMs } from './util.js';

export interface RunsRoutesDeps {
  runsStore: RunsStore;
  usageLedger: UsageLedger;
  // Daemon.ts caches the latest UsagePoller snapshot in a closure variable, not a store —
  // inject a getter rather than requiring a new persisted/broadcastable wrapper for it.
  getAccountUsage?: () => AccountUsageSnapshot | null;
}

const RUN_KINDS: ReadonlySet<string> = new Set(['sess', 'track', 'sched']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_BREAKDOWN_WINDOW_MS = 5 * 60 * 60 * 1000;

function filtersFromQuery(url: URL): RunFilters {
  const windowMs = parseWindowMs(url.searchParams.get('window'));
  const kindRaw = url.searchParams.get('kind');
  const kind = kindRaw && RUN_KINDS.has(kindRaw) ? (kindRaw as RunKind) : undefined;
  const repo = url.searchParams.get('repo') ?? undefined;
  const verdict = url.searchParams.get('verdict') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  return {
    sinceMs: windowMs !== undefined ? Date.now() - windowMs : undefined,
    kind,
    repo: repo || undefined,
    verdict: verdict || undefined,
    q: q || undefined,
  };
}

function paginationFromQuery(url: URL): { limit: number; offset: number } {
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

export function registerRunsRoutes(server: Server, deps: RunsRoutesDeps): void {
  const { runsStore, usageLedger, getAccountUsage } = deps;

  server.route('GET', '/api/runs', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const filters = filtersFromQuery(url);
    const { limit, offset } = paginationFromQuery(url);
    const matched = runsStore.list(filters); // unpaginated: tally is over every matching row, not just the page
    const tally = matched.reduce(
      (acc, r) => {
        acc.totalDurationMs += r.durationMs ?? 0;
        acc.totalCostUsd += r.costUsd ?? 0;
        return acc;
      },
      { count: matched.length, totalDurationMs: 0, totalCostUsd: 0 },
    );
    const runs = matched.slice(offset, offset + limit);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runs, tally }));
  });

  server.route('GET', '/api/runs.csv', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const filters = filtersFromQuery(url);
    const rows = runsStore.list(filters);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="runs.csv"');
    res.end(runsStore.toCsv(rows));
  });

  server.route('GET', '/api/usage/breakdown', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const windowMs = parseWindowMs(url.searchParams.get('window')) ?? DEFAULT_BREAKDOWN_WINDOW_MS;
    const accountUsage = getAccountUsage?.() ?? undefined;
    const breakdown = usageLedger.breakdown(windowMs, accountUsage);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(breakdown));
  });
}
