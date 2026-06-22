import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildTmuxSessionArgs, CONTAINER_USER } from './claude.js';
import { ensureVolume, volumeExists } from './docker.js';

/**
 * Codex support mirrors the Claude support in `claude.ts`, trimmed for what
 * Codex actually has: a synced `~/.codex` config volume, a detachable tmux
 * session, and `codex login`. Codex has no plugin system, so there is no
 * plugin-native-deps rebuild and no setup-skill seeding here.
 */
export const SHARED_CODEX_VOLUME = 'agentbox-codex-config';
export const DEFAULT_CODEX_SESSION = 'codex';
/** Workspace inside the box, same as for claude. */
const CONTAINER_CODEX_DIR = '/home/vscode/.codex';
/**
 * Image-baked copy of the AgentBox Codex activity hooks (Dockerfile.box COPYs
 * `scripts/agentbox-codex-hooks.json` here). {@link seedCodexHooks} copies it
 * into the codex-config volume as `~/.codex/hooks.json`.
 */
const IN_BOX_CODEX_HOOKS_PATH = '/usr/local/share/agentbox/codex-hooks.json';

export interface CodexConfigSpec {
  /** Resolved Docker volume name mounted at /home/vscode/.codex. */
  volume: string;
}

export function resolveCodexVolume(opts: { isolate: boolean; boxId: string }): CodexConfigSpec {
  if (opts.isolate) {
    return { volume: `${SHARED_CODEX_VOLUME}-${opts.boxId}` };
  }
  return { volume: SHARED_CODEX_VOLUME };
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
 * alphabet gets wrapped. Mirrors the helper in claude.ts (not exported there).
 */
function shQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface EnsureCodexVolumeOptions {
  /**
   * When true and the host's ~/.codex exists, rsync host -> volume on every
   * call. Additive (no `--delete`): host files win on overlap, box-only files
   * (e.g. an `auth.json` written by an in-box `codex login`) are preserved.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container (the box image). */
  image: string;
}

export interface EnsureCodexVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper ran (syncFromHost was true AND host ~/.codex existed). */
  synced: boolean;
}

/**
 * Ensure the codex-config volume exists, then (when {@link
 * EnsureCodexVolumeOptions.syncFromHost} is true and the host has a `~/.codex`)
 * rsync host -> volume via a throwaway helper container. The host is treated as
 * authoritative — same model as {@link import('./claude.js').ensureClaudeVolume}.
 *
 * Rollout transcripts (`sessions/`), logs (`log/`) and shell history
 * (`history.jsonl`) are excluded: large, box-irrelevant, and not something the
 * in-box codex needs seeded.
 *
 * Codex's session-state DBs and indexes are also excluded:
 *   - `state_*.sqlite*` is the `threads` INDEX over the rollout files
 *     (id -> rollout_path, cwd, title, git, ...). Codex reads the resume cwd
 *     from `threads.cwd`, so seeding the host copy made a teleported session
 *     resume at its *host* cwd and pop Codex's "Choose working directory"
 *     prompt — overriding the cwd we rewrite in the rollout. The index is a
 *     derived cache (Codex backfills it from the rollouts present, see the
 *     `backfill_state` table), so the box rebuilds it from the one teleported
 *     rollout (already rewritten to /workspace) -> no prompt.
 *   - `logs_*.sqlite*`, `session_index.jsonl`,
 *     `external_agent_session_imports.json`, `shell_snapshots/` are likewise
 *     host-session runtime state, not config. Excluding them also stops the
 *     host's entire cross-project Codex history from leaking into every box.
 * Config / auth / extensions (`config.toml`, `auth.json`, `prompts/`, `skills/`,
 * `plugins/`, `rules/`, `memories/`) are still synced.
 *
 * When there is nothing to sync the volume root is still `chown`ed to uid 1000
 * so a throwaway `codex login` container (running as `vscode`) can write
 * `auth.json` into a freshly created, otherwise root-owned volume.
 */
