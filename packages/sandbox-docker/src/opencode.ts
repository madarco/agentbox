import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildTmuxSessionArgs, CONTAINER_USER } from './claude.js';
import { ensureVolume, volumeExists } from './docker.js';

/**
 * OpenCode support mirrors the Codex support in `codex.ts`. The one structural
 * difference: OpenCode splits its state across two XDG directories —
 * `~/.config/opencode` (config) and `~/.local/share/opencode` (data + the
 * `auth.json` provider credentials). A single volume holds both: it is mounted
 * at the data dir, and the config dir is relocated into a `config/` subdir of
 * that same volume via the `OPENCODE_CONFIG_DIR` env var (OpenCode-specific, so
 * safe to set box-global — unlike `XDG_DATA_HOME`).
 */
export const SHARED_OPENCODE_VOLUME = 'agentbox-opencode-config';
export const DEFAULT_OPENCODE_SESSION = 'opencode';
/** Volume mount point inside the box — OpenCode's native data dir. */
const CONTAINER_OPENCODE_DIR = '/home/vscode/.local/share/opencode';
/** Relocated config dir (a subdir of the volume); the value of `OPENCODE_CONFIG_DIR`. */
const CONTAINER_OPENCODE_CONFIG_DIR = '/home/vscode/.local/share/opencode/config';
/**
 * Relocated XDG state base (a subdir of the volume); the value of `XDG_STATE_HOME`.
 * OpenCode derives its state dir as `$XDG_STATE_HOME/opencode`, so its state
 * (incl. `model.json` — the last-selected model) lands at
 * `<volume>/.state/opencode` and persists with the volume. OpenCode has no
 * dedicated `OPENCODE_STATE_DIR`, so `XDG_STATE_HOME` is the only knob.
 */
const CONTAINER_OPENCODE_STATE_HOME = '/home/vscode/.local/share/opencode/.state';
/** Image-baked AgentBox OpenCode plugin (copied in from packages/sandbox-docker/scripts/). */
const IN_BOX_OPENCODE_PLUGIN_PATH = '/usr/local/share/agentbox/opencode-agentbox-plugin.js';

export interface OpencodeConfigSpec {
  /** Resolved Docker volume name mounted at the OpenCode data dir. */
  volume: string;
}

export function resolveOpencodeVolume(opts: {
  isolate: boolean;
  boxId: string;
}): OpencodeConfigSpec {
  if (opts.isolate) {
    return { volume: `${SHARED_OPENCODE_VOLUME}-${opts.boxId}` };
  }
  return { volume: SHARED_OPENCODE_VOLUME };
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
 * Single-quote a token for /bin/sh. Conservative: anything outside the safe
 * alphabet gets wrapped. Mirrors the helper in codex.ts.
 */
function shQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface EnsureOpencodeVolumeOptions {
  /**
   * When true and the host has OpenCode dirs, rsync host -> volume on every
   * call. Additive (no `--delete`): host files win on overlap, box-only files
   * (e.g. an `auth.json` written by an in-box `opencode auth login`) are kept.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container (the box image). */
  image: string;
}

export interface EnsureOpencodeVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper ran (syncFromHost was true AND a host dir existed). */
  synced: boolean;
}

/**
 * Ensure the opencode-config volume exists, then (when {@link
 * EnsureOpencodeVolumeOptions.syncFromHost} is true and the host has OpenCode
 * state) rsync host -> volume via a throwaway helper container. The host is
 * authoritative — same model as the claude/codex volumes.
 *
 * Three host sources land in the one volume: `~/.local/share/opencode` -> volume
 * root (the data dir, holds `auth.json`), `~/.config/opencode` -> volume
 * `config/` (the relocated config dir), and `~/.local/state/opencode` ->
 * volume `.state/opencode` (the relocated state dir, holds `model.json` — the
 * last-selected model, matched by `XDG_STATE_HOME` in {@link buildOpencodeMounts}).
 * The data sync excludes the SQLite session storage / logs (`storage`, `log`,
 * `project`, `cache`, `bin`) — large, box-irrelevant, and host binaries don't run
 * on linux. The state sync is newest-wins (`--update`) since the model is two-way.
 *
 * When there is nothing to sync the volume root is still `chown`ed to uid 1000
 * so a throwaway `opencode auth login` container can write into it.
 */
