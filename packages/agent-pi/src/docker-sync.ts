/**
 * Pi's docker behavior.
 *
 * Simpler than OpenCode's in one structural way: Pi keeps everything under a
 * SINGLE root (`~/.pi/agent`), so one volume mounted at that path is the whole
 * layout — no relocated XDG dirs, no `*_CONFIG_DIR` env to set. Every path,
 * exclude and env value below is read from the registry row rather than
 * restated; that is what keeps this in step with the cloud stager.
 */

import { agentPushExcludes } from '@agentbox/core';
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  buildTermSafeTmuxExec,
  buildTmuxSessionArgs,
  CONTAINER_USER,
  createDockerSyncTransport,
  ensureVolume,
  volumeExists,
} from '@agentbox/sandbox-docker';
import { AgentInstallError, ensureAgentInstalled, resolveAgentSpec } from '@agentbox/sandbox-core';

const PI_SPEC = resolveAgentSpec('pi');

/** The shared pi-config volume, from the registry — never a second literal. */
export const SHARED_PI_VOLUME = PI_SPEC.dockerVolume;
export const DEFAULT_PI_SESSION = PI_SPEC.sessionName;
/** Volume mount point inside the box — Pi's own config root. */
const CONTAINER_PI_DIR = PI_SPEC.staticPaths[0]!.boxDir;
/** Host source for the push, from the same registry entry. */
const HOST_PI_DIR = join(homedir(), ...PI_SPEC.staticPaths[0]!.hostHomeRel);
/** `PI_SKIP_VERSION_CHECK` and friends, as declared. */
const PI_BOX_RUN_ENV = PI_SPEC.boxRunEnv;

/**
 * Provider API keys forwarded from the host's `process.env` into the box.
 *
 * Pi resolves a key as `--api-key` -> `auth.json` -> environment -> a custom
 * provider entry, so these are a real fallback for a host that authenticates by
 * env rather than by logging in.
 */
export const PI_FORWARDED_ENV_KEYS = PI_SPEC.forwardedEnvKeys;

/**
 * `--exclude` flags for the config tree, rendered from the registry.
 *
 * `'volume'`, not `'snapshot'`: this volume IS the box's credential store, so
 * `auth.json` must land in it. The vendored `fd`/`rg` under `bin/` are dropped
 * by the spec's own list — they are host-native binaries.
 */
function configVolumeExcludeFlags(): string {
  const path = PI_SPEC.staticPaths[0];
  const derived = path ? agentPushExcludes(PI_SPEC, path, 'volume') : [];
  return derived.map((p) => `--exclude=${p}`).join(' ');
}

export interface PiConfigSpec {
  /** Resolved Docker volume name mounted at Pi's config root. */
  volume: string;
}

export function resolvePiVolume(opts: { isolate: boolean; boxId: string }): PiConfigSpec {
  return { volume: opts.isolate ? `${SHARED_PI_VOLUME}-${opts.boxId}` : SHARED_PI_VOLUME };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Single-quote a token for /bin/sh. Mirrors the helper in the other agents. */
function shQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface EnsurePiVolumeOptions {
  /**
   * When true and the host has a `~/.pi/agent`, rsync host -> volume on every
   * call. Additive (no `--delete`): host files win on overlap, box-only files
   * (an `auth.json` written by an in-box `/login`) are kept.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container (the box image). */
  image: string;
}

export interface EnsurePiVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper ran (syncFromHost AND a host dir existed). */
  synced: boolean;
}

/**
 * Ensure the pi-config volume exists, then (when `syncFromHost` and the host has
 * Pi state) rsync host -> volume via a throwaway helper. The host is
 * authoritative — same model as the claude/codex/opencode volumes.
 *
 * When there is nothing to sync the volume root is still chowned so a throwaway
 * login container can write into it: a freshly created docker volume is
 * root-owned and the box runs as `vscode`.
 */
export async function ensurePiVolume(
  spec: PiConfigSpec,
  opts: EnsurePiVolumeOptions,
): Promise<EnsurePiVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  // `vscode` by NAME, not uid 1000: the uid differs per provider and the helper
  // resolves the name from the box image's own passwd.
  const chown = `chown -R ${CONTAINER_USER}:${CONTAINER_USER} /dst`;

  if (opts.syncFromHost && (await pathExists(HOST_PI_DIR))) {
    await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      '-v',
      `${HOST_PI_DIR}:/src:ro`,
      opts.image,
      'sh',
      '-c',
      `rsync -a ${configVolumeExcludeFlags()} /src/ /dst/ && ${chown}`,
    ]);
    return { created, synced: true };
  }

  await execa(
    'docker',
    ['run', '--rm', '--user', '0', '-v', `${spec.volume}:/dst`, opts.image, 'sh', '-c', chown],
    { reject: false },
  );
  return { created, synced: false };
}

export interface PiMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /** The declared `boxRunEnv` plus any forwarded provider keys set on the host. */
  env: Record<string, string>;
  volumeName: string;
}

