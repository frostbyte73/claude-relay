import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import type { ActionRegistry } from '../actions/index.js';
import { actionDirFor, ACTION_CATEGORIES } from '../actions/registry.js';
import { buildScorecard } from '../actions/scorecard.js';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRunsStore } from '../storage/action-runs-store.js';
import type { ActionDenial, DenialsStore } from '../storage/denials-store.js';
import type { ActionAuthor, ActionRevisionsStore } from '../storage/action-revisions-store.js';
import {
  forgetEdit, loadPersistedEdits, persistEdit,
  type ActionEdit, type ActionProposal,
} from '../storage/action-edits-store.js';
import { intakeProposal, ledgerActionFor, onSessionGone } from '../actions/proposal-intake.js';
import { resolvableWriteTargets } from '../permissions/shell-split.js';
import type { ActionRunLedger } from '../work/action-run-ledger.js';
import type { SessionManager } from '../session/session-manager.js';
import type { WorkEngine } from '../work/engine.js';
import type { DaemonConfig } from '../config.js';
import { ensureActionsInstalled, bundledRepoDir } from '../setup-actions.js';
import { parseJsonObject, parseWindowMs, readJsonBody } from './util.js';

export interface ActionsRoutesDeps {
  outpostActionsDir: string;
  RUNTIME_DIR: string;
  SRC_DIR: string;
  secret: string;
  config: DaemonConfig;
  actionRegistry: ActionRegistry;
  actionsStore: ActionsStore;
  actionRunsStore: ActionRunsStore;
  denialsStore: DenialsStore;
  actionRunLedger: ActionRunLedger;
  actionRevisionsStore: ActionRevisionsStore;
  manager: SessionManager;
  engine: WorkEngine;
  notifyAll: (message: unknown) => void;
}

const DEFAULT_SCORECARD_WINDOW = '30d';

// Hook-facing handlers the daemon wires into HookServer/MCP after this factory
// runs. The action-edit + denial state they close over lives here so the whole
// action-authoring surface is one module rather than scattered across daemon.ts.
export interface ActionsRoutesHandlers {
  recordActionDenial: (denial: {
    actionName: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
  }) => void;
  onActionProposalHandler: (body: string) => Promise<void>;
  // Called from the daemon's session-end hook: drop the tracking entry for a
  // dying action-edit session so its card stops showing a stale "review" pill.
  dropEditForSession: (sessionId: string) => void;
  // Registers the ActionEdit for a schedule-spawned meta.improve-actions session.
  // Without it the proposal that session posts has no edit to land on and is dropped.
  beginImproverEdit: (input: { sessionId: string; actionName: string }) => void;
  // What the improver's selector reads to avoid racing an edit already in flight.
  listPendingEdits: () => Array<{ actionName: string | null; authorAction?: string }>;
}

