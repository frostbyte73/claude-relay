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
const draftPath = (id, stepId, draftId) => `${stepPath(id, stepId)}/drafts/${encodeURIComponent(draftId)}`;

export const workApi = {
  listJobs()                       { return request('/jobs'); },
  getJob(id)                       { return request(jobPath(id)); },
  // Whole timeline from the spill log; job.events itself is capped at the last 50.
  getJobEvents(id, limit = 1000)   { return request(`${jobPath(id)}/events?limit=${encodeURIComponent(limit)}`); },
  // Per-file diffs for the step's commented files — what lets a review comment render inside
  // its hunk instead of at the end of one. Fetched on demand; the daemon does not persist these.
  getPrPatches(id, stepId)         { return request(`${stepPath(id, stepId)}/pr-patches`); },
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
  discardReconciliation(id, feedback) { return request(`${jobPath(id)}/reconciliation/discard`, { method: 'POST', body: JSON.stringify(feedback ? { feedback } : {}) }); },
  addStep(id, step)                { return request(`${jobPath(id)}/steps`, { method: 'POST', body: JSON.stringify(step) }); },
  editStep(id, stepId, patch)      { return request(stepPath(id, stepId), { method: 'PATCH', body: JSON.stringify(patch) }); },
  cancelStep(id, stepId)           { return request(`${stepPath(id, stepId)}/cancel`, { method: 'POST', body: '{}' }); },
  reorderSteps(id, ids)            { return request(`${jobPath(id)}/steps/reorder`, { method: 'POST', body: JSON.stringify({ ids }) }); },
  resolveStep(id, stepId, payload) { return request(`${stepPath(id, stepId)}/resolve`, { method: 'POST', body: JSON.stringify(payload ?? {}) }); },
  retryStep(id, stepId, note)      { return request(`${stepPath(id, stepId)}/retry`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }); },
  tickNow(id)                      { return request(`${jobPath(id)}/tick`, { method: 'POST', body: '{}' }); },
  rerunLatest(id)                  { return request(`${jobPath(id)}/rerun-latest`, { method: 'POST', body: '{}' }); },
  resetJob(id)                     { return request(`${jobPath(id)}/reset`, { method: 'POST', body: '{}' }); },
  syncNow()                        { return request('/sync', { method: 'POST', body: '{}' }); },
  syncJob(id)                      { return request(`${jobPath(id)}/sync`, { method: 'POST', body: '{}' }); },
  launchStep(id, stepId)           { return request(`${stepPath(id, stepId)}/launch`, { method: 'POST', body: '{}' }); },
  messageStep(id, stepId, body)    { return request(`${stepPath(id, stepId)}/message`, { method: 'POST', body: JSON.stringify({ body }) }); },
  resolveStepGate(id, stepId, approved, feedback) {
    return request(`${stepPath(id, stepId)}/gate`, { method: 'POST', body: JSON.stringify({ approved, ...(feedback !== undefined ? { feedback } : {}) }) });
  },
  markStepResolved(id, stepId)     { return request(`${stepPath(id, stepId)}/mark-resolved`, { method: 'POST', body: '{}' }); },
  setJobPriority(id, highPriority) { return request(`${jobPath(id)}/priority`, { method: 'POST', body: JSON.stringify({ highPriority }) }); },
  // Write-draft decisions (Task 9's routes). `calls` is the user's (possibly edited) payload —
  // it IS what gets pinned and executed on accept, not just a confirmation flag.
  acceptDraft(id, stepId, draftId, calls) {
    return request(`${draftPath(id, stepId, draftId)}/accept`, { method: 'POST', body: JSON.stringify({ calls }) });
  },
  reviseDraft(id, stepId, draftId, feedback) {
    return request(`${draftPath(id, stepId, draftId)}/revise`, { method: 'POST', body: JSON.stringify({ feedback }) });
  },
  denyDraft(id, stepId, draftId, reason) {
    return request(`${draftPath(id, stepId, draftId)}/deny`, { method: 'POST', body: JSON.stringify({ reason }) });
  },
};
