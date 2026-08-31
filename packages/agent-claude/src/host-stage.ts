/**
 * Claude's host-side staging — the part that is more than a copy.
 *
 * It filters host-path hooks out of the synced `settings.json`, forces the
 * native install method, aliases the host workspace onto `/workspace` and marks
 * it trusted. None of that is expressible as `staticPaths` data, which is why
 * claude supplies its own stager instead of riding the generic one.
 *
 * It lives here rather than in `sandbox-core` because it is claude's, and
 * `sandbox-core` cannot import an agent package. `stageAllAgentStatic` reaches
 * it through `AgentCloudModule.stageStatic`, the seam that made the move
 * possible; the rsync/tar primitives it uses are exported from `sandbox-core`.
 */

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  emptyResult,
  findBrokenSymlinks,
  makeCleanup,
  mkStageDir,
  pathExists,
  resolveAgentSpec,
  STAGE_WRITABLE_CHMOD,
  stageSingleFileTarball,
  tarballFromDir,
  type StageResult,
} from '@agentbox/sandbox-core';
import {
  addProjectAlias,
  filterHostHooks,
  setInstallMethodNative,
  trustWorkspace,
} from './hooks-filter.js';

/** Workspace path inside every cloud sandbox — matches the Docker model. */
const CLOUD_WORKSPACE = '/workspace';
const CREDENTIALS_BACKUP_FILE = resolveAgentSpec('claude').credential.hostBackup;

// ---------- claude ----------

export interface StageClaudeOptions {
  /** Defaults to `homedir()`. Override for tests. */
  hostHome?: string;
  /**
   * The host-absolute workspace path being mounted as `/workspace` in the
   * box. When set, host-keyed `projects[<hostWorkspace>]` in `_claude.json`
   * gets duplicated to `projects['/workspace']` so MCP servers, history,
   * and trust state line up with the host's view of this project.
   */
  hostWorkspace?: string;
}

// Static-stage rsync excludes are registry data (single source of truth,
// drift-guarded by the registry test). Bare patterns, mapped to `--exclude=`
// at the rsync call; per-run broken-symlink excludes are appended there.
const CLAUDE_STATIC_EXCLUDES = resolveAgentSpec('claude').staticPaths[0]?.exclude ?? [];

/**
 * Build the in-box `_claude.json` from the host's `~/.claude.json` (or a
 * sensible default when the host has no Claude config). Shared between the
 * full static tarball (prepare-time bake) and the json-only overlay
 * (create-time refresh).
 *
 * The defaults set `hasCompletedOnboarding: true` — a user who has installed
 * AgentBox has accepted Claude Code's onboarding implicitly, and the box's
 * Claude must not block on the theme picker. When the host *does* have a
 * `~/.claude.json`, the existing `hasCompletedOnboarding` / `theme` pass
 * through unchanged (the filter chain only touches hooks/install/projects/
 * trust).
 */
async function buildBoxClaudeJsonFromHost(opts: {
  hostHome: string;
  hostWorkspace?: string;
}): Promise<unknown> {
  const { hostHome, hostWorkspace } = opts;
  const hostClaudeJson = join(hostHome, '.claude.json');
  let working: unknown;
  if (await pathExists(hostClaudeJson)) {
    try {
      working = JSON.parse(await readFile(hostClaudeJson, 'utf8'));
    } catch {
      working = null;
    }
  }
  if (working === undefined || working === null) {
    working = {
      installMethod: 'native',
      autoUpdates: false,
      autoUpdatesProtectedForNative: true,
      // Pre-accept onboarding so the in-box Claude doesn't show the theme
      // picker on first run. AgentBox installing implies the user has
      // already used Claude Code on the host.
      hasCompletedOnboarding: true,
      projects: { [CLOUD_WORKSPACE]: { hasTrustDialogAccepted: true } },
    };
  } else {
    working = filterHostHooks(working, hostHome).data;
    working = setInstallMethodNative(working).data;
    if (hostWorkspace) {
      working = addProjectAlias(working, hostWorkspace, CLOUD_WORKSPACE).data;
    }
    working = trustWorkspace(working, CLOUD_WORKSPACE).data;
    // Belt-and-suspenders for hosts that have ~/.claude.json but haven't
    // completed onboarding (e.g. a CI runner or a fresh dev machine that's
    // never opened Claude interactively).
    if (typeof working === 'object' && working !== null) {
      const w = working as Record<string, unknown>;
      if (w['hasCompletedOnboarding'] !== true) w['hasCompletedOnboarding'] = true;
    }
  }
  return working;
}

/**
 * Tarball with **only** `_claude.json` at the root, built from the host's
 * current `~/.claude.json` state. Used at cloud create-time to overlay the
 * box's onboarding state, so a stale prepare-time snapshot doesn't trap the
 * in-box Claude at the theme picker. E2B (which doesn't bake `_claude.json`
 * at prepare-time at all) relies on this overlay for any onboarding state.
 *
 * Returns a real tarball even when the host has no `~/.claude.json` — the
 * default falls back to a minimal pre-onboarded shape (see
 * {@link buildBoxClaudeJsonFromHost}).
 */