export function registerActionsRoutes(server: Server, deps: ActionsRoutesDeps): ActionsRoutesHandlers {
  const {
    outpostActionsDir, RUNTIME_DIR, SRC_DIR, secret, config,
    actionRegistry, actionsStore, actionRunsStore, denialsStore, actionRunLedger,
    actionRevisionsStore, manager, engine, notifyAll,
  } = deps;

  // ── local helpers ──────────────────────────────────────────────────────
  function spawnEditSession(
    kind: 'action-edit' | 'skill-edit',
    cwd: string,
    initialInput: string,
    extraEnv: Record<string, string> = {},
  ): string {
    const sessionId = randomUUID();
    manager.spawnDetached(sessionId, cwd, extraEnv);
    manager.tagKind(sessionId, kind);
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: initialInput } });
    return sessionId;
  }

  function loopbackApiUrl(): string {
    const port = config.httpPort;
    return port !== null ? `http://127.0.0.1:${port}` : '';
  }

  function readSkillDescription(dir: string): string {
    try {
      const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      const m = md.match(/^description:\s*(.+)$/m);
      return m && m[1] ? m[1].trim() : '';
    } catch { return ''; }
  }

  function dedupe(xs: string[]): string[] { return Array.from(new Set(xs)); }

  function listOutpostActions() {
    const out: Array<{ name: string; description: string; category: string; skillMd: string; dir: string; allowlist: object }> = [];
    for (const a of actionRegistry.listActions()) {
      const overlay = actionsStore.get(a.name).allowlist;
      const merged = {
        alwaysAllow:             dedupe([...a.allowlist.alwaysAllow,             ...(overlay.alwaysAllow ?? [])]),
        alwaysAllowBashPatterns: dedupe([...a.allowlist.alwaysAllowBashPatterns, ...(overlay.alwaysAllowBashPatterns ?? [])]),
        alwaysAllowMcpPatterns:  dedupe([...a.allowlist.alwaysAllowMcpPatterns,  ...(overlay.alwaysAllowMcpPatterns ?? [])]),
        alwaysAllowPathPatterns: dedupe([...a.allowlist.alwaysAllowPathPatterns, ...(overlay.alwaysAllowPathPatterns ?? [])]),
      };
      let body = '';
      try { body = readFileSync(join(a.dir, 'SKILL.md'), 'utf8'); } catch { /* missing */ }
      out.push({
        name: a.name,
        dir: a.dir,
        description: a.frontmatter.description,
        category: a.frontmatter.outpost.category,
        skillMd: body,
        allowlist: merged,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function listExternalSkills() {
    const skillsDir = join(homedir(), '.claude', 'skills');
    // realpathSync follows the runtime → repo symlink (setup-actions's dev mode),
    // so we also exclude the repo's bundled actions dir to keep them out of skills.
    const repoActionsDir = join(SRC_DIR, '..', 'actions');
    let entries: string[] = [];
    try { entries = readdirSync(skillsDir); } catch { return []; }
    const out: Array<{ name: string; description: string; skillMd: string; dir: string }> = [];
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const link = join(skillsDir, name);
      let real: string;
      try { real = realpathSync(link); } catch { continue; }
      if (real.startsWith(outpostActionsDir)) continue;
      if (real.startsWith(repoActionsDir)) continue;
      if (real.includes('/.claude/plugins/cache/')) continue;
      try { if (!lstatSync(real).isDirectory()) continue; } catch { continue; }
      if (!existsSync(join(real, 'SKILL.md'))) continue;
      let body = '';
      try { body = readFileSync(join(real, 'SKILL.md'), 'utf8'); } catch { /* missing */ }
      out.push({ name, dir: real, description: readSkillDescription(real), skillMd: body });
    }
    return out;
  }

  function readSkillMd(dir: string): string {
    try { return readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { return ''; }
  }

  function writeActionEnvelope(sessionId: string, body: object): string {
    const dir = join(RUNTIME_DIR, 'action-edits', sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'envelope.json');
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
  }

  function actionEditEnv(sessionId: string, envelopePath: string, actionName: string | null): Record<string, string> {
    const env: Record<string, string> = {
      OUTPOST_API_URL: loopbackApiUrl(),
      OUTPOST_ENVELOPE: envelopePath,
      OUTPOST_HOOK_PORT: String(config.hookPort),
      DAEMON_AUTH: secret,
      ACTION_EDIT_SESSION_ID: sessionId,
    };
    if (actionName) env.OUTPOST_ACTION_NAME = actionName;
    return env;
  }

  // ── action-edit propose/verify/apply state ───────────────────────────
  // Keyed by action name (for edits) or by the placeholder `new:<sessionId>`
  // for "new action" flows where the name isn't chosen until the skill picks one.
  const actionEditsDir = join(RUNTIME_DIR, 'action-edits');
  const actionEdits = new Map<string, ActionEdit>();
  function editKey(actionName: string | null, sessionId: string): string {
    return actionName ? `a:${actionName}` : `new:${sessionId}`;
  }
  function findEditBySession(sessionId: string): { key: string; edit: ActionEdit } | undefined {
    for (const [key, edit] of actionEdits) {
      if (edit.sessionId === sessionId) return { key, edit };
    }
    return undefined;
  }
  function setEdit(key: string, edit: ActionEdit): void {
    actionEdits.set(key, edit);
    persistEdit(actionEditsDir, edit);
    try { notifyAll({ type: 'actions_changed' }); } catch { /* during startup */ }
  }
  function clearEdit(key: string): void {
    const edit = actionEdits.get(key);
    if (actionEdits.delete(key)) {
      if (edit) forgetEdit(actionEditsDir, edit.sessionId);
      try { notifyAll({ type: 'actions_changed' }); } catch { /* during startup */ }
    }
  }
  for (const edit of loadPersistedEdits(actionEditsDir)) {
    actionEdits.set(editKey(edit.actionName, edit.sessionId), edit);
  }

  // An action's history changed. The acting client invalidates its own cache, but improver
  // events land while nobody is acting, so the History card needs to be told.
  function notifyRevised(action: string): void {
    try { notifyAll({ type: 'action_revised', action }); } catch { /* during startup */ }
  }

  // ── Runtime denial tracking ───────────────────────────────────────────
  // Records every tool call that action sessions had blocked by allowlist-miss.
  // The PWA surfaces these as one-click "Add to allowlist" suggestions so the
  // user can see what the action tried that they overlooked.
  function suggestRule(toolName: string, toolInput: unknown): ActionDenial['suggested'] {
    if (toolName === 'Bash') {
      const cmd = (toolInput as { command?: string })?.command ?? '';
      // A shell redirection is gated as a Write, so no bash rule alone can unblock a
      // command that writes to an ungranted path. Suggest the path grant its target
      // needs — the leading command is usually already covered by the action's groups.
      const target = resolvableWriteTargets(cmd)[0];
      if (target) {
        const dir = target.replace(/\/[^/]*$/, '') || '/';
        return { kind: 'path', value: `Write:^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` };
      }
      // Anchor on the first whitespace-delimited token (the binary). Narrow enough
      // to avoid blanket Bash grants while obvious enough to one-click approve.
      const head = cmd.split(/\s+/)[0] ?? '';
      const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { kind: 'bash', value: escaped ? `^${escaped} ` : '^' };
    }
    if (toolName.startsWith('mcp__')) {
      return { kind: 'mcp', value: `^${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` };
    }
    // Try a path rule for file-touching tools — confines the grant to the actual
    // directory the action touched.
    const PATH_FIELDS: Record<string, string[]> = {
      Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'],
      MultiEdit: ['file_path'], NotebookEdit: ['notebook_path', 'file_path'],
      Glob: ['path'], Grep: ['path'],
    };
    const fields = PATH_FIELDS[toolName];
    if (fields) {
      const input = toolInput as Record<string, unknown> | null;
      for (const f of fields) {
        const v = input && typeof input === 'object' ? input[f] : undefined;
        if (typeof v === 'string' && v.length > 0) {
          const dir = v.replace(/\/[^/]*$/, '') || '/';
          const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return { kind: 'path', value: `${toolName}:^${escaped}/` };
        }
      }
    }
    return { kind: 'tool', value: toolName };
  }

  // Score the rejected draft and open the redraft replacing it. Feedback arriving
  // before any proposal was posted isn't a rejection — the same drafting round just
  // got a new brief, so leave its run open.
  function redraft(edit: ActionEdit, hadProposal: boolean): void {
    if (!hadProposal) return;
    const { sessionId } = edit;
    actionRunLedger.closeExternal(sessionId, 'submitted');
    actionRunLedger.verdictExternal(sessionId, 'revised');
    actionRunLedger.openExternal({ action: ledgerActionFor(edit), round: 'redraft', sessionId });
  }

  // A discarded draft is a rejection. The ledger already counts it; this keeps the text that
  // was declined and the reason, which is what tells the improver a taken suggestion from a
  // sent-back one. Must run before the caller clears edit.proposal.
  function noteRejected(edit: ActionEdit, feedback: string, author: ActionAuthor = 'user'): void {
    if (!edit.proposal || !edit.actionName) return;
    actionRevisionsStore.record({
      action: edit.actionName,
      kind: 'rejected',
      author,
      body: edit.proposal.skillMdAfter,
      rationale: edit.proposal.summary,
      feedback,
      sessionId: edit.sessionId,
    });
  }

  const recordActionDenial: ActionsRoutesHandlers['recordActionDenial'] = ({ actionName, sessionId, toolName, toolInput }) => {
    const suggested = suggestRule(toolName, toolInput);
    const denial = denialsStore.record({
      actionName, sessionId, toolName, toolInput, suggested,
      runId: actionRunLedger.noteDenial(sessionId),
    });
    console.log(`[deny] ${actionName} ${toolName} → suggest ${suggested.kind}:${suggested.value} (count ${denial.count})`);
    try { notifyAll({ type: 'actions_changed' }); } catch { /* during startup */ }
  };

  // An improver cycle that found nothing worth changing. Recorded rather than dropped: it's
  // what advances the review clock, and a quiet cycle is a result the user should be able
  // to see. No proposal means no review card, so the edit is cleared outright.
  function acceptNoChange(key: string, edit: ActionEdit, summary: string): void {
    if (!edit.actionName) {
      console.warn('[work] action-proposal: noChange with no action name — dropping');
      return;
    }
    actionRevisionsStore.record({
      action: edit.actionName,
      kind: 'reviewed',
      author: edit.author ?? 'improver',
      rationale: summary,
      sessionId: edit.sessionId,
    });
    actionRunLedger.closeExternal(edit.sessionId, 'submitted');
    actionRunLedger.verdictExternal(edit.sessionId, 'accepted');
    clearEdit(key);
    notifyRevised(edit.actionName);
    console.log(`[work] ${ledgerActionFor(edit)} reviewed ${edit.actionName}: no change proposed`);
  }

  const onActionProposalHandler: ActionsRoutesHandlers['onActionProposalHandler'] = async (body) => {
    const payload = parseJsonObject(body) as Parameters<typeof intakeProposal>[0] | null;
    if (!payload) throw new Error('invalid json body');
    if (!payload.sessionId) {
      console.warn('[hook] /work/action-proposal: missing sessionId');
      return;
    }
    const located = findEditBySession(payload.sessionId);
    if (!located) {
      console.warn(`[hook] /work/action-proposal: no edit-session for ${payload.sessionId.slice(0,8)}`);
      return;
    }
    let { key, edit } = located;
    // For "new action" flows the skill picks the name with this proposal —
    // promote the edit's key from `new:<sessionId>` → `a:<name>`.
    if (!edit.actionName && payload.actionName) {
      actionEdits.delete(key);
      edit = { ...edit, actionName: payload.actionName };
      key = editKey(payload.actionName, edit.sessionId);
    }
    let skillMdBefore = '';
    if (edit.actionName) {
      // Best-effort: the "before" text is only for the review diff, so a not-yet-valid
      // name (skill still settling on one) just yields no before-text.
      try { skillMdBefore = readSkillMd(actionDirFor(outpostActionsDir, edit.actionName).dir); }
      catch { /* invalid/unsettled name */ }
    }

    const intake = intakeProposal(payload, { skillMdBefore, now: Date.now() });
    if (intake.kind === 'invalid') {
      console.warn(`[hook] /work/action-proposal: ${intake.reason}`);
      return;
    }
    if (intake.kind === 'no-change') {
      acceptNoChange(key, edit, intake.summary);
      return;
    }

    edit.status = 'review';
    edit.proposal = intake.proposal;
    setEdit(key, edit);
    // Recorded even though nothing has been applied yet: a proposal the user then rejects is
    // exactly the signal the improver needs about its own suggestions. Skipped while the
    // new-action flow is still unnamed — there's no action to file it under.
    if (edit.actionName) {
      actionRevisionsStore.record({
        action: edit.actionName,
        kind: 'proposed',
        author: edit.author ?? 'user',
        body: intake.proposal.skillMdAfter,
        rationale: intake.proposal.summary,
        allowlistAdds: intake.proposal.allowlistAdds,
        sessionId: edit.sessionId,
      });
      notifyRevised(edit.actionName);
    }
    console.log(`[work] action-proposal posted for ${edit.actionName ?? '<new>'} (${intake.proposal.skillMdAfter.length}b skill_md, ${intake.proposal.allowlistAdds.length} rules)`);
  };

  // ── routes ─────────────────────────────────────────────────────────────
  server.route('GET', '/api/actions', async (_req, res) => {
    const actions = listOutpostActions();
    const catalog = actionRegistry.listActions().map((a) => ({
      name: a.name,
      description: a.frontmatter.description,
      kind: a.frontmatter.outpost.kind,
      category: a.frontmatter.outpost.category,
      runner: a.frontmatter.outpost.runner,
      permissions: a.frontmatter.outpost.permissions ?? [],
      side_effects: a.frontmatter.outpost.side_effects,
      human_gate: a.frontmatter.outpost.human_gate ?? false,
      timeout_sec: a.frontmatter.outpost.timeout_sec ?? null,
      input_schema: a.inputSchema,
      output_schema: a.outputSchema,
      allowlist: a.allowlist,
    }));
    const skills = listExternalSkills();
    const edits = Array.from(actionEdits.values()).map((e) => ({
      actionName: e.actionName,
      sessionId: e.sessionId,
      status: e.status,
      startedAt: e.startedAt,
      proposal: e.proposal,
    }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ actions, catalog, skills, edits, denials: denialsStore.all() }));
  });

  function handleScorecard(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0]!;
    const m = path.match(/^\/api\/actions\/([^/]+)\/scorecard$/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    const url = new URL(req.url ?? '', 'http://internal');
    const windowMs = parseWindowMs(url.searchParams.get('window') ?? DEFAULT_SCORECARD_WINDOW);
    const now = Date.now();
    const scorecard = buildScorecard(
      name,
      actionRunsStore.listByAction(name),
      denialsStore.list(name),
      { now, ...(windowMs !== undefined ? { windowMs } : {}) },
    );
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ scorecard }));
  }

  // An action with no recorded runs answers 200 with a zeroed card, not 404 — a
  // freshly-created action should render "no runs yet", not an error.
  server.route('GET', '/api/actions/:name/scorecard', handleScorecard);

  // Dismiss a single denial entry (after the user adds the rule, or just ignores it).
  server.route('DELETE', '/api/actions/:name/denials/:denialId', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/actions\/([^/]+)\/denials\/([^/?]+)/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    const denialId = decodeURIComponent(m[2]!);
    if (denialsStore.dismiss(name, denialId)) {
      try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
    }
    res.statusCode = 204;
    res.end();
  });

  // Clear all denials for an action at once.
  server.route('DELETE', '/api/actions/:name/denials', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/actions\/([^/]+)\/denials(?:\?|$)/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    if (denialsStore.clear(name)) {
      try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
    }
    res.statusCode = 204;
    res.end();
  });

  server.route('POST', '/api/actions/new', async (req, res) => {
    mkdirSync(outpostActionsDir, { recursive: true });
    const payload = await readJsonBody<{ feedback?: string; name?: string; category?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    // Optional user-supplied name. We don't validate strictly here — the action-builder
    // skill is the source of truth for naming and will normalize. We just forward it as a hint.
    const rawName = (payload?.name ?? '').trim();
    const proposedName = /^[a-z0-9][a-z0-9-]{0,63}$/i.test(rawName) ? rawName.toLowerCase() : '';
    // Optional category override. Reject an out-of-set value up front (the skill would
    // otherwise have to reconcile a hint it can't legally honor).
    const rawCategory = (payload?.category ?? '').trim().toLowerCase();
    if (rawCategory && !ACTION_CATEGORIES.includes(rawCategory as never)) {
      res.statusCode = 400; res.end(`category must be one of ${ACTION_CATEGORIES.join('|')}`); return;
    }
    const proposedCategory = rawCategory || undefined;
    const sessionId = randomUUID();
    const envelope = {
      kind: 'action-edit',
      mode: 'new' as const,
      actionName: null,
      // Hints to the action-builder skill. The skill SHOULD honor them unless the name
      // is invalid (it then picks a corrected name and explains the override).
      proposedName: proposedName || undefined,
      proposedCategory,
      actionsDir: outpostActionsDir,
      userFeedback: feedback,
      proposalRoute: '/work/action-proposal',
    };
    const envelopePath = writeActionEnvelope(sessionId, envelope);
    manager.spawnDetached(sessionId, outpostActionsDir, actionEditEnv(sessionId, envelopePath, null), 'default');
    manager.tagKind(sessionId, 'action-edit');
    engine.bindAction(sessionId, 'meta.build-action');
    actionRunLedger.openExternal({ action: 'meta.build-action', round: 'draft', sessionId });
    engine.stampActionSession(sessionId, 'meta.build-action', proposedName ? `New action: ${proposedName}` : 'New action');
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: '/meta.build-action' } });
    const edit: ActionEdit = {
      // Pre-populate actionName so the pending-new card shows the user's chosen
      // name immediately instead of "(naming…)". The skill can still override if it
      // chooses a different one in its proposal.
      actionName: proposedName || null,
      sessionId,
      status: 'editing',
      startedAt: Date.now(),
      feedback,
    };
    setEdit(editKey(edit.actionName, sessionId), edit);
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId, actionName: proposedName || null }));
  });

  server.route('POST', '/api/actions/:name/edit', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!name) { res.statusCode = 400; res.end('missing name'); return; }
    let dir: string;
    try { ({ dir } = actionDirFor(outpostActionsDir, name)); }
    catch (e) { res.statusCode = 400; res.end(`invalid action name: ${(e as Error).message}`); return; }
    try { if (!lstatSync(dir).isDirectory()) throw new Error('not a dir'); }
    catch { res.statusCode = 404; res.end('no such action'); return; }
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    const key = editKey(name, '');

    // If an edit is already running for this action, treat this as proposal-feedback —
    // forward the message to the same session, clear any prior proposal, and reuse it.
    const existing = actionEdits.get(key);
    if (existing) {
      const hadProposal = !!existing.proposal;
      noteRejected(existing, feedback);
      existing.feedback = feedback;
      existing.status = 'editing';
      existing.proposal = undefined;
      setEdit(key, existing);
      redraft(existing, hadProposal);
      const followup = feedback
        ? `Replacement feedback from the user:\n\n${feedback}\n\nRe-read $OUTPOST_ENVELOPE (skill_md_before may be stale if you already applied a draft) and post a new proposal.`
        : 'Replan with no new feedback — refresh the proposal.';
      manager.sendOrResume(existing.sessionId, dir, { type: 'user', message: { role: 'user', content: followup } }, actionEditEnv(existing.sessionId, join(RUNTIME_DIR, 'action-edits', existing.sessionId, 'envelope.json'), name));
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessionId: existing.sessionId, reused: true }));
      return;
    }

    const sessionId = randomUUID();
    const skillMdBefore = readSkillMd(dir);
    const envelope = {
      kind: 'action-edit',
      mode: 'edit' as const,
      actionName: name,
      actionDir: dir,
      skillMdBefore,
      currentAllowlist: actionsStore.get(name).allowlist,
      userFeedback: feedback,
      proposalRoute: '/work/action-proposal',
    };
    const envelopePath = writeActionEnvelope(sessionId, envelope);
    manager.spawnDetached(sessionId, dir, actionEditEnv(sessionId, envelopePath, name), 'default');
    manager.tagKind(sessionId, 'action-edit');
    engine.bindAction(sessionId, 'meta.build-action');
    actionRunLedger.openExternal({ action: 'meta.build-action', round: 'draft', sessionId });
    engine.stampActionSession(sessionId, 'meta.build-action', `Edit action: ${name}`);
    manager.send(sessionId, { type: 'user', message: { role: 'user', content: '/meta.build-action' } });
    setEdit(key, {
      actionName: name,
      sessionId,
      status: 'editing',
      startedAt: Date.now(),
      feedback,
    });
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId }));
  });

  // Approve the pending proposal: write SKILL.md, add allowlist rules, close session.
  // Keyed by sessionId so the "new action" flow (no name at first) works the same.
  server.route('POST', '/api/action-edits/:sessionId/approve', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!sessionId) { res.statusCode = 400; res.end('missing sessionId'); return; }
    const located = findEditBySession(sessionId);
    if (!located || !located.edit.proposal) { res.statusCode = 404; res.end('no pending proposal'); return; }
    const { key, edit } = located;
    const proposal = edit.proposal;
    const name = edit.actionName;
    if (!proposal) { res.statusCode = 404; res.end('no pending proposal'); return; }
    if (!name) { res.statusCode = 400; res.end('proposal has no action name'); return; }
    let dir: string;
    try { ({ dir } = actionDirFor(outpostActionsDir, name)); }
    catch (e) { res.statusCode = 400; res.end(`invalid action name: ${(e as Error).message}`); return; }
    const payload = await readJsonBody<{ actor?: string }>(req);
    // Provenance, not authentication — the PWA server is already trusted on the tailnet.
    // The edit itself knows who authored it (the improver's is registered as such at spawn),
    // so `actor` is only a manual override for callers that have no edit row to speak for them.
    const author: ActionAuthor = edit.author ?? (payload?.actor === 'improver' ? 'improver' : 'user');
    try {
      // Rules land before the write so the revision can record exactly which ones were new:
      // addRule answers false for a duplicate, and only genuinely-new rules are safe for a
      // later revert to remove.
      const allowlistAdds: ActionProposal['allowlistAdds'] = [];
      for (const rule of proposal.allowlistAdds ?? []) {
        try { if (actionsStore.addRule(name, rule.kind, rule.value)) allowlistAdds.push(rule); }
        catch (e) { console.warn(`[action-edit] skipping invalid rule ${rule.kind}=${rule.value}: ${(e as Error).message}`); }
      }
      actionRevisionsStore.applyWrite({
        action: name,
        dir,
        body: proposal.skillMdAfter,
        author,
        allowlistAdds,
        rationale: proposal.summary,
        sessionId: edit.sessionId,
      });
      // The proposal only carries SKILL.md, but the registry requires input/output
      // schemas to load an action. Seed permissive defaults for a brand-new action;
      // never clobber an existing action's schemas on edit.
      const defaultSchema = JSON.stringify({ type: 'object' }, null, 2) + '\n';
      for (const f of ['input.schema.json', 'output.schema.json']) {
        const p = join(dir, f);
        if (!existsSync(p)) writeFileSync(p, defaultSchema);
      }
    } catch (e) {
      res.statusCode = 500; res.end(`apply failed: ${(e as Error).message}`); return;
    }
    edit.status = 'applying';
    setEdit(key, edit);
    notifyRevised(name);
    actionRunLedger.closeExternal(edit.sessionId, 'submitted');
    actionRunLedger.verdictExternal(edit.sessionId, 'accepted');
    void manager.close(edit.sessionId).catch(() => { /* tolerate */ });
    // Re-symlink into ~/.claude/skills, then reload the registry so the new action
    // reaches the catalog in the same actions_changed broadcast clearEdit fires —
    // otherwise the detail pane, still selected on this name, renders "Skill not found".
    try { ensureActionsInstalled(bundledRepoDir(SRC_DIR), RUNTIME_DIR); } catch { /* tolerate */ }
    try { actionRegistry.load(); } catch (e) { console.warn(`[action-edit] registry reload failed: ${(e as Error).message}`); }
    clearEdit(key);
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, actionName: name }));
  });

  // User submits new feedback on the active edit (with or without a posted proposal):
  // clear any proposal, send the feedback to the same session so it drafts again.
  server.route('POST', '/api/action-edits/:sessionId/proposal-feedback', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!sessionId) { res.statusCode = 400; res.end('missing sessionId'); return; }
    const located = findEditBySession(sessionId);
    if (!located) { res.statusCode = 404; res.end('no active edit'); return; }
    const { key, edit } = located;
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    if (!feedback) { res.statusCode = 400; res.end('feedback required'); return; }
    const hadProposal = !!edit.proposal;
    noteRejected(edit, feedback);
    edit.feedback = feedback;
    edit.status = 'editing';
    edit.proposal = undefined;
    setEdit(key, edit);
    redraft(edit, hadProposal);
    const cwd = edit.actionName ? join(outpostActionsDir, edit.actionName) : outpostActionsDir;
    const followup = `Replacement feedback from the user:\n\n${feedback}\n\nDraft a new proposal that addresses this, then POST it again.`;
    manager.sendOrResume(
      edit.sessionId, cwd,
      { type: 'user', message: { role: 'user', content: followup } },
      actionEditEnv(edit.sessionId, join(RUNTIME_DIR, 'action-edits', edit.sessionId, 'envelope.json'), edit.actionName),
    );
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  // Cancel: kill the session, drop the pending proposal.
  server.route('POST', '/api/action-edits/:sessionId/cancel', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!sessionId) { res.statusCode = 400; res.end('missing sessionId'); return; }
    const located = findEditBySession(sessionId);
    if (located) {
      noteRejected(located.edit, '');
      void manager.close(located.edit.sessionId).catch(() => { /* tolerate */ });
      actionRunLedger.closeExternal(located.edit.sessionId, 'abandoned');
      clearEdit(located.key);
    }
    res.statusCode = 204; res.end();
  });

  server.route('POST', '/api/skills/new', async (req, res) => {
    const skillsDir = join(homedir(), '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    const sections: string[] = [];
    if (feedback) sections.push(`User intent for this new skill:\n${feedback}`);
    sections.push('/skill-creator');
    const id = spawnEditSession('skill-edit', skillsDir, sections.join('\n\n'));
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId: id }));
  });

  server.route('POST', '/api/skills/:name/edit', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    if (!name) { res.statusCode = 400; res.end('missing name'); return; }
    const skillDir = join(homedir(), '.claude', 'skills', name);
    let real: string;
    try { real = realpathSync(skillDir); }
    catch { res.statusCode = 404; res.end('no such skill'); return; }
    if (real.startsWith(outpostActionsDir)) {
      res.statusCode = 400; res.end('use /api/actions/:name/edit for actions'); return;
    }
    if (real.includes('/.claude/plugins/cache/')) {
      res.statusCode = 400; res.end('plugin-cache skills are read-only'); return;
    }
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const feedback = (payload?.feedback ?? '').trim();
    const sections: string[] = [`You are editing the existing skill "${name}" in cwd.`];
    if (feedback) sections.push(`User feedback for this revision:\n${feedback}`);
    sections.push('/skill-creator');
    const id = spawnEditSession('skill-edit', real, sections.join('\n\n'));
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId: id }));
  });

  server.route('DELETE', '/api/actions/:name', async (req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('?')[0]!.split('/').pop()!);
    // includes('/')/'..' rejected up front as defense-in-depth; actionDirFor re-validates.
    if (!name || name.includes('/') || name.includes('..')) {
      res.statusCode = 400; res.end('invalid name'); return;
    }
    let dir: string;
    try { ({ dir } = actionDirFor(outpostActionsDir, name)); }
    catch (e) { res.statusCode = 400; res.end(`invalid action name: ${(e as Error).message}`); return; }
    const link = join(homedir(), '.claude', 'skills', name);
    actionRevisionsStore.noteDeleted(name, dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tolerate */ }
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) unlinkSync(link);
    } catch { /* tolerate missing */ }
    actionsStore.deleteAction(name);
    // Reload the registry + broadcast so the removed action leaves the catalog.
    try { actionRegistry.load(); } catch (e) { console.warn(`[action-delete] registry reload failed: ${(e as Error).message}`); }
    try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  function dropEditForSession(sessionId: string): void {
    const located = findEditBySession(sessionId);
    if (!located) return;
    const { keep, outcome } = onSessionGone(located.edit);
    actionRunLedger.closeExternal(sessionId, outcome);
    // A posted proposal outlives its session — see onSessionGone. Approve tolerates a dead
    // session and proposal-feedback resumes one, so the card stays reviewable.
    if (keep) return;
    noteRejected(located.edit, '', 'system');
    clearEdit(located.key);
  }

  const beginImproverEdit: ActionsRoutesHandlers['beginImproverEdit'] = ({ sessionId, actionName }) => {
    // Keyed `a:<name>` like a user edit, which is what stops the improver and the user from
    // both holding an edit on one action — and what the selector reads to skip it.
    setEdit(editKey(actionName, sessionId), {
      actionName,
      sessionId,
      status: 'editing',
      startedAt: Date.now(),
      feedback: '',
      authorAction: 'meta.improve-actions',
      author: 'improver',
    });
    actionRunLedger.openExternal({ action: 'meta.improve-actions', round: 'review', sessionId });
  };

  const listPendingEdits: ActionsRoutesHandlers['listPendingEdits'] = () =>
    Array.from(actionEdits.values()).map((e) => ({ actionName: e.actionName, authorAction: e.authorAction }));

  return {
    recordActionDenial, onActionProposalHandler, dropEditForSession,
    beginImproverEdit, listPendingEdits,
  };
}
