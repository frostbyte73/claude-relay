const BASE = '/api/schedules';

async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`schedules api ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204 || res.status === 202) return null;
  return res.json();
}

const idPath = (id) => `${BASE}/${encodeURIComponent(id)}`;

export const schedulesApi = {
  list()                   { return request(BASE); },
  create(body)              { return request(BASE, { method: 'POST', body: JSON.stringify(body) }); },
  update(id, patch)         { return request(idPath(id), { method: 'PATCH', body: JSON.stringify(patch) }); },
  remove(id)                { return request(idPath(id), { method: 'DELETE' }); },
  runNow(id)                { return request(`${idPath(id)}/run-now`, { method: 'POST', body: '{}' }); },
  // Resuming a paused schedule is `update(id, { enabled: true })` — the store's
  // ScheduleUpdate shape (src/schedules/schedules-store.ts) has no separate resume route.
  pause(id)                 { return request(`${idPath(id)}/pause`, { method: 'POST', body: '{}' }); },
  duplicate(id)             { return request(`${idPath(id)}/duplicate`, { method: 'POST', body: '{}' }); },
  listRuns(id, limit)       { return request(`${idPath(id)}/runs${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`); },
  approveGithubPost(id, runId) { return request(`${idPath(id)}/runs/${encodeURIComponent(runId)}/approve-github`, { method: 'POST', body: '{}' }); },
};

// Prompt-first authoring surface (routes/schedule-edits.ts). Kept as standalone
// exports rather than schedulesApi methods: these drive the meta.build-schedule
// builder session + script test-run, not schedule CRUD.

// → { sessionId } of the spawned builder; the draft proposal arrives later over WS.
export function createScheduleDraft(prompt) {
  return request(`${BASE}/new`, { method: 'POST', body: JSON.stringify({ prompt }) });
}

// Runs a script-kind `what` for real → { outcome: 'ok' | 'error', output }.
export function testScript(what) {
  return request(`${BASE}/test`, { method: 'POST', body: JSON.stringify({ what }) });
}

// Feeds a failing test back to the builder session → a fresh schedule_draft_ready. 202, no body.
export function redraftSchedule(sessionId, error, currentDraft) {
  return request(`${idPath(sessionId)}/redraft`, { method: 'POST', body: JSON.stringify({ error, currentDraft }) });
}
