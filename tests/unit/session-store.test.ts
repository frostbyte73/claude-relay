import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/session/session-store.js';

describe('SessionStore', () => {
  let rootDir: string;
  let projectDir: string;

  beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'sstest-root-'));
    projectDir = join(rootDir, '-test-project');
    mkdirSync(projectDir);
    const tmp = tmpdir();
    // Both sessions live in the same project (same cwd) — they're "sibling sessions",
    // not "different projects." Keeping cwd identical here is intentional.
    writeFileSync(
      join(projectDir, 'sess-aaaaaaaa.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'Investigating INC-540' }) + '\n' +
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'what is up with INC-540' } }) + '\n',
    );
    writeFileSync(
      join(projectDir, 'sess-bbbbbbbb.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'hello' } }) + '\n',
    );
  });

  it('lists sessions with id + mtime', () => {
    const store = new SessionStore({ root: rootDir });
    const projects = store.listProjects();
    const sessions = projects[0]!.sessions;
    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-aaaaaaaa', 'sess-bbbbbbbb']);
  });

  it('reads the title from summary records when present', () => {
    const store = new SessionStore({ root: rootDir });
    const sessions = store.listProjects()[0]!.sessions;
    const a = sessions.find((s) => s.id === 'sess-aaaaaaaa')!;
    expect(a.title).toBe('Investigating INC-540');
  });

  it('falls back to first-user-message preview when no summary record exists', () => {
    const store = new SessionStore({ root: rootDir });
    const sessions = store.listProjects()[0]!.sessions;
    const b = sessions.find((s) => s.id === 'sess-bbbbbbbb')!;
    // Titles get cleaned: first-letter capitalization is applied.
    expect(b.title).toContain('Hello');
  });

  it('strips filler prefixes and surfaces slash-command args as the title', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-titles-root-'));
    const proj = join(root, '-test-titles');
    mkdirSync(proj);
    const tmp = tmpdir();
    // Filler-prefix case: "can you look into …" should drop the prefix and capitalize.
    writeFileSync(
      join(proj, 'sess-filler.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'can you look into the cluster outage in frankfurt' } }) + '\n',
    );
    // Slash-command case: /goal's <command-args> payload IS the user's intent, even
    // though the surrounding envelope looks like a system injection.
    writeFileSync(
      join(proj, 'sess-cmd.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: '<command-name>/goal</command-name><command-args>ship gamekit by tomorrow morning</command-args>' } }) + '\n',
    );
    const sessions = new SessionStore({ root }).listProjects()[0]!.sessions;
    const filler = sessions.find((s) => s.id === 'sess-filler')!;
    const cmd = sessions.find((s) => s.id === 'sess-cmd')!;
    // "can you look into" → stripped, then "the cluster outage…" capitalized.
    expect(filler.title.startsWith('The cluster outage')).toBe(true);
    // /goal args appear as the title source, after first-letter capitalization.
    expect(cmd.title).toBe('Ship gamekit by tomorrow morning');
  });

  it('stamps action sessions from the session-meta sidecar (title + class override the transcript)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-action-root-'));
    const proj = join(root, '-test-action');
    const metaDir = mkdtempSync(join(tmpdir(), 'sstest-action-meta-'));
    mkdirSync(proj);
    const tmp = tmpdir();
    // Orchestrator sessions kick off with a bare `/meta.orchestrate <uuid>` turn, so the
    // transcript-derived title would be the raw UUID. The sidecar must win.
    writeFileSync(
      join(proj, 'sess-orch.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: '<command-name>/meta.orchestrate</command-name><command-args>3a630f00-01f6-4e18</command-args>' } }) + '\n',
    );
    // A plain interactive session with no sidecar stays sessionClass-less.
    writeFileSync(
      join(proj, 'sess-plain.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'poke around the repo' } }) + '\n',
    );
    const store = new SessionStore({ root, sessionMetaDir: metaDir });
    store.writeActionMeta('sess-orch', { action: 'meta.orchestrate', title: 'Ship the login flow' });

    const sessions = store.listProjects()[0]!.sessions;
    const orch = sessions.find((s) => s.id === 'sess-orch')!;
    expect(orch.title).toBe('Ship the login flow');
    expect(orch.sessionClass).toBe('action');
    expect(orch.actionLabel).toBe('meta.orchestrate');

    const plain = sessions.find((s) => s.id === 'sess-plain')!;
    expect(plain.sessionClass).toBeUndefined();
    expect(plain.title).toContain('Poke around');
  });

  it('carries structured Task* tool_use fields and surfaces their tool_result', () => {
    // The PWA's todos panel is rebuilt from the disk transcript on reload, so session-store
    // has to preserve enough of each Task* tool call to do that: name, input, tool_use_id,
    // and the matching tool_result text (which carries the server-assigned task id). Other
    // tools' results stay dropped — they'd bloat the transcript for no UI benefit.
    const root = mkdtempSync(join(tmpdir(), 'sstest-task-root-'));
    const proj = join(root, '-test-task');
    mkdirSync(proj);
    const tmp = tmpdir();
    writeFileSync(
      join(proj, 'sess-task.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_01',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_create', name: 'TaskCreate', input: { subject: 'Ship feature' } },
            { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { path: '/x' } },
          ],
        },
      }) + '\n' +
      JSON.stringify({
        type: 'user',
        cwd: tmp,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_create', content: 'Task #1 created successfully: Ship feature' },
            { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file contents we do not want in the transcript' },
          ],
        },
      }) + '\n',
    );
    const msgs = new SessionStore({ root }).readMessages('sess-task');
    const create = msgs.find((m) => m.toolName === 'TaskCreate');
    expect(create?.toolUseId).toBe('toolu_create');
    expect((create?.toolInput as { subject: string }).subject).toBe('Ship feature');
    const result = msgs.find((m) => m.role === 'tool_result');
    expect(result?.toolUseId).toBe('toolu_create');
    expect(result?.text).toContain('Task #1 created');
    // Read's tool_result must NOT leak through — that's the existing behavior we're preserving.
    expect(msgs.some((m) => m.role === 'tool_result' && m.toolUseId === 'toolu_read')).toBe(false);
  });

  it('stamps msgId on assistant + tool_use entries so the PWA can dedupe WS replays', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-msgid-root-'));
    const proj = join(root, '-test-msgid');
    mkdirSync(proj);
    const tmp = tmpdir();
    writeFileSync(
      join(proj, 'sess-cccccccc.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'hi' } }) + '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_01abc',
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking now' },
            { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { path: '/tmp/x' } },
          ],
        },
      }) + '\n',
    );
    const store = new SessionStore({ root });
    const msgs = store.readMessages('sess-cccccccc');
    const assistantText = msgs.find((m) => m.role === 'assistant');
    const toolUse = msgs.find((m) => m.role === 'tool_use');
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(assistantText?.msgId).toBe('msg_01abc');
    expect(toolUse?.msgId).toBe('msg_01abc');
    expect(userMsg?.msgId).toBeUndefined();
  });

  it('extracts cwd from the first jsonl line in a project dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-cwd-root-'));
    const proj = join(root, '-test-cwd');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-aa.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/alice/project', message: { content: 'hi' } }) + '\n',
    );
    const store = new SessionStore({ root });
    expect(store.readCwdFromProject(proj)).toBe('/Users/alice/project');
  });

  it('returns null when no jsonl in the project dir has a cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-no-cwd-root-'));
    const proj = join(root, '-test-no-cwd');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-aa.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'no cwd here' } }) + '\n',
    );
    expect(new SessionStore({ root }).readCwdFromProject(proj)).toBeNull();
  });

  it('walks to the next jsonl when the most-recent has no cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-cwd-fallback-root-'));
    const proj = join(root, '-test-cwd-fallback');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-old.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/alice/projectA', message: { content: 'hi' } }) + '\n',
    );
    const newerPath = join(proj, 'sess-new.jsonl');
    writeFileSync(newerPath, JSON.stringify({ type: 'summary', summary: 'no cwd here' }) + '\n');
    const future = new Date(Date.now() + 2000);
    utimesSync(newerPath, future, future);
    expect(new SessionStore({ root }).readCwdFromProject(proj)).toBe('/Users/alice/projectA');
  });

  it('lists projects under a root, each with cwd + sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-root-'));
    const projA = join(root, '-Users-alice-projectA');
    const projB = join(root, '-Users-alice-projectB');
    mkdirSync(projA);
    mkdirSync(projB);
    const cwdA = mkdtempSync(join(tmpdir(), 'cwd-a-'));
    const cwdB = mkdtempSync(join(tmpdir(), 'cwd-b-'));
    writeFileSync(
      join(projA, 'sess-a1.jsonl'),
      JSON.stringify({ type: 'user', cwd: cwdA, message: { content: 'a1' } }) + '\n',
    );
    writeFileSync(
      join(projB, 'sess-b1.jsonl'),
      JSON.stringify({ type: 'user', cwd: cwdB, message: { content: 'b1' } }) + '\n',
    );
    const projects = new SessionStore({ root }).listProjects();
    expect(projects.length).toBe(2);
    expect(projects.map((p) => p.projectDir).sort()).toEqual([projA, projB].sort());
    const a = projects.find((p) => p.projectDir === projA)!;
    expect(a.sessions.map((s) => s.id)).toEqual(['sess-a1']);
    expect(a.cwd).toBe(cwdA);
  });

  it('hides projects whose cwd no longer exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-orphan-'));
    const proj = join(root, '-tmp-deleted-path');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 'sess-o.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/this/path/does/not/exist', message: { content: 'x' } }) + '\n',
    );
    expect(new SessionStore({ root }).listProjects()).toEqual([]);
  });

  it('sorts projects by max session mtime descending', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-sort-'));
    const projOld = join(root, '-Users-alice-old');
    const projNew = join(root, '-Users-alice-new');
    mkdirSync(projOld);
    mkdirSync(projNew);
    const cwdOld = mkdtempSync(join(tmpdir(), 'cwd-old-'));
    const cwdNew = mkdtempSync(join(tmpdir(), 'cwd-new-'));
    writeFileSync(
      join(projOld, 'sess-old.jsonl'),
      JSON.stringify({ type: 'user', cwd: cwdOld, message: { content: 'old' } }) + '\n',
    );
    writeFileSync(
      join(projNew, 'sess-new.jsonl'),
      JSON.stringify({ type: 'user', cwd: cwdNew, message: { content: 'new' } }) + '\n',
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(join(projNew, 'sess-new.jsonl'), future, future);
    const projects = new SessionStore({ root }).listProjects();
    expect(projects[0]!.projectDir).toBe(projNew);
    expect(projects[1]!.projectDir).toBe(projOld);
  });

  it('findSession locates a session across project dirs and returns its cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-find-'));
    const projA = join(root, '-Users-alice-projectA');
    mkdirSync(projA);
    const tmp = tmpdir();
    writeFileSync(
      join(projA, 'sess-target.jsonl'),
      JSON.stringify({ type: 'user', cwd: tmp, message: { content: 'hi' } }) + '\n',
    );
    const found = new SessionStore({ root }).findSession('sess-target');
    expect(found?.cwd).toBe(tmp);
    expect(found?.projectDir).toBe(projA);
  });

  it('findSession returns null for an unknown id', () => {
    const root = mkdtempSync(join(tmpdir(), 'sstest-find-miss-'));
    mkdirSync(join(root, '-Users-alice-empty'));
    expect(new SessionStore({ root }).findSession('nope')).toBeNull();
  });
});

