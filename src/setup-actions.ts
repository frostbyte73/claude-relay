import { homedir } from 'node:os';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export function ensureActionsInstalled(
  srcRepoDir: string,
  outpostRuntimeDir: string,
): { actions: string[] } {
  const skillsDir = join(homedir(), '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const actions = installActions(
    join(srcRepoDir, 'actions'),
    join(outpostRuntimeDir, 'actions'),
    skillsDir,
  );
  return { actions };
}

// Copies bundled actions into ~/.outpost/actions so users can edit them.
// Real directories are left alone — user edits survive upgrades. Stale symlinks
// from the old install pattern are replaced with copies.
function installActions(srcDir: string, dstDir: string, skillsDir: string): string[] {
  mkdirSync(dstDir, { recursive: true });
  if (existsSync(srcDir)) {
    for (const category of safeReaddir(srcDir)) {
      const srcCat = join(srcDir, category);
      if (!isDir(srcCat)) continue;
      const dstCat = join(dstDir, category);
      mkdirSync(dstCat, { recursive: true });
      for (const name of safeReaddir(srcCat)) {
        const src = join(srcCat, name);
        if (!isDir(src)) continue;
        const dst = join(dstCat, name);
        let existing: ReturnType<typeof lstatSync> | null = null;
        try { existing = lstatSync(dst); } catch { /* missing */ }
        if (existing) {
          if (existing.isSymbolicLink()) {
            try { unlinkSync(dst); } catch { /* tolerate */ }
          } else {
            continue;
          }
        }
        try {
          cpSync(src, dst, { recursive: true });
          console.log(`[work] installed action: ${dst}`);
        } catch (e) {
          console.warn(`[work] could not install action ${category}/${name}: ${(e as Error).message}`);
        }
      }
    }
  }
  // NOTE: we intentionally do NOT prune here. ~/.outpost/actions is the authoritative,
  // user-editable store (the registry reads it), so it holds user-authored actions that
  // don't exist in the bundled repo — e.g. `write/run-github-workflow`. pruneStaleActions
  // would delete exactly those (any dst action in a repo-defined category the repo lacks),
  // nuking a just-created action on the next ensureActionsInstalled call. Stale *bundled*
  // actions dropped from the repo are handled by the registry's tolerant load + explicit
  // cleanup instead. pruneStaleActions is kept as a manual utility (see its tests).
  return symlinkActionsToSkills(dstDir, skillsDir);
}

// After a repo action dir disappears (e.g. renamed), remove the stale copy under
// dstDir and its owned skill symlink so the dead action stops appearing in the
// catalog. Only prunes within categories the repo source still defines — an
// action's whole category, or anything at all, is left alone if srcDir is
// missing or empty (defense against wiping installs on a bad path).
export function pruneStaleActions(srcDir: string, dstDir: string, skillsDir: string): void {
  const srcCategories = safeReaddir(srcDir).filter((c) => isDir(join(srcDir, c)));
  if (srcCategories.length === 0) return;
  const ownedRoot = resolve(dstDir);

  for (const category of srcCategories) {
    const srcCat = join(srcDir, category);
    const dstCat = join(dstDir, category);
    if (!isDir(dstCat)) continue;
    for (const name of safeReaddir(dstCat)) {
      const dst = join(dstCat, name);
      if (!isDir(dst)) continue;
      if (existsSync(join(srcCat, name))) continue;
      try {
        rmSync(dst, { recursive: true, force: true });
        console.log(`[work] pruned stale action: ${dst}`);
      } catch (e) {
        console.warn(`[work] could not prune stale action ${category}/${name}: ${(e as Error).message}`);
        continue;
      }
      pruneOwnedSkillSymlink(join(skillsDir, `${category}.${name}`), ownedRoot);
    }
  }
}

// Removes the flat skills symlink for a pruned action, but only if it's a symlink
// we created (points somewhere under dstDir) — real dirs or foreign symlinks are
// left alone.
function pruneOwnedSkillSymlink(linkPath: string, ownedRoot: string): void {
  let stat: ReturnType<typeof lstatSync> | null = null;
  try { stat = lstatSync(linkPath); } catch { return; }
  if (!stat.isSymbolicLink()) return;
  let target = '';
  try { target = readlinkSync(linkPath); } catch { return; }
  if (resolve(target) !== ownedRoot && !resolve(target).startsWith(ownedRoot + '/')) return;
  try {
    unlinkSync(linkPath);
    console.log(`[work] pruned stale skill symlink: ${linkPath}`);
  } catch (e) {
    console.warn(`[work] could not remove stale skill symlink ${linkPath}: ${(e as Error).message}`);
  }
}

function symlinkActionsToSkills(actionsDir: string, skillsDir: string): string[] {
  const installed: string[] = [];
  for (const category of safeReaddir(actionsDir)) {
    const catDir = join(actionsDir, category);
    if (!isDir(catDir)) continue;
    for (const name of safeReaddir(catDir)) {
      const src = join(catDir, name);
      if (!isDir(src)) continue;
      const flatName = `${category}.${name}`;
      const dst = join(skillsDir, flatName);
      if (linkOrLeaveAlone(src, dst, flatName)) installed.push(flatName);
    }
  }
  return installed;
}

// Force-resymlinks stale links we own; leaves real dirs alone.
function linkOrLeaveAlone(src: string, dst: string, label: string): boolean {
  let existing: ReturnType<typeof lstatSync> | null = null;
  try { existing = lstatSync(dst); } catch { /* missing */ }

  if (!existing) {
    try {
      symlinkSync(src, dst, 'dir');
      console.log(`[work] linked: ~/.claude/skills/${label} -> ${src}`);
      return true;
    } catch (e) {
      console.warn(`[work] could not link ${label}: ${(e as Error).message}`);
      return false;
    }
  }

  if (existing.isSymbolicLink()) {
    let target = '';
    try { target = readlinkSync(dst); } catch { /* unreadable */ }
    if (target === src) return true;
    try {
      unlinkSync(dst);
      symlinkSync(src, dst, 'dir');
      console.log(`[work] relinked: ~/.claude/skills/${label} -> ${src} (was ${target || 'unreadable'})`);
      return true;
    } catch (e) {
      console.warn(`[work] ${label}: could not replace stale symlink (${(e as Error).message}) — leaving alone`);
      return false;
    }
  }

  console.warn(`[work] ${label}: ~/.claude/skills/${label} exists and is not a symlink — leaving alone`);
  return false;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

// Bundled repo paths, for daemon.ts to pass into ensureActionsInstalled.
export function bundledRepoDir(srcDir: string): string {
  return join(srcDir, '..');
}
