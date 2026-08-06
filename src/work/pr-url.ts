// One source of truth for the GitHub PR-URL shape. The watcher uses it to decide what it may
// hand to `gh` as a subprocess argument; the engine uses it to tell provision() which repo a
// step's work belongs to, so a planner that picked the wrong registered project is refused
// rather than silently reviewing an unrelated diff.
//
// The `(?!\.{1,2}\/)` guards exclude a bare `.`/`..` segment: owner and repo get spliced into
// `repos/<owner>/<repo>/pulls/<n>/comments`, so `..` there is path traversal out of the
// endpoint. Dots *inside* a segment (`my.repo.js`) stay legal.
export const PR_URL_RE =
  /^https:\/\/github\.com\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/pull\/\d+$/;

export function parsePrUrl(url: string): { owner: string; repo: string; number: string } | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1]!, repo: m[2]!, number: m[3]! } : null;
}

// `owner/repo` for a step, from the only field a planner supplies it in. Deliberately reads
// the strict shape: a url that wouldn't survive the watcher's check is not one to build an
// origin assertion from either.
export function expectRepoOf(inputs: Record<string, unknown> | undefined): string | undefined {
  const raw = inputs?.prUrl;
  if (typeof raw !== 'string' || !PR_URL_RE.test(raw)) return undefined;
  const parsed = parsePrUrl(raw);
  return parsed ? `${parsed.owner}/${parsed.repo}` : undefined;
}
