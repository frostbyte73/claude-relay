// Skills-library view-model (D2): pure derivation over state/actions.js's
// three raw lists — `actions` (on-disk Outpost actions: description/category/
// skillMd/merged allowlist), `catalog` (registry view: runner/permissions/
// schema/base allowlist), and `skills` (non-Outpost skills discovered under
// ~/.claude/skills, category 'custom' by convention). Zero DOM.

import { formatCostUsd, formatDurationMs } from './runs.js';
import { relPast } from '../utils/formatting.js';

function catalogByName(state) {
  const map = new Map();
  for (const a of state.catalog ?? []) map.set(a.name, a);
  return map;
}

// One row shape for both Outpost actions and external skills so the list/
// detail renderers don't need to branch on origin.
export function skillCatalog(state) {
  const byName = catalogByName(state);
  const fromActions = (state.actions ?? []).map((a) => {
    const cat = byName.get(a.name);
    return {
      name: a.name,
      category: a.category,
      description: a.description ?? '',
      skillMd: a.skillMd ?? '',
      allowlist: a.allowlist ?? cat?.allowlist ?? {},
      runner: cat?.runner ?? 'claude',
      permissions: cat?.permissions ?? [],
      sideEffects: cat?.side_effects ?? 'none',
      kind: 'action',
    };
  });
  const fromSkills = (state.skills ?? []).map((s) => ({
    name: s.name,
    category: 'custom',
    description: s.description ?? '',
    skillMd: s.skillMd ?? '',
    allowlist: {},
    runner: 'claude',
    permissions: [],
    sideEffects: 'none',
    kind: 'skill',
  }));
  return [...fromActions, ...fromSkills].sort((a, b) => a.name.localeCompare(b.name));
}

export function filterSkills(items, { q, category, kind } = {}) {
  const needle = (q ?? '').trim().toLowerCase();
  return items.filter((it) => {
    if (kind && it.kind !== kind) return false;
    if (category && category !== 'all' && it.category !== category) return false;
    if (!needle) return true;
    return it.name.toLowerCase().includes(needle) || it.description.toLowerCase().includes(needle);
  });
}

export function skillByName(state, name) {
  return skillCatalog(state).find((it) => it.name === name) ?? null;
}

// Ordered group names an item inherits — 'core' implicit for claude runners.
// Mirrors src/routes/meta.ts's groupNamesForAction; duplicated client-side
// since the server only exposes per-group action *counts*, not the reverse
// per-action group list.
export function permissionGroupNames(item) {
  const names = [];
  if (item.runner === 'claude') names.push('core');
  for (const g of item.permissions ?? []) if (g !== 'core') names.push(g);
  return names;
}

export function allowlistRuleCount(allowlist) {
  if (!allowlist) return 0;
  return (allowlist.alwaysAllow?.length ?? 0)
    + (allowlist.alwaysAllowBashPatterns?.length ?? 0)
    + (allowlist.alwaysAllowMcpPatterns?.length ?? 0)
    + (allowlist.alwaysAllowPathPatterns?.length ?? 0);
}

const OUTCOME_TONE = {
  accepted: 'ok',
  merged: 'ok',
  revised: 'warn',
  submitted: 'info',
  failed: 'hot',
  gave_up: 'hot',
  abandoned: 'idle',
  interrupted: 'idle',
};

export function outcomeTone(outcome) {
  return OUTCOME_TONE[outcome] ?? 'info';
}

function pct(v) {
  return typeof v === 'number' ? `${Math.round(v * 100)}%` : '—';
}