export async function stageClaudeJsonOnlyForUpload(
  opts: StageClaudeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const stageDir = await mkStageDir('claude-json-only');
  let tarballPath: string | null = null;
  try {
    const claudeJson = await buildBoxClaudeJsonFromHost({
      hostHome,
      hostWorkspace: opts.hostWorkspace,
    });
    await writeFile(join(stageDir, '_claude.json'), JSON.stringify(claudeJson, null, 2));
    tarballPath = await tarballFromDir(stageDir, 'claude-json-only');
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

/**
 * Filtered tarball of `~/.claude/` (+ `~/.claude.json` as `_claude.json` at
 * tarball root) **excluding** `.credentials.json`. Extracts into
 * `/home/vscode/.claude/` on the sandbox FS at snapshot-bake time.
 *
 * Mirrors `ensureClaudeVolume`'s rsync excludes (drops `node_modules`),
 * filters host-path hooks out of `settings.json` / `_claude.json`, coerces
 * install-method to native, aliases the host workspace path to `/workspace`,
 * and pre-trusts `/workspace`. Plugin `installed_plugins.json` and
 * `known_marketplaces.json` get their host-home `installPath` values rewritten
 * to the box's `/home/vscode/.claude/`.
 */
export async function stageClaudeStaticForUpload(
  opts: StageClaudeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostClaude = join(hostHome, '.claude');
  if (!(await pathExists(hostClaude))) return emptyResult();

  const stageDir = await mkStageDir('claude-static');
  let tarballPath: string | null = null;
  try {
    // rsync host ~/.claude → stage. --copy-unsafe-links dereferences user
    // skill symlinks; --exclude=node_modules drops host-platform binaries
    // (fsevents.node, esbuild, ...). Broken symlinks would abort the whole
    // sync under --copy-unsafe-links, so pre-scan and exclude them.
    //
    // Drop runtime/history state so the snapshot bake doesn't capture
    // per-machine session data the in-box claude will regenerate anyway.
    const broken = await findBrokenSymlinks(hostClaude);
    const excludes = [
      ...CLAUDE_STATIC_EXCLUDES.map((p) => `--exclude=${p}`),
      ...broken.map((r) => `--exclude=/${r}`),
    ];
    await execa('rsync', [
      '-a',
      STAGE_WRITABLE_CHMOD,
      '--copy-unsafe-links',
      ...excludes,
      `${hostClaude}/`,
      `${stageDir}/`,
    ]);

    // settings.json: filter host-path hooks; rewrite in place when changed.
    const settingsPath = join(stageDir, 'settings.json');
    if (await pathExists(settingsPath)) {
      try {
        const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
        const filtered = filterHostHooks(parsed, hostHome);
        if (filtered.removedCommands.length > 0) {
          await writeFile(settingsPath, JSON.stringify(filtered.data, null, 2));
        }
      } catch {
        // Leave the rsynced copy if parse failed.
      }
    }

    // _claude.json — sourced from $HOME/.claude.json (which lives outside
    // ~/.claude). Apply the same filter chain `ensureClaudeVolume` uses:
    // host-path hooks, install-method=native, host->/workspace project alias,
    // and /workspace trust pre-accept. The Dockerfile.box bakes a symlink
    // `~/.claude.json -> ~/.claude/_claude.json` so the in-box claude reads
    // through to this file at runtime.
    const claudeJson = await buildBoxClaudeJsonFromHost({
      hostHome,
      hostWorkspace: opts.hostWorkspace,
    });
    await writeFile(join(stageDir, '_claude.json'), JSON.stringify(claudeJson, null, 2));

    // plugins/*.json: rewrite host-home installPath/installLocation values to
    // the box's /home/vscode/.claude/plugins/ tree. Without this, claude
    // resolves plugin paths to /Users/<you>/... inside the box and the
    // marketplace fails to load.
    const pluginsDir = join(stageDir, 'plugins');
    if (await pathExists(pluginsDir)) {
      try {
        const entries = await readdir(pluginsDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
          const file = join(pluginsDir, ent.name);
          const raw = await readFile(file, 'utf8');
          const replaced = raw
            .split(`${hostHome}/.claude/plugins/`)
            .join('/home/vscode/.claude/plugins/');
          if (replaced !== raw) await writeFile(file, replaced);
        }
      } catch {
        // Best-effort: a broken plugins/ dir mustn't sink the whole seed.
      }
    }

    tarballPath = await tarballFromDir(stageDir, 'claude-static');
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

/**
 * Tarball with **only** `.credentials.json` (sourced from
 * `~/.agentbox/claude-credentials.json`, the portable backup the Docker
 * provider's `syncClaudeCredentials` mirrors from the macOS Keychain). The
 * cloud path extracts this into `/home/vscode/.agentbox-creds/claude/` on the
 * shared `agentbox-credentials` volume; a baked symlink in the snapshot at
 * `~/.claude/.credentials.json` resolves through to it at runtime.
 *
 * Returns an empty result when no backup exists (the in-box claude falls back
 * to interactive sign-in).
 */
export async function stageClaudeCredentialsForUpload(): Promise<StageResult> {
  if (!(await pathExists(CREDENTIALS_BACKUP_FILE))) return emptyResult();
  return stageSingleFileTarball('claude-creds', CREDENTIALS_BACKUP_FILE, '.credentials.json');
}