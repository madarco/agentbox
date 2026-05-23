/**
 * Stage the host's agent-config trees (`~/.claude`, `~/.codex`,
 * `~/.config/opencode` + `~/.local/share/opencode`) into a filtered tarball
 * any provider can ship into a remote sandbox. This is the cloud-provider
 * counterpart to the rsync-into-named-volume flow `ensureClaudeVolume` /
 * `ensureCodexVolume` / `ensureOpencodeVolume` already do for local Docker
 * boxes — same filters and excludes, but the output is a single .tar.gz the
 * caller uploads with `CloudBackend.uploadFile` and extracts inside the
 * sandbox with `tar -xzf … -C <mountPath>`.
 *
 * Each `stage<Agent>ForUpload(opts)` returns a `StageResult`:
 *   - `tarballPath`: absolute path to a `.tar.gz`, or `null` when the host has
 *     nothing relevant to stage (no `~/.claude` etc.).
 *   - `cleanup()`: removes the staging dir + the tarball; ALWAYS call after
 *     the upload completes, even on error.
 *   - `warnings`: non-fatal user-facing messages (the codex Keychain landmine
 *     surfaces here).
 *
 * The functions require `rsync` and `tar` on the host. macOS + every common
 * Linux distro ship both.
 */

import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { execa } from 'execa';
import {
  addProjectAlias,
  filterHostHooks,
  setInstallMethodNative,
  trustWorkspace,
} from './claude-hooks-filter.js';
import { CREDENTIALS_BACKUP_FILE } from './claude-credentials.js';

export interface StageResult {
  /** Absolute path to the .tar.gz, or null when there was nothing to stage. */
  tarballPath: string | null;
  /** Remove the staging dir + tarball. Idempotent. */
  cleanup(): Promise<void>;
  /** Non-fatal messages (e.g. codex Keychain landmine). */
  warnings: string[];
}