export async function ensureCodexVolume(
  spec: CodexConfigSpec,
  opts: EnsureCodexVolumeOptions,
): Promise<EnsureCodexVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  const hostCodex = join(homedir(), '.codex');
  const willSync = opts.syncFromHost && (await pathExists(hostCodex));
  if (willSync) {
    await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      '-v',
      `${hostCodex}:/src:ro`,
      opts.image,
      'sh',
      '-c',
      // --exclude=hooks.json: the AgentBox activity hooks file is box-owned
      // (seeded by seedCodexHooks); never let the host copy clobber it.
      // The session-state DBs / indexes are excluded so a teleported session
      // resumes at /workspace (Codex reads the cwd from state_*.sqlite's threads
      // index, which it backfills from the box's rollouts) and the host's
      // cross-project Codex history doesn't leak into the box.
      // The trailing `rm -rf` purges any state DBs a PREVIOUS sync (before these
      // excludes) already copied into the shared volume — rsync without
      // --delete only adds/updates. The globs are no-ops with `-f` when absent,
      // and never touch box-owned `sessions/` (the teleported rollouts) or
      // `hooks.json`.
      'rsync -a --exclude=sessions --exclude=log --exclude=history.jsonl --exclude=hooks.json' +
        ' --exclude=state_*.sqlite* --exclude=logs_*.sqlite* --exclude=session_index.jsonl' +
        ' --exclude=external_agent_session_imports.json --exclude=shell_snapshots' +
        ' /src/ /dst/' +
        ' && rm -rf /dst/state_*.sqlite* /dst/logs_*.sqlite* /dst/session_index.jsonl' +
        ' /dst/external_agent_session_imports.json /dst/shell_snapshots' +
        ' && chown -R 1000:1000 /dst',
    ]);
    return { created, synced: true };
  }

  // No host ~/.codex to sync — still make the (possibly freshly created,
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
 * Seed the AgentBox Codex activity hooks into the codex-config volume from the
 * image-baked copy ({@link IN_BOX_CODEX_HOOKS_PATH}) as `~/.codex/hooks.json`.
 * Codex auto-discovers that file; its hooks accumulate with any the user
 * defined, so this never disables the user's own hooks.
 *
 * Re-seeded on every create/start (image-versioned) so an image upgrade
 * propagates. Best-effort — a failure must not fail box creation.
 */
export async function seedCodexHooks(
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
      `{ [ -f ${IN_BOX_CODEX_HOOKS_PATH} ] && cp -a ${IN_BOX_CODEX_HOOKS_PATH} /dst/hooks.json && ` +
        `chown 1000:1000 /dst/hooks.json && echo SEEDED; } || true`,
    ]);
    return { seeded: stdout.includes('SEEDED') };
  } catch {
    return { seeded: false };
  }
}

export interface CodexMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /** Env vars to forward into the container; only keys set + non-empty on the host. */
  env: Record<string, string>;
  volumeName: string;
}

// Forwarded from the host's `process.env` into the box at `docker run -e` time
// (and re-forwarded by `startCodexSession` at `docker exec -e` time). Codex
// stores the selected model in `~/.codex/config.toml`, not the environment, so
// the API key is the only thing worth forwarding.
export const CODEX_FORWARDED_ENV_KEYS = ['OPENAI_API_KEY'] as const;

export function buildCodexMounts(
  spec: CodexConfigSpec,
  hostEnv: NodeJS.ProcessEnv,
): CodexMountResult {
  const env: Record<string, string> = {};
  for (const k of CODEX_FORWARDED_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_CODEX_DIR}`],
    env,
    volumeName: spec.volume,
  };
}

export class CodexSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSessionError';
  }
}

export interface EnsureCodexInstalledResult {
  /**
   * True when codex had to be installed just now — i.e. it was absent from the
   * box image. Happens for boxes created from a checkpoint image captured
   * before Codex was baked into the base image, or from an older base image.
   */
  installed: boolean;
}

/**
 * Make sure the `codex` binary is on PATH inside the box. Codex is baked into
 * the current base image, but a box created from a **checkpoint** image (a
 * frozen snapshot — see docs/create-and-checkpoints.md) captured before Codex
 * support, or from an older base image, won't have it. In that case we
 * `npm install -g @openai/codex` into the box's writable layer (persists across
 * stop/start, wiped on destroy), mirroring how `--with-playwright` installs at
 * create time.
 *
 * Fast no-op (one `command -v`) when codex is already present — the case for
 * every box built from the current base image. Throws {@link CodexSessionError}
 * when codex is absent *and* the install fails.
 */
export async function ensureCodexInstalled(
  container: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<EnsureCodexInstalledResult> {
  const probe = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'sh', '-c', 'command -v codex'],
    { reject: false },
  );
  if (probe.exitCode === 0) return { installed: false };

  opts.onProgress?.('installing codex (absent from this box image)');
  const install = await execa(
    'docker',
    ['exec', '--user', 'root', container, 'bash', '-lc', 'npm install -g @openai/codex 2>&1'],
    { reject: false },
  );
  if (install.exitCode !== 0) {
    throw new CodexSessionError(
      `codex is not in this box's image and \`npm install -g @openai/codex\` failed ` +
        `(exit ${String(install.exitCode)}). This box was likely created from a ` +
        `checkpoint captured before Codex support — recapture the project checkpoint ` +
        `from a fresh box. Install output:\n${(install.stdout ?? '').toString().slice(-600)}`,
    );
  }
  return { installed: true };
}

