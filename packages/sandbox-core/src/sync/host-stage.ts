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
import { resolveAgentSpec } from './registry.js';
import { sanitizeCodexConfigForBox } from './codex-config.js';

/**
 * Portable host backup of the claude OAuth creds — the single source of truth is
 * the registry (`credential.hostBackup`), which resolves to
 * `~/.agentbox/claude-credentials.json`. The docker provider's
 * `syncClaudeCredentials` mirrors the macOS Keychain into this same path.
 */
const CREDENTIALS_BACKUP_FILE = resolveAgentSpec('claude').credential.hostBackup;

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
const STAGE_WRITABLE_CHMOD = '--chmod=Du+rwx,Fu+rw';

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

// ---------- codex ----------

export interface StageCodexOptions {
  hostHome?: string;
}

// Registry data (single source of truth, drift-guarded by the registry test).
// Bare patterns mapped to `--exclude=` at the rsync call. Highlights: the
// `state_*.sqlite*` threads index is the resume-cwd source (rebuilt in-box from
// rollouts, so seeding it would trap a teleported session at the host cwd);
// `packages`/`plugins/.plugin-appserver`/`computer-use` are heavy macOS-only
// artifacts that balloon the staged tarball (~800 MB → ~0.5 MB).
const CODEX_STATIC_EXCLUDES = resolveAgentSpec('codex').staticPaths[0]?.exclude ?? [];

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
/**
 * Best-effort, in-place sanitize of a staged `config.toml`: drops host-only-path
 * `mcp_servers` / `notify` / local marketplaces via {@link
 * sanitizeCodexConfigForBox}. A missing file, a parse failure, or any IO error
 * leaves the file untouched — staging must never fail on config sanitization.
 */
async function sanitizeStagedCodexConfig(configPath: string, hostHome: string): Promise<void> {
  try {
    if (!(await pathExists(configPath))) return;
    const { text, changed } = sanitizeCodexConfigForBox(await readFile(configPath, 'utf8'), hostHome);
    if (changed) await writeFile(configPath, text);
  } catch {
    // leave the rsynced copy as-is
  }
}

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
      STAGE_WRITABLE_CHMOD,
      '-L',
      ...codexBroken.map((r) => `--exclude=/${r}`),
      ...CODEX_STATIC_EXCLUDES.map((p) => `--exclude=${p}`),
      `${hostCodex}/`,
      `${stageDir}/`,
    ]);
    // Strip host-only-path entries (desktop-Codex.app MCP servers like
    // node_repl, a macOS notify helper, local-source marketplaces) from the
    // staged config.toml so the in-box codex doesn't try to exec macOS paths.
    // Best-effort: a parse failure leaves the rsynced copy intact.
    await sanitizeStagedCodexConfig(join(stageDir, 'config.toml'), hostHome);
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

// ---------- agents (shared ~/.agents skills) ----------

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

/**
 * Tarball with **only** `auth.json`. Prefers the cloud backup
 * `~/.agentbox/codex-credentials.json` (a login captured from a previous cloud
 * box by `extractCloudAgentCredentials`); falls back to the host's real
 * `~/.codex/auth.json` so a fresh project still bootstraps from a host login.
 * Surfaces the macOS Keychain landmine as a warning when neither exists — see
 * `CODEX_KEYCHAIN_WARNING`.
 */
export async function stageCodexCredentialsForUpload(
  opts: StageCodexOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  // Prefer the cloud backup under <hostHome>/.agentbox. Derive it from hostHome
  // (rather than the module-load `CODEX_CREDENTIALS_BACKUP_FILE` constant) so the
  // path tracks the active home: production uses the real home — identical to the
  // constant — while tests/callers can redirect the whole lookup via hostHome.
  const cloudBackup = join(hostHome, '.agentbox', 'codex-credentials.json');
  if (await pathExists(cloudBackup)) {
    return stageSingleFileTarball('codex-creds', cloudBackup, 'auth.json');
  }
  const hostAuth = join(hostHome, '.codex', 'auth.json');
  if (!(await pathExists(hostAuth))) return emptyResult([CODEX_KEYCHAIN_WARNING]);
  return stageSingleFileTarball('codex-creds', hostAuth, 'auth.json');
}

// ---------- opencode ----------

export interface StageOpencodeOptions {
  hostHome?: string;
}

// Registry data (single source of truth, drift-guarded by the registry test).
// Bare patterns mapped to `--exclude=` at the rsync call. `auth.json` ships
// separately; the rest is host-only runtime state.
const OPENCODE_DATA_EXCLUDES = resolveAgentSpec('opencode').staticPaths[0]?.exclude ?? [];

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
        STAGE_WRITABLE_CHMOD,
        '-L',
        ...dataBroken.map((r) => `--exclude=/${r}`),
        ...OPENCODE_DATA_EXCLUDES.map((p) => `--exclude=${p}`),
        `${hostData}/`,
        `${stageDir}/`,
      ]);
    }
    if (hasConfig) {
      const configStage = join(stageDir, 'config');
      const cfgBroken = await findBrokenSymlinks(hostConfig);
      await execa('rsync', [
        '-a',
        STAGE_WRITABLE_CHMOD,
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
 * Tarball with **only** `auth.json`. Prefers the cloud backup
 * `~/.agentbox/opencode-credentials.json` (captured from a previous cloud box);
 * falls back to the host's real `~/.local/share/opencode/auth.json`. Returns an
 * empty result when neither exists.
 */
export async function stageOpencodeCredentialsForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  // Cloud backup under <hostHome>/.agentbox, derived from hostHome (see the
  // codex stager above) so the path tracks the active home and tests stay
  // hermetic; production matches OPENCODE_CREDENTIALS_BACKUP_FILE.
  const cloudBackup = join(hostHome, '.agentbox', 'opencode-credentials.json');
  if (await pathExists(cloudBackup)) {
    return stageSingleFileTarball('opencode-creds', cloudBackup, 'auth.json');
  }
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

// ---------- all-agent static bake (shared across cloud prepare paths) ----------

/** Box-side dir each tool's static tarball extracts into. Provider-neutral —
 *  the same target on every backend (docker model). */
const CLAUDE_STATIC_BOX_DIR = '/home/vscode/.claude';
const CODEX_STATIC_BOX_DIR = '/home/vscode/.codex';
const OPENCODE_STATIC_BOX_DIR = '/home/vscode/.local/share/opencode';
const AGENTS_STATIC_BOX_DIR = '/home/vscode/.agents';

export interface AgentStaticStage {
  kind: 'claude' | 'codex' | 'opencode' | 'agents';
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
export async function stageAllAgentStatic(
  opts: { hostWorkspace?: string } = {},
): Promise<AgentStaticStage[]> {
  const [claude, codex, opencode, agents] = await Promise.all([
    stageClaudeStaticForUpload({ hostWorkspace: opts.hostWorkspace }),
    stageCodexStaticForUpload(),
    stageOpencodeStaticForUpload(),
    stageAgentsStaticForUpload(),
  ]);
  return [
    { kind: 'claude', extractDir: CLAUDE_STATIC_BOX_DIR, staged: claude },
    { kind: 'codex', extractDir: CODEX_STATIC_BOX_DIR, staged: codex },
    { kind: 'opencode', extractDir: OPENCODE_STATIC_BOX_DIR, staged: opencode },
    { kind: 'agents', extractDir: AGENTS_STATIC_BOX_DIR, staged: agents },
  ];
}