describe('SessionStore — registry merge + isGitRepo', () => {
  function makeRoot(): { root: string; registryPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'ss-merge-root-'));
    const registryPath = join(root, 'projects.json');
    return { root, registryPath };
  }
  function makeCwd(parent: string, name: string): string {
    const cwd = join(parent, name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  it('registry-only project appears with source="registry" and empty sessions', async () => {
    const { ProjectRegistry } = await import('../../src/storage/project-registry.js');
    const { root, registryPath } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-cwd-'));
    const cwd = makeCwd(cwdHost, 'projectA');
    const registry = new ProjectRegistry(registryPath);
    registry.add(cwd);
    const store = new SessionStore({ root, registry });
    const match = store.listProjects().find((p) => p.cwd === cwd);
    expect(match).toBeDefined();
    expect(match!.source).toBe('registry');
    expect(match!.sessions).toEqual([]);
  });

  it('claude-only project appears with source="claude"', async () => {
    const { ProjectRegistry } = await import('../../src/storage/project-registry.js');
    const { root, registryPath } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-cwd-'));
    const cwd = makeCwd(cwdHost, 'projectB');
    const projectDir = join(root, cwd.replace(/\//g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'aaa.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n',
    );
    const registry = new ProjectRegistry(registryPath);
    const store = new SessionStore({ root, registry });
    const match = store.listProjects().find((p) => p.cwd === cwd);
    expect(match).toBeDefined();
    expect(match!.source).toBe('claude');
    expect(match!.sessions.length).toBe(1);
  });

  it('project in both registry AND claude-history is tagged source="both"', async () => {
    const { ProjectRegistry } = await import('../../src/storage/project-registry.js');
    const { root, registryPath } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-cwd-'));
    const cwd = makeCwd(cwdHost, 'projectC');
    const projectDir = join(root, cwd.replace(/\//g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'bbb.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n',
    );
    const registry = new ProjectRegistry(registryPath);
    registry.add(cwd);
    const store = new SessionStore({ root, registry });
    const match = store.listProjects().find((p) => p.cwd === cwd);
    expect(match).toBeDefined();
    expect(match!.source).toBe('both');
    expect(match!.sessions.length).toBe(1);
  });

  it('registry entry whose cwd does not exist on disk is filtered out', async () => {
    const { ProjectRegistry } = await import('../../src/storage/project-registry.js');
    const { root, registryPath } = makeRoot();
    const registry = new ProjectRegistry(registryPath);
    registry.add('/this/path/does/not/exist');
    const store = new SessionStore({ root, registry });
    expect(store.listProjects().find((p) => p.cwd === '/this/path/does/not/exist')).toBeUndefined();
  });

  it('isGitRepo=true when <cwd>/.git exists', async () => {
    const { ProjectRegistry } = await import('../../src/storage/project-registry.js');
    const { execFileSync } = await import('node:child_process');
    const { root, registryPath } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-cwd-'));
    const cwd = makeCwd(cwdHost, 'projectGit');
    execFileSync('git', ['init', '-q', cwd]);
    const registry = new ProjectRegistry(registryPath);
    registry.add(cwd);
    const store = new SessionStore({ root, registry });
    const match = store.listProjects().find((p) => p.cwd === cwd);
    expect(match!.isGitRepo).toBe(true);
  });

  it('isGitRepo=false when <cwd>/.git absent', async () => {
    const { ProjectRegistry } = await import('../../src/storage/project-registry.js');
    const { root, registryPath } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-cwd-'));
    const cwd = makeCwd(cwdHost, 'projectPlain');
    const registry = new ProjectRegistry(registryPath);
    registry.add(cwd);
    const store = new SessionStore({ root, registry });
    const match = store.listProjects().find((p) => p.cwd === cwd);
    expect(match!.isGitRepo).toBe(false);
  });

  it('store works without a registry (backward compat — registry option omitted)', () => {
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-cwd-'));
    const cwd = makeCwd(cwdHost, 'projectBackcompat');
    const projectDir = join(root, cwd.replace(/\//g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'ccc.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n',
    );
    const store = new SessionStore({ root });
    const match = store.listProjects().find((p) => p.cwd === cwd);
    expect(match!.source).toBe('claude');
    expect(typeof match!.isGitRepo).toBe('boolean');
  });
});

describe('SessionStore — worktree merge', () => {
  function makeRoot(): { root: string } {
    return { root: mkdtempSync(join(tmpdir(), 'ss-wt-root-')) };
  }
  function makeCwd(parent: string, name: string): string {
    const cwd = join(parent, name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  it('worktree-derived project-dir is folded into its parent (sessions annotated)', async () => {
    const { WorktreeManager } = await import('../../src/git/worktree-manager.js');
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-wt-cwd-'));
    const parentCwd = makeCwd(cwdHost, 'parent');
    const worktreePath = makeCwd(cwdHost, 'wt-abc');
    // Pre-seed: parent has 1 raw session.
    const parentDir = join(root, parentCwd.replace(/\//g, '-'));
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(
      join(parentDir, 'sess-parent.jsonl'),
      JSON.stringify({ type: 'user', cwd: parentCwd, message: { content: 'hi from parent' } }) + '\n',
    );
    // Worktree dir has 1 session (claude wrote it because we spawned at worktreePath).
    const wtDir = join(root, worktreePath.replace(/\//g, '-'));
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(
      join(wtDir, 'sessworktree.jsonl'),
      JSON.stringify({ type: 'user', cwd: worktreePath, message: { content: 'hi from worktree' } }) + '\n',
    );
    // WorktreeManager record ties the worktreePath back to the parent.
    const wtMgrRoot = mkdtempSync(join(tmpdir(), 'wt-mgr-'));
    const wtMgr = new WorktreeManager({ root: wtMgrRoot, projectsRoot: mkdtempSync(join(tmpdir(), 'wt-proj-')) });
    wtMgr._testSeedRecord({
      sessionId: 'sessworktree',
      projectCwd: parentCwd,
      worktreePath,
      branch: 'outpost/abc',
      baseBranch: 'main',
      createdAt: 100,
    });
    const store = new SessionStore({ root, worktreeManager: wtMgr });
    const projects = store.listProjects();
    // Only ONE row in the merged view (worktree got folded in).
    expect(projects.find((p) => p.cwd === parentCwd)).toBeDefined();
    expect(projects.find((p) => p.cwd === worktreePath)).toBeUndefined();
    const parent = projects.find((p) => p.cwd === parentCwd)!;
    // Both sessions visible on the parent row.
    expect(parent.sessions.map((s) => s.id).sort()).toEqual(['sess-parent', 'sessworktree']);
    // Worktree session is annotated.
    const wtSess = parent.sessions.find((s) => s.id === 'sessworktree')!;
    expect(wtSess.worktreePath).toBe(worktreePath);
    expect(wtSess.worktreeBranch).toBe('outpost/abc');
    // Parent session has no worktree annotation.
    const parSess = parent.sessions.find((s) => s.id === 'sess-parent')!;
    expect(parSess.worktreePath).toBeUndefined();
  });

  it('worktree-only project (no parent JSONL yet) synthesizes the parent row', async () => {
    const { WorktreeManager } = await import('../../src/git/worktree-manager.js');
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-wt-cwd-'));
    const parentCwd = makeCwd(cwdHost, 'newparent');
    const worktreePath = makeCwd(cwdHost, 'wt-new');
    // No raw scan hit for the parent — only the worktree dir has a session.
    const wtDir = join(root, worktreePath.replace(/\//g, '-'));
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(
      join(wtDir, 'sessnew.jsonl'),
      JSON.stringify({ type: 'user', cwd: worktreePath, message: { content: 'first session in this project' } }) + '\n',
    );
    const wtMgrRoot = mkdtempSync(join(tmpdir(), 'wt-mgr-'));
    const wtMgr = new WorktreeManager({ root: wtMgrRoot, projectsRoot: mkdtempSync(join(tmpdir(), 'wt-proj-')) });
    wtMgr._testSeedRecord({
      sessionId: 'sessnew',
      projectCwd: parentCwd,
      worktreePath,
      branch: 'outpost/new',
      baseBranch: 'main',
      createdAt: 100,
    });
    const store = new SessionStore({ root, worktreeManager: wtMgr });
    const projects = store.listProjects();
    const parent = projects.find((p) => p.cwd === parentCwd);
    expect(parent).toBeDefined();
    expect(parent!.sessions.map((s) => s.id)).toEqual(['sessnew']);
    expect(parent!.sessions[0]!.worktreeBranch).toBe('outpost/new');
  });

  it('archived worktree records: session row stamped archived:true', async () => {
    const { WorktreeManager } = await import('../../src/git/worktree-manager.js');
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-wt-cwd-'));
    const parentCwd = makeCwd(cwdHost, 'archpar');
    const parentDir = join(root, parentCwd.replace(/\//g, '-'));
    mkdirSync(parentDir, { recursive: true });
    // The archived session's JSONL is still on disk in the WORKTREE-derived dir
    // (the JSONL wasn't deleted on archive — only the worktree path was). For the
    // purposes of this test the dir doesn't need to exist on disk because the
    // tombstone has `worktreePath: ''` and we look up by sessionId not by dir.
    // Instead, we put the session JSONL in the parent's dir (simulating a "started
    // in shared mode" session that then got worktree-archived) — unrealistic but
    // exercises the archived-stamp logic.
    writeFileSync(
      join(parentDir, 'sessarc.jsonl'),
      JSON.stringify({ type: 'user', cwd: parentCwd, message: { content: 'archived session' } }) + '\n',
    );
    const wtMgrRoot = mkdtempSync(join(tmpdir(), 'wt-mgr-'));
    const wtMgr = new WorktreeManager({ root: wtMgrRoot, projectsRoot: mkdtempSync(join(tmpdir(), 'wt-proj-')) });
    wtMgr._testSeedRecord({
      sessionId: 'sessarc',
      projectCwd: parentCwd,
      worktreePath: '',  // tombstone
      branch: '',
      baseBranch: 'main',
      createdAt: 100,
      archivedAt: 200,
    });
    const store = new SessionStore({ root, worktreeManager: wtMgr });
    const parent = store.listProjects().find((p) => p.cwd === parentCwd)!;
    const sess = parent.sessions.find((s) => s.id === 'sessarc');
    expect(sess?.archived).toBe(true);
  });

  it('stamps archived:true on a session whose mtime is older than the 7d auto-archive window', async () => {
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-stale-cwd-'));
    const cwd = makeCwd(cwdHost, 'stale-project');
    const projDir = join(root, cwd.replace(/\//g, '-'));
    mkdirSync(projDir, { recursive: true });
    const stalePath = join(projDir, 'sessstale.jsonl');
    const freshPath = join(projDir, 'sessfresh.jsonl');
    writeFileSync(stalePath, JSON.stringify({ type: 'user', cwd, message: { content: 'old' } }) + '\n');
    writeFileSync(freshPath, JSON.stringify({ type: 'user', cwd, message: { content: 'new' } }) + '\n');
    // Backdate stale file to 8 days ago; leave fresh at "now".
    const eightDaysAgoSec = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stalePath, eightDaysAgoSec, eightDaysAgoSec);

    const store = new SessionStore({ root });
    const project = store.listProjects().find((p) => p.cwd === cwd)!;
    const stale = project.sessions.find((s) => s.id === 'sessstale')!;
    const fresh = project.sessions.find((s) => s.id === 'sessfresh')!;
    expect(stale.archived).toBe(true);
    expect(fresh.archived).toBeUndefined();
  });

  it('a project whose every session is auto-archived still appears in listProjects()', async () => {
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-all-stale-'));
    const cwd = makeCwd(cwdHost, 'all-stale-project');
    const projDir = join(root, cwd.replace(/\//g, '-'));
    mkdirSync(projDir, { recursive: true });
    // Two stale JSONLs, both backdated past 7d.
    const p1 = join(projDir, 'oldone.jsonl');
    const p2 = join(projDir, 'oldtwo.jsonl');
    writeFileSync(p1, JSON.stringify({ type: 'user', cwd, message: { content: 'a' } }) + '\n');
    writeFileSync(p2, JSON.stringify({ type: 'user', cwd, message: { content: 'b' } }) + '\n');
    const oldSec = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(p1, oldSec, oldSec);
    utimesSync(p2, oldSec, oldSec);

    const store = new SessionStore({ root });
    const project = store.listProjects().find((p) => p.cwd === cwd);
    expect(project).toBeDefined();
    expect(project!.sessions).toHaveLength(2);
    expect(project!.sessions.every((s) => s.archived === true)).toBe(true);
  });

  it('does NOT auto-archive a stale session whose worktree is still active', async () => {
    const { WorktreeManager } = await import('../../src/git/worktree-manager.js');
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-stale-wt-cwd-'));
    const parentCwd = makeCwd(cwdHost, 'parent');
    const worktreePath = makeCwd(cwdHost, 'wt-stale');
    const wtDir = join(root, worktreePath.replace(/\//g, '-'));
    mkdirSync(wtDir, { recursive: true });
    const stalePath = join(wtDir, 'sessstalewt.jsonl');
    writeFileSync(stalePath, JSON.stringify({ type: 'user', cwd: worktreePath, message: { content: 'long-running branch' } }) + '\n');
    // Backdate well past 7d.
    const oldSec = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stalePath, oldSec, oldSec);
    const wtMgrRoot = mkdtempSync(join(tmpdir(), 'wt-mgr-'));
    const wtMgr = new WorktreeManager({ root: wtMgrRoot, projectsRoot: mkdtempSync(join(tmpdir(), 'wt-proj-')) });
    wtMgr._testSeedRecord({
      sessionId: 'sessstalewt',
      projectCwd: parentCwd,
      worktreePath,
      branch: 'outpost/stalewt',
      baseBranch: 'main',
      createdAt: 100,
    });
    const store = new SessionStore({ root, worktreeManager: wtMgr });
    const parent = store.listProjects().find((p) => p.cwd === parentCwd)!;
    const sess = parent.sessions.find((s) => s.id === 'sessstalewt')!;
    expect(sess.worktreePath).toBe(worktreePath);
    expect(sess.archived).toBeUndefined();
  });

  it('two dirs resolving to one cwd merge sessions; a stale dir cannot clobber the real project', () => {
    // Regression: a Claude-native worktree dir (…/.claude/worktrees/<branch>) whose session
    // recorded the PARENT repo's cwd resolves — via readCwdFromProject's fallback — to that
    // parent cwd. The old byCwd map was last-writer-wins, so the 1-session worktree dir wiped
    // out the real project's dozens of sessions. They must union instead.
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-collide-cwd-'));
    const cwd = makeCwd(cwdHost, 'repo');
    const sanitized = cwd.replace(/\//g, '-');
    // Canonical dir: basename === sanitized(cwd), two sessions.
    const canonicalDir = join(root, sanitized);
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'sess-main1.jsonl'), JSON.stringify({ type: 'user', cwd, message: { content: 'main 1' } }) + '\n');
    writeFileSync(join(canonicalDir, 'sess-main2.jsonl'), JSON.stringify({ type: 'user', cwd, message: { content: 'main 2' } }) + '\n');
    // Stale worktree dir: basename ≠ sanitized(cwd), but its session recorded the parent cwd.
    const staleDir = join(root, `${sanitized}--claude-worktrees-fix`);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'sess-wt.jsonl'), JSON.stringify({ type: 'user', cwd, message: { content: 'worktree session' } }) + '\n');

    const store = new SessionStore({ root });
    const projects = store.listProjects();
    const project = projects.find((p) => p.cwd === cwd)!;
    expect(project).toBeDefined();
    // All three sessions survive the collapse.
    expect(project.sessions.map((s) => s.id).sort()).toEqual(['sess-main1', 'sess-main2', 'sess-wt']);
    // The basename-matching dir is the representative, not the stale worktree dir.
    expect(project.projectDir).toBe(canonicalDir);
    // Each session still resolves to the physical dir its JSONL lives in.
    expect(store.findSession('sess-main1')!.projectDir).toBe(canonicalDir);
    expect(store.findSession('sess-wt')!.projectDir).toBe(staleDir);
  });

  it('findSession returns the PHYSICAL projectDir (raw scan), not the merged-view parent', async () => {
    const { WorktreeManager } = await import('../../src/git/worktree-manager.js');
    const { root } = makeRoot();
    const cwdHost = mkdtempSync(join(tmpdir(), 'ss-wt-cwd-'));
    const parentCwd = makeCwd(cwdHost, 'physpar');
    const worktreePath = makeCwd(cwdHost, 'wt-phys');
    const wtDir = join(root, worktreePath.replace(/\//g, '-'));
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(
      join(wtDir, 'sessphys.jsonl'),
      JSON.stringify({ type: 'user', cwd: worktreePath, message: { content: 'hi' } }) + '\n',
    );
    const wtMgrRoot = mkdtempSync(join(tmpdir(), 'wt-mgr-'));
    const wtMgr = new WorktreeManager({ root: wtMgrRoot, projectsRoot: mkdtempSync(join(tmpdir(), 'wt-proj-')) });
    wtMgr._testSeedRecord({
      sessionId: 'sessphys',
      projectCwd: parentCwd,
      worktreePath,
      branch: 'outpost/phys',
      baseBranch: 'main',
      createdAt: 100,
    });
    const store = new SessionStore({ root, worktreeManager: wtMgr });
    const found = store.findSession('sessphys');
    expect(found).toBeDefined();
    // Physical projectDir = the worktree-derived dir (where the JSONL actually lives).
    expect(found!.projectDir).toBe(wtDir);
    // findSession's cwd is also the raw scan's cwd (the worktree path).
    expect(found!.cwd).toBe(worktreePath);
  });
});
