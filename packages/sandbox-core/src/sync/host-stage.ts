/**
 * Stage the host's agent-config trees (`~/.claude`, `~/.codex`,
 * `~/.config/opencode` + `~/.local/share/opencode`) into filtered tarballs any
 * provider can ship into a remote sandbox.
 *
 * Per agent we produce **two** tarballs:
 *
 *   - **static**: plugins, skills, settings, marketplaces, prompts, config —
 *     stuff that's stable across re-auths. The cloud path bakes this into the
 *     published Daytona snapshot once (`agentbox daytona publish-snapshot`),
 *     so it ships into the sandbox FS at snapshot capture time, never the
 *     S3-backed FUSE volume.
 *
 *   - **credentials**: the renewable OAuth/auth files only (a handful of KB).
 *     The cloud path uploads these into a per-org `agentbox-credentials`
 *     volume on every create (cheap) and `agentbox daytona resync` refreshes
 *     them after a re-auth — without touching the snapshot.
 *
 * Each `stage*ForUpload(opts)` returns a `StageResult`:
 *   - `tarballPath`: absolute path to a `.tar.gz`, or `null` when the host has
 *     nothing relevant to stage (no `~/.claude` etc., or no credentials file).
 *   - `cleanup()`: removes the staging dir + the tarball; ALWAYS call after
 *     the upload completes, even on error.
 *   - `warnings`: non-fatal user-facing messages (the codex Keychain landmine
 *     surfaces here).
 *
 * Requires `rsync` and `tar` on the host. macOS + every common Linux distro
 * ship both.
 */

import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { execa } from 'execa';
import { resolveAgentSpec } from './registry.js';
import type { AgentId, AgentPathMap } from '@agentbox/core';

/**
 * Portable host backup of the claude OAuth creds — the single source of truth is
 * the registry (`credential.hostBackup`), which resolves to
 * `~/.agentbox/claude-credentials.json`. The docker provider's
 * `syncClaudeCredentials` mirrors the macOS Keychain into this same path.
 */