export interface StartCodexSessionOptions {
  container: string;
  codexArgs: string[];
  sessionName?: string;
}

/**
 * Start a detached tmux session running the Codex CLI inside the container.
 * Survives client disconnects; reattach via {@link buildCodexAttachArgv}. The
 * shared {@link buildTmuxSessionArgs} remaps the prefix (Ctrl+a / Ctrl+b) and
 * hides the inner status bar, exactly as for the claude session.
 */
// Flags codex needs to actually try our seeded hooks.json from the box image:
// - `--enable hooks` opts into Claude-style lifecycle hook loading (the codex
//   feature was renamed from `codex_hooks` -> `hooks` in 0.134.0).
// - `--dangerously-bypass-hook-trust` skips the in-TUI "trust these hooks?"
//   dialog that would otherwise block startup on every fresh box. The hooks
//   are AgentBox-managed and pre-vetted; the user never sees them, so trust
//   verification has no UX value here.
// The actual mechanism that lights up codex.state in production is the
// tmux-pane scraper (codex-scraper.ts); these flags are defense-in-depth for
// the day codex's JSON-hook firing becomes reliable.
const CODEX_AGENTBOX_FLAGS = ['--enable', 'hooks', '--dangerously-bypass-hook-trust'] as const;

export async function startCodexSession(opts: StartCodexSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_CODEX_SESSION;
  const cmd = ['codex', ...CODEX_AGENTBOX_FLAGS, ...opts.codexArgs].map(shQuote).join(' ');
  const term = process.env['TERM'] ?? 'xterm-256color';
  const envFlags: string[] = ['-e', `TERM=${term}`];
  for (const k of CODEX_FORWARDED_ENV_KEYS) {
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
    throw new CodexSessionError(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/codex.*not found|exec: "codex"/i.test(stderr)) {
    throw new CodexSessionError(
      `codex is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/duplicate session/i.test(stderr)) {
    throw new CodexSessionError(
      `a tmux session "${sessionName}" already exists in ${opts.container}; use \`agentbox codex attach\` to reattach.`,
    );
  }
  throw new CodexSessionError(
    `failed to start codex session in ${opts.container}: ${stderr.trim() || `exit ${String(result.exitCode)}`}`,
  );
}

/**
 * The `docker` argv that attaches an interactive terminal to a box's Codex
 * tmux session. Mirrors {@link import('./claude.js').buildClaudeAttachArgv}.
 */
export function buildCodexAttachArgv(container: string, sessionName?: string): string[] {
  const name = sessionName ?? DEFAULT_CODEX_SESSION;
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
 * The `docker run` argv for an interactive `codex login` in a throwaway
 * container. Mounts the codex-config volume at `~/.codex` so the written
 * credentials persist. Defaults to `--device-auth` — the headless device-code
 * flow (prints a URL + one-time code, no localhost callback to publish) — which
 * is the only OAuth flow that works cleanly from inside a container. Explicit
 * `extraArgs` (e.g. `['--api-key']`) override the default verbatim.
 *
 * `DISPLAY` is blanked for the same reason as the claude login: the image bakes
 * `DISPLAY=:1` (a VNC X server) and codex must not try to open a browser there.
 */
export function buildCodexLoginRunArgv(opts: {
  volume: string;
  image: string;
  extraArgs: string[];
}): string[] {
  const term = process.env['TERM'] ?? 'xterm-256color';
  const loginArgs = opts.extraArgs.length > 0 ? opts.extraArgs : ['--device-auth'];
  return [
    'run',
    '-it',
    '--rm',
    '-e',
    `TERM=${term}`,
    '-e',
    'DISPLAY=',
    '-v',
    `${opts.volume}:${CONTAINER_CODEX_DIR}`,
    '--user',
    CONTAINER_USER,
    opts.image,
    'codex',
    'login',
    ...loginArgs,
  ];
}

/**
 * Run an interactive docker argv (from {@link buildCodexLoginRunArgv}) with the
 * user's terminal attached. Returns the exit code; a null status is reported
 * as 1.
 */
export function runInteractiveCodexLogin(dockerArgv: string[]): { exitCode: number } {
  const child = spawnSync('docker', dockerArgv, { stdio: 'inherit' });
  return { exitCode: child.status ?? 1 };
}

/**
 * True when the codex-config volume already holds an `auth.json`. Used to skip
 * the first-run sign-in offer when an earlier box / `agentbox codex login`
 * already authenticated.
 */
export async function volumeHasCodexAuth(volume: string, image: string): Promise<boolean> {
  const res = await execa(
    'docker',
    ['run', '--rm', '-v', `${volume}:/dst`, image, 'sh', '-c', 'test -e /dst/auth.json'],
    { reject: false },
  );
  return res.exitCode === 0;
}

export interface CodexSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

/**
 * Best-effort: returns `{ running: false, …, startedAt: null }` for any
 * non-zero exit from `tmux has-session`. Mirrors `claudeSessionInfo`.
 */
export async function codexSessionInfo(
  container: string,
  sessionName?: string,
): Promise<CodexSessionInfo> {
  const name = sessionName ?? DEFAULT_CODEX_SESSION;
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

export interface PullCodexResult {
  /** Volume items copied to the host (or, in dry-run, that would be copied). */
  newItems: string[];
}

export interface PullCodexOptions {
  /** Image for the throwaway helper container; use the box's image. */
  image: string;
  /** When true, compute the delta but write nothing. */
  dryRun?: boolean;
}

/** Top-level codex-config items `download codex` considers. */
const CODEX_PULL_ITEMS = ['config.toml', 'auth.json', 'prompts'] as const;

/**
 * Reverse of {@link ensureCodexVolume}: pull box-side codex config/auth from
 * the codex-config volume back to the host's `~/.codex`. Additive only — an
 * item already present on the host is never overwritten. The box need not be
 * running (we read the *volume* via a throwaway helper container).
 */
export async function pullCodexConfig(
  spec: CodexConfigSpec,
  opts: PullCodexOptions,
): Promise<PullCodexResult> {
  const hostCodex = join(homedir(), '.codex');

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
      `for f in ${CODEX_PULL_ITEMS.join(' ')}; do [ -e "/src/$f" ] && echo "$f"; done; true`,
    ],
    { reject: false },
  );
  if (inv.exitCode !== 0) {
    throw new CodexSessionError(
      `failed to read codex-config volume ${spec.volume}: ${(inv.stderr ?? '').toString().trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }

  const present = new Set(
    (inv.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const newItems: string[] = [];
  for (const item of CODEX_PULL_ITEMS) {
    if (!present.has(item)) continue;
    if (await pathExists(join(hostCodex, item))) continue; // additive — never overwrite
    newItems.push(item);
  }

  if (opts.dryRun || newItems.length === 0) return { newItems };

  // Copy each new item from the volume into the host ~/.codex. `--user 0` so
  // root can read uid-1000 files; chown the result back to the host user so
  // the host's own `codex` can read/write a freshly created ~/.codex.
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const cmds = newItems.map((it) => `cp -a '/src/${it}' '/dst/${it}'`);
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
      `${hostCodex}:/dst`,
      opts.image,
      'sh',
      '-c',
      `mkdir -p /dst && ${cmds.join(' && ')} && chown -R ${String(uid)}:${String(gid)} /dst`,
    ],
    { reject: false },
  );
  if (apply.exitCode !== 0) {
    throw new CodexSessionError(
      `failed to copy codex config from ${spec.volume}: ${(apply.stderr ?? '').toString().trim() || `exit ${String(apply.exitCode)}`}`,
    );
  }
  return { newItems };
}
