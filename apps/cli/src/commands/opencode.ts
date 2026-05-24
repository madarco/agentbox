import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type UserConfig,
} from '@agentbox/config';
import {
  buildOpencodeAttachArgv,
  buildOpencodeLoginRunArgv,
  createBox,
  DEFAULT_RELAY_PORT,
  detectEngine,
  ensureImage,
  ensureOpencodeInstalled,
  ensureOpencodeVolume,
  formatDetachNotice,
  inspectBox,
  OPENCODE_FORWARDED_ENV_KEYS,
  OpencodeSessionError,
  opencodeSessionInfo,
  runInteractiveOpencodeLogin,
  SHARED_OPENCODE_VOLUME,
  startBox,
  startOpencodeSession,
  unpauseBox,
  volumeHasOpencodeAuth,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { cloudAgentAttach } from './_cloud-attach.js';
import { cloudAgentCreate } from './_cloud-agent-create.js';
import { providerForCreate } from '../provider/registry.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { openCommandLog } from '../lib/log-file.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

/** Ref shown in the detach notice: the per-project index `n` when set, else the name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
}

/** Host-side URL for the relay (loopback for the wrapper's SSE subscription). */
const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach to a box's OpenCode tmux session through the wrapped-pty footer (same
 * channel `agentbox claude`/`codex` use for host-action prompts), then exit
 * with the inner pty's code.
 */
async function attachOpencodeWrapped(
  box: { id: string; name: string; container: string; projectIndex?: number },
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
): Promise<never> {
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildOpencodeAttachArgv(box.container, sessionName),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'opencode',
    detachable: true,
    detachNotice: formatDetachNotice(reattach, 'opencode'),
    onError,
  });
  process.exit(code);
}

interface OpencodeCreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  yes?: boolean;
  isolateOpencodeConfig?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true
  sharedDockerCache?: boolean;
  portless?: boolean; // commander: --portless / --no-portless => true / false / undefined
  sessionName?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /** Sandbox backend: `docker` (default) or `daytona`. */
  provider?: string;
}

function buildOpencodeCliOverrides(opts: OpencodeCreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.isolateOpencodeConfig === true) box.isolateOpencodeConfig = true;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  const opencode: NonNullable<UserConfig['opencode']> = {};
  if (opts.sessionName !== undefined) opencode.sessionName = opts.sessionName;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (Object.keys(opencode).length > 0) out.opencode = opencode;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  return out;
}

/**
 * Run `opencode auth login` in a throwaway container against the shared
 * opencode-config volume — credentials persist there and seed every later box.
 * Interactive provider picker; `extraArgs` (e.g. `--provider anthropic`) are
 * forwarded verbatim.
 */
async function runOpencodeLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractiveOpencodeLogin(
    buildOpencodeLoginRunArgv({ volume: SHARED_OPENCODE_VOLUME, image, extraArgs }),
  );
  return exitCode;
}

/**
 * True when OpenCode is already authenticated: a forwarded provider key in the
 * host env, a host `~/.local/share/opencode/auth.json` (carried into the box by
 * the volume sync), or an `auth.json` already in the shared opencode volume.
 */
async function opencodeAuthAvailable(image: string): Promise<boolean> {
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
    if ((process.env[k] ?? '').length > 0) return true;
  }
  if (await fileExists(join(homedir(), '.local', 'share', 'opencode', 'auth.json'))) return true;
  return volumeHasOpencodeAuth(SHARED_OPENCODE_VOLUME, image);
}

/**
 * First-run sign-in offer, shown before box creation. When no OpenCode
 * credentials are available, prompts the user and (on confirm) runs
 * `opencode auth login` in a throwaway container — the result seeds every
 * future box via the shared volume. Silent no-op when already authenticated,
 * in non-interactive runs, or with `--yes`.
 */
