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
  if (res.status === 204) return null;
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
