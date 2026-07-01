import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import {
  addProjectAlias,
  filterHostHooks,
  setInstallMethodNative,
  trustWorkspace,
} from '../claude-hooks-filter.js';
import {
  mergeInstalledPlugins,
  mergeKnownMarketplaces,
  pickNewItems,
  referencedPluginVersionKeys,
  SKILL_EXCLUDE_PREFIXES,
} from '../claude-pull.js';
import { ensureVolume, volumeExists } from '../../docker.js';
import { detectEngine, orbstackVolumePath } from '../host-export.js';
import { encodeClaudeProjectsKey } from '../host-stage.js';
// The host-side unsyncable-symlink pre-scan moved to the shared sync layer
// (also used by the ~/.agents skills seed); re-exported for existing importers
// (the find-unsyncable-symlinks test) and used internally by the claude stage.
import { findUnsyncableSymlinks } from '@agentbox/sandbox-core';
export { findUnsyncableSymlinks };

export const SHARED_CLAUDE_VOLUME = 'agentbox-claude-config';
export const DEFAULT_CLAUDE_SESSION = 'claude';
const CONTAINER_CLAUDE_DIR = '/home/vscode/.claude';
export const CONTAINER_USER = 'vscode';
/** Workspace is always mounted here inside the box, regardless of host path. */
const CONTAINER_WORKSPACE = '/workspace';
/**
 * Image-baked copy of the agentbox-setup skill (Dockerfile.box COPYs
 * `apps/cli/share/agentbox-setup/SKILL.md` here). We seed it into the
 * claude-config volume so `/agentbox-setup` is available *inside boxes only* —
 * it is intentionally never written to the host's ~/.claude.
 */
const IN_BOX_SETUP_GUIDE_PATH = '/usr/local/share/agentbox/setup-guide.md';
/** Destination skill file inside the claude-config volume (mounted at /dst). */
const SETUP_SKILL_DST = '/dst/skills/agentbox-setup/SKILL.md';

export interface ClaudeConfigSpec {
  /** Resolved Docker volume name mounted at /home/vscode/.claude. */
  volume: string;
}

export function resolveClaudeVolume(opts: { isolate: boolean; boxId: string }): ClaudeConfigSpec {
  if (opts.isolate) {
    return { volume: `${SHARED_CLAUDE_VOLUME}-${opts.boxId}` };
  }
  return { volume: SHARED_CLAUDE_VOLUME };
}

export interface EnsureClaudeVolumeOptions {
  /**
   * When true and the host's ~/.claude exists, rsync host -> volume on every call.
   * Sync is additive: files present on host overwrite same-named files in the
   * volume; box-only files (e.g. `projects/<hash>/*.jsonl` session history written
   * inside earlier boxes) are preserved.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container; we use the box image to avoid extra pulls. */
  image: string;
  /**
   * Host-absolute path of the workspace being bound to /workspace inside the
   * box. When provided, the synced `_claude.json` gets `projects[<hostWorkspace>]`
   * duplicated to `projects['/workspace']` so project-scoped MCP servers,
   * trust state, and history match what the host has for this project.
   */
  hostWorkspace?: string;
}

export interface EnsureClaudeVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper actually ran (syncFromHost was true AND host ~/.claude existed). */
  synced: boolean;
  /**
   * Number of hook entries dropped during sync because their `command` pointed
   * at a host path (under `$HOME/`) that wouldn't exist inside the container.
   * 0 when nothing was filtered or no sync ran.
   */
  filteredHookCount?: number;
  /**
   * True when the synced `_claude.json` had its install-method fields
   * (installMethod / autoUpdates / autoUpdatesProtectedForNative) coerced
   * to match the box's native install. False when they already matched.
   */
  installMethodFixed?: boolean;
  /**
   * True when `projects[<hostWorkspace>]` was duplicated to
   * `projects['/workspace']` in the synced `_claude.json` so the in-box claude
   * sees the host's project-scoped state (mcpServers, history, …).
   */
  aliasedProjectKey?: boolean;
  /**
   * True when `projects['/workspace'].hasTrustDialogAccepted` was set to `true`
   * in the synced `_claude.json` (it wasn't already). Pre-trusting the box's
   * workspace skips the trust dialog and avoids the Claude Code untrusted-
   * workspace `400 role 'system'` bug.
   */
  workspaceTrusted?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the claude-config volume already holds a `_claude.json` at its
 * root. Claude Code treats `~/.claude.json` as its own mutable runtime/auth
 * state (`oauthAccount`, `userID`, onboarding flags, ...). Once the volume has
 * one — written by an earlier box session or the throwaway `claude auth login`
 * container — overwriting it with the host's copy clobbers that state, and the
 * box's first API request then fails with `400 "system" role is not supported`.
 * Callers use this to keep `_claude.json` write-once.
 */
async function volumeHasClaudeJson(volume: string, image: string): Promise<boolean> {
  const res = await execa(
    'docker',
    ['run', '--rm', '-v', `${volume}:/dst`, image, 'sh', '-c', 'test -e /dst/_claude.json'],
    { reject: false },
  );
  return res.exitCode === 0;
}


/**
 * Ensure the named volume exists, then (when {@link EnsureClaudeVolumeOptions.syncFromHost}
 * is true and the host has a `~/.claude` directory) rsync host -> volume via a throwaway
 * helper container. The host is treated as the authoritative source for config:
 * settings, auth token, skills, plugins, and MCP entries on the host overwrite the
 * same-named files in the volume on every call. Files that only exist in the volume
 * (in-box session history under `projects/`, statsig cache, etc.) are preserved —
 * rsync runs without `--delete`.
 *
 * Caveat: if another box is currently running with the same shared volume mounted,
 * the rsync can change config files under it mid-session. We accept this as part of
 * "host is authoritative" — per-box state under `projects/` is untouched, so the
 * effect is limited to overlapping config files (rare to be edited live).
 *
 * Returns `created: true` only on the very first run for this volume; `synced: true`
 * whenever the rsync actually executed.
 */
