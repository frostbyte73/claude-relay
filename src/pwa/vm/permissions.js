// Permissions page view-model: pure derivations from raw
// /api/permission-groups, /api/allowlist/rules, and /api/permissions/pending
// payloads into the row/card shapes the three Permissions renderers consume.
// No DOM, no store reads — callers pass raw snapshots in.

const GROUP_ORDER = ['core', 'read', 'pull', 'edit', 'push'];

// Mirrors GATED_GROUPS in src/actions/registry.ts. Duplicated rather than fetched because
// the PWA has no route that exposes it, and a card that quietly stops saying "gated" is a
// worse failure than one that goes stale loudly — a test in this ship pins the two together.
export const GATED_GROUP_NAMES = ['push'];

const KIND_ORDER = ['tool', 'bash', 'mcp', 'path'];
const KIND_FIELD = {
  tool: 'alwaysAllow',
  bash: 'alwaysAllowBashPatterns',
  mcp: 'alwaysAllowMcpPatterns',
  path: 'alwaysAllowPathPatterns',
};
const KIND_LABEL = { tool: 'Tools', bash: 'Bash patterns', mcp: 'MCP patterns', path: 'Path patterns' };

function rulesOf(group, kind) {
  const list = group?.[KIND_FIELD[kind]];
  return Array.isArray(list) ? list : [];
}

export function groupCards(groups = []) {
  return [...groups]
    .sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name))
    .map((g) => ({
      name: g.name,
      description: g.description ?? '',
      actionCount: g.actionCount ?? 0,
      ruleCount: KIND_ORDER.reduce((n, k) => n + rulesOf(g, k).length, 0),
      gated: GATED_GROUP_NAMES.includes(g.name),
      tone: GROUP_ORDER.includes(g.name) ? g.name : 'core',
    }));
}

// `index` is the rule's position within its own kind array — the PUT body rebuilds the whole
// group, so an editor needs to address a rule by where it sits, not by its text (two identical
// patterns in one kind would otherwise be indistinguishable).
export function groupContents(group) {
  return KIND_ORDER
    .map((kind) => ({
      kind,
      label: KIND_LABEL[kind],
      rules: rulesOf(group, kind).map((value, index) => ({ kind, value, index })),
    }))
    .filter((s) => s.rules.length > 0);
}

function basenameOf(p) {
  if (typeof p !== 'string' || !p) return p;
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function scopeLabel(scope) {
  if (scope === 'global') return 'global';
  if (scope && typeof scope === 'object') {
    if (scope.project) return `project · ${basenameOf(scope.project)}`;
    if (scope.action) return `action · ${scope.action}`;
  }
  return 'unknown';
}

export function grantRows(rules = []) {
  return rules.map((r) => ({
    id: r.id,
    kind: r.kind,
    pattern: r.value,
    scopeText: scopeLabel(r.scope),
    editable: !(r.scope && typeof r.scope === 'object' && 'action' in r.scope),
  }));
}

export function pendingRows(pending = {}) {
  const mcp = (pending.mcp ?? []).filter((s) => s.unclassified > 0);

  const byAction = new Map();
  for (const row of pending.denials ?? []) {
    if (!byAction.has(row.action)) byAction.set(row.action, []);
    byAction.get(row.action).push(row);
  }
  const denials = [...byAction.entries()]
    .map(([action, rows]) => ({ action, rows }))
    .sort((a, b) => Math.max(...b.rows.map((r) => r.at)) - Math.max(...a.rows.map((r) => r.at)));

  const total = mcp.reduce((n, s) => n + s.unclassified, 0) + (pending.denials ?? []).length;

  return { mcp, denials, total };
}