async function maybeRunOpencodeLogin(args: { image: string; yes: boolean }): Promise<void> {
  if (!process.stdin.isTTY || args.yes) return;
  if (await opencodeAuthAvailable(args.image)) return;

  const answer = await confirm({
    message: 'Sign in to OpenCode? (pick a provider; saved and reused by every box)',
    initialValue: true,
  });
  if (isCancel(answer) || !answer) {
    log.info('Skipped sign-in — opencode will prompt you to sign in inside the box.');
    return;
  }

  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(args.image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
  // Ensure the shared volume exists (and is vscode-writable) before the login
  // container writes auth.json into it.
  s.message('preparing opencode config');
  await ensureOpencodeVolume(
    { volume: SHARED_OPENCODE_VOLUME },
    { syncFromHost: true, image: args.image },
  );
  s.stop('image ready');

  const exitCode = await runOpencodeLoginContainer(args.image, []);
  if (exitCode !== 0) {
    log.warn('OpenCode login did not complete; continuing — run `agentbox opencode login` to retry.');
    return;
  }
  log.success('Signed in to OpenCode — saved for future boxes.');
}

export const opencodeCommand = new Command('opencode')
  .description('Create a sandboxed box and launch OpenCode in a detachable tmux session')
  // Mirror create's surface so users can swap the verb without re-learning flags.
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option('--host-snapshot', 'APFS-clone the host workspace into a per-box scratch dir before seeding /workspace (stabilizes the tar-pipe source)')
  .option('--no-host-snapshot', 'tar-pipe directly from the live host workspace at create time')
  .option(
    '--snapshot <ref>',
    'start from a project checkpoint (see `agentbox checkpoint`); overrides box.defaultCheckpoint',
  )
  .option('--image <ref>', 'override the box image')
  .option('-y, --yes', 'skip prompts, accept defaults')
  .option(
    '--isolate-opencode-config',
    'use a per-box OpenCode volume instead of the shared agentbox-opencode-config',
  )
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option(
    '--with-env',
    'copy host env/config files (.env*, secrets.toml, agentbox.yaml, ...) into /workspace at create time (gitignore-bypassing)',
  )
  .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
  .option(
    '--shared-docker-cache',
    "use the shared 'agentbox-docker-cache' volume for in-box docker images (preserved on destroy; only one box can run at a time when set)",
  )
  .option(
    '--portless',
    'map the box web app to https://<name>.localhost via the Portless proxy (Docker Desktop)',
  )
  .option('--no-portless', 'do not register a Portless alias for this box')
  .option('--session-name <name>', 'tmux session name (default from config; built-in: opencode)')
  .option('--memory <size>', 'memory ceiling (e.g. 512m, 2g); unset = unlimited')
  .option('--cpus <n>', 'CPU count cap (fractional ok, e.g. 1.5); unset = unlimited')
  .option('--pids-limit <n>', 'max process count (PIDs cgroup); unset = unlimited')
  .option('--disk <size>', 'best-effort writable-layer size (e.g. 10g); no-op on overlay2/macOS')
  .option(
    '--provider <name>',
    "sandbox backend: 'docker' (default) or 'daytona' for a cloud box",
  )
  .argument(
    '[opencode-args...]',
    "extra args passed to opencode inside the box; place after `--`, e.g. `agentbox opencode -- -m anthropic/claude-sonnet-4-5`",
  )
  .action(async (opencodeArgs: string[], opts: OpencodeCreateOptions) => {
    const cmdLog = openCommandLog('opencode');
    process.stderr.write(`log: ${cmdLog.path}\n`);
    intro('Starting OpenCode in a box...');

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildOpencodeCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    // Resolve provider. Cloud path skips docker-only steps (login offer,
    // Portless, createBox) and delegates to cloudAgentCreate.
    const providerName = opts.provider ?? cfg.effective.box.provider ?? 'docker';
    const isCloud = providerName !== 'docker';
    const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
    const checkpointRef =
      opts.snapshot && opts.snapshot.length > 0
        ? opts.snapshot
        : providerDefault.length > 0
          ? providerDefault
          : undefined;

    if (isCloud) {
      const provider = await providerForCreate({ flag: opts.provider, config: cfg.effective });
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      await cloudAgentCreate({
        provider,
        request: {
          workspacePath: opts.workspace,
          name: opts.name,
          checkpointRef,
          image: cfg.effective.box.image,
          withPlaywright,
          withEnv: cfg.effective.box.withEnv,
          vnc: { enabled: cfg.effective.box.vnc },
          limits: resolveLimits(cfg.effective.box, opts),
          projectRoot,
        },
        binary: 'opencode',
        sessionName: cfg.effective.opencode.sessionName,
        mode: 'opencode',
        extraArgs: opencodeArgs,
      });
      return;
    }

    // First-run sign-in offer — before any box work, so the user signs in up
    // front. Uses a throwaway container; the result seeds every future box.
    await maybeRunOpencodeLogin({ image: cfg.effective.box.image, yes: !!opts.yes });

    // First-run Portless opt-in (Docker Desktop only).
    const portlessEnabled = await maybePromptPortless({
      engine: await detectEngine(),
      enabled: cfg.effective.portless.enabled,
      yes: !!opts.yes,
      cwd: opts.workspace,
    });

    // host-snapshot default off: explicit flag/config wins.
    const useSnapshot =
      opts.hostSnapshot === false
        ? false
        : opts.hostSnapshot === true
          ? true
          : (cfg.effective.box.hostSnapshot ?? false);
    const sessionName = cfg.effective.opencode.sessionName;

    const s = spinner();
    s.start('creating box');
    let containerName = '';
    try {
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        checkpointRef,
        image: cfg.effective.box.image,
        opencodeConfig: { isolate: cfg.effective.box.isolateOpencodeConfig },
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        vnc: { enabled: cfg.effective.box.vnc },
        docker: { sharedCache: cfg.effective.box.dockerCacheShared },
        portless: portlessEnabled,
        portlessStateDir: cfg.effective.portless.stateDir || undefined,
        limits: resolveLimits(cfg.effective.box, opts),
        projectRoot,
        onLog: (line) => {
          s.message(clampSpinnerLine(line));
          cmdLog.write(line);
        },
      });
      containerName = result.record.container;

      // OpenCode is baked into the current base image, but a box built from a
      // checkpoint captured before OpenCode support won't have it — install it
      // into the box's writable layer in that case (fast no-op otherwise).
      s.message('checking opencode');
      cmdLog.write('checking opencode');
      await ensureOpencodeInstalled(result.record.container, {
        onProgress: (line) => {
          s.message(clampSpinnerLine(line));
          cmdLog.write(line);
        },
      });

      s.message('starting opencode session');
      await startOpencodeSession({
        container: result.record.container,
        opencodeArgs,
        sessionName,
      });

      const nSuffix =
        typeof result.record.projectIndex === 'number'
          ? `  ·  n ${String(result.record.projectIndex)}`
          : '';
      s.stop(`box ${result.record.container} ready${nSuffix}`);

      outro('attaching — Control+a d to detach, leaves opencode running');
      await attachOpencodeWrapped(
        result.record,
        sessionName,
        reattachRef(result.record),
        (m) => cmdLog.write(m),
      );
    } catch (err) {
      s.stop('failed');
      cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (err instanceof OpencodeSessionError) {
        log.error(err.message);
        if (containerName) {
          log.info(`The box ${containerName} is still running. Destroy it with:`);
          log.info(`  agentbox destroy ${containerName} -y`);
        }
        cmdLog.close();
        process.exit(1);
      }
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });

interface OpencodeStartOptions {
  sessionName?: string;
  syncConfig?: boolean; // commander: --no-sync-config => false; default true
}

// Shared by `opencode start` and `opencode attach`: if a session is already
// running, just attach; otherwise auto-unpause/start the box, (optionally)
// resync the OpenCode config, launch opencode, then attach.
async function startOrAttachOpencode(
  box: BoxRecord,
  opencodeArgs: string[],
  opts: OpencodeStartOptions,
): Promise<void> {
  const cfg = await loadEffectiveConfig(box.workspacePath, {
    cliOverrides: opts.sessionName ? { opencode: { sessionName: opts.sessionName } } : {},
  });
  const sessionName = cfg.effective.opencode.sessionName;

  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }

  // If a tmux session already exists, just attach — no resync, ignore any
  // post-`--` args (they only apply to a fresh opencode).
  const existing = await opencodeSessionInfo(box.container, sessionName);
  if (existing.running) {
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachOpencodeWrapped(box, sessionName, reattachRef(box));
    return;
  }

  // First-run sign-in offer — before any box prep.
  await maybeRunOpencodeLogin({ image: box.image, yes: false });

  const s = spinner();
  s.start('preparing box');

  // Auto-unpause/start. `startBox` relaunches ctl/vnc/dockerd.
  if (insp.state === 'paused') {
    s.message('unpausing box');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    s.message('starting box');
    await startBox(box.id);
  }

  // Re-sync the host's OpenCode config/auth into the box volume (default; opt
  // out with --no-sync-config). Skipped for `opencode attach`, and for boxes
  // with no OpenCode volume mounted — opencode still runs against container-
  // local config in that case.
  const syncConfig = opts.syncConfig !== false;
  if (syncConfig && box.opencodeConfigVolume) {
    s.message('syncing OpenCode config into box volume');
    await ensureOpencodeVolume(
      { volume: box.opencodeConfigVolume },
      { syncFromHost: true, image: box.image },
    );
  }

  // Install opencode if the box image lacks it (checkpoint predating OpenCode).
  s.message('checking opencode');
  await ensureOpencodeInstalled(box.container, {
    onProgress: (line) => s.message(clampSpinnerLine(line)),
  });

  s.message('starting opencode session');
  await startOpencodeSession({ container: box.container, opencodeArgs, sessionName });

  s.stop(`box ${box.container} ready`);

  outro('attaching — Control+a d to detach, leaves opencode running');
  await attachOpencodeWrapped(box, sessionName, reattachRef(box));
}