export async function ensureClaudeVolume(
  spec: ClaudeConfigSpec,
  opts: EnsureClaudeVolumeOptions,
): Promise<EnsureClaudeVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  if (!opts.syncFromHost) return { created, synced: false };

  const hostClaude = join(homedir(), '.claude');
  if (!(await pathExists(hostClaude))) return { created, synced: false };

  // rsync (not cp -a) so repeat syncs skip unchanged files. rsync is installed in
  // the box image (Dockerfile.box). Trailing slash on /src-claude/ means
  // "contents of src", matching the original cp -a /src/. /dst/ semantics.
  // We run as root (--user 0) because the volume's existing content may be a
  // mix of UIDs (host's macOS UID for files copied from ~/.claude, plus
  // vscode's UID 1000 for anything claude wrote inside a box); only root can
  // rewrite arbitrary ownership. The post-chown brings everything back to
  // UID 1000 so the in-box vscode user can read/write.
  //
  // We also pull in ~/.claude.json (the *file* at home root that Claude Code
  // uses for global state: hasCompletedOnboarding, anonymousId, oauthAccount,
  // plugin caches). It's not inside ~/.claude, so we bind-mount it separately
  // (when present) and copy it into the volume as _claude.json. A symlink
  // baked into the image (/home/vscode/.claude.json -> .../_claude.json)
  // makes it reachable from the path claude expects.
  const hostClaudeJson = join(homedir(), '.claude.json');
  const hasJson = await pathExists(hostClaudeJson);
  // `_claude.json` is write-once in the volume. The first writer wins — the
  // throwaway `claude auth login` container (seeded just before it via this
  // same function), or an earlier box session. Re-copying the host's
  // ~/.claude.json on every create/start would clobber Claude's own
  // `oauthAccount` and break the box's first request (see volumeHasClaudeJson).
  const seedClaudeJson = !(await volumeHasClaudeJson(spec.volume, opts.image));
  const hostHome = homedir();
  // Claude Code's user-skills convention: ~/.claude/skills/<name> is a
  // RELATIVE symlink to ../../.agents/skills/<name>. From /src-claude/skills/
  // inside the helper that resolves to /.agents/skills/<name>. Bind-mount the
  // host's ~/.agents at /.agents so --copy-unsafe-links can dereference each
  // symlink into a real directory in /dst. Without this, rsync errors with
  // "symlink has no referent" and the whole sync aborts.
  const hostAgents = join(homedir(), '.agents');
  const hasAgents = await pathExists(hostAgents);
  const args: string[] = [
    'run',
    '--rm',
    '--user',
    '0',
    // HOST_HOME used inside the shell script to rewrite host-absolute
    // installPath values in plugins/installed_plugins.json.
    '-e',
    `HOST_HOME=${hostHome}`,
    '-v',
    `${spec.volume}:/dst`,
    '-v',
    `${hostClaude}:/src-claude:ro`,
  ];
  if (hasJson && seedClaudeJson) args.push('-v', `${hostClaudeJson}:/src-claude-json:ro`);
  if (hasAgents) args.push('-v', `${hostAgents}:/.agents:ro`);

  // Pre-filter host-path hooks. Hook commands whose path is under the user's
  // host home (e.g. `/Users/marco/.config/iterm2/cc-status`) won't exist
  // inside the Linux container, and Claude logs a noisy
  // `SessionStart:startup hook error /bin/sh: …: not found` every time. We
  // build a small tempdir with filtered copies of `settings.json` /
  // `.claude.json`, mount it as `/src-filter`, and let the helper container
  // overlay it on top of what rsync brought in. The host files are never
  // touched.
  const filterDir = await mkdtemp(join(tmpdir(), 'agentbox-claude-filter-'));
  let filteredHookCount = 0;
  let installMethodFixed = false;
  let aliasedProjectKey = false;
  let workspaceTrusted = false;
  try {
    const settingsResult = await maybeFilterTo(
      join(hostClaude, 'settings.json'),
      join(filterDir, 'settings.json'),
      hostHome,
    );
    filteredHookCount += settingsResult.removedHooks;
    if (!seedClaudeJson) {
      // The volume already has a `_claude.json`; write-once leaves it intact
      // (see seedClaudeJson). No host overlay is generated for it — the
      // settings.json filtering above still applies.
    } else if (hasJson) {
      const jsonResult = await maybeFilterTo(
        hostClaudeJson,
        join(filterDir, '_claude.json'),
        hostHome,
        {
          setInstallMethodNative: true,
          aliasProject: opts.hostWorkspace
            ? { from: opts.hostWorkspace, to: CONTAINER_WORKSPACE }
            : undefined,
          trustWorkspacePath: CONTAINER_WORKSPACE,
        },
      );
      filteredHookCount += jsonResult.removedHooks;
      installMethodFixed = jsonResult.installMethodFixed;
      aliasedProjectKey = jsonResult.aliasedProjectKey;
      workspaceTrusted = jsonResult.workspaceTrusted;
    } else {
      // Host has no ~/.claude.json. Write a minimal _claude.json directly to
      // the filter dir so the in-box claude still gets installMethod=native
      // (skips the integrity warning) and a pre-trusted /workspace (skips the
      // trust dialog — and avoids the Claude Code bug where an untrusted
      // workspace yields `400 role 'system' is not supported on this model`).
      await writeFile(
        join(filterDir, '_claude.json'),
        JSON.stringify(
          {
            installMethod: 'native',
            autoUpdates: false,
            autoUpdatesProtectedForNative: true,
            projects: { [CONTAINER_WORKSPACE]: { hasTrustDialogAccepted: true } },
          },
          null,
          2,
        ),
      );
      installMethodFixed = true;
      workspaceTrusted = true;
    }
    if (filteredHookCount > 0 || installMethodFixed || aliasedProjectKey || workspaceTrusted) {
      args.push('-v', `${filterDir}:/src-filter:ro`);
    }
    // Pre-scan for symlinks the in-container rsync can't dereference. With
    // --copy-unsafe-links rsync errors out and exits 23 when an unsafe
    // symlink's referent is missing inside the box — either broken on the host
    // (`~/.claude/debug/latest` points at a reaped debug file) or valid on the
    // host but pointing outside the mounted trees (`~/.claude` + `~/.agents`),
    // e.g. a dev's skills symlinked into an agentbox source checkout. We can't
    // predict every case, so we walk once and tell rsync to skip those entries.
    const reachableRoots = hasAgents ? [hostClaude, hostAgents] : [hostClaude];
    const brokenSymlinks = await findUnsyncableSymlinks(hostClaude, reachableRoots);
    // Exclude the host-keyed `projects/` tree: its dir name encodes the host
    // cwd, but the in-box claude (cwd /workspace) reads the `-workspace` key,
    // so a verbatim copy never lines up and just leaks host paths into the
    // volume. We re-add only the current project's memory below, rekeyed to
    // -workspace. (Box-written -workspace sessions stay put — rsync has no
    // --delete; session-teleport still uploads its single jsonl directly.)
    const rsyncExcludes = ['--exclude=node_modules', '--exclude=/projects'];
    for (const rel of brokenSymlinks) rsyncExcludes.push(`--exclude=/${rel}`);
    const rsyncFlags = `-a --copy-unsafe-links ${rsyncExcludes.join(' ')}`;
    // Rekey the host project's memory/ -> /dst/projects/-workspace/memory.
    // The key is [A-Za-z0-9-] only (encodeClaudeProjectsKey), so it's shell-safe
    // to interpolate. Empty snippet when no workspace or the helper finds no
    // host memory dir (the `[ -d ... ]` guard).
    const memoryKey = opts.hostWorkspace ? encodeClaudeProjectsKey(opts.hostWorkspace) : null;
    const memoryRekeyStep = memoryKey
      ? ` && { [ -d "/src-claude/projects/${memoryKey}/memory" ] && ` +
        `mkdir -p /dst/projects/-workspace && ` +
        `rm -rf /dst/projects/-workspace/memory && ` +
        `cp -a "/src-claude/projects/${memoryKey}/memory" /dst/projects/-workspace/memory; true; }`
      : '';
    args.push(
      opts.image,
      'sh',
      '-c',
      // Each step in its own brace group so a missing optional file (no
      // .claude.json on host, no filtered overlays) doesn't short-circuit the
      // final chown.
      //
      // --copy-unsafe-links: dereference symlinks pointing OUTSIDE
      //   /src-claude (e.g. ~/.claude/skills/* -> ../../.agents/skills/*),
      //   so user skills materialize as real directories inside the volume
      //   without needing to also bind-mount ~/.agents.
      // --exclude=node_modules: skip every node_modules directory anywhere
      //   in the tree. Plugin caches (plugins/cache/<m>/<p>/<v>/node_modules)
      //   ship host-platform-specific binaries (darwin-arm64 fsevents,
      //   esbuild, rollup, sharp) that are useless on linux/amd64. The
      //   plugin source still lands; node_modules is rebuilt lazily inside
      //   the box on first claude session (see rebuildPluginNativeDeps).
      //
      // The top-level plugin registry JSONs (installed_plugins.json,
      // known_marketplaces.json) carry host-absolute `installPath` /
      // `installLocation` values; without rewriting, claude resolves them
      // to `/Users/<you>/...` (or, when claude detects the missing path,
      // falls back to a slug derived from `source.repo` like
      // `microsoft-playwright-cli` — neither exists in the box, and the
      // marketplace fails to load, which masquerades as "plugin not
      // found in marketplace"). One sweep over every JSON directly under
      // /dst/plugins/ catches both files (and any future registry).
      // One-shot migration for volumes that were populated before
      // --exclude=node_modules existed. Without it, the volume keeps
      // host-darwin node_modules forever (rsync without --delete won't
      // remove them). The `.agentbox-cleaned-nm-v1` sentinel makes the wipe
      // a no-op after the first run; rebuildPluginNativeDeps repopulates
      // linux/amd64 node_modules on the next `agentbox claude`.
      '{ [ ! -f /dst/.agentbox-cleaned-nm-v1 ] && ' +
        'find /dst -name node_modules -type d -prune -exec rm -rf {} + && ' +
        'touch /dst/.agentbox-cleaned-nm-v1; true; }' +
        ` && rsync ${rsyncFlags} /src-claude/ /dst/` +
        ' && { [ -f /src-claude-json ] && cp -a /src-claude-json /dst/_claude.json; true; }' +
        ' && { [ -f /src-filter/settings.json ] && cp -a /src-filter/settings.json /dst/settings.json; true; }' +
        ' && { [ -f /src-filter/_claude.json ] && cp -a /src-filter/_claude.json /dst/_claude.json; true; }' +
        ' && { [ -d /dst/plugins ] && [ -n "$HOST_HOME" ] && ' +
        'find /dst/plugins -maxdepth 1 -type f -name "*.json" ' +
        '-exec sed -i "s|$HOST_HOME/.claude/plugins/|/home/vscode/.claude/plugins/|g" {} +; true; }' +
        memoryRekeyStep +
        ' && chown -R 1000:1000 /dst',
    );
    await execa('docker', args);
  } finally {
    await rm(filterDir, { recursive: true, force: true });
  }

  return {
    created,
    synced: true,
    filteredHookCount,
    installMethodFixed,
    aliasedProjectKey,
    workspaceTrusted,
  };
}

