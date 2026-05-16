import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { addProjectAlias, clearInstallMethod, filterHostHooks } from './claude-hooks-filter.js';
import {
  mergeInstalledPlugins,
  mergeKnownMarketplaces,
  pickNewItems,
  SKILL_EXCLUDE_PREFIXES,
} from './claude-pull.js';
import { ensureVolume, volumeExists } from './docker.js';
import { detectEngine, orbstackVolumePath } from './host-export.js';

export const SHARED_CLAUDE_VOLUME = 'agentbox-claude-config';
export const DEFAULT_CLAUDE_SESSION = 'claude';
const CONTAINER_CLAUDE_DIR = '/home/vscode/.claude';
const CONTAINER_USER = 'vscode';
/** Workspace is always mounted here inside the box, regardless of host path. */
const CONTAINER_WORKSPACE = '/workspace';

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
   * True when the synced `_claude.json` had its top-level `installMethod`
   * field scrubbed (host had it set; we let in-box claude redetect).
   */
  clearedInstallMethod?: boolean;
  /**
   * True when `projects[<hostWorkspace>]` was duplicated to
   * `projects['/workspace']` in the synced `_claude.json` so the in-box claude
   * sees the host's project-scoped state (mcpServers, history, …).
   */
  aliasedProjectKey?: boolean;
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
 * Walk `root` and return rsync-style relative paths of every symlink whose
 * target doesn't resolve. We pass these to rsync as `--exclude` patterns so
 * the broken-symlink set (e.g. claude's `debug/latest` once an older debug
 * file is reaped) doesn't abort the whole sync under `--copy-unsafe-links`.
 *
 * Crosses into subdirs; doesn't follow symlinks (the whole point is to test
 * them rather than traverse them).
 */
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
  if (hasJson) args.push('-v', `${hostClaudeJson}:/src-claude-json:ro`);
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
  let clearedInstallMethod = false;
  let aliasedProjectKey = false;
  try {
    const settingsResult = await maybeFilterTo(
      join(hostClaude, 'settings.json'),
      join(filterDir, 'settings.json'),
      hostHome,
    );
    filteredHookCount += settingsResult.removedHooks;
    if (hasJson) {
      const jsonResult = await maybeFilterTo(
        hostClaudeJson,
        join(filterDir, '_claude.json'),
        hostHome,
        {
          clearInstallMethod: true,
          aliasProject: opts.hostWorkspace
            ? { from: opts.hostWorkspace, to: CONTAINER_WORKSPACE }
            : undefined,
        },
      );
      filteredHookCount += jsonResult.removedHooks;
      clearedInstallMethod = jsonResult.clearedInstallMethod;
      aliasedProjectKey = jsonResult.aliasedProjectKey;
    }
    if (filteredHookCount > 0 || clearedInstallMethod || aliasedProjectKey) {
      args.push('-v', `${filterDir}:/src-filter:ro`);
    }
    // Pre-scan for broken symlinks. With --copy-unsafe-links rsync errors out
    // and exits 23 when any unsafe symlink's referent is missing — e.g.
    // `~/.claude/debug/latest` regularly points to a debug file that's been
    // reaped. We can't predict every such case, so we walk once and tell
    // rsync to skip exactly those entries.
    const brokenSymlinks = await findBrokenSymlinks(hostClaude);
    const rsyncExcludes = ['--exclude=node_modules'];
    for (const rel of brokenSymlinks) rsyncExcludes.push(`--exclude=/${rel}`);
    const rsyncFlags = `-a --copy-unsafe-links ${rsyncExcludes.join(' ')}`;
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
        ' && chown -R 1000:1000 /dst',
    );
    await execa('docker', args);
  } finally {
    await rm(filterDir, { recursive: true, force: true });
  }

  return { created, synced: true, filteredHookCount, clearedInstallMethod, aliasedProjectKey };
}

/**
 * Read a JSON file, run it through {@link filterHostHooks}, (when opted in)
 * {@link clearInstallMethod}, and (when opted in) {@link addProjectAlias},
 * and write the result to `dest` ONLY when at least one change was made.
 * Tolerant of missing or garbage JSON — silently returns zero changes in
 * those cases (sync proceeds with the raw rsync'd file).
 */