/** Workspace path inside every cloud sandbox — matches the Docker model. */
const CLOUD_WORKSPACE = '/workspace';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findBrokenSymlinks(root: string): Promise<string[]> {
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

async function mkStageDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentbox-${prefix}-stage-`));
}

function emptyResult(warnings: string[] = []): StageResult {
  return { tarballPath: null, cleanup: async () => {}, warnings };
}

async function tarballFromDir(stageDir: string, agent: string): Promise<string> {
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

function makeCleanup(paths: string[]): () => Promise<void> {
  return async () => {
    for (const p of paths) {
      await rm(p, { recursive: true, force: true });
    }
  };
}

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

/**
 * Build a filtered tarball of `~/.claude/` (+ `~/.claude.json` as
 * `_claude.json` at the tarball root) ready to extract into a cloud
 * sandbox's claude-config volume mount.
 *
 * Mirrors `ensureClaudeVolume`'s rsync excludes (drops `node_modules`),
 * filters host-path hooks out of `settings.json` / `_claude.json`, coerces
 * install-method to native, aliases the host workspace path to `/workspace`,
 * and pre-trusts `/workspace` so the in-box claude skips the trust dialog.
 * Plugin `installed_plugins.json` and `known_marketplaces.json` get their
 * host-home `installPath` values rewritten to the box's `/home/vscode/.claude/`.
 */
export async function stageClaudeForUpload(opts: StageClaudeOptions = {}): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostClaude = join(hostHome, '.claude');
  if (!(await pathExists(hostClaude))) return emptyResult();

  const stageDir = await mkStageDir('claude');
  let tarballPath: string | null = null;
  try {
    // 1. rsync host ~/.claude → stage. --copy-unsafe-links derefences user-
    //    skill symlinks; --exclude=node_modules drops host-platform binaries
    //    (fsevents.node, esbuild, ...). Broken symlinks would otherwise abort
    //    the whole sync under --copy-unsafe-links, so pre-scan and exclude them.
    //
    //    For cloud uploads we additionally drop runtime/history state — the
    //    Docker provider keeps these via rsync (cheap bind-mount), but over the
    //    Daytona API a typical `~/.claude` tarball balloons past 100 MB because
    //    `projects/` and `file-history/` hold per-box session metadata
    //    accumulated over months. The cloud seed wants credentials + user
    //    config + skills + plugins; everything else is per-machine runtime that
    //    the in-box claude regenerates on demand.
    const CLAUDE_RUNTIME_EXCLUDES = [
      'projects',
      'sessions',
      'history.jsonl',
      'file-history',
      'shell-snapshots',
      'backups',
      'session-env',
      'paste-cache',
      'cache',
      'telemetry',
      'tasks',
      'downloads',
      'chrome',
      'ide',
      'debug',
      'mcp-needs-auth-cache.json',
      'stats-cache.json',
    ];
    const broken = await findBrokenSymlinks(hostClaude);
    const excludes = [
      '--exclude=node_modules',
      ...CLAUDE_RUNTIME_EXCLUDES.map((p) => `--exclude=${p}`),
      ...broken.map((r) => `--exclude=/${r}`),
    ];
    await execa('rsync', [
      '-a',
      '--copy-unsafe-links',
      ...excludes,
      `${hostClaude}/`,
      `${stageDir}/`,
    ]);

    // 2. settings.json: filter host-path hooks; rewrite in place when changed.
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

    // 3. _claude.json — sourced from $HOME/.claude.json (which lives outside
    //    ~/.claude). Apply the same chain of filters as ensureClaudeVolume
    //    uses: host-path hooks, install-method=native, host->/workspace
    //    project alias, and /workspace trust pre-accept.
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
      // Minimal _claude.json: skips integrity warning + trust dialog.
      working = {
        installMethod: 'native',
        autoUpdates: false,
        autoUpdatesProtectedForNative: true,
        projects: { [CLOUD_WORKSPACE]: { hasTrustDialogAccepted: true } },
      };
    } else {
      working = filterHostHooks(working, hostHome).data;
      working = setInstallMethodNative(working).data;
      if (opts.hostWorkspace) {
        working = addProjectAlias(working, opts.hostWorkspace, CLOUD_WORKSPACE).data;
      }
      working = trustWorkspace(working, CLOUD_WORKSPACE).data;
    }
    await writeFile(join(stageDir, '_claude.json'), JSON.stringify(working, null, 2));

    // 3b. .credentials.json — the OAuth token file Claude Code reads alongside
    //     `_claude.json`. On macOS the host's ~/.claude/.credentials.json is
    //     typically missing because the token is in the system Keychain, but
    //     the agentbox Docker provider mirrors a portable copy to
    //     ~/.agentbox/claude-credentials.json via syncClaudeCredentials. That
    //     backup is what we ship to the cloud volume. Without this, the in-box
    //     claude sees `_claude.json` (account info) but no token and bounces
    //     to the interactive sign-in flow — which inside a tmux-attached SSH
    //     session manifests as an immediate exit.
    if (await pathExists(CREDENTIALS_BACKUP_FILE)) {
      await copyFile(CREDENTIALS_BACKUP_FILE, join(stageDir, '.credentials.json'));
    }

    // 4. plugins/*.json: rewrite host-home installPath/installLocation values
    //    to the box's /home/vscode/.claude/plugins/ tree. Without this, claude
    //    resolves plugin paths to /Users/<you>/... inside the box and the
    //    marketplace fails to load. Sweep every top-level JSON; the docker
    //    flow does the same.
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

    tarballPath = await tarballFromDir(stageDir, 'claude');
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

export interface StageCodexOptions {
  hostHome?: string;
}

/**
 * Build a filtered tarball of `~/.codex` for the codex-config volume.
 *
 * Same excludes as `ensureCodexVolume` (`sessions/`, `log/`, `history.jsonl`,
 * `hooks.json`). When `~/.codex` exists but `auth.json` is missing, surface a
 * Keychain landmine warning and stage nothing (caller will skip the upload):
 * the macOS Codex CLI defaults to storing the token in Keychain rather than
 * `auth.json`, and a tarball without `auth.json` would give a signed-in-on-
 * host / signed-out-in-box experience that the user wouldn't expect.
 */
export async function stageCodexForUpload(opts: StageCodexOptions = {}): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostCodex = join(hostHome, '.codex');
  if (!(await pathExists(hostCodex))) return emptyResult();

  const hasAuthJson = await pathExists(join(hostCodex, 'auth.json'));
  if (!hasAuthJson) {
    return emptyResult([
      'codex: ~/.codex/auth.json missing. On macOS the codex CLI defaults to ' +
        'storing the OAuth token in the system Keychain, which isn\'t reachable ' +
        'from a remote sandbox. To share creds with cloud boxes either:\n' +
        '  - add `cli_auth_credentials_store = "file"` to ~/.codex/config.toml ' +
        'then re-run `codex login`, or\n' +
        '  - set OPENAI_API_KEY in your environment, or\n' +
        '  - run `codex login --with-api-key` for a file-backed login.\n' +
        'Skipping codex seed; in-box codex will prompt for sign-in.',
    ]);
  }

  const stageDir = await mkStageDir('codex');
  let tarballPath: string | null = null;
  try {
    // Plain `-a` (no `--copy-unsafe-links`): codex sprouts symlinks pointing
    // outside ~/.codex (`tmp/arg0/*/applypatch -> ~/.nvm/.../codex`, a multi-MB
    // darwin-arm64 binary, plus `skills/* -> ~/.agents/skills/*`). Following
    // those would balloon the tarball past 280 MB (observed) AND bake host
    // platform binaries into a linux sandbox. The docker provider does the same
    // — see `ensureCodexVolume` in codex.ts. Broken symlinks survive because
    // `-a` preserves them as symlinks.
    //
    // Cloud-only extra excludes vs docker: SQLite state, vendor_imports, tmp,
    // and shell-snapshot data are big runtime artifacts the in-box codex
    // regenerates on demand; uploading them via the Daytona API is wasted
    // bandwidth (~50 MB extra otherwise).
    // `-L` (--copy-links): dereference EVERY symlink, including user-skill
    // links like `~/.codex/skills/inngest -> ~/.agents/skills/inngest`. Daytona
    // volumes are S3-backed FUSE mounts that reject symlink creation
    // ("Operation not permitted"), so the tarball must be symlink-free.
    // Broken symlinks would abort rsync under `-L`, so pre-scan and skip them.
    const codexBroken = await findBrokenSymlinks(hostCodex);
    await execa('rsync', [
      '-a',
      '-L',
      ...codexBroken.map((r) => `--exclude=/${r}`),
      '--exclude=sessions',
      '--exclude=log',
      '--exclude=history.jsonl',
      '--exclude=hooks.json',
      '--exclude=logs_2.sqlite',
      '--exclude=logs_2.sqlite-shm',
      '--exclude=logs_2.sqlite-wal',
      '--exclude=state_5.sqlite',
      '--exclude=state_5.sqlite-shm',
      '--exclude=state_5.sqlite-wal',
      '--exclude=sqlite',
      '--exclude=cache',
      '--exclude=vendor_imports',
      '--exclude=tmp',
      // .tmp holds the codex plugin sync state — ~100 MB of marketplace cache.
      // Not the same as `tmp/`; both can exist side by side on a host that has
      // run codex for a while.
      '--exclude=.tmp',
      '--exclude=.codex-global-state.json',
      '--exclude=.codex-global-state.json.bak',
      '--exclude=.personality_migration',
      '--exclude=shell_snapshots',
      '--exclude=session_index.jsonl',
      '--exclude=models_cache.json',
      '--exclude=installation_id',
      '--exclude=version.json',
      `${hostCodex}/`,
      `${stageDir}/`,
    ]);
    tarballPath = await tarballFromDir(stageDir, 'codex');
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

export interface StageOpencodeOptions {
  hostHome?: string;
}

/**
 * Build a filtered tarball laid out for the opencode-config volume. OpenCode
 * splits state across two XDG dirs on the host (`~/.local/share/opencode` for
 * data + auth.json, `~/.config/opencode` for config). The cloud volume is
 * mounted at the *data* dir; the config dir is relocated to a `config/`
 * subdir of the volume via `OPENCODE_CONFIG_DIR` set in the provision env.
 * So the tarball's layout is:
 *
 *   ./auth.json                ← from ~/.local/share/opencode/auth.json
 *   ./<other data files>       ← from ~/.local/share/opencode/
 *   ./config/<config files>    ← from ~/.config/opencode/
 *
 * Excludes the SQLite session storage / logs / cloned-repo trees / host
 * binaries (`storage`, `log`, `project`, `cache`, `bin`, `repos`, the
 * `opencode.db*` files). Same excludes as `ensureOpencodeVolume`.
 */
export async function stageOpencodeForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostData = join(hostHome, '.local', 'share', 'opencode');
  const hostConfig = join(hostHome, '.config', 'opencode');
  const hasData = await pathExists(hostData);
  const hasConfig = await pathExists(hostConfig);
  if (!hasData && !hasConfig) return emptyResult();

  const stageDir = await mkStageDir('opencode');
  let tarballPath: string | null = null;
  try {
    // `-L` (--copy-links): dereference EVERY symlink to produce a symlink-
    // free tarball. Daytona's FUSE-backed volumes reject symlink creation
    // ("Operation not permitted"). Broken symlinks would abort rsync under
    // `-L`, so pre-scan and skip them.
    if (hasData) {
      const dataBroken = await findBrokenSymlinks(hostData);
      await execa('rsync', [
        '-a',
        '-L',
        ...dataBroken.map((r) => `--exclude=/${r}`),
        '--exclude=storage',
        '--exclude=log',
        '--exclude=project',
        '--exclude=cache',
        '--exclude=bin',
        '--exclude=repos',
        '--exclude=snapshot',
        '--exclude=config',
        '--exclude=opencode.db',
        '--exclude=opencode.db-shm',
        '--exclude=opencode.db-wal',
        `${hostData}/`,
        `${stageDir}/`,
      ]);
    }
    if (hasConfig) {
      const configStage = join(stageDir, 'config');
      const cfgBroken = await findBrokenSymlinks(hostConfig);
      await execa('rsync', [
        '-a',
        '-L',
        ...cfgBroken.map((r) => `--exclude=/${r}`),
        `${hostConfig}/`,
        `${configStage}/`,
      ]);
    }
    tarballPath = await tarballFromDir(stageDir, 'opencode');
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