/**
 * Seed the `agentbox-setup` skill into the claude-config volume from the
 * image-baked copy ({@link IN_BOX_SETUP_GUIDE_PATH}). This is the box-only
 * install path: the skill is intentionally never written to the host's
 * ~/.claude (so `agentbox claude` doesn't pollute the user's machine).
 *
 * Independent of `ensureClaudeVolume`'s host rsync — it runs even when the
 * host has no ~/.claude or `syncFromHost` was false. The skill is
 * agentbox-owned and image-versioned (not user-customizable, excluded from
 * the host<->box sync), so we re-copy it unconditionally: a stale copy in a
 * long-lived shared volume must not pin an old skill after an image upgrade.
 *
 * Best-effort: a failure here must not fail box creation.
 */
export async function seedSetupSkillIntoVolume(
  volume: string,
  image: string,
): Promise<{ seeded: boolean }> {
  try {
    const { stdout } = await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${volume}:/dst`,
      image,
      'sh',
      '-c',
      // Always overwrite from the image so an image upgrade propagates. Prints
      // SEEDED on success; the whole thing is `|| true` so a missing image
      // asset is a clean no-op, never a non-zero exit.
      `{ [ -f ${IN_BOX_SETUP_GUIDE_PATH} ] && ` +
        `rm -rf /dst/skills/agentbox-setup && ` +
        `mkdir -p /dst/skills/agentbox-setup && ` +
        `cp -a ${IN_BOX_SETUP_GUIDE_PATH} ${SETUP_SKILL_DST} && ` +
        `chown -R 1000:1000 /dst/skills/agentbox-setup && echo SEEDED; } || true`,
    ]);
    return { seeded: stdout.includes('SEEDED') };
  } catch {
    return { seeded: false };
  }
}

/**
 * Read a JSON file, run it through {@link filterHostHooks}, (when opted in)
 * {@link setInstallMethodNative}, {@link addProjectAlias}, and
 * {@link trustWorkspace}, and write the result to `dest` ONLY when at least
 * one change was made. Tolerant of missing or garbage JSON — silently returns
 * zero changes in those cases (sync proceeds with the raw rsync'd file).
 */
async function maybeFilterTo(
  src: string,
  dest: string,
  hostHome: string,
  opts: {
    setInstallMethodNative?: boolean;
    aliasProject?: { from: string; to: string };
    trustWorkspacePath?: string;
  } = {},
): Promise<{
  removedHooks: number;
  installMethodFixed: boolean;
  aliasedProjectKey: boolean;
  workspaceTrusted: boolean;
}> {
  const zero = {
    removedHooks: 0,
    installMethodFixed: false,
    aliasedProjectKey: false,
    workspaceTrusted: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(src, 'utf8'));
  } catch {
    return zero;
  }
  const filtered = filterHostHooks(parsed, hostHome);
  let working: unknown = filtered.data;
  let installFixed = false;
  if (opts.setInstallMethodNative) {
    const r = setInstallMethodNative(working);
    working = r.data;
    installFixed = r.applied;
  }
  let aliased = false;
  if (opts.aliasProject) {
    const r = addProjectAlias(working, opts.aliasProject.from, opts.aliasProject.to);
    working = r.data;
    aliased = r.aliased;
  }
  let trusted = false;
  if (opts.trustWorkspacePath) {
    const r = trustWorkspace(working, opts.trustWorkspacePath);
    working = r.data;
    trusted = r.trusted;
  }
  if (filtered.removedCommands.length === 0 && !installFixed && !aliased && !trusted) {
    return zero;
  }
  await writeFile(dest, JSON.stringify(working, null, 2));
  return {
    removedHooks: filtered.removedCommands.length,
    installMethodFixed: installFixed,
    aliasedProjectKey: aliased,
    workspaceTrusted: trusted,
  };
}

export interface ClaudeMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /** Env vars to forward into the container; only includes keys that were set + non-empty on the host. */
  env: Record<string, string>;
  volumeName: string;
}

// Forwarded from the host's `process.env` into the box at `docker run -e` time
// (and re-forwarded by `startClaudeSession` at `docker exec -e` time, so a
// later `agentbox claude start <existing-box>` picks up the host's current
// session env even when the container was created from a different shell).
//
// CLAUDE_EFFORT / ANTHROPIC_MODEL: Claude Code stores the user's model
// selection (Opus/Sonnet/Haiku via /model or --effort) only in the parent
// claude's process env — not in `~/.claude.json` or `~/.claude/settings.json`.
// When the user invokes `agentbox claude` from inside their host claude
// session, that env IS present in the calling shell; forwarding it is the
// only way the in-box claude inherits the same model default.
export const CLAUDE_FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_EFFORT',
  'ANTHROPIC_MODEL',
] as const;
// Internal alias kept so existing usages in this file stay terse.
const FORWARDED_ENV_KEYS = CLAUDE_FORWARDED_ENV_KEYS;

export function buildClaudeMounts(
  spec: ClaudeConfigSpec,
  hostEnv: NodeJS.ProcessEnv,
): ClaudeMountResult {
  const env: Record<string, string> = {};
  for (const k of FORWARDED_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_CLAUDE_DIR}`],
    env,
    volumeName: spec.volume,
  };
}

export interface RebuildPluginNativeDepsResult {
  /** Plugin cache directories whose node_modules was (re)installed during this call. */
  rebuilt: string[];
  /** Plugin cache directories where install failed; non-fatal, claude often still loads. */
  failed: Array<{ dir: string; stderr: string }>;
  /**
   * Stale plugin-version cache dirs (`<m>/<p>/<v>`, not referenced by
   * `installed_plugins.json`) whose `node_modules` was pruned during this call.
   */
  pruned: string[];
  /** Total bytes freed by {@link RebuildPluginNativeDepsResult.pruned}. */
  prunedBytes: number;
  /**
   * True when the in-box exec was skipped entirely because a host-side scan
   * proved every package.json-bearing plugin already carries its install
   * marker. Only possible when the volume is host-visible (OrbStack).
   */
  skipped: boolean;
}

/** Per-plugin sentinel written inside the cache dir after a successful install. */
const PLUGIN_INSTALLED_MARKER = '.agentbox-installed';

/**
 * Per-plugin sentinel written (mtime = failure time) when an install fails. A
 * plugin with a *recent* fail marker is skipped instead of retried on every
 * launch; once the marker ages past {@link PLUGIN_INSTALL_BACKOFF_MS} it's
 * retried. Cleared on a later success.
 */
const PLUGIN_FAILED_MARKER = '.agentbox-install-failed';

/** How long a failed plugin install is skipped before it's retried. */
const PLUGIN_INSTALL_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Backoff window in whole minutes, for the in-box `find -mmin` recency test. */
const PLUGIN_INSTALL_BACKOFF_MIN = Math.round(PLUGIN_INSTALL_BACKOFF_MS / 60000);

