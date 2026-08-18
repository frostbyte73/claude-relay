// Permissions page view-model: pure derivations from raw
// /api/permission-groups, /api/allowlist/rules, and /api/permissions/pending
// payloads into the row/card shapes the three Permissions renderers consume.
// No DOM, no store reads — callers pass raw snapshots in.

const GROUP_ORDER = ['core', 'read', 'pull', 'edit', 'push'];

// Mirrors GATED_GROUPS in src/actions/registry.ts. Duplicated rather than fetched because
// the PWA has no route that exposes it, and a card that quietly stops saying "gated" is a
// worse failure than one that goes stale loudly — a test in this ship pins the two together.
export const GATED_GROUP_NAMES = ['push'];

export const KIND_ORDER = ['tool', 'bash', 'mcp', 'path'];
const KIND_FIELD = {
  tool: 'alwaysAllow',
  bash: 'alwaysAllowBashPatterns',
  mcp: 'alwaysAllowMcpPatterns',
  path: 'alwaysAllowPathPatterns',
};
// Exported because the editor also labels the kinds a group has no rules for — groupContents
// drops those sections, and a second copy of the labels would be free to drift.
export const KIND_LABEL = { tool: 'Tools', bash: 'Bash patterns', mcp: 'MCP patterns', path: 'Path patterns' };

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

// The three untouched arrays are copied, not aliased: the snapshot this reads from must
// survive a refused save intact, and an alias makes that a promise about who mutates rather
// than a property of the value.
function withRules(group, kind, rules) {
  const next = {
    description: group?.description ?? '',
    alwaysAllow: [...rulesOf(group, 'tool')],
    alwaysAllowBashPatterns: [...rulesOf(group, 'bash')],
    alwaysAllowMcpPatterns: [...rulesOf(group, 'mcp')],
    alwaysAllowPathPatterns: [...rulesOf(group, 'path')],
  };
  next[KIND_FIELD[kind]] = rules;
  return next;
}

// PUT replaces the whole group, so every edit rebuilds all four arrays from the current
// state. Pure and copy-on-write: the store's snapshot must survive a refused save intact.
// `index === null` appends.
export function groupWithRule(group, kind, index, value) {
  const rules = [...rulesOf(group, kind)];
  if (index === null) rules.push(value); else rules[index] = value;
  return withRules(group, kind, rules);
}

export function groupWithoutRule(group, kind, index) {
  return withRules(group, kind, rulesOf(group, kind).filter((_, i) => i !== index));
}

// A refused save answers `<rule>: <why>`, and the rule it names is not always the one just
// edited — a group can already hold a rule a later lint would refuse, and the server reports
// the first one it hits. Match the message back to a row so the explanation lands on the
// offending rule; a null answer means the page shows it group-wide instead of blaming an
// arbitrary row. Longest match wins, so one rule that prefixes another can't steal it.
export function errorTarget(group, message) {
  let best = null;
  for (const kind of KIND_ORDER) {
    rulesOf(group, kind).forEach((value, index) => {
      if (!message.startsWith(`${value}: `)) return;
      if (!best || value.length > best.value.length) best = { kind, index, value };
    });
  }
  return best ? { kind: best.kind, index: best.index } : null;
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

// `/api/mcp/catalog`'s raw `{ servers: ServerProposal[] }` payload — fetched separately from,
// and slower than, the denials half of the pending panel (a live tools/list probe per
// configured server; see routes/meta.ts's handleGetPermissionsPending comment on why the two
// don't share a request). A placement's `group: null` is exactly "the classifier couldn't
// place it, a human must" — i.e. unclassified. The caller composes this together with the
// denials-route payload into one `pendingRows({ mcp, denials })` call; the shape translation
// stays here so neither fetch site has to know pendingRows' input shape.
export function mcpUnclassifiedRows(servers = []) {
  return servers.map((s) => ({
    server: s.server,
    unclassified: (s.placements ?? []).filter((p) => p.group === null).length,
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