async function maybeFilterTo(
  src: string,
  dest: string,
  hostHome: string,
  opts: {
    clearInstallMethod?: boolean;
    aliasProject?: { from: string; to: string };
  } = {},
): Promise<{
  removedHooks: number;
  clearedInstallMethod: boolean;
  aliasedProjectKey: boolean;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(src, 'utf8'));
  } catch {
    return { removedHooks: 0, clearedInstallMethod: false, aliasedProjectKey: false };
  }
  const filtered = filterHostHooks(parsed, hostHome);
  let working: unknown = filtered.data;
  let cleared = false;
  if (opts.clearInstallMethod) {
    const r = clearInstallMethod(working);
    working = r.data;
    cleared = r.cleared;
  }
  let aliased = false;
  if (opts.aliasProject) {
    const r = addProjectAlias(working, opts.aliasProject.from, opts.aliasProject.to);
    working = r.data;
    aliased = r.aliased;
  }
  if (filtered.removedCommands.length === 0 && !cleared && !aliased) {
    return { removedHooks: 0, clearedInstallMethod: false, aliasedProjectKey: false };
  }
  await writeFile(dest, JSON.stringify(working, null, 2));
  return {
    removedHooks: filtered.removedCommands.length,
    clearedInstallMethod: cleared,
    aliasedProjectKey: aliased,
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
const FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_EFFORT',
  'ANTHROPIC_MODEL',
] as const;

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
   * True when the in-box exec was skipped entirely because a host-side scan
   * proved every package.json-bearing plugin already carries its install
   * marker. Only possible when the volume is host-visible (OrbStack).
   */
  skipped: boolean;
}

/** Per-plugin sentinel written inside the cache dir after a successful install. */
const PLUGIN_INSTALLED_MARKER = '.agentbox-installed';

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
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
 * Pure host-side scan of a plugin `cache/<m>/<p>/<v>/` tree. Returns true iff
 * at least one version dir has a `package.json` but no install marker — i.e.
 * the in-box rebuild would actually do npm work. A missing/empty cache root
 * means nothing to do (false). Mirrors the in-box script's accept/skip rules
 * (`packages/sandbox-docker/src/claude.ts` rebuild script) so the host
 * pre-check and the container never disagree.
 */
export async function scanPluginCacheForRebuild(cacheRoot: string): Promise<boolean> {
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
        const vPath = join(pPath, v.name);
        if (!(await isFile(join(vPath, 'package.json')))) continue;
        if (await isFile(join(vPath, PLUGIN_INSTALLED_MARKER))) continue;
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
 * `npm install` (or `npm ci` when a lockfile is present) for any plugin
 * whose `package.json` exists but `node_modules` is missing. Idempotent —
 * subsequent calls are no-ops once node_modules exists.
 *
 * This exists because the host→volume rsync excludes `node_modules` (host
 * darwin-arm64 native binaries like fsevents.node / @esbuild/darwin-arm64
 * are useless on the linux/amd64 box). The first claude session in a fresh
 * box pays the install cost; subsequent attaches don't.
 *
 * Failures on individual plugins are reported but don't throw — most
 * plugins still load with a partial dependency graph, and we prefer
 * launching claude over blocking on a third-party plugin's install hiccup.
 */
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
      return { rebuilt: [], failed: [], skipped: true };
    }
  }
  // Marker (not node_modules) gates re-runs: some plugins have empty
  // dependency lists, so npm install completes successfully without
  // creating node_modules — checking only the directory would loop.
  const script = `set -u
PLUGINS_DIR=/home/vscode/.claude/plugins/cache
MARKER=.agentbox-installed
if [ ! -d "$PLUGINS_DIR" ]; then exit 0; fi
for dir in "$PLUGINS_DIR"/*/*/*/; do
  [ -d "$dir" ] || continue
  [ -f "$dir/package.json" ] || continue
  [ -f "$dir/$MARKER" ] && continue
  rel="\${dir#$PLUGINS_DIR/}"
  echo "REBUILD_START $rel"
  if (cd "$dir" && \\
      if [ -f package-lock.json ]; then \\
        npm ci --no-audit --no-fund --silent; \\
      else \\
        npm install --no-audit --no-fund --silent --no-package-lock; \\
      fi) 2>/tmp/agentbox-npm.err; then
    touch "$dir/$MARKER"
    echo "REBUILD_OK $rel"
  else
    echo "REBUILD_FAIL $rel"
    sed 's/^/  /' /tmp/agentbox-npm.err
    echo "REBUILD_FAIL_END"
  fi
done
`;
  const result = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'sh', '-c', script],
    { reject: false },
  );
  const rebuilt: string[] = [];
  const failed: Array<{ dir: string; stderr: string }> = [];
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
    }
  }
  return { rebuilt, failed, skipped: false };
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
 * Replace the current process with `docker exec -it tmux attach`. Ctrl-b d returns
 * the user to their host shell with exit 0. We forward TERM so tmux declares
 * the outer terminal's true-color and hyperlink capabilities; without it
 * docker exec sets TERM=xterm and Claude renders without RGB.
 */
export function attachClaudeSession(container: string, sessionName?: string): never {
  const name = sessionName ?? DEFAULT_CLAUDE_SESSION;
  const term = process.env['TERM'] ?? 'xterm-256color';
  const child = spawnSync(
    'docker',
    [
      'exec',
      '-it',
      '-e',
      `TERM=${term}`,
      '--user',
      CONTAINER_USER,
      container,
      'tmux',
      'attach',
      '-t',
      name,
    ],
    { stdio: 'inherit' },
  );
  process.exit(child.status ?? 0);
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