/**
 * Persistent npm cache, kept inside the claude-config volume so a given
 * package@version is fetched from the registry once *globally* and reused by
 * every later box and plugin version. Shared across boxes with the default
 * shared volume; per-box only under `--isolate-claude-config`. Not named
 * `node_modules`, so the one-time node_modules cleanup migration leaves it
 * alone; the host->volume rsync is additive (won't delete it) and `pull claude`
 * only pulls skills/plugins/agents/commands (won't drag it to the host).
 */
const NPM_CACHE_DIR = '/home/vscode/.claude/.agentbox-npm-cache';

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** True when `p` exists and its mtime is within the install-backoff window. */
async function isRecentFailMarker(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return Date.now() - st.mtimeMs < PLUGIN_INSTALL_BACKOFF_MS;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read `installed_plugins.json` next to a plugin cache dir and reduce it to the
 * set of `<m>/<p>/<v>` version keys it actively references. Missing/unparseable
 * file -> empty set ("can't determine"), which callers treat as "apply no
 * reference-based filtering".
 */
async function readReferencedPluginKeys(installedPluginsJsonPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(installedPluginsJsonPath, 'utf8');
    return referencedPluginVersionKeys(JSON.parse(raw) as unknown);
  } catch {
    return new Set<string>();
  }
}

/**
 * Pure host-side scan of a plugin `cache/<m>/<p>/<v>/` tree. Returns true iff
 * at least one version dir has a `package.json`, no install marker, and no
 * *recent* failure marker — i.e. the in-box rebuild would actually do npm
 * work. A missing/empty cache root means nothing to do (false). Mirrors the
 * in-box script's accept/skip rules (`packages/sandbox-docker/src/claude.ts`
 * rebuild script) so the host pre-check and the container never disagree.
 *
 * When the sibling `installed_plugins.json` yields a non-empty referenced set,
 * unreferenced version dirs are ignored here exactly as the in-box loop skips
 * installing them (prevention) — a stale dir is never "rebuild work".
 */
export async function scanPluginCacheForRebuild(cacheRoot: string): Promise<boolean> {
  const referenced = await readReferencedPluginKeys(
    join(cacheRoot, '..', 'installed_plugins.json'),
  );
  let marketplaces;
  try {
    marketplaces = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const m of marketplaces) {
    if (!m.isDirectory()) continue;
    const mPath = join(cacheRoot, m.name);
    let plugins;
    try {
      plugins = await readdir(mPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of plugins) {
      if (!p.isDirectory()) continue;
      const pPath = join(mPath, p.name);
      let versions;
      try {
        versions = await readdir(pPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const v of versions) {
        if (!v.isDirectory()) continue;
        if (referenced.size > 0 && !referenced.has(`${m.name}/${p.name}/${v.name}`)) continue;
        const vPath = join(pPath, v.name);
        if (!(await isFile(join(vPath, 'package.json')))) continue;
        if (await isFile(join(vPath, PLUGIN_INSTALLED_MARKER))) continue;
        if (await isRecentFailMarker(join(vPath, PLUGIN_FAILED_MARKER))) continue;
        return true;
      }
    }
  }
  return false;
}

/**
 * Host-visible `plugins/cache` dir for a claude-config volume, or null when the
 * engine doesn't expose volume contents to the host (Docker Desktop / other).
 * Returns the cache path even if it doesn't exist yet — {@link
 * scanPluginCacheForRebuild} treats a missing cache as "nothing to do" — but
 * only once the volume itself is materialized on the host.
 */
async function resolveClaudeCacheLiveOnHost(volume: string): Promise<string | null> {
  if ((await detectEngine()) !== 'orbstack') return null;
  if (!(await isDir(orbstackVolumePath(volume)))) return null;
  return orbstackVolumePath(volume, 'plugins', 'cache');
}

/**
 * Walk `/home/vscode/.claude/plugins/cache/<m>/<p>/<v>/` inside the box and run
 * `npm install` (or `npm ci` when a lockfile is present) for any plugin that
 * ships a `package.json` but hasn't been installed yet. Marker-gated (not
 * node_modules — plugins with empty dep lists install cleanly without ever
 * creating a node_modules dir, so a dir check would loop forever).
 *
 * This exists because the host→volume rsync excludes `node_modules` (host
 * darwin-arm64 native binaries like fsevents.node / @esbuild/darwin-arm64
 * are useless on the linux/amd64 box). The first claude session in a fresh
 * box pays the install cost; subsequent attaches don't.
 *
 * Three things keep this fast: installs run **in parallel** (bounded), npm
 * shares a **persistent cache in the claude-config volume** ({@link
 * NPM_CACHE_DIR}) with `--prefer-offline` so a package@version is fetched once
 * globally, and a failed plugin records {@link PLUGIN_FAILED_MARKER} so it's
 * skipped (not retried) until {@link PLUGIN_INSTALL_BACKOFF_MS} elapses.
 *
 * Failures on individual plugins are reported but don't throw — most
 * plugins still load with a partial dependency graph, and we prefer
 * launching claude over blocking on a third-party plugin's install hiccup.
 *
 * When this pass runs at all (i.e. a plugin difference was detected, so a
 * rebuild is warranted) it also **prunes** stale plugin-version dirs: when
 * Claude updates a plugin it leaves the old `cache/<m>/<p>/<v>/` dir on disk,
 * and its ~hundreds-of-MB `node_modules` would otherwise live forever in the
 * shared claude-config volume. Any version dir not referenced by
 * `installed_plugins.json` has its `node_modules` (and our markers) removed,
 * and the install loop never (re)installs into an unreferenced dir.
 */
async function readBoxReferencedPluginKeys(container: string): Promise<Set<string>> {
  const res = await execa(
    'docker',
    [
      'exec',
      '--user',
      CONTAINER_USER,
      container,
      'cat',
      `${CONTAINER_CLAUDE_DIR}/plugins/installed_plugins.json`,
    ],
    { reject: false },
  );
  if (res.exitCode !== 0 || !res.stdout) return new Set<string>();
  try {
    return referencedPluginVersionKeys(JSON.parse(res.stdout) as unknown);
  } catch {
    return new Set<string>();
  }
}

export async function rebuildPluginNativeDeps(
  container: string,
  opts: {
    onProgress?: (line: string) => void;
    /**
     * The claude-config volume backing this box. When given and host-visible
     * (OrbStack), a pure-fs pre-scan skips the `docker exec` entirely if every
     * package.json plugin already has its install marker — the common case for
     * every box after the first global install.
     */
    volume?: string;
  } = {},
): Promise<RebuildPluginNativeDepsResult> {
  if (opts.volume) {
    const cacheRoot = await resolveClaudeCacheLiveOnHost(opts.volume);
    if (cacheRoot && !(await scanPluginCacheForRebuild(cacheRoot))) {
      return { rebuilt: [], failed: [], pruned: [], prunedBytes: 0, skipped: true };
    }
  }
  // Reference set from the box's installed_plugins.json: version dirs Claude no
  // longer points at are stale. An empty set (file missing / unparseable)
  // disables both prevention and the prune pass — the script then behaves
  // exactly as it did before this feature.
  const referenced = await readBoxReferencedPluginKeys(container);
  const refSetup =
    referenced.size > 0
      ? `cat <<'AGENTBOX_REF_EOF' > "$WORK/referenced"\n${[...referenced].sort().join('\n')}\nAGENTBOX_REF_EOF\n`
      : '';
  // The host parser below expects the REBUILD_START / REBUILD_OK /
  // REBUILD_FAIL..REBUILD_FAIL_END protocol (plus PRUNE_OK lines); parallel
  // jobs write per-dir result+stderr files and we replay them after `wait`.
  const script = `set -u
PLUGINS_DIR=/home/vscode/.claude/plugins/cache
MARKER=${PLUGIN_INSTALLED_MARKER}
FAILMARKER=${PLUGIN_FAILED_MARKER}
NPM_CACHE=${NPM_CACHE_DIR}
BACKOFF_MIN=${PLUGIN_INSTALL_BACKOFF_MIN}
MAX=4
[ -d "$PLUGINS_DIR" ] || exit 0
mkdir -p "$NPM_CACHE"
WORK=\$(mktemp -d)
${refSetup}relkey() { printf '%s' "\${1#$PLUGINS_DIR/}" | tr '/' '_'; }
# True when refs are unknown (no file) or $1 (<m>/<p>/<v>) is referenced.
is_referenced() {
  [ -s "$WORK/referenced" ] || return 0
  grep -Fxq "$1" "$WORK/referenced"
}
# Run one plugin's install. $1 is frozen by value at call time, so it's safe
# to read from the backgrounded subshell; the rest are set-once constants.
do_one() {
  d=\$1
  key=\$(relkey "$d")
  if (cd "$d" && \\
      if [ -f package-lock.json ]; then \\
        npm ci --no-audit --no-fund --silent --prefer-offline --cache "$NPM_CACHE"; \\
      else \\
        npm install --no-audit --no-fund --silent --no-package-lock --prefer-offline --cache "$NPM_CACHE"; \\
      fi) >"$WORK/$key.out" 2>"$WORK/$key.err"; then
    touch "$d/$MARKER"
    rm -f "$d/$FAILMARKER"
    printf 'OK\\n' > "$WORK/$key.res"
  else
    : > "$d/$FAILMARKER"
    printf 'FAIL\\n' > "$WORK/$key.res"
  fi
}
# Prune pass: every unreferenced (stale) version dir loses its node_modules and
# our markers. Only runs when installed_plugins.json gave us a reference set.
if [ -s "$WORK/referenced" ]; then
  for dir in "$PLUGINS_DIR"/*/*/*/; do
    [ -d "$dir" ] || continue
    rel=\${dir%/}; rel=\${rel#$PLUGINS_DIR/}
    grep -Fxq "$rel" "$WORK/referenced" && continue
    if [ -d "$dir/node_modules" ]; then
      bytes=\$(du -sb "$dir/node_modules" 2>/dev/null | cut -f1)
      [ -n "$bytes" ] || bytes=0
      rm -rf "$dir/node_modules" "$dir/$MARKER" "$dir/$FAILMARKER"
      echo "PRUNE_OK $rel $bytes"
    else
      rm -f "$dir/$MARKER" "$dir/$FAILMARKER"
    fi
  done
fi
n=0
for dir in "$PLUGINS_DIR"/*/*/*/; do
  [ -d "$dir" ] || continue
  [ -f "$dir/package.json" ] || continue
  rel=\${dir%/}; rel=\${rel#$PLUGINS_DIR/}
  is_referenced "$rel" || continue
  [ -f "$dir/$MARKER" ] && continue
  [ -n "\$(find "$dir" -maxdepth 1 -name "$FAILMARKER" -mmin -\$BACKOFF_MIN 2>/dev/null)" ] && continue
  echo "REBUILD_START \${dir#$PLUGINS_DIR/}"
  n=\$((n+1))
  printf '%s\\n' "$dir" >> "$WORK/dirs"
done
if [ "$n" -eq 0 ]; then rm -rf "$WORK"; exit 0; fi
running=0
while IFS= read -r dir; do
  do_one "$dir" &
  running=\$((running+1))
  if [ "$running" -ge "$MAX" ]; then wait; running=0; fi
done < "$WORK/dirs"
wait
while IFS= read -r dir; do
  key=\$(relkey "$dir")
  rel=\${dir#$PLUGINS_DIR/}
  [ -f "$WORK/$key.res" ] || continue
  read -r st < "$WORK/$key.res"
  if [ "$st" = OK ]; then
    echo "REBUILD_OK $rel"
  else
    echo "REBUILD_FAIL $rel"
    sed 's/^/  /' "$WORK/$key.err"
    echo "REBUILD_FAIL_END"
  fi
done < "$WORK/dirs"
rm -rf "$WORK"
`;
  const result = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'sh', '-c', script],
    { reject: false },
  );
  const rebuilt: string[] = [];
  const failed: Array<{ dir: string; stderr: string }> = [];
  const pruned: string[] = [];
  let prunedBytes = 0;
  const lines = (result.stdout ?? '').split('\n');
  let collectingFail: { dir: string; stderr: string[] } | null = null;
  for (const line of lines) {
    if (collectingFail) {
      if (line === 'REBUILD_FAIL_END') {
        failed.push({ dir: collectingFail.dir, stderr: collectingFail.stderr.join('\n') });
        collectingFail = null;
      } else {
        collectingFail.stderr.push(line);
      }
      continue;
    }
    if (line.startsWith('REBUILD_START ')) {
      opts.onProgress?.(`rebuilding ${line.slice('REBUILD_START '.length)}`);
    } else if (line.startsWith('REBUILD_OK ')) {
      rebuilt.push(line.slice('REBUILD_OK '.length));
    } else if (line.startsWith('REBUILD_FAIL ')) {
      collectingFail = { dir: line.slice('REBUILD_FAIL '.length), stderr: [] };
    } else if (line.startsWith('PRUNE_OK ')) {
      // `PRUNE_OK <m>/<p>/<v> <bytes>` — bytes is the last space-delimited token.
      const rest = line.slice('PRUNE_OK '.length);
      const sp = rest.lastIndexOf(' ');
      if (sp > 0) {
        const dir = rest.slice(0, sp);
        const bytes = Number(rest.slice(sp + 1));
        pruned.push(dir);
        if (Number.isFinite(bytes)) prunedBytes += bytes;
        opts.onProgress?.(`pruning stale plugin cache ${dir}`);
      }
    }
  }
  return { rebuilt, failed, pruned, prunedBytes, skipped: false };
}