export function buildPiMounts(spec: PiConfigSpec, hostEnv: NodeJS.ProcessEnv): PiMountResult {
  const env: Record<string, string> = { ...PI_BOX_RUN_ENV };
  for (const k of PI_FORWARDED_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_PI_DIR}`],
    env,
    volumeName: spec.volume,
  };
}

export class PiSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSessionError';
  }
}

export interface EnsurePiInstalledResult {
  /** True when `pi` had to be installed just now — i.e. absent from the image. */
  installed: boolean;
}

/**
 * Make sure the `pi` binary is on PATH inside the box, installing it from the
 * registry's recipe if not. Fast no-op (one `command -v`) when already present.
 */
export async function ensurePiInstalled(
  container: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<EnsurePiInstalledResult> {
  try {
    return await ensureAgentInstalled(createDockerSyncTransport({ container }), 'pi', opts);
  } catch (err) {
    if (err instanceof AgentInstallError) throw new PiSessionError(err.message);
    throw err;
  }
}

export interface StartPiSessionOptions {
  container: string;
  piArgs: string[];
  sessionName?: string;
}

/**
 * Start a detached tmux session running the Pi TUI inside the container.
 *
 * `launchFlags` (`-a`) are prepended HERE, from the registry row.
 *
 * There is no shared docker launch path that applies them: the generic one
 * lives in `sandbox-cloud`'s `detached-agent.ts` and covers the CLOUD
 * providers only, so on docker each agent's own starter must do it (codex's
 * does, for its hook-trust flags). Omitting them made `agentbox pi` on docker
 * launch bare, so a repo carrying a `.pi/` dir blocked on Pi's project-trust
 * prompt -- which nothing on the host can answer.
 */
export async function startPiSession(opts: StartPiSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_PI_SESSION;
  const flags = PI_SPEC.launchFlags ?? [];
  const cmd = [PI_SPEC.binary, ...flags, ...opts.piArgs].map(shQuote).join(' ');
  const term = process.env['TERM'] ?? 'xterm-256color';
  const envFlags: string[] = ['-e', `TERM=${term}`];
  for (const [k, v] of Object.entries(PI_BOX_RUN_ENV)) envFlags.push('-e', `${k}=${v}`);
  for (const k of PI_FORWARDED_ENV_KEYS) {
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
    throw new PiSessionError(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/duplicate session/i.test(stderr)) {
    throw new PiSessionError(
      `a tmux session "${sessionName}" already exists in ${opts.container}; use \`agentbox pi attach\` to reattach.`,
    );
  }
  throw new PiSessionError(
    `failed to start pi session in ${opts.container}: ${stderr.trim() || `exit ${String(result.exitCode)}`}`,
  );
}

/** The `docker` argv that attaches an interactive terminal to Pi's session. */
export function buildPiAttachArgv(container: string, sessionName?: string): string[] {
  return buildTermSafeTmuxExec({
    container,
    user: CONTAINER_USER,
    tmuxScript: 'exec tmux attach -t "$1"',
    positionals: [sessionName ?? DEFAULT_PI_SESSION],
  });
}

/**
 * The `docker run` argv for an interactive Pi login in a throwaway container.
 *
 * Pi has NO non-interactive login subcommand — signing in is the in-TUI
 * `/login` slash command — so this launches the TUI itself against the shared
 * volume, and the written `auth.json` persists there for every later box.
 *
 * `DISPLAY` is blanked for the same reason as the other agents' logins: the
 * image bakes `DISPLAY=:1` (a VNC X server) and Pi must not try to open a
 * browser there, which forces the terminal URL/paste-code flow.
 *
 * `--no-session` keeps the login run from leaving a stray transcript in the
 * shared volume, and `-a` matches a normal launch's trust handling.
 */
export function buildPiLoginRunArgv(opts: {
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
    ...Object.entries(PI_BOX_RUN_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v',
    `${opts.volume}:${CONTAINER_PI_DIR}`,
    '--user',
    CONTAINER_USER,
    opts.image,
    PI_SPEC.binary,
    '--no-session',
    '-a',
    ...opts.extraArgs,
  ];
}

/** Run an interactive docker argv with the user's terminal attached. */
export function runInteractivePiLogin(dockerArgv: string[]): { exitCode: number } {
  const child = spawnSync('docker', dockerArgv, { stdio: 'inherit' });
  return { exitCode: child.status ?? 1 };
}

/**
 * True when the pi-config volume already holds a NON-EMPTY `auth.json`.
 *
 * Pi writes `{}` on first run before any provider is added, so a bare existence
 * check would report a signed-out box as authenticated and skip the sign-in
 * offer. `-s` (non-empty) plus a `{}` reject is the cheap shape test that
 * matches the registry's `realShape: 'nonempty-json'`.
 */
export async function volumeHasPiAuth(volume: string, image: string): Promise<boolean> {
  const res = await execa(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${volume}:/dst`,
      image,
      'sh',
      '-c',
      `test -s /dst/auth.json && [ "$(tr -d ' \\n\\t' < /dst/auth.json)" != '{}' ]`,
    ],
    { reject: false },
  );
  return res.exitCode === 0;
}

export interface PiSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

/** Best-effort probe; any non-zero exit reads as "not running". */
export async function piSessionInfo(
  container: string,
  sessionName?: string,
): Promise<PiSessionInfo> {
  const name = sessionName ?? DEFAULT_PI_SESSION;
  const has = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'tmux', 'has-session', '-t', name],
    { reject: false },
  );
  if (has.exitCode !== 0) return { running: false, sessionName: name, startedAt: null };
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