export async function ensureOpencodeVolume(
  spec: OpencodeConfigSpec,
  opts: EnsureOpencodeVolumeOptions,
): Promise<EnsureOpencodeVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  const hostData = join(homedir(), '.local', 'share', 'opencode');
  const hostConfig = join(homedir(), '.config', 'opencode');
  const hostState = join(homedir(), '.local', 'state', 'opencode');
  const hasData = await pathExists(hostData);
  const hasConfig = await pathExists(hostConfig);
  const hasState = await pathExists(hostState);
  const willSync = opts.syncFromHost && (hasData || hasConfig || hasState);

  if (willSync) {
    const args = ['run', '--rm', '--user', '0', '-v', `${spec.volume}:/dst`];
    if (hasData) args.push('-v', `${hostData}:/src-data:ro`);
    if (hasConfig) args.push('-v', `${hostConfig}:/src-config:ro`);
    if (hasState) args.push('-v', `${hostState}:/src-state:ro`);
    const steps: string[] = [];
    if (hasData) {
      // Exclude the SQLite session store (`opencode.db*`), logs, cloned repos
      // and host binaries — large / box-irrelevant. `auth.json` (when present)
      // and small json carry over.
      steps.push(
        'rsync -a --exclude=storage --exclude=log --exclude=project --exclude=cache' +
          ' --exclude=bin --exclude=repos --exclude=config' +
          ' --exclude=opencode.db --exclude=opencode.db-shm --exclude=opencode.db-wal' +
          ' /src-data/ /dst/',
      );
    }
    if (hasConfig) {
      steps.push('mkdir -p /dst/config && rsync -a /src-config/ /dst/config/');
    }
    if (hasState) {
      // The selected model (`model.json`) is two-way state, not host-authoritative
      // config: `--update` (newest-wins) keeps a stale host file from clobbering a
      // model picked inside the box (which persists in this volume). `locks` is a
      // runtime lock dir — host-local, never synced.
      steps.push(
        'mkdir -p /dst/.state/opencode &&' +
          ' rsync -a --update --exclude=locks /src-state/ /dst/.state/opencode/',
      );
    }
    steps.push('chown -R 1000:1000 /dst');
    args.push(opts.image, 'sh', '-c', steps.join(' && '));
    await execa('docker', args);
    return { created, synced: true };
  }

  // No host OpenCode state to sync — still make the (possibly freshly created,
  // root-owned) volume root writable by the in-box `vscode` user.
  await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      opts.image,
      'sh',
      '-c',
      'chown 1000:1000 /dst',
    ],
    { reject: false },
  );
  return { created, synced: false };
}

/**
 * Seed the AgentBox state-reporting plugin into the OpenCode config volume
 * from the image-baked copy ({@link IN_BOX_OPENCODE_PLUGIN_PATH}) as
 * `<volume>/config/plugins/agentbox-state.js`. OpenCode auto-loads any
 * JS/TS file under `$OPENCODE_CONFIG_DIR/plugins/` at startup; the plugin
 * subscribes to OpenCode's event bus and shells `agentbox-ctl opencode-state`
 * for each lifecycle transition.
 *
 * Re-seeded on every create/start (image-versioned) so an image upgrade
 * propagates. Best-effort — a failure must not fail box creation.
 */
export async function seedOpencodePlugin(
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
      `{ [ -f ${IN_BOX_OPENCODE_PLUGIN_PATH} ] && mkdir -p /dst/config/plugins && ` +
        `cp -a ${IN_BOX_OPENCODE_PLUGIN_PATH} /dst/config/plugins/agentbox-state.js && ` +
        `chown -R 1000:1000 /dst/config/plugins && echo SEEDED; } || true`,
    ]);
    return { seeded: stdout.includes('SEEDED') };
  } catch {
    return { seeded: false };
  }
}