export class ClaudeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSessionError';
  }
}

export interface StartClaudeSessionOptions {
  container: string;
  claudeArgs: string[];
  sessionName?: string;
  /** Previously fed into the in-tmux status bar; now unused (the outer UI
   *  shows the name). Kept for back-compat — callers may still pass it. */
  boxName?: string;
}

/**
 * Single-quote a token for /bin/sh. Conservative: anything outside the safe alphabet
 * gets wrapped. We don't try to detect "obviously safe" inputs; quoting is cheap.
 */
function shQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start a detached tmux session running Claude Code inside the container. The session
 * survives client disconnects; reattach via {@link attachClaudeSession}.
 *
 * We forward the host's TERM (default xterm-256color) so the in-container tmux
 * picks the right terminal-overrides at session creation time — without this,
 * docker exec defaults TERM to `xterm` and tmux can't declare 24-bit color.
 *
 * We also re-forward {@link FORWARDED_ENV_KEYS} from the host's process env.
 * Values set at container-create time (via runBox -e) are still inherited
 * for free, but the user might be invoking `agentbox claude start <box>`
 * from a different shell session — e.g. inside their host claude (which sets
 * CLAUDE_EFFORT) for a box created earlier from a plain terminal. Re-passing
 * at exec time lets the in-box claude pick up the host's *current* selection.
 */
export async function startClaudeSession(opts: StartClaudeSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_CLAUDE_SESSION;
  const cmd = ['claude', ...opts.claudeArgs].map(shQuote).join(' ');
  const term = process.env['TERM'] ?? 'xterm-256color';
  const envFlags: string[] = ['-e', `TERM=${term}`];
  for (const k of FORWARDED_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) envFlags.push('-e', `${k}=${v}`);
  }
  const result = await execa(
    'docker',
    [
      'exec',
      ...envFlags,
      '--user',
      CONTAINER_USER,
      opts.container,
      'tmux',
      'new-session',
      '-d',
      '-s',
      sessionName,
      cmd,
      ...buildTmuxSessionArgs(sessionName),
    ],
    { reject: false },
  );
  if (result.exitCode === 0) return;
  const stderr = (result.stderr ?? '').toString();
  if (result.exitCode === 127 || /command not found|tmux: not found/i.test(stderr)) {
    throw new ClaudeSessionError(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/claude.*not found|exec: "claude"/i.test(stderr)) {
    throw new ClaudeSessionError(
      `claude is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/duplicate session/i.test(stderr)) {
    throw new ClaudeSessionError(
      `a tmux session "${sessionName}" already exists in ${opts.container}; use \`agentbox claude attach\` to reattach.`,
    );
  }
  throw new ClaudeSessionError(
    `failed to start claude session in ${opts.container}: ${stderr.trim() || `exit ${String(result.exitCode)}`}`,
  );
}

