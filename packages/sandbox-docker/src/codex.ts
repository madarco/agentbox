import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildTermSafeTmuxExec, buildTmuxSessionArgs, CONTAINER_USER } from './claude.js';
import { sanitizeCodexConfigForBox, MINIMAL_TRUSTED_CODEX_CONFIG } from './codex-config.js';
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
    // Skills handling depends on whether the host uses the shared ~/.agents dir.
    // WITH ~/.agents: ~/.codex/skills/<x> are symlinks into ~/.agents/skills,
    //   which the box mounts from its own volume (agents.ts) — codex reads
    //   ~/.agents/skills directly, so the per-codex copies are redundant.
    //   Exclude `skills` (also dodges an rsync "could not make way for new
    //   symlink" failure when the shared volume holds them as real dirs from an
    //   earlier deref) and `find`-purge those stale non-system dirs, keeping
    //   codex's runtime-managed `.system`.
    // WITHOUT ~/.agents: the user keeps real skills directly under
    //   ~/.codex/skills — sync them as-is (no exclude, no purge) so they reach
    //   the box (the box has no ~/.agents volume to fall back on).
    const hasAgents = await pathExists(join(homedir(), '.agents'));
    const skillsExclude = hasAgents ? ' --exclude=skills' : '';
    const skillsPurge = hasAgents
      ? ' && { [ -d /dst/skills ] && find /dst/skills -mindepth 1 -maxdepth 1 ! -name .system -exec rm -rf {} + || true; }'
      : '';
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
        skillsExclude +
        ' --exclude=state_*.sqlite* --exclude=logs_*.sqlite* --exclude=session_index.jsonl' +
        ' --exclude=external_agent_session_imports.json --exclude=shell_snapshots' +
        ' /src/ /dst/' +
        ' && rm -rf /dst/state_*.sqlite* /dst/logs_*.sqlite* /dst/session_index.jsonl' +
        ' /dst/external_agent_session_imports.json /dst/shell_snapshots' +
        skillsPurge +
        ' && chown -R 1000:1000 /dst',
    ]);
    await sanitizeVolumeCodexConfig(spec.volume, opts.image);
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
  // Even with nothing to sync, pre-trust /workspace so a Codex user with no host
  // ~/.codex/config.toml doesn't hit the trust prompt. sanitizeVolumeCodexConfig
  // writes a minimal trusted config when the host has none.
  if (!(await pathExists(join(hostCodex, 'config.toml')))) {
    await sanitizeVolumeCodexConfig(spec.volume, opts.image);
  }
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
 *
 * Shape note (codex 0.134.0): `hooks.json` must be `{ hooks: { Event: [...] } }`
 * (matching the `HooksFile` Rust struct), with NO extra top-level keys — codex's
 * strict parser rejects unknown fields (a stray `$comment` produced a startup
 * `failed to parse hooks config` warning). Loading also needs `--enable hooks`
 * and either the in-TUI trust dialog or `--dangerously-bypass-hook-trust`, both
 * supplied by {@link CODEX_AGENTBOX_FLAGS}. In practice JSON-hook firing is still
 * unreliable in 0.134.0 (TUI mode skips them on some startup paths) — the real
 * mechanism that lights up state in production is the tmux-pane scraper in
 * `packages/ctl/src/codex-scraper.ts`. These hooks remain a defense-in-depth
 * seed so any future codex build that fixes the firing also lights up state.
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

/**
 * Overwrite the box's just-synced `~/.codex/config.toml` with a sanitized copy
 * that drops host-only-path entries (desktop-Codex.app MCP servers like
 * `node_repl`, a macOS `notify` helper, local-source marketplaces) — see
 * {@link sanitizeCodexConfigForBox}. Without this the in-box codex tries to exec
 * macOS paths and prints `MCP client ... failed to start: No such file` warnings.
 *
 * Runs AFTER the rsync so the raw copy already exists: best-effort, and a no-op
 * when nothing host-only is present. On a missing host config, a TOML parse
 * failure, or a container error we leave the raw rsynced copy intact — the box
 * must never end up without a `config.toml`.
 */
async function sanitizeVolumeCodexConfig(
  volume: string,
  image: string,
): Promise<{ sanitized: boolean }> {
  try {
    const hostConfig = join(homedir(), '.codex', 'config.toml');
    // No host config to sanitize: still seed a minimal config that pre-trusts
    // /workspace, so a Codex user without a host config.toml doesn't hit the
    // "trust this folder?" prompt in the box.
    let text: string;
    if (!(await pathExists(hostConfig))) {
      text = MINIMAL_TRUSTED_CODEX_CONFIG;
    } else {
      const sanitized = sanitizeCodexConfigForBox(await readFile(hostConfig, 'utf8'));
      if (!sanitized.changed || sanitized.text.length === 0) return { sanitized: false };
      text = sanitized.text;
    }
    // `-i` keeps stdin attached so execa's `input` reaches `cat`; without it the
    // container gets immediate EOF and `>` truncates config.toml to empty. Write
    // to a temp file then `mv` so a partial/failed write never clobbers the
    // rsynced copy.
    await execa(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--user',
        '0',
        '-v',
        `${volume}:/dst`,
        image,
        'sh',
        '-c',
        'cat > /dst/config.toml.tmp && chown 1000:1000 /dst/config.toml.tmp && ' +
          'mv /dst/config.toml.tmp /dst/config.toml',
      ],
      { input: text },
    );
    return { sanitized: true };
  } catch {
    return { sanitized: false };
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
// The flag makes codex print a (cosmetic, duplicated) "--dangerously-bypass-
//   hook-trust is enabled" warning at startup. There is NO codex option to
//   silence only that warning. The only way to drop it is to stop passing the
//   flag and instead persist hook trust in config.toml as
//   `[hooks.state."<hooks.json path>:<event>:0:0"] trusted_hash = "sha256:…"`
//   (one entry per event, written when you accept the dialog). We deliberately
//   do NOT seed those: the hash is an opaque codex-internal digest (not
//   reproducible from the hook command) tied to both hooks.json content and the
//   codex version — a mismatch turns the cosmetic warning into a *blocking*
//   "Hooks need review" dialog on every box. The bypass flag always works, so
//   the warning is the accepted cost. (`hooks.managed_dir` auto-trusts but did
//   not fire the hooks in testing.)
// The actual mechanism that lights up codex.state in production is the
// tmux-pane scraper (codex-scraper.ts); these flags are defense-in-depth for
// the day codex's JSON-hook firing becomes reliable (it does fire on 0.141.0).
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
  return buildTermSafeTmuxExec({
    container,
    user: CONTAINER_USER,
    tmuxScript: 'exec tmux attach -t "$1"',
    positionals: [name],
  });
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
