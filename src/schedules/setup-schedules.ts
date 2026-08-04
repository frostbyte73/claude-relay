import type { SchedulesStore } from './schedules-store.js';

// The Linear intake script: query the viewer's assigned open issues and enqueue one job per issue
// via the daemon's own create-job hook endpoint (idempotent on dedupeKey). Runs directly on the
// cron tick — no Claude session. LINEAR_API_TOKEN reaches the script because runScript merges
// process.env; OUTPOST_HOOK_PORT/DAEMON_AUTH are injected by the scheduler's scriptEnv(). The
// token is sent as a raw `authorization` header (no "Bearer" prefix) — that's what Linear expects.
const LINEAR_SCRIPT = String.raw`
set -euo pipefail
resp=$(curl -fsS -X POST https://api.linear.app/graphql \
  -H "authorization: $LINEAR_API_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"query { viewer { assignedIssues(filter: { state: { type: { in: [\"unstarted\", \"started\"] } } }, first: 50) { nodes { id identifier url title description } } } }"}')
echo "$resp" | jq -c '.data.viewer.assignedIssues.nodes[]' | while read -r issue; do
  identifier=$(echo "$issue" | jq -r .identifier)
  url=$(echo "$issue" | jq -r .url)
  title=$(echo "$issue" | jq -r .title)
  body=$(echo "$issue" | jq -r '.description // ""')
  curl -fsS -X POST "http://127.0.0.1:$OUTPOST_HOOK_PORT/work/create-job" \
    -H "x-daemon-auth: $DAEMON_AUTH" -H 'content-type: application/json' \
    -d "$(jq -n --arg t "$title" --arg b "$body" --arg k "$identifier" --arg u "$url" \
      '{source:"linear",title:$t,body:$b,dedupeKey:$k,externalRef:{url:$u,issueIdentifier:$k}}')" >/dev/null
done
`.trim();

// Seeds the daemon's built-in schedules at startup. `ensureBuiltin` is idempotent on id, so
// this can (and must) run on every boot without clobbering a user's edits to an existing row.
export function seedBuiltinSchedules(store: SchedulesStore, homeDir: string): void {
  store.ensureBuiltin({
    id: 'claude-updater',
    name: 'Update Claude Code',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    what: { kind: 'script', script: 'brew upgrade claude-code', cwd: homeDir },
  });
  store.ensureBuiltin({
    id: 'linear',
    name: 'Linear — assigned issues',
    trigger: { kind: 'cron', expr: '0 * * * *' },
    what: { kind: 'script', script: LINEAR_SCRIPT, cwd: homeDir },
    // Without a token the hourly cron would just record an error run forever; only
    // enable on first seed if the token is already present. ensureBuiltin only applies
    // `enabled` on first seed, so a user who adds a token later can flip it on manually.
    enabled: !!process.env.LINEAR_API_TOKEN,
  });
  store.ensureBuiltin({
    id: 'pr-watcher',
    name: 'PR watcher',
    trigger: { kind: 'cron', expr: '*/5 * * * *' },
    what: { kind: 'native', handler: 'pr-watcher' },
  });
  store.ensureBuiltin({
    id: 'user-prs-watcher',
    name: 'My open PRs',
    trigger: { kind: 'cron', expr: '*/10 * * * *' },
    what: { kind: 'native', handler: 'user-prs-watcher' },
  });
}