export interface OpencodeMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /**
   * Env vars for the container: the fixed `OPENCODE_CONFIG_DIR` (relocates the
   * config dir into the volume) plus any forwarded provider keys set on the host.
   */
  env: Record<string, string>;
  volumeName: string;
}

// Provider API keys forwarded from the host's `process.env` into the box.
// OpenCode's primary auth is the synced `auth.json`; these are a fallback /
// supplement (OpenCode "loads keys from environment variables at startup").
// Both Google key names are forwarded: `opencode auth list` recognizes
// `GEMINI_API_KEY`, but the underlying provider SDK reads
// `GOOGLE_GENERATIVE_AI_API_KEY` at request time.
export const OPENCODE_FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
] as const;

export function buildOpencodeMounts(
  spec: OpencodeConfigSpec,
  hostEnv: NodeJS.ProcessEnv,
): OpencodeMountResult {
  // OPENCODE_CONFIG_DIR is a fixed box-internal path (relocates the config dir
  // into the volume). It is OpenCode-specific, so setting it box-global is
  // safe — unlike XDG_DATA_HOME, which would move every app's data dir.
  // XDG_STATE_HOME relocates OpenCode's state dir (model.json etc.) into the
  // volume too; it is generic, but the only state we read back is the
  // `opencode/` subdir, so other tools' state landing there is harmless.
  const env: Record<string, string> = {
    OPENCODE_CONFIG_DIR: CONTAINER_OPENCODE_CONFIG_DIR,
    XDG_STATE_HOME: CONTAINER_OPENCODE_STATE_HOME,
  };
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_OPENCODE_DIR}`],
    env,
    volumeName: spec.volume,
  };
}

export class OpencodeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeSessionError';
  }
}

export interface EnsureOpencodeInstalledResult {
  /**
   * True when opencode had to be installed just now — i.e. it was absent from
   * the box image. Happens for boxes created from a checkpoint image captured
   * before OpenCode support, or from an older base image.
   */
  installed: boolean;
}

/**
 * Make sure the `opencode` binary is on PATH inside the box. OpenCode is baked
 * into the current base image, but a box created from a checkpoint image (a
 * frozen snapshot) captured before OpenCode support — or from an older base
 * image — won't have it. In that case we `npm install -g opencode-ai` into the
 * box's writable layer (persists across stop/start, wiped on destroy), mirroring
 * how `--with-playwright` installs at create time.
 *
 * Fast no-op (one `command -v`) when opencode is already present. Throws
 * {@link OpencodeSessionError} when opencode is absent *and* the install fails.
 */
export async function ensureOpencodeInstalled(
  container: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<EnsureOpencodeInstalledResult> {
  const probe = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'sh', '-c', 'command -v opencode'],
    { reject: false },
  );
  if (probe.exitCode === 0) return { installed: false };

  opts.onProgress?.('installing opencode (absent from this box image)');
  const install = await execa(
    'docker',
    ['exec', '--user', 'root', container, 'bash', '-lc', 'npm install -g opencode-ai 2>&1'],
    { reject: false },
  );
  if (install.exitCode !== 0) {
    throw new OpencodeSessionError(
      `opencode is not in this box's image and \`npm install -g opencode-ai\` failed ` +
        `(exit ${String(install.exitCode)}). This box was likely created from a ` +
        `checkpoint captured before OpenCode support — recapture the project checkpoint ` +
        `from a fresh box. Install output:\n${(install.stdout ?? '').toString().slice(-600)}`,
    );
  }
  return { installed: true };
}

export interface StartOpencodeSessionOptions {
  container: string;
  opencodeArgs: string[];
  sessionName?: string;
}

/**
 * Start a detached tmux session running the OpenCode TUI inside the container.
 * Survives client disconnects; reattach via {@link buildOpencodeAttachArgv}. The
 * shared {@link buildTmuxSessionArgs} remaps the prefix and hides the inner
 * status bar, exactly as for the claude/codex sessions.
 *
 * `OPENCODE_CONFIG_DIR` is already in the container env (set at `docker run -e`
 * by {@link buildOpencodeMounts}), so `docker exec` inherits it — only the
 * host-forwarded provider keys are re-passed here to pick up the host shell's
 * current values.
 */