/**
 * Replace the current process with `docker exec -it tmux attach`. Ctrl+a d returns
 * the user to their host shell with exit 0. We forward TERM so tmux declares
 * the outer terminal's true-color and hyperlink capabilities; without it
 * docker exec sets TERM=xterm and Claude renders without RGB.
 */
/**
 * The `docker` argv that attaches an interactive terminal to a box's Claude
 * tmux session. Shared by {@link attachClaudeSession} (which `spawnSync`s it
 * directly) and the dashboard command (which hands it to `tmux respawn-pane`).
 */
/**
 * Shell snippet (run via `sh -c`) that guarantees TERM resolves inside the box
 * before tmux starts. The box runs Ubuntu, whose terminfo database does not
 * carry every host terminal: notably `xterm-ghostty`, which was added to
 * ncurses after 24.04 shipped. Forwarding such a TERM makes `tmux attach` exit
 * immediately with "missing or unsuitable terminal", which looks like a brief
 * flash and an instant exit. When the box cannot resolve $TERM, fall back to
 * xterm-256color, which the image always provides.
 */
export const TERM_FALLBACK_SNIPPET =
  'if ! infocmp "$TERM" >/dev/null 2>&1; then TERM=xterm-256color; export TERM; fi; ';

/**
 * Build the `docker exec` argv that runs an in-box tmux command under `sh -c`
 * with the TERM guard ({@link TERM_FALLBACK_SNIPPET}) applied first.
 *
 * `tmuxScript` is the tmux command line as it should reach tmux (use `\;` for
 * tmux's own command separator, since a shell now parses it). `positionals` are
 * bound to "$1", "$2", ... inside the script, so session names are passed as
 * args rather than interpolated, keeping names with odd characters safe. The
 * host's TERM is still forwarded via `-e`, so a box that does know it keeps full
 * fidelity; the guard only downgrades the unknown case.
 */
export function buildTermSafeTmuxExec(opts: {
  container: string;
  user: string;
  tmuxScript: string;
  positionals: string[];
}): string[] {
  const term = process.env['TERM'] ?? 'xterm-256color';
  return [
    'exec',
    '-it',
    '-e',
    `TERM=${term}`,
    '--user',
    opts.user,
    opts.container,
    'sh',
    '-c',
    `${TERM_FALLBACK_SNIPPET}${opts.tmuxScript}`,
    'sh',
    ...opts.positionals,
  ];
}

export function buildClaudeAttachArgv(container: string, sessionName?: string): string[] {
  const name = sessionName ?? DEFAULT_CLAUDE_SESSION;
  return buildTermSafeTmuxExec({
    container,
    user: CONTAINER_USER,
    tmuxScript: 'exec tmux attach -t "$1"',
    positionals: [name],
  });
}

/**
 * Like {@link buildClaudeAttachArgv}, but for the dashboard's right pane.
 * Agent-agnostic — `sessionName` selects which agent's tmux session to attach
 * (`claude` / `codex` / `opencode`). The dashboard already draws its own bottom
 * status bar, so a second client must not show the inner tmux status bar. We
 * attach via a *grouped* sibling session (`<name>-dash`, `tmux new-session -t
 * <name>`): grouped sessions share the same windows/panes (identical live
 * screen + scrollback) but keep independent session options, so `status off`
 * here does not affect a direct `agentbox <agent> attach` to `<name>`. The
 * `\;` elements are tmux's command separator, escaped so the wrapping `sh -c`
 * passes them to tmux verbatim instead of treating them as shell separators.
 * `new-session -A -d` is a no-op if the grouped session already exists;
 * `attach` runs after `status off` so the footer is gone on first paint. Runs
 * under the shared TERM guard ({@link buildTermSafeTmuxExec}) for the same
 * reason the direct attach builders do.
 */
export function buildDashboardAttachArgv(
  container: string,
  sessionName?: string,
): string[] {
  const name = sessionName ?? DEFAULT_CLAUDE_SESSION;
  // The grouped sibling session name ("<name>-dash") is derived in-shell from
  // $1, so the session name stays a single positional that sh never re-parses.
  return buildTermSafeTmuxExec({
    container,
    user: CONTAINER_USER,
    tmuxScript:
      'dash="$1-dash"; exec tmux new-session -A -d -s "$dash" -t "$1" \\; set -t "$dash" status off \\; attach -t "$dash"',
    positionals: [name],
  });
}

/**
 * Poll a box's tmux pane until it has rendered non-blank content, or until
 * `timeoutMs` elapses. The dashboard's right-pane terminal emulator can latch
 * blank if it attaches while a heavy agent TUI (notably OpenCode's Bun-based
 * UI) is still initializing — a fresh attach gets tmux's full screen replay,
 * but a mid-init attach can miss it. Waiting for first content means the
 * dashboard attaches in the working (post-draw) condition. Best-effort:
 * returns on timeout regardless so a never-drawing agent never hangs the UI.
 */
export async function waitForTmuxPaneContent(
  container: string,
  sessionName: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await execa(
      'docker',
      ['exec', '--user', CONTAINER_USER, container, 'tmux', 'capture-pane', '-p', '-t', sessionName],
      { reject: false },
    );
    if (res.exitCode === 0 && (res.stdout ?? '').trim().length > 0) return;
    await delay(400);
  }
}

/**
 * The list of tmux subcommands that configure a session: remap the prefix
 * (Ctrl+a primary, Ctrl+b kept as secondary), enable CSI-u extended-key
 * reporting so Claude Code can distinguish Shift+Enter from Enter, and turn
 * the inner tmux status bar off so it doesn't double up with the outer
 * wrapped-pty footer. Single source of truth shared by the docker path
 * (via {@link buildTmuxSessionArgs}, which folds these into execa argv with
 * `;` separators) and the cloud path (via
 * {@link buildTmuxConfigShellSnippet}, which formats them as `tmux …`
 * shell statements for SSH transport).
 *
 * `prefix`/`bind-key` are server-global (no `-t`) — fine because each box
 * runs one tmux server per session role. `status off` is session-scoped
 * with `-t <session>` so the dashboard's grouped sibling session
 * (`<name>-dash`) keeps its own option scope.
 */
function tmuxConfigSubcommands(sessionName: string): readonly (readonly string[])[] {
  return [
    ['set', '-g', 'prefix', 'C-a'],
    ['set', '-g', 'prefix2', 'C-b'],
    ['bind-key', 'C-a', 'send-prefix'],
    ['bind-key', 'C-b', 'send-prefix', '-2'],
    ['bind-key', 'd', 'detach-client'],
    ['set', '-g', 'extended-keys', 'on'],
    ['set', '-as', 'terminal-features', ',*:extkeys'],
    ['set', '-t', sessionName, 'status', 'off'],
  ];
}

/**
 * tmux command-list (separator-prefixed) appended after `tmux new-session …`
 * in {@link startClaudeSession}. The bare `;` elements are tmux's command
 * separator (execa array args, no host shell, so they reach tmux verbatim).
 * See {@link tmuxConfigSubcommands} for the shared subcommand definitions
 * and why each setting is set the way it is.
 */
export function buildTmuxSessionArgs(sessionName: string): string[] {
  const out: string[] = [];
  for (const sub of tmuxConfigSubcommands(sessionName)) {
    out.push(';', ...sub);
  }
  return out;
}

/**
 * Same tmux configuration as {@link buildTmuxSessionArgs}, formatted as a
 * shell snippet (`tmux <args>; tmux <args>; …`) suitable for transports
 * that go through a remote shell — i.e. the cloud providers' `ssh -t`
 * attach in `@agentbox/sandbox-cloud`'s `renderInnerCommand`. The docker
 * path uses execa argv directly and doesn't need this.
 *
 * Each subcommand is its own `tmux` invocation joined with `; ` (shell
 * statement separator), because the in-tmux `;` separator can't pass
 * through `ssh -t '...'` without ambiguity — single-quoted shell args
 * forward `;` to the remote shell, where it would split the command line
 * before reaching tmux. Multiple `tmux` invocations are equivalent
 * (they're all idempotent `set`/`bind-key` operations) and re-applying
 * on every reattach is harmless.
 */