const opencodeAttachCommand = new Command('attach')
  .description(
    'Attach to an OpenCode tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs config — use `opencode start` for that)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: opencode)')
  .action(async function (this: Command, idOrName: string | undefined) {
    const opts = this.optsWithGlobals() as OpencodeStartOptions;
    intro('Attaching to OpenCode session...');
    try {
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        await cloudAgentAttach({
          box,
          binary: 'opencode',
          sessionName: opts.sessionName ?? 'opencode',
          mode: 'opencode',
        });
        return;
      }
      await startOrAttachOpencode(box, [], { ...opts, syncConfig: false });
    } catch (err) {
      if (err instanceof OpencodeSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const opencodeStartCommand = new Command('start')
  .description(
    'Start an OpenCode tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: opencode)')
  .option(
    '--no-sync-config',
    "skip rsyncing the host's OpenCode config into the box's volume before starting (faster; use existing in-box state)",
  )
  .argument(
    '[opencode-args...]',
    "extra args passed to opencode when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox opencode start 1 -- -m anthropic/claude-sonnet-4-5`",
  )
  .action(async function (this: Command, idOrName: string | undefined, opencodeArgs: string[]) {
    const opts = this.optsWithGlobals() as OpencodeStartOptions;
    intro('Starting OpenCode in a box...');
    try {
      // Two positionals make commander bind the first post-`--` token to
      // `[box]`; resolveBoxOrShift detects that and auto-picks the box.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const effectiveOpencodeArgs = shifted && idOrName ? [idOrName, ...opencodeArgs] : opencodeArgs;
      if ((box.provider ?? 'docker') !== 'docker') {
        await cloudAgentAttach({
          box,
          binary: 'opencode',
          sessionName: opts.sessionName ?? 'opencode',
          mode: 'opencode',
          extraArgs: effectiveOpencodeArgs,
        });
        return;
      }
      await startOrAttachOpencode(box, effectiveOpencodeArgs, opts);
    } catch (err) {
      if (err instanceof OpencodeSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const opencodeLoginCommand = new Command('login')
  .description(
    'Sign in to OpenCode for use in sandboxes. Runs `opencode auth login` in a throwaway container against the shared opencode-config volume (interactive provider picker; pass e.g. `-- --provider anthropic`). Usable before the first `agentbox opencode`.',
  )
  .argument(
    '[args...]',
    'extra args forwarded to `opencode auth login`; place after `--`, e.g. `agentbox opencode login -- --provider anthropic`',
  )
  .action(async (args: string[]) => {
    intro('Signing in to OpenCode...');
    if (!process.stdin.isTTY) {
      log.error('`agentbox opencode login` needs an interactive terminal.');
      process.exit(1);
    }
    try {
      const cfg = await loadEffectiveConfig(process.cwd());
      const image = cfg.effective.box.image;

      const s = spinner();
      s.start('preparing sandbox image');
      await ensureImage(image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
      // Ensure the shared volume exists + is vscode-writable before the login
      // container writes auth.json into it.
      s.message('preparing opencode config');
      await ensureOpencodeVolume({ volume: SHARED_OPENCODE_VOLUME }, { syncFromHost: true, image });
      s.stop('image ready');

      const exitCode = await runOpencodeLoginContainer(image, args);
      if (exitCode !== 0) {
        log.warn(`\`opencode auth login\` exited with code ${String(exitCode)}`);
        process.exit(exitCode);
      }
      outro('signed in — credentials saved for future boxes');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

opencodeCommand.addCommand(opencodeAttachCommand);
opencodeCommand.addCommand(opencodeStartCommand);
opencodeCommand.addCommand(opencodeLoginCommand);