export async function startOpencodeSession(opts: StartOpencodeSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_OPENCODE_SESSION;
  const cmd = ['opencode', ...opts.opencodeArgs].map(shQuote).join(' ');
  const term = process.env['TERM'] ?? 'xterm-256color';
  const envFlags: string[] = ['-e', `TERM=${term}`];
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
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
    throw new OpencodeSessionError(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/opencode.*not found|exec: "opencode"/i.test(stderr)) {
    throw new OpencodeSessionError(
      `opencode is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/duplicate session/i.test(stderr)) {
    throw new OpencodeSessionError(
      `a tmux session "${sessionName}" already exists in ${opts.container}; use \`agentbox opencode attach\` to reattach.`,
    );
  }
  throw new OpencodeSessionError(
    `failed to start opencode session in ${opts.container}: ${stderr.trim() || `exit ${String(result.exitCode)}`}`,
  );
}

/**
 * The `docker` argv that attaches an interactive terminal to a box's OpenCode
 * tmux session. Mirrors {@link import('./codex.js').buildCodexAttachArgv}.
 */
export function buildOpencodeAttachArgv(container: string, sessionName?: string): string[] {
  const name = sessionName ?? DEFAULT_OPENCODE_SESSION;
  const term = process.env['TERM'] ?? 'xterm-256color';
  return [
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
  ];
}

/**
 * The `docker run` argv for an interactive `opencode auth login` in a throwaway
 * container. Mounts the opencode-config volume so the written `auth.json`
 * persists, and sets `OPENCODE_CONFIG_DIR` so config writes land in the volume
 * too. `opencode auth login` is interactive (provider picker); `extraArgs` are
 * appended verbatim (e.g. `['--provider', 'anthropic']`).
 *
 * `DISPLAY` is blanked for the same reason as the claude/codex login: the image
 * bakes `DISPLAY=:1` (a VNC X server) and opencode must not try to open a
 * browser there — forcing the terminal URL/paste-code flow.
 */
export function buildOpencodeLoginRunArgv(opts: {
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
    '-e',
    `OPENCODE_CONFIG_DIR=${CONTAINER_OPENCODE_CONFIG_DIR}`,
    '-e',
    `XDG_STATE_HOME=${CONTAINER_OPENCODE_STATE_HOME}`,
    '-v',
    `${opts.volume}:${CONTAINER_OPENCODE_DIR}`,
    '--user',
    CONTAINER_USER,
    opts.image,
    'opencode',
    'auth',
    'login',
    ...opts.extraArgs,
  ];
}

/**
 * Run an interactive docker argv (from {@link buildOpencodeLoginRunArgv}) with
 * the user's terminal attached. Returns the exit code; a null status is
 * reported as 1.
 */
export function runInteractiveOpencodeLogin(dockerArgv: string[]): { exitCode: number } {
  const child = spawnSync('docker', dockerArgv, { stdio: 'inherit' });
  return { exitCode: child.status ?? 1 };
}

/**
 * True when the opencode-config volume already holds an `auth.json` (at the
 * data-dir root). Used to skip the first-run sign-in offer when an earlier box
 * / `agentbox opencode login` already authenticated.
 */
export async function volumeHasOpencodeAuth(volume: string, image: string): Promise<boolean> {
  const res = await execa(
    'docker',
    ['run', '--rm', '-v', `${volume}:/dst`, image, 'sh', '-c', 'test -e /dst/auth.json'],
    { reject: false },
  );
  return res.exitCode === 0;
}

export interface OpencodeSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

/**
 * Best-effort: returns `{ running: false, …, startedAt: null }` for any
 * non-zero exit from `tmux has-session`. Mirrors `codexSessionInfo`.
 */
