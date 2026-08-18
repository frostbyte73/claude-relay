// Fetch wrappers for the Settings/Permissions endpoints: permission groups (and their
// revision history), allowlist rules, pending classifications, MCP connection health.
//
// The mutating half — PUT /api/permission-groups/:name above all — answers a refused edit
// with 400 and the lint's own plain-text explanation of WHY the rule is unsafe. That text is
// the only explanation a user ever gets, so MetaApiError carries the response body through
// verbatim: callers render `err.body`, never a message of their own invention.

export class MetaApiError extends Error {
  constructor(status, body) {
    super(body || `meta api ${status}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new MetaApiError(res.status, text.trim());
  }
  return res.status === 204 ? null : res.json();
}

function jsonBody(body) {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const metaApi = {
  permissionGroups() { return request('/api/permission-groups'); },
  allowlistRules()   { return request('/api/allowlist/rules'); },
  mcpStatus()        { return request('/api/mcp/status'); },
  pending()          { return request('/api/permissions/pending'); },

  // Replaces the WHOLE group — the caller rebuilds all four pattern arrays.
  putPermissionGroup(name, group, rationale) {
    return request(`/api/permission-groups/${encodeURIComponent(name)}`,
      jsonBody(rationale ? { group, rationale } : { group }));
  },
  groupRevisions(name) {
    return request(`/api/permission-groups/${encodeURIComponent(name)}/revisions`);
  },
  revertGroup(name, revisionId) {
    return request(
      `/api/permission-groups/${encodeURIComponent(name)}/revert/${encodeURIComponent(revisionId)}`,
      { method: 'POST' },
    );
  },

  putAllowlistRule(id, value) {
    return request(`/api/allowlist/rules/${encodeURIComponent(id)}`, jsonBody({ value }));
  },
  deleteAllowlistRule(id) {
    return request(`/api/allowlist/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