// Headline numbers for the detail pane. A null rate renders '—', never 0% — an
// action nothing has ruled on yet has no score, which is not the same as a bad one.
export function scorecardTiles(sc) {
  if (!sc) return [];
  return [
    { key: 'runs', label: 'Runs', value: String(sc.runs), tone: 'info' },
    { key: 'first-try', label: 'First try', value: pct(sc.firstTryRate), tone: sc.firstTryRate === null ? 'idle' : 'ok' },
    {
      key: 'revisions',
      label: 'Avg revisions',
      value: typeof sc.avgRevisions === 'number' ? sc.avgRevisions.toFixed(1) : '—',
      tone: (sc.avgRevisions ?? 0) > 0.5 ? 'warn' : 'info',
    },
    {
      key: 'failures',
      label: 'Failures',
      value: String((sc.outcomes?.failed ?? 0) + (sc.outcomes?.gave_up ?? 0)),
      tone: (sc.outcomes?.failed ?? 0) + (sc.outcomes?.gave_up ?? 0) > 0 ? 'hot' : 'info',
    },
    { key: 'denials', label: 'Denials', value: String(sc.denials?.total ?? 0), tone: (sc.denials?.total ?? 0) > 0 ? 'warn' : 'info' },
    { key: 'cost', label: 'Cost / run', value: formatCostUsd(sc.cost?.avgUsd ?? null), tone: 'info' },
  ];
}

export function scorecardRows(sc, now = Date.now()) {
  return (sc?.recent ?? []).map((r) => ({
    id: r.id,
    round: r.round,
    attempt: r.attempt,
    outcome: r.outcome ?? 'submitted',
    tone: outcomeTone(r.outcome ?? 'submitted'),
    durationText: typeof r.durationMs === 'number' ? formatDurationMs(r.durationMs) : '—',
    costText: formatCostUsd(r.costUsd ?? null),
    whenText: relPast(r.startedAt, now),
    jobId: r.jobId,
  }));
}

const REVISION_TONE = {
  applied: 'info',
  proposed: 'info',
  created: 'idle',
  rejected: 'idle',
  reviewed: 'idle',
  reverted: 'warn',
  drifted: 'warn',
  deleted: 'hot',
};

const REVISION_LABEL = {
  applied: 'applied',
  proposed: 'proposed',
  created: 'first recorded',
  rejected: 'rejected',
  reviewed: 'reviewed, no change',
  reverted: 'reverted',
  drifted: 'changed on disk',
  deleted: 'deleted',
};

const AUTHOR_LABEL = {
  user: 'you',
  improver: 'improver',
  external: 'edited outside Outpost',
  system: 'system',
};

export function bytesText(n) {
  if (typeof n !== 'number') return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}

// One row per recorded event on an action — the applied revisions and the proposals that
// never landed, in one list. `canRevert` is the server's call: it knows whether the body
// is still retained.
export function revisionRows(events, now = Date.now()) {
  return (events ?? []).map((e) => ({
    id: e.id,
    kind: e.kind,
    kindLabel: REVISION_LABEL[e.kind] ?? e.kind,
    tone: REVISION_TONE[e.kind] ?? 'info',
    authorLabel: AUTHOR_LABEL[e.author] ?? e.author ?? '',
    whenText: relPast(e.at, now),
    rationale: e.rationale ?? '',
    feedback: e.feedback ?? '',
    ruleAdds: e.allowlistAdds ?? [],
    ruleRemovals: e.allowlistRemoved ?? [],
    diff: e.diff ?? '',
    hasBody: !!e.hasBody,
    canRevert: !!e.canRevert,
    bytesText: bytesText(e.bodyBytes),
  }));
}

// Classifies unified-diff lines for rendering. Deliberately not a parser — src/git/diff-parser.js
// is TypeScript and the PWA ships unbundled, so it can't be imported here.
export function revisionDiffLines(diffText) {
  if (!diffText) return [];
  const lines = String(diffText).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((text) => {
    if (text.startsWith('@@')) return { cls: 'hunk', text };
    if (text.startsWith('diff --git ') || text.startsWith('--- ') || text.startsWith('+++ ')) {
      return { cls: 'meta', text };
    }
    if (text.startsWith('+')) return { cls: 'add', text };
    if (text.startsWith('-')) return { cls: 'del', text };
    return { cls: 'ctx', text };
  });
}

// Strips a leading `---\n...\n---\n` YAML frontmatter block before
// markdown-rendering a SKILL.md body (name/description are already surfaced
// by the header — same transform as the legacy work/actions-list.js editor).
export function stripFrontmatter(md) {
  const m = String(md ?? '').match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}