export interface StageResult {
  /** Absolute path to the .tar.gz, or null when there was nothing to stage. */
  tarballPath: string | null;
  /** Remove the staging dir + tarball. Idempotent. */
  cleanup(): Promise<void>;
  /** Non-fatal messages (e.g. codex Keychain landmine). */
  warnings: string[];
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function findBrokenSymlinks(root: string): Promise<string[]> {
  const broken: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        try {
          await stat(full);
        } catch {
          broken.push(relative(root, full));
        }
      } else if (ent.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(root);
  return broken;
}

export async function mkStageDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentbox-${prefix}-stage-`));
}

// A stage dir is a throwaway scratch copy that we rewrite in place (filter
// settings.json, sanitize config.toml, rewrite plugin paths) and then `rm`.
// `rsync -a` implies `-p`, so it preserves the *source's* modes — and when the
// source is read-only (skill/plugin symlinks into the Nix store, or any
// root-owned / 0444 dotfiles), the copy comes out read-only too. That breaks us
// two ways: the in-place `writeFile` rewrites fail with EACCES, and `rm` can't
// unlink children of a 0555 dir (`EACCES unlink .../skills/*/SKILL.md`). Force
// the copy user-writable — a scratch dir has no business inheriting the store's
// perms. Only GNU rsync honors this; macOS's openrsync ignores it (and doesn't
// hit the read-only-source case in practice), so it's a safe no-op there.
export const STAGE_WRITABLE_CHMOD = '--chmod=Du+rwx,Fu+rw';

export function emptyResult(warnings: string[] = []): StageResult {
  return { tarballPath: null, cleanup: async () => {}, warnings };
}

export async function tarballFromDir(stageDir: string, agent: string): Promise<string> {
  const tarballPath = join(tmpdir(), `agentbox-${agent}-${basename(stageDir)}.tar.gz`);
  // COPYFILE_DISABLE=1: macOS's bsdtar (the system `tar`) walks extended attrs
  // and emits AppleDouble `._<name>` sidecars for any file with xattrs, which
  // then pollute the volume inside the cloud sandbox (claude reads ~/.claude
  // top-level and chokes on those bogus entries). The env knob makes Apple's
  // copyfile() helpers a no-op, so tar produces a clean POSIX archive.
  await execa('tar', ['-czf', tarballPath, '-C', stageDir, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return tarballPath;
}

export function makeCleanup(paths: string[]): () => Promise<void> {
  return async () => {
    for (const p of paths) {
      await rm(p, { recursive: true, force: true });
    }
  };
}

/**
 * Stage one file into a tarball whose only entry is that file at the tarball
 * root. Used for the credentials-only variants.
 */
export async function stageSingleFileTarball(
  agent: string,
  sourcePath: string,
  tarballEntryName: string,
): Promise<StageResult> {
  const stageDir = await mkStageDir(agent);
  let tarballPath: string | null = null;
  try {
    await copyFile(sourcePath, join(stageDir, tarballEntryName));
    tarballPath = await tarballFromDir(stageDir, agent);
    return {
      tarballPath,
      cleanup: makeCleanup([stageDir, tarballPath]),
      warnings: [],
    };
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
    throw err;
  }
}

// ---------- the generic stager ----------

/**
 * Stage one agent's static config from its registry row alone.
 *
 * Every `staticPaths` entry carries what an rsync needs — host source, box
 * destination, sub-path to land at, includes and excludes — so an agent that
 * needs no post-processing needs no code here at all: it declares its paths and
 * this stages them. That is what makes a newly added agent reach every cloud
 * provider's snapshot without an edit to this file.
 *
 * `stagedAs: 'state'` entries are skipped. They are two-way per-box state, and
 * a snapshot is shared by every box made from it.
 *
 * Agents whose staging needs more than a copy (claude filters host hooks, codex
 * sanitizes `config.toml` and purges orphan marketplaces) keep a dedicated
 * stager, listed in `DEDICATED_STATIC_STAGERS` below.
 */
export async function stageAgentStaticForUpload(
  agent: string,
  opts: { hostHome?: string } = {},
): Promise<StageResult> {
  const spec = resolveAgentSpec(agent);
  const hostHome = opts.hostHome ?? homedir();
  const sources = spec.staticPaths.filter((sp) => (sp.stagedAs ?? 'static') === 'static');

  const present: Array<{ path: AgentPathMap; hostPath: string }> = [];
  for (const path of sources) {
    const hostPath = join(hostHome, ...path.hostHomeRel);
    if (await pathExists(hostPath)) present.push({ path, hostPath });
  }
  if (present.length === 0) return emptyResult();

  const stageDir = await mkStageDir(`${spec.id}-static`);
  let tarballPath: string | null = null;
  try {
    for (const { path, hostPath } of present) {
      const dest = path.relocToSubpath ? join(stageDir, path.relocToSubpath) : stageDir;
      // `-L` dereferences symlinks (Daytona's FUSE volumes reject creating
      // them); a broken one would abort the whole rsync, so pre-scan and
      // exclude. Rule order is first-match-wins: the anchored broken-symlink
      // excludes come first, then the includes that carve out of the excludes.
      const broken = await findBrokenSymlinks(hostPath);
      await execa('rsync', [
        '-a',
        STAGE_WRITABLE_CHMOD,
        '-L',
        ...broken.map((r) => `--exclude=/${r}`),
        ...(path.include ?? []).map((pat) => `--include=${pat}`),
        ...(path.exclude ?? []).map((pat) => `--exclude=${pat}`),
        `${hostPath}/`,
        `${dest}/`,
      ]);
    }
    tarballPath = await tarballFromDir(stageDir, `${spec.id}-static`);
    return { tarballPath, cleanup: makeCleanup([stageDir, tarballPath]), warnings: [] };
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
    throw err;
  }
}

/**
 * Filtered tarball of `~/.agents/` (the cross-agent "Agent Skills" dir).
 * Extracts into `/home/vscode/.agents/` on the sandbox FS at snapshot-bake time
 * so the in-box agents (codex reads `~/.agents/skills` directly) see the same
 * skill set the host does. `-L` dereferences each skill's symlinks into real
 * files; broken ones are excluded so the sync can't abort.
 */
export async function stageAgentsStaticForUpload(
  opts: { hostHome?: string } = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostAgents = join(hostHome, '.agents');
  if (!(await pathExists(hostAgents))) return emptyResult();

  const stageDir = await mkStageDir('agents-static');
  let tarballPath: string | null = null;
  try {
    const broken = await findBrokenSymlinks(hostAgents);
    await execa('rsync', [
      '-a',
      STAGE_WRITABLE_CHMOD,
      '-L',
      ...broken.map((r) => `--exclude=/${r}`),
      `${hostAgents}/`,
      `${stageDir}/`,
    ]);
    tarballPath = await tarballFromDir(stageDir, 'agents-static');
    return {
      tarballPath,
      cleanup: makeCleanup([stageDir, tarballPath]),
      warnings: [],
    };
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
    throw err;
  }
}

// ---------- all-agent static bake (shared across cloud prepare paths) ----------

/** Box-side dir each tool's static tarball extracts into. Provider-neutral —
 *  the same target on every backend (docker model). */
/** Extract root for the shared `~/.agents` skills tree. */
export const AGENTS_STATIC_BOX_DIR = '/home/vscode/.agents';

export interface AgentStaticStage {
  kind: AgentId | 'agents';
  /** Absolute box path the static tarball extracts into. */
  extractDir: string;
  staged: StageResult;
}

/**
 * Stage all four host static-config trees in parallel, each paired with the
 * box-side dir it extracts into. This is the single source of truth for the
 * cloud prepare paths (vercel / hetzner / daytona / e2b): every provider walks
 * this list and supplies only its own upload + extract transport, never its own
 * copy of the producer→dir mapping. The caller must `staged.cleanup()` each
 * result after the build has picked the tarball up.
 */