export function buildTmuxConfigShellSnippet(sessionName: string): string {
  return tmuxConfigSubcommands(sessionName)
    .map((sub) => `tmux ${sub.map(shellSingleQuoteIfNeeded).join(' ')}`)
    .join('; ');
}

/**
 * Wrap `s` in POSIX single quotes only if it contains characters that
 * shells (sh/bash/zsh) parse specially. Tmux args like `,*:extkeys` need
 * quoting (the `*` would glob); plain identifiers like `C-a` or `prefix`
 * don't. Keeping the unquoted form when safe makes the generated SSH
 * command easier to read in logs.
 */
function shellSingleQuoteIfNeeded(s: string): string {
  return /^[A-Za-z0-9_:.\/=+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * The `docker` argv for an interactive login shell in a box — the same shape
 * `agentbox shell` uses (vscode user, image WORKDIR `/workspace`, `bash -l`).
 * Handed to node-pty by the dashboard's "open a shell" action.
 */
export function buildShellArgv(container: string): string[] {
  const term = process.env['TERM'] ?? 'xterm-256color';
  return ['exec', '-it', '-e', `TERM=${term}`, '--user', CONTAINER_USER, container, 'bash', '-l'];
}

/**
 * The `docker run` argv for an interactive `claude auth login` in a throwaway
 * container. Mounts the claude-config volume at `~/.claude` so the written
 * credentials persist; runs before any box exists. `extraArgs` are appended
 * verbatim (e.g. `['--claudeai']`, `['--sso']`).
 *
 * `DISPLAY` is blanked: the box image bakes `DISPLAY=:1` (a VNC X server) and
 * `claude auth login` would otherwise try to open a browser on that invisible
 * display. An empty `DISPLAY` forces claude's terminal URL/paste-code flow.
 */
export function buildClaudeLoginRunArgv(opts: {
  volume: string;
  image: string;
  extraArgs: string[];
}): string[] {
  const term = process.env['TERM'] ?? 'xterm-256color';
  return [
    'run',
    '-it',
    '--rm',
    '-e',
    `TERM=${term}`,
    '-e',
    'DISPLAY=',
    '-v',
    `${opts.volume}:${CONTAINER_CLAUDE_DIR}`,
    '--user',
    CONTAINER_USER,
    opts.image,
    'claude',
    'auth',
    'login',
    ...opts.extraArgs,
  ];
}

/**
 * Run an interactive docker argv (from {@link buildClaudeLoginRunArgv}) with
 * the user's terminal attached. Returns the exit code; a null status (killed /
 * failed to spawn) is reported as 1.
 */
export function runInteractiveClaudeLogin(dockerArgv: string[]): { exitCode: number } {
  const child = spawnSync('docker', dockerArgv, { stdio: 'inherit' });
  return { exitCode: child.status ?? 1 };
}

export interface WarmUpClaudeResult {
  /** True once a headless `claude -p` request actually succeeded. */
  warmed: boolean;
  /** How many attempts were made (1 = warm on the first try). */
  attempts: number;
}

/**
 * After a fresh `claude auth login`, the *first* Claude Code inference request
 * on the newly minted Claude.ai subscription token is rejected by the API with
 * `400 role 'system' is not supported on this model` — the account/token needs
 * one inference round-trip to be provisioned. A later process then works
 * (confirmed empirically: the first in-box session 400s, every later
 * box/session on the same credentials succeeds).
 *
 * Absorb that sacrificial request here: run a headless `claude -p` in a
 * throwaway container against the shared volume the login just wrote to,
 * retrying until one request actually succeeds — so the user's real box
 * session is never the first request. `--dangerously-skip-permissions` keeps
 * the headless run from stalling on a trust/permission prompt (this is a
 * throwaway sandbox container; nothing it does is persisted beyond the volume).
 *
 * Best-effort and time-boxed: if it never succeeds we return `warmed: false`
 * and the caller proceeds anyway — the box then behaves exactly as it did
 * before this warm-up existed.
 */
export async function warmUpClaudeCredentials(
  volume: string,
  image: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<WarmUpClaudeResult> {
  const MAX_ATTEMPTS = 6;
  const SLEEP_MS = 5000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    opts.onProgress?.(`checking credentials... ${attempt}/${MAX_ATTEMPTS}`);
    const res = await execa(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${volume}:${CONTAINER_CLAUDE_DIR}`,
        '--user',
        CONTAINER_USER,
        '-e',
        'DISABLE_AUTOUPDATER=1',
        image,
        'claude',
        '--dangerously-skip-permissions',
        '-p',
        'ok',
      ],
      { reject: false, timeout: 60_000 },
    );
    // `claude -p` can exit 0 while printing an API error as the turn's text,
    // so success needs a clean exit AND no error signature in the output.
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const apiError = /API Error|is not supported on this model|"type":\s*"error"/i.test(out);
    if (res.exitCode === 0 && !apiError) return { warmed: true, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) await delay(SLEEP_MS);
  }
  return { warmed: false, attempts: MAX_ATTEMPTS };
}

export function formatDetachNotice(
  ref: string,
  command: 'claude' | 'shell' | 'codex' | 'opencode' = 'claude',
  suffix = '',
): string {
  return `Session detached. Reattach with: agentbox ${command} attach ${ref}${suffix}`;
}

export function attachClaudeSession(
  container: string,
  sessionName?: string,
  reattachRef?: string,
): never {
  const child = spawnSync('docker', buildClaudeAttachArgv(container, sessionName), {
    stdio: 'inherit',
  });
  const code = child.status ?? 0;
  if (reattachRef && code === 0) {
    // Overwrite tmux's own `[detached (from session …)]` line (printed just
    // above the cursor on a clean detach). Best-effort cosmetics: if the
    // terminal ignores the cursor moves, our line still prints below it.
    process.stdout.write('\x1b[1A\x1b[2K\r' + formatDetachNotice(reattachRef) + '\n');
  }
  process.exit(code);
}

export interface ClaudeSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}` format string, or null when not running. */
  startedAt: string | null;
}

/**
 * Best-effort: returns `{ running: false, …, startedAt: null }` for any non-zero exit
 * from `tmux has-session` (which includes "no server running" and "no such session").
 */
export async function claudeSessionInfo(
  container: string,
  sessionName?: string,
): Promise<ClaudeSessionInfo> {
  const name = sessionName ?? DEFAULT_CLAUDE_SESSION;
  const has = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'tmux', 'has-session', '-t', name],
    { reject: false },
  );
  if (has.exitCode !== 0) {
    return { running: false, sessionName: name, startedAt: null };
  }
  const ts = await execa(
    'docker',
    [
      'exec',
      '--user',
      CONTAINER_USER,
      container,
      'tmux',
      'display-message',
      '-p',
      '-t',
      name,
      '#{session_created}',
    ],
    { reject: false },
  );
  let startedAt: string | null = null;
  if (ts.exitCode === 0) {
    const secs = Number.parseInt((ts.stdout ?? '').trim(), 10);
    if (Number.isFinite(secs) && secs > 0) startedAt = new Date(secs * 1000).toISOString();
  }
  return { running: true, sessionName: name, startedAt };
}

export interface PullClaudeResult {
  /**
   * Box-installed extensions not present on the host. `category` is one of
   * skills/agents/commands (then `name` is the dir name) or `plugins` (then
   * `name` is the `<marketplace>/<plugin>` cache key).
   */
  newItems: Array<{ category: string; name: string }>;
  /** Registry JSONs that gained box-only entries (e.g. `known_marketplaces.json`). */
  mergedRegistries: string[];
}

export interface PullClaudeOptions {
  /** Image for the throwaway helper container; use the box's image to avoid extra pulls. */
  image: string;
  /** When true, compute the delta but write nothing. */
  dryRun?: boolean;
}

const PULL_DIR_CATEGORIES = ['skills', 'agents', 'commands'] as const;

/**
 * Immediate child item names of `dir`, or [] if it doesn't exist. Symlinks
 * count: the host's `~/.claude/skills/<name>` is a symlink into `~/.agents`
 * (Claude Code's user-skills convention), so `isDirectory()` alone would miss
 * them and every host skill would look "new".
 */
async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Reverse of {@link ensureClaudeVolume}: pull box-installed Claude extensions
 * (skills/agents/commands dirs + plugins) from the claude-config volume back to
 * the host's `~/.claude`. Additive only — an item already present on the host
 * is never overwritten. The box need not be running; we read the *volume* via a
 * throwaway helper container (the exact mirror of the forward sync), so this
 * also works while the box is stopped.
 *
 * Plugin registry JSONs (`installed_plugins.json`, `known_marketplaces.json`)
 * are merged host-side: only box-only keys are added, with the forward sync's
 * `/home/vscode/.claude/plugins/` rewrite reversed back to the host path.
 */
export async function pullClaudeExtras(
  spec: ClaudeConfigSpec,
  opts: PullClaudeOptions,
): Promise<PullClaudeResult> {
  const hostHome = homedir();
  const hostClaude = join(hostHome, '.claude');

  // Inventory pass: enumerate the volume's contents via a read-only helper
  // container. `--user 0` so root can read files claude wrote as uid 1000.
  // base64 -w0 keeps each registry JSON on one parseable line.
  const inventoryScript = [
    'for cat in skills agents commands; do',
    '  [ -d "/src/$cat" ] || continue;',
    '  for d in "/src/$cat"/*/; do',
    '    [ -d "$d" ] || continue;',
    '    printf "DIR %s %s\\n" "$cat" "$(basename "$d")";',
    '  done;',
    'done;',
    'if [ -d /src/plugins/cache ]; then',
    '  for m in /src/plugins/cache/*/; do',
    '    [ -d "$m" ] || continue;',
    '    for p in "$m"*/; do',
    '      [ -d "$p" ] || continue;',
    '      printf "PLUGIN %s/%s\\n" "$(basename "$m")" "$(basename "$p")";',
    '    done;',
    '  done;',
    'fi;',
    'for f in installed_plugins known_marketplaces; do',
    '  [ -f "/src/plugins/$f.json" ] || continue;',
    '  printf "JSON %s " "$f";',
    '  base64 -w0 "/src/plugins/$f.json";',
    '  printf "\\n";',
    'done',
  ].join(' ');

  const inv = await execa(
    'docker',
    ['run', '--rm', '--user', '0', '-v', `${spec.volume}:/src:ro`, opts.image, 'sh', '-c', inventoryScript],
    { reject: false },
  );
  if (inv.exitCode !== 0) {
    throw new ClaudeSessionError(
      `failed to read claude-config volume ${spec.volume}: ${(inv.stderr ?? '').toString().trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }

  const boxDirs: Record<string, string[]> = { skills: [], agents: [], commands: [] };
  const boxPlugins: string[] = [];
  const boxJson: Record<string, unknown> = {};
  for (const line of (inv.stdout ?? '').split('\n')) {
    if (line.startsWith('DIR ')) {
      const rest = line.slice(4);
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      const cat = rest.slice(0, sp);
      const name = rest.slice(sp + 1);
      if (cat in boxDirs) boxDirs[cat]!.push(name);
    } else if (line.startsWith('PLUGIN ')) {
      boxPlugins.push(line.slice(7));
    } else if (line.startsWith('JSON ')) {
      const rest = line.slice(5);
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      const which = rest.slice(0, sp);
      try {
        boxJson[which] = JSON.parse(Buffer.from(rest.slice(sp + 1), 'base64').toString('utf8'));
      } catch {
        // Leave undefined; the merge helpers tolerate it.
      }
    }
  }

  // Compute deltas host-side (the host ~/.claude is directly accessible —
  // only the volume needed a container).
  const newItems: PullClaudeResult['newItems'] = [];
  const applyPaths: Array<{ src: string; dest: string }> = [];
  for (const cat of PULL_DIR_CATEGORIES) {
    const hostNames = await listChildDirs(join(hostClaude, cat));
    const excludes = cat === 'skills' ? SKILL_EXCLUDE_PREFIXES : [];
    for (const name of pickNewItems(boxDirs[cat] ?? [], hostNames, excludes)) {
      newItems.push({ category: cat, name });
      applyPaths.push({ src: `/src/${cat}/${name}`, dest: `/dst/${cat}/${name}` });
    }
  }
  const hostPluginKeys: string[] = [];
  for (const m of await listChildDirs(join(hostClaude, 'plugins', 'cache'))) {
    for (const p of await listChildDirs(join(hostClaude, 'plugins', 'cache', m))) {
      hostPluginKeys.push(`${m}/${p}`);
    }
  }
  for (const key of pickNewItems(boxPlugins, hostPluginKeys)) {
    newItems.push({ category: 'plugins', name: key });
    applyPaths.push({ src: `/src/plugins/cache/${key}`, dest: `/dst/plugins/cache/${key}` });
  }

  // Additive merge of the two plugin registries (reverses the forward path
  // rewrite). Computed regardless so the preview can report it.
  const hostInstalled = await readJsonFile(join(hostClaude, 'plugins', 'installed_plugins.json'));
  const hostMarkets = await readJsonFile(join(hostClaude, 'plugins', 'known_marketplaces.json'));
  const mergedInstalled = mergeInstalledPlugins(hostInstalled, boxJson['installed_plugins'], {
    hostHome,
  });
  const mergedMarkets = mergeKnownMarketplaces(hostMarkets, boxJson['known_marketplaces'], {
    hostHome,
  });
  const mergedRegistries: string[] = [];
  if (mergedInstalled.changed) mergedRegistries.push('installed_plugins.json');
  if (mergedMarkets.changed) mergedRegistries.push('known_marketplaces.json');

  if (opts.dryRun || (newItems.length === 0 && mergedRegistries.length === 0)) {
    return { newItems, mergedRegistries };
  }

  // Apply pass: rsync each new item dir from the volume into the host
  // ~/.claude bind mount. --ignore-existing is belt-and-suspenders (the
  // host-side delta is the real guard); --exclude=node_modules because the
  // box carries linux/amd64 binaries useless on the darwin host (claude/host
  // rebuilds lazily, same rationale as the forward sync's exclude).
  if (applyPaths.length > 0) {
    const cmds = applyPaths.map(({ src, dest }) => {
      const parent = dest.slice(0, dest.lastIndexOf('/'));
      return `mkdir -p '${parent}' && rsync -a --ignore-existing --exclude=node_modules '${src}/' '${dest}/'`;
    });
    const apply = await execa(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        '0',
        '-v',
        `${spec.volume}:/src:ro`,
        '-v',
        `${hostClaude}:/dst`,
        opts.image,
        'sh',
        '-c',
        cmds.join(' && '),
      ],
      { reject: false },
    );
    if (apply.exitCode !== 0) {
      throw new ClaudeSessionError(
        `failed to copy extensions from ${spec.volume}: ${(apply.stderr ?? '').toString().trim() || `exit ${String(apply.exitCode)}`}`,
      );
    }
  }

  // Registry JSONs are written host-side (host path is directly writable;
  // no container needed) — only when the merge actually added keys.
  if (mergedMarkets.changed || mergedInstalled.changed) {
    await mkdir(join(hostClaude, 'plugins'), { recursive: true });
    if (mergedMarkets.changed) {
      await writeFile(
        join(hostClaude, 'plugins', 'known_marketplaces.json'),
        `${JSON.stringify(mergedMarkets.data, null, 2)}\n`,
      );
    }
    if (mergedInstalled.changed) {
      await writeFile(
        join(hostClaude, 'plugins', 'installed_plugins.json'),
        `${JSON.stringify(mergedInstalled.data, null, 2)}\n`,
      );
    }
  }

  return { newItems, mergedRegistries };
}
