async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`actions api ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const actionsApi = {
  list()                  { return request('/api/actions'); },
  createNew(feedback = '', name = '', category = '') { return request('/api/actions/new', { method: 'POST', body: JSON.stringify({ feedback, name, category }) }); },
  createNewSkill(feedback = '') { return request('/api/skills/new', { method: 'POST', body: JSON.stringify({ feedback }) }); },
  edit(name, feedback = '')     { return request(`/api/actions/${encodeURIComponent(name)}/edit`, { method: 'POST', body: JSON.stringify({ feedback }) }); },
  editSkill(name, feedback = '') { return request(`/api/skills/${encodeURIComponent(name)}/edit`, { method: 'POST', body: JSON.stringify({ feedback }) }); },
  dismissDenial(name, denialId) { return request(`/api/actions/${encodeURIComponent(name)}/denials/${encodeURIComponent(denialId)}`, { method: 'DELETE' }); },
  approveProposal(sessionId)      { return request(`/api/action-edits/${encodeURIComponent(sessionId)}/approve`, { method: 'POST', body: '{}' }); },
  feedbackProposal(sessionId, feedback) { return request(`/api/action-edits/${encodeURIComponent(sessionId)}/proposal-feedback`, { method: 'POST', body: JSON.stringify({ feedback }) }); },
  cancelEdit(sessionId)           { return request(`/api/action-edits/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: '{}' }); },
  remove(name)            { return request(`/api/actions/${encodeURIComponent(name)}`, { method: 'DELETE' }); },
  addAllowlistRule(name, kind, value) {
    return request('/api/allowlist/rules', {
      method: 'POST',
      body: JSON.stringify({ kind, value, scope: { action: name } }),
    });
  },
  // Skills-library detail: recent journal entries + the permission-groups
  // catalog (src/routes/meta.ts). Colocated here rather than a new net file —
  // both are action-metadata reads, same shape of concern as the rest of this module.
  journal(name, limit) {
    return request(`/api/actions/${encodeURIComponent(name)}/journal${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`);
  },
  scorecard(name, window = '30d') {
    return request(`/api/actions/${encodeURIComponent(name)}/scorecard?window=${encodeURIComponent(window)}`);
  },
  permissionGroups() { return request('/api/permission-groups'); },
};
