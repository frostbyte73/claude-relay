import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { Ajv } from 'ajv';
import type {
  ActionAllowlist, ActionCategory, ActionDef, ActionFrontmatter, ActionKind, ActionRunner,
  PermissionGroupMap, SideEffects,
} from './types.js';
import { assertNotWriteShaped } from '../permissions/write-shape.js';

export const ACTION_CATEGORIES: readonly ActionCategory[] = ['read','write','code','meta'];
// Groups whose grants mean "may propose this write for approval", not "may run it".
export const GATED_GROUPS: ReadonlySet<string> = new Set(['push']);
const KINDS: readonly ActionKind[] = ['action','step-orchestrator'];
const SIDE_EFFECTS: readonly SideEffects[] = ['none','gated-write','worktree-edit','external-write'];
const RUNNERS: readonly ActionRunner[] = ['claude','builtin'];

// Resolve a dotted action name (`<category>.<rest>`) to its on-disk directory
// `<actionsDir>/<category>/<rest>`. Throws on an unknown category or a `rest`
// that isn't a plain kebab slug — the latter doubles as a path-traversal guard
// so a malformed name can't escape actionsDir.
export function actionDirFor(actionsDir: string, name: string): { dir: string; category: string; rest: string } {
  const dot = name.indexOf('.');
  if (dot <= 0) throw new Error(`action name must be "<category>.<rest>": ${JSON.stringify(name)}`);
  const category = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  if (!ACTION_CATEGORIES.includes(category as ActionCategory))
    throw new Error(`action category must be one of ${ACTION_CATEGORIES.join('|')}: ${JSON.stringify(category)}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rest))
    throw new Error(`action name segment must match ^[a-z0-9][a-z0-9-]*$: ${JSON.stringify(rest)}`);
  return { dir: join(actionsDir, category, rest), category, rest };
}

// The groups an action inherits: `core` implied for a claude runner, then its declared
// `permissions` (an explicit "core" in that list is a no-op). Exported because three callers
// need the same answer and they must not drift — resolvePermissions builds the action's grants
// from it, GET /api/permission-groups counts actions per group with it, and the denial-verdict
// route refuses a promote into a group outside it (a group the action can't see grants it
// nothing). Takes the frontmatter shape structurally so a caller holding a plain parsed
// SKILL.md doesn't need an ActionDef.
export function groupNamesForAction(fm: { outpost: { runner: string; permissions?: string[] } }): string[] {
  const names: string[] = [];
  if (fm.outpost.runner === 'claude') names.push('core');
  for (const g of fm.outpost.permissions ?? []) {
    if (g !== 'core') names.push(g);
  }
  return names;
}

export interface RegistryLoadError {
  path: string;
  message: string;
}

export interface RegistryLoadResult {
  actions: number;
  errors: RegistryLoadError[];
}

export interface ActionRegistryOpts {
  // Inherited per-action via outpost.permissions; `core` is auto-granted to claude-runners.
  permissionGroups?: PermissionGroupMap;
}

// Filesystem-backed action registry. load() throws on any malformed entry.
export class ActionRegistry {
  private readonly actionsByName = new Map<string, ActionDef>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private permissionGroups: PermissionGroupMap;

  constructor(private readonly actionsDir: string, opts: ActionRegistryOpts = {}) {
    this.permissionGroups = opts.permissionGroups ?? {};
    // Accept format hints as documentation; ajv warns otherwise.
    for (const fmt of ['uri','url','date-time','date','time','email','uuid','regex','ipv4','ipv6','hostname']) {
      this.ajv.addFormat(fmt, true);
    }
  }

  load(): RegistryLoadResult {
    const errors: RegistryLoadError[] = [];
    this.actionsByName.clear();
    if (existsSync(this.actionsDir)) this.walkActions(this.actionsDir, errors);
    // Rosters resolve only once every action is loaded. A name that doesn't is a rebind target
    // the controller can never reach — it would fail mid-step, after the work leading up to it.
    for (const def of this.actionsByName.values()) {
      for (const entry of def.frontmatter.outpost.roster ?? []) {
        if (!this.actionsByName.has(entry))
          errors.push({ path: def.dir, message: `outpost.roster names an unknown action: ${entry}` });
      }
    }
    if (errors.length > 0) {
      const detail = errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
      throw new Error(`Action registry: ${errors.length} invalid entr${errors.length === 1 ? 'y' : 'ies'}\n${detail}`);
    }
    return { actions: this.actionsByName.size, errors };
  }

  // Caller must load() afterwards — every action's resolved allowlist is derived from these,
  // and nothing already loaded is recomputed.
  setPermissionGroups(groups: PermissionGroupMap): void {
    this.permissionGroups = groups;
  }

  getAction(name: string): ActionDef | undefined { return this.actionsByName.get(name); }
  listActions(): ActionDef[] { return [...this.actionsByName.values()]; }
  gatedFor(actionName: string): ActionAllowlist | undefined {
    return this.getAction(actionName)?.gated;
  }

  // The groups this action's grants actually come from — the only destinations a promote can
  // usefully target. Filtered to groups that exist right now, since an implied `core` is only
  // inherited if there is a `core` to inherit. `undefined` means the action isn't in the
  // catalog at all, which is a different answer from "inherits nothing".
  inheritedGroups(actionName: string): string[] | undefined {
    const action = this.getAction(actionName);
    if (!action) return undefined;
    return groupNamesForAction(action.frontmatter).filter((name) => !!this.permissionGroups[name]);
  }

  private walkActions(root: string, errors: RegistryLoadError[]): void {
    for (const category of safeReaddir(root)) {
      const catDir = join(root, category);
      if (!isDir(catDir)) continue;
      for (const name of safeReaddir(catDir)) {
        const actionDir = join(catDir, name);
        if (!isDir(actionDir)) continue;
        try {
          const def = this.loadAction(actionDir);
          if (this.actionsByName.has(def.name)) {
            errors.push({ path: actionDir, message: `duplicate action name: ${def.name}` });
            continue;
          }
          this.actionsByName.set(def.name, def);
        } catch (e) {
          errors.push({ path: actionDir, message: (e as Error).message });
        }
      }
    }
  }

  private loadAction(dir: string): ActionDef {
    const { frontmatter, body } = parseFrontmatter(join(dir, 'SKILL.md'));
    const fm = this.coerceActionFrontmatter(frontmatter, dir);

    const inputSchema = readJson(join(dir, 'input.schema.json'));
    const outputSchema = readJson(join(dir, 'output.schema.json'));
    try { this.ajv.compile(inputSchema as object); }
    catch (e) { throw new Error(`input.schema.json invalid: ${(e as Error).message}`); }
    try { this.ajv.compile(outputSchema as object); }
    catch (e) { throw new Error(`output.schema.json invalid: ${(e as Error).message}`); }

    const extras = readAllowlist(join(dir, 'allowlist.json'));
    for (const v of extras.alwaysAllow) assertNotWriteShaped('tool', v);
    for (const v of extras.alwaysAllowBashPatterns) assertNotWriteShaped('bash', v);
    for (const v of extras.alwaysAllowMcpPatterns) assertNotWriteShaped('mcp', v);
    for (const v of extras.alwaysAllowPathPatterns) assertNotWriteShaped('path', v);
    const { allowlist, gated } = this.resolvePermissions(fm, extras);

    return {
      name: fm.name,
      dir,
      frontmatter: fm,
      body,
      inputSchema,
      outputSchema,
      allowlist,
      gated,
    };
  }

  // Returns the union of (core if claude) + each named group + colocated extras, plus the
  // subset of that union which came from a gated group (see GATED_GROUPS).
  private resolvePermissions(
    fm: ActionFrontmatter, extras: ActionAllowlist,
  ): { allowlist: ActionAllowlist; gated: ActionAllowlist } {
    const merged: ActionAllowlist = {
      alwaysAllow: [], alwaysAllowBashPatterns: [],
      alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
    };
    const gated: ActionAllowlist = {
      alwaysAllow: [], alwaysAllowBashPatterns: [],
      alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
    };
    for (const name of groupNamesForAction(fm)) {
      const group = this.permissionGroups[name];
      if (!group) {
        // An absent `core` is legitimate — a registry built without permission groups at all,
        // or a builtin runner. An absent *declared* group is a broken SKILL.md.
        if (name === 'core') continue;
        throw new Error(`unknown permission group: ${JSON.stringify(name)}`);
      }
      mergeAllowlist(merged, group);
      if (GATED_GROUPS.has(name)) mergeAllowlist(gated, group);
    }
    mergeAllowlist(merged, extras);
    return { allowlist: merged, gated };
  }

  private coerceActionFrontmatter(raw: unknown, dir: string): ActionFrontmatter {
    if (!isObject(raw)) throw new Error('frontmatter missing or not an object');
    const r = raw as Record<string, unknown>;
    const op = r.outpost;
    if (!isObject(op)) throw new Error('outpost block missing');
    const o = op as Record<string, unknown>;
    const kind: ActionKind = o.kind === undefined ? 'action' : o.kind as ActionKind;
    if (!KINDS.includes(kind))
      throw new Error(`outpost.kind must be one of ${KINDS.join('|')} (got ${JSON.stringify(o.kind)})`);
    if (typeof r.name !== 'string' || !r.name.includes('.'))
      throw new Error('frontmatter.name must be "<category>.<rest>"');
    if (typeof r.description !== 'string' || !r.description)
      throw new Error('frontmatter.description required');
    if (!ACTION_CATEGORIES.includes(o.category as ActionCategory))
      throw new Error(`outpost.category must be one of ${ACTION_CATEGORIES.join('|')}`);
    if (!SIDE_EFFECTS.includes(o.side_effects as SideEffects))
      throw new Error(`outpost.side_effects must be one of ${SIDE_EFFECTS.join('|')}`);
    if (!RUNNERS.includes(o.runner as ActionRunner))
      throw new Error(`outpost.runner must be one of ${RUNNERS.join('|')}`);

    // Dir-vs-name check: actions/<category>/<rest>/ ⇒ name === "<category>.<rest>"
    const restDir = basename(dir);
    const catDir = basename(dirname(dir));
    const expected = `${catDir}.${restDir}`;
    if (r.name !== expected)
      throw new Error(`frontmatter.name ${JSON.stringify(r.name)} != dir-derived ${JSON.stringify(expected)}`);
    if (o.category !== catDir)
      throw new Error(`outpost.category ${JSON.stringify(o.category)} != dir category ${JSON.stringify(catDir)}`);

    const permissions = o.permissions;
    if (permissions !== undefined && !(Array.isArray(permissions) && permissions.every((x) => typeof x === 'string'))) {
      throw new Error('outpost.permissions must be a string[] of group names');
    }

    if (o.plannable !== undefined && typeof o.plannable !== 'boolean')
      throw new Error('outpost.plannable must be a boolean');

    const roster = o.roster;
    if (roster !== undefined) {
      if (!(Array.isArray(roster) && roster.every((x) => typeof x === 'string')))
        throw new Error('outpost.roster must be a string[] of action names');
      if (kind !== 'step-orchestrator')
        throw new Error('outpost.roster is only meaningful on kind: step-orchestrator');
    }

    return {
      name: r.name,
      description: r.description,
      outpost: {
        kind,
        category: o.category as ActionCategory,
        side_effects: o.side_effects as SideEffects,
        runner: o.runner as ActionRunner,
        permissions: permissions as string[] | undefined,
        plannable: o.plannable as boolean | undefined,
        roster: roster as string[] | undefined,
        timeout_sec: typeof o.timeout_sec === 'number' ? o.timeout_sec : undefined,
        retries: typeof o.retries === 'number' ? o.retries : undefined,
      },
    };
  }
}

function mergeAllowlist(dst: ActionAllowlist, src: ActionAllowlist): void {
  for (const x of src.alwaysAllow)             if (!dst.alwaysAllow.includes(x))             dst.alwaysAllow.push(x);
  for (const x of src.alwaysAllowBashPatterns) if (!dst.alwaysAllowBashPatterns.includes(x)) dst.alwaysAllowBashPatterns.push(x);
  for (const x of src.alwaysAllowMcpPatterns)  if (!dst.alwaysAllowMcpPatterns.includes(x))  dst.alwaysAllowMcpPatterns.push(x);
  for (const x of src.alwaysAllowPathPatterns) if (!dst.alwaysAllowPathPatterns.includes(x)) dst.alwaysAllowPathPatterns.push(x);
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function readAllowlist(path: string): ActionAllowlist {
  const empty: ActionAllowlist = {
    alwaysAllow: [], alwaysAllowBashPatterns: [],
    alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  if (!existsSync(path)) return empty;
  const raw = readJson(path) as Partial<ActionAllowlist>;
  return {
    alwaysAllow: Array.isArray(raw.alwaysAllow) ? [...raw.alwaysAllow] : [],
    alwaysAllowBashPatterns: Array.isArray(raw.alwaysAllowBashPatterns) ? [...raw.alwaysAllowBashPatterns] : [],
    alwaysAllowMcpPatterns: Array.isArray(raw.alwaysAllowMcpPatterns) ? [...raw.alwaysAllowMcpPatterns] : [],
    alwaysAllowPathPatterns: Array.isArray(raw.alwaysAllowPathPatterns) ? [...raw.alwaysAllowPathPatterns] : [],
  };
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
function parseFrontmatter(path: string): { frontmatter: unknown; body: string } {
  const src = readFileSync(path, 'utf8');
  const m = FM_RE.exec(src);
  if (!m) throw new Error('no frontmatter block (expected leading "---\\n...\\n---")');
  const [, fmBlock = '', body = ''] = m;
  // JSON_SCHEMA blocks custom YAML tags; frontmatter is untrusted input.
  const fm = yaml.load(fmBlock, { schema: yaml.JSON_SCHEMA });
  return { frontmatter: fm, body };
}
