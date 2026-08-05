const BASE = '/api/work';

async function request(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`work api ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

const jobPath = (id) => `/jobs/${encodeURIComponent(id)}`;
const stepPath = (id, stepId) => `${jobPath(id)}/steps/${encodeURIComponent(stepId)}`;

export const workApi = {
  listJobs()                       { return request('/jobs'); },
  getJob(id)                       { return request(jobPath(id)); },
  // Whole timeline from the spill log; job.events itself is capped at the last 50.
  getJobEvents(id, limit = 1000)   { return request(`${jobPath(id)}/events?limit=${encodeURIComponent(limit)}`); },
  createJob(body)                  { return request('/jobs', { method: 'POST', body: JSON.stringify(body) }); },
  promoteFromSession(sessionId)    { return request(`/jobs/from-session/${encodeURIComponent(sessionId)}`, { method: 'POST', body: '{}' }); },
  approve(id, body)                { return request(`${jobPath(id)}/approve`, { method: 'POST', body: JSON.stringify(body) }); },
  reject(id, body)                 { return request(`${jobPath(id)}/reject`, { method: 'POST', body: JSON.stringify(body) }); },
  abandon(id)                      { return request(`${jobPath(id)}/abandon`, { method: 'POST', body: '{}' }); },
  markDone(id)                     { return request(`${jobPath(id)}/mark-done`, { method: 'POST', body: '{}' }); },
  deleteJob(id)                    { return request(jobPath(id), { method: 'DELETE' }); },
  launchOrchestrator(id, context)  { return request(`${jobPath(id)}/launch-orchestrator`, { method: 'POST', body: JSON.stringify(context ? { context } : {}) }); },
  replan(id, feedback)             { return request(`${jobPath(id)}/replan`, { method: 'POST', body: JSON.stringify({ feedback }) }); },
  applyReconciliation(id)          { return request(`${jobPath(id)}/reconciliation/apply`, { method: 'POST', body: '{}' }); },
  discardReconciliation(id)        { return request(`${jobPath(id)}/reconciliation/discard`, { method: 'POST', body: '{}' }); },
  addStep(id, step)                { return request(`${jobPath(id)}/steps`, { method: 'POST', body: JSON.stringify(step) }); },
  editStep(id, stepId, patch)      { return request(stepPath(id, stepId), { method: 'PATCH', body: JSON.stringify(patch) }); },
  cancelStep(id, stepId)           { return request(`${stepPath(id, stepId)}/cancel`, { method: 'POST', body: '{}' }); },
  reorderSteps(id, ids)            { return request(`${jobPath(id)}/steps/reorder`, { method: 'POST', body: JSON.stringify({ ids }) }); },
  resolveStep(id, stepId, payload) { return request(`${stepPath(id, stepId)}/resolve`, { method: 'POST', body: JSON.stringify(payload ?? {}) }); },
  retryStep(id, stepId)            { return request(`${stepPath(id, stepId)}/retry`, { method: 'POST', body: '{}' }); },
  tickNow(id)                      { return request(`${jobPath(id)}/tick`, { method: 'POST', body: '{}' }); },
  rerunLatest(id)                  { return request(`${jobPath(id)}/rerun-latest`, { method: 'POST', body: '{}' }); },
  resetJob(id)                     { return request(`${jobPath(id)}/reset`, { method: 'POST', body: '{}' }); },
  syncNow()                        { return request('/sync', { method: 'POST', body: '{}' }); },
  syncJob(id)                      { return request(`${jobPath(id)}/sync`, { method: 'POST', body: '{}' }); },
  resolveReply(id, stepId, body)   { return request(`${stepPath(id, stepId)}/replies/resolve`, { method: 'POST', body: JSON.stringify(body) }); },
  enqueueEdit(id, stepId, body)    { return request(`${stepPath(id, stepId)}/edits/enqueue`, { method: 'POST', body: JSON.stringify(body) }); },
  lockReply(id, stepId, body)      { return request(`${stepPath(id, stepId)}/replies/lock`, { method: 'POST', body: JSON.stringify(body) }); },
  react(id, stepId, body)          { return request(`${stepPath(id, stepId)}/reactions`, { method: 'POST', body: JSON.stringify(body) }); },
  regenerateReply(id, stepId, body) { return request(`${stepPath(id, stepId)}/replies/regenerate`, { method: 'POST', body: JSON.stringify(body) }); },
  launchStep(id, stepId)           { return request(`${stepPath(id, stepId)}/launch`, { method: 'POST', body: '{}' }); },
  setJobPriority(id, highPriority) { return request(`${jobPath(id)}/priority`, { method: 'POST', body: JSON.stringify({ highPriority }) }); },
};