export async function opencodeSessionInfo(
  container: string,
  sessionName?: string,
): Promise<OpencodeSessionInfo> {
  const name = sessionName ?? DEFAULT_OPENCODE_SESSION;
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

export interface PullOpencodeResult {
  /** Volume items copied to the host (or, in dry-run, that would be copied). */
  newItems: string[];
}

export interface PullOpencodeOptions {
  /** Image for the throwaway helper container; use the box's image. */
  image: string;
  /** When true, compute the delta but write nothing. */
  dryRun?: boolean;
}

/** Data-dir items (volume root -> host ~/.local/share/opencode). */
const OPENCODE_PULL_DATA_ITEMS = ['auth.json'] as const;
/**
 * Config-dir items (volume `config/` -> host ~/.config/opencode). Covers both
 * the `.json` and `.jsonc` global config and OpenCode's user-extension subdirs.
 */
const OPENCODE_PULL_CONFIG_ITEMS = [
  'opencode.json',
  'opencode.jsonc',
  'agents',
  'commands',
  'modes',
  'plugins',
  'skills',
  'tools',
  'themes',
] as const;

/**
 * Reverse of {@link ensureOpencodeVolume}: pull box-side OpenCode config/auth
 * from the volume back to the host. Additive only — an item already present on
 * the host is never overwritten. The box need not be running (we read the
 * *volume* via a throwaway helper container). `auth.json` lands in the host's
 * `~/.local/share/opencode`; config items in `~/.config/opencode`.
 */
export async function pullOpencodeConfig(
  spec: OpencodeConfigSpec,
  opts: PullOpencodeOptions,
): Promise<PullOpencodeResult> {
  const hostData = join(homedir(), '.local', 'share', 'opencode');
  const hostConfig = join(homedir(), '.config', 'opencode');

  // Inventory: data items at the volume root, config items under `config/`.
  const inv = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/src:ro`,
      opts.image,
      'sh',
      '-c',
      `for f in ${OPENCODE_PULL_DATA_ITEMS.join(' ')}; do [ -e "/src/$f" ] && echo "data $f"; done;` +
        ` for f in ${OPENCODE_PULL_CONFIG_ITEMS.join(' ')}; do [ -e "/src/config/$f" ] && echo "config $f"; done;` +
        ' true',
    ],
    { reject: false },
  );
  if (inv.exitCode !== 0) {
    throw new OpencodeSessionError(
      `failed to read opencode-config volume ${spec.volume}: ${(inv.stderr ?? '').toString().trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }

  // Volume items not already on the host (additive — never overwrite).
  const newItems: Array<{ label: string; src: string; hostDst: 'data' | 'config'; name: string }> =
    [];
  for (const line of (inv.stdout ?? '').split('\n')) {
    const [group, name] = line.trim().split(/\s+/, 2);
    if (!name || (group !== 'data' && group !== 'config')) continue;
    const hostBase = group === 'data' ? hostData : hostConfig;
    if (await pathExists(join(hostBase, name))) continue;
    newItems.push({
      label: group === 'data' ? name : `config/${name}`,
      src: group === 'data' ? `/src/${name}` : `/src/config/${name}`,
      hostDst: group,
      name,
    });
  }

  if (opts.dryRun || newItems.length === 0) {
    return { newItems: newItems.map((i) => i.label) };
  }

  // Copy each new item from the volume into the matching host dir. `--user 0`
  // so root can read uid-1000 files; chown the result back to the host user.
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const cmds = newItems.map(
    (i) => `cp -a '${i.src}' '${i.hostDst === 'data' ? '/dst-data' : '/dst-config'}/${i.name}'`,
  );
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
      `${hostData}:/dst-data`,
      '-v',
      `${hostConfig}:/dst-config`,
      opts.image,
      'sh',
      '-c',
      `mkdir -p /dst-data /dst-config && ${cmds.join(' && ')}` +
        ` && chown -R ${String(uid)}:${String(gid)} /dst-data /dst-config`,
    ],
    { reject: false },
  );
  if (apply.exitCode !== 0) {
    throw new OpencodeSessionError(
      `failed to copy opencode config from ${spec.volume}: ${(apply.stderr ?? '').toString().trim() || `exit ${String(apply.exitCode)}`}`,
    );
  }
  return { newItems: newItems.map((i) => i.label) };
}
