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

/**
 * Stage one file into a tarball whose only entry is that file at the tarball
 * root. Used for the credentials-only variants.
 */
async function stageSingleFileTarball(
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
      '--exclude=node_modules',
      '--exclude=.credentials.json',
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

// ---------- codex ----------

export interface StageCodexOptions {
  hostHome?: string;
}

const CODEX_RSYNC_EXCLUDES = [
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
  // .tmp holds codex plugin sync state — ~100 MB of marketplace cache. Not
  // the same as `tmp/`; both can exist side by side on a long-running host.
  '--exclude=.tmp',
  '--exclude=.codex-global-state.json',
  '--exclude=.codex-global-state.json.bak',
  '--exclude=.personality_migration',
  '--exclude=shell_snapshots',
  '--exclude=session_index.jsonl',
  '--exclude=models_cache.json',
  '--exclude=installation_id',
  '--exclude=version.json',
];

const CODEX_KEYCHAIN_WARNING =
  'codex: ~/.codex/auth.json missing. On macOS the codex CLI defaults to ' +
  'storing the OAuth token in the system Keychain, which isn\'t reachable ' +
  'from a remote sandbox. To share creds with cloud boxes either:\n' +
  '  - add `cli_auth_credentials_store = "file"` to ~/.codex/config.toml ' +
  'then re-run `codex login`, or\n' +
  '  - set OPENAI_API_KEY in your environment, or\n' +
  '  - run `codex login --with-api-key` for a file-backed login.\n' +
  'Skipping codex seed; in-box codex will prompt for sign-in.';

/**
 * Filtered tarball of `~/.codex/` **excluding** `auth.json`. Extracts into
 * `/home/vscode/.codex/` on the sandbox FS at snapshot-bake time.
 *
 * `-L` dereferences EVERY symlink (codex sprouts links into `~/.nvm` for the
 * `applypatch` argv0 trick and into `~/.agents/skills/*`); produces a
 * symlink-free archive suitable for the FUSE-backed Daytona volume and the
 * sandbox FS alike. Broken symlinks would abort rsync under `-L`, so pre-scan
 * and skip them.
 */
export async function stageCodexStaticForUpload(
  opts: StageCodexOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostCodex = join(hostHome, '.codex');
  if (!(await pathExists(hostCodex))) return emptyResult();

  const stageDir = await mkStageDir('codex-static');
  let tarballPath: string | null = null;
  try {
    const codexBroken = await findBrokenSymlinks(hostCodex);
    await execa('rsync', [
      '-a',
      '-L',
      ...codexBroken.map((r) => `--exclude=/${r}`),
      '--exclude=auth.json',
      ...CODEX_RSYNC_EXCLUDES,
      `${hostCodex}/`,
      `${stageDir}/`,
    ]);
    tarballPath = await tarballFromDir(stageDir, 'codex-static');
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
 * Tarball with **only** `auth.json` (sourced from `~/.codex/auth.json`).
 * Surfaces the macOS Keychain landmine as a warning when the file is missing
 * — see `CODEX_KEYCHAIN_WARNING`.
 */
export async function stageCodexCredentialsForUpload(
  opts: StageCodexOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostAuth = join(hostHome, '.codex', 'auth.json');
  if (!(await pathExists(hostAuth))) return emptyResult([CODEX_KEYCHAIN_WARNING]);
  return stageSingleFileTarball('codex-creds', hostAuth, 'auth.json');
}

// ---------- opencode ----------

export interface StageOpencodeOptions {
  hostHome?: string;
}

const OPENCODE_DATA_EXCLUDES = [
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
];

/**
 * Filtered tarball of opencode static config. Layout extracts into
 * `/home/vscode/.local/share/opencode/`:
 *
 *   ./<data files>            ← from ~/.local/share/opencode/ (minus auth.json)
 *   ./config/<config files>   ← from ~/.config/opencode/
 *
 * `auth.json` is **excluded** — it ships separately via the credentials
 * variant.
 */
export async function stageOpencodeStaticForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostData = join(hostHome, '.local', 'share', 'opencode');
  const hostConfig = join(hostHome, '.config', 'opencode');
  const hasData = await pathExists(hostData);
  const hasConfig = await pathExists(hostConfig);
  if (!hasData && !hasConfig) return emptyResult();

  const stageDir = await mkStageDir('opencode-static');
  let tarballPath: string | null = null;
  try {
    // `-L` dereferences every symlink — Daytona's FUSE volumes reject symlink
    // creation, and the sandbox FS doesn't care either way. Broken symlinks
    // would abort rsync under `-L`, so pre-scan and skip them.
    if (hasData) {
      const dataBroken = await findBrokenSymlinks(hostData);
      await execa('rsync', [
        '-a',
        '-L',
        ...dataBroken.map((r) => `--exclude=/${r}`),
        '--exclude=auth.json',
        ...OPENCODE_DATA_EXCLUDES,
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
    tarballPath = await tarballFromDir(stageDir, 'opencode-static');
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
 * Tarball with **only** `auth.json` (sourced from
 * `~/.local/share/opencode/auth.json`). Returns an empty result when the host
 * has no opencode auth file.
 */
export async function stageOpencodeCredentialsForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostAuth = join(hostHome, '.local', 'share', 'opencode', 'auth.json');
  if (!(await pathExists(hostAuth))) return emptyResult();
  return stageSingleFileTarball('opencode-creds', hostAuth, 'auth.json');
}

/**
 * Tarball with **only** the selected-model state (`model.json`, sourced from
 * `~/.local/state/opencode/model.json`). Extracts to a box's state dir so a
 * fresh box inherits the host's active model instead of OpenCode's default.
 * Returns an empty result when the host has never picked a model.
 */
export async function stageOpencodeStateForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostModel = join(hostHome, '.local', 'state', 'opencode', 'model.json');
  if (!(await pathExists(hostModel))) return emptyResult();
  return stageSingleFileTarball('opencode-state', hostModel, 'model.json');
}
