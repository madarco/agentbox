import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, intro, log, outro, spinner } from '../lib/prompt.js';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type AttachOpenIn,
  type UserConfig,
} from '@agentbox/config';
import { ensureProjectRepoOnControlPlane } from '../control-plane/ensure-repo-installed.js';
import {
  buildOpencodeAttachArgv,
  buildOpencodeLoginRunArgv,
  createBox,
  DEFAULT_BOX_IMAGE,
  DEFAULT_RELAY_PORT,
  detectEngine,
  ensureImage,
  ensureOpencodeInstalled,
  ensureOpencodeVolume,
  extractOpencodeCredentials,
  formatDetachNotice,
  inspectBox,
  recordLastAgent,
  OPENCODE_CREDENTIALS_BACKUP_FILE,
  OPENCODE_FORWARDED_ENV_KEYS,
  OpencodeSessionError,
  opencodeSessionInfo,
  runInteractiveOpencodeLogin,
  SHARED_OPENCODE_VOLUME,
  startBox,
  startOpencodeSession,
  unpauseBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { reattachRef, resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import {
  assertAgentCredsAvailable,
  MissingAgentCredsError,
  opencodeAuthAvailable,
} from '../lib/queue/assert-creds.js';
import { cloudSizingProviderOptions } from '../lib/cloud-sizing.js';
import { parseMaxOption } from '../lib/queue/parse-max-option.js';
import { submitQueueJob } from '../lib/queue/submit.js';
import { captureOpenTerminalContext } from '../terminal/queue-open.js';
import { hostAwareOpenIn } from '../terminal/host.js';
import { maybeResyncWorkspace } from '../lib/resync-start.js';
import { buildResyncWarning } from '../lib/resync-warning.js';
import {
  ATTACH_IN_HELP,
  INLINE_HELP,
  NO_ATTACH_HELP,
  resolveAttachInOption,
} from './_attach-in.js';
import { cloudAgentAttach, cloudAgentStartDetached } from './_cloud-attach.js';
import { cloudAgentCreate } from './_cloud-agent-create.js';
import { runCarryGate, runQueuedCarryGate } from '../lib/carry-gate.js';
import { FromBranchError, UseBranchError, resolveBranchSelection } from '../lib/from-branch.js';
import { providerForCreate } from '../provider/registry.js';
import { prepareTeleport, TeleportError } from '../session-teleport/index.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { makeProgressReporter } from '../lib/progress.js';
import { printLaunchRecap } from '../lib/launch-recap.js';
import { openCommandLog } from '../lib/log-file.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

function pickOpencodeCreateOpts(opts: OpencodeCreateOptions): import('@agentbox/relay').QueueJobCreateOpts {
  return {
    workspace: opts.workspace,
    name: opts.name,
    hostSnapshot: opts.hostSnapshot,
    snapshot: opts.snapshot,
    image: opts.image,
    withPlaywright: opts.withPlaywright,
    withEnv: opts.withEnv,
    vnc: opts.vnc,
    resync: opts.resync,
    sharedDockerCache: opts.sharedDockerCache,
    portless: opts.portless,
    sessionName: opts.sessionName,
    memory: opts.memory,
    cpus: opts.cpus,
    pidsLimit: opts.pidsLimit,
    disk: opts.disk,
  };
}

/** Host-side URL for the relay (loopback for the wrapper's SSE subscription). */
const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

/**
 * Attach to a box's OpenCode tmux session through the wrapped-pty footer (same
 * channel `agentbox claude`/`codex` use for host-action prompts), then exit
 * with the inner pty's code.
 */
export async function attachOpencodeWrapped(
  box: { id: string; name: string; container: string; projectIndex?: number },
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
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
    openIn,
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
  /** --carry-yes (or AGENTBOX_CARRY_YES=1): auto-approve the carry: block. */
  carryYes?: boolean;
  /** --carry <mode>: 'skip' disables carry for this run (also AGENTBOX_CARRY=skip). */
  carry?: 'skip' | 'ask';
  vnc?: boolean; // commander: --no-vnc => false; default true
  resync?: boolean; // commander: --no-resync => false; default true (config box.resyncOnStart)
  sharedDockerCache?: boolean;
  portless?: boolean; // commander: --portless / --no-portless => true / false / undefined
  sessionName?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /** Sandbox backend: `docker` (default) or `daytona`. */
  provider?: string;
  /** --from-branch <ref>: base the box's per-box branch on this ref instead of HEAD. */
  fromBranch?: string;
  /** -b / --use-branch <name>: reuse an existing branch directly instead of forking agentbox/<name>. */
  useBranch?: string;
  /** -v / --verbose: bypass the spinner and stream raw provider output. */
  verbose?: boolean;
  /** Raw `--attach-in <mode>` value; validated by `parseAttachInOption`. */
  attachIn?: string;
  /** --inline: shortcut for `--attach-in same` (long-form only — `-i` is `--initial-prompt`). */
  inline?: boolean;
  /** Commander parses `-d, --no-attach` as `attach: false` (defaults true). */
  attach?: boolean;
  /** `-i, --initial-prompt <text>`: seed opencode with this user turn; runs in background. */
  initialPrompt?: string;
  /** Per-invocation override of `queue.maxConcurrent`. */
  maxRunning?: string;
  /** Per-invocation override of `queue.maxWorking`. */
  maxWorking?: string;
  /** `-c, --continue`: detected then refused (v1 stub). */
  continue?: boolean;
  /** `--resume <id>`: detected then refused (v1 stub). */
  resume?: string;
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
  const attachIn = resolveAttachInOption(opts);
  if (attachIn !== undefined) out.attach = { openIn: attachIn };
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
  if (!answer) {
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

/** True when the cloud push has an opencode credential source on the host. */
async function cloudOpencodeCredAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  for (const p of [OPENCODE_CREDENTIALS_BACKUP_FILE, join(homedir(), '.local', 'share', 'opencode', 'auth.json')]) {
    try {
      await access(p);
      return true;
    } catch {
      /* not present */
    }
  }
  return false;
}

/**
 * Cloud counterpart of {@link maybeRunOpencodeLogin}, offered before creating a
 * CLOUD box. Cloud reads the host backup `~/.agentbox/opencode-credentials.json`
 * (or the host's real `~/.local/share/opencode/auth.json`); the docker login
 * writes only to the shared volume, so after a successful login we extract its
 * `auth.json` into the backup for the cloud push to seed. Skips on
 * non-TTY / --yes / a credential source already present.
 */
async function maybeRunCloudOpencodeLogin(args: { image: string; yes: boolean }): Promise<void> {
  if (!process.stdin.isTTY || args.yes) return;
  if (await cloudOpencodeCredAvailable()) return;

  const answer = await confirm({
    message: 'Sign in to OpenCode? (pick a provider; saved and reused by every box)',
    initialValue: true,
  });
  if (!answer) {
    log.info('Skipped sign-in — opencode will prompt you to sign in inside the box.');
    return;
  }

  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(args.image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
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
  const { copied } = await extractOpencodeCredentials(SHARED_OPENCODE_VOLUME, args.image);
  if (copied) log.success('Signed in to OpenCode — saved for future boxes.');
  else log.warn('OpenCode login finished but no auth.json was captured — sign in inside the box if needed.');
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
    '--carry-yes',
    "auto-approve agentbox.yaml's `carry:` block (also AGENTBOX_CARRY_YES=1). Required for non-TTY use of `-y` when carry: is non-empty.",
  )
  .option(
    '--carry <mode>',
    "control the carry: block; 'skip' disables it for this box (also AGENTBOX_CARRY=skip). Default: 'ask' (prompt).",
    'ask',
  )
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
    '--no-resync',
    "do not sync the box with the host on start (default: merge the host's current branch + overlay its uncommitted/untracked changes, keeping the box's version on conflict)",
  )
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
  .option(
    '--from-branch <ref>',
    "base the box's per-box branch on this ref (branch / tag / SHA) instead of HEAD. Branch/tag names are fetched from origin first.",
  )
  .option(
    '-b, --use-branch <name>',
    "reuse an existing branch directly instead of forking agentbox/<box-name>. Commits/pushes flow straight to it. Docker fails if the host already has it checked out. Mutually exclusive with --from-branch.",
  )
  .option(
    '-v, --verbose',
    'bypass the spinner and stream raw provider output to stderr. The same content always lands in ~/.agentbox/logs/opencode.log.',
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('--inline', INLINE_HELP)
  .option('-d, --no-attach', NO_ATTACH_HELP)
  .option(
    '-i, --initial-prompt <text>',
    'seed the opencode session with this initial user turn and run in background (no attach). Jobs go through the host-wide queue (queue.maxConcurrent).',
  )
  .option(
    '--max-running <n>',
    'per-invocation override of queue.maxConcurrent; only honored when `-i` is set',
  )
  .option(
    '--max-working <n>',
    'per-invocation override of queue.maxWorking; only honored when `-i` is set',
  )
  .option(
    '-c, --continue',
    'session teleport (not yet supported for opencode in v1; emits a friendly error)',
  )
  .option(
    '--resume <id>',
    'session teleport (not yet supported for opencode in v1; emits a friendly error)',
  )
  .argument(
    '[opencode-args...]',
    "extra args passed to opencode inside the box; place after `--`, e.g. `agentbox opencode -- -m anthropic/claude-sonnet-4-5`",
  )
  .action(async (opencodeArgs: string[], opts: OpencodeCreateOptions) => {
    const cmdLog = openCommandLog('opencode');
    intro('Starting OpenCode in a box...');

    // OpenCode session teleport is not yet supported (v1 stub). Detect resume
    // flags early and bail with a clear message before any box work happens.
    if (opts.continue === true || opts.resume) {
      try {
        await prepareTeleport({
          agent: 'opencode',
          hostCwd: opts.workspace,
          mode:
            opts.continue === true
              ? { kind: 'continue' }
              : { kind: 'resume', id: opts.resume! },
        });
      } catch (err) {
        if (err instanceof TeleportError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
    }

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildOpencodeCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    // Resolve provider. Cloud path skips docker-only steps (login offer,
    // Portless, createBox) and delegates to cloudAgentCreate.
    const providerName = opts.provider ?? cfg.effective.box.provider ?? 'docker';
    const isCloud = providerName !== 'docker';

    // When a control plane is configured, make sure this project's repo is
    // authorized on its GitHub App so the box can lease push tokens.
    await ensureProjectRepoOnControlPlane({
      controlPlaneUrl: cfg.effective.relay.controlPlaneUrl,
      gitPushMode: cfg.effective.git.pushMode,
      projectRoot,
      yes: !!opts.yes,
    });

    const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
    const checkpointRef =
      opts.snapshot && opts.snapshot.length > 0
        ? opts.snapshot
        : providerDefault.length > 0
          ? providerDefault
          : undefined;

    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      try {
        await assertAgentCredsAvailable({
          agent: 'opencode',
          image: cfg.effective.box.image,
          providerName,
        });
      } catch (err) {
        if (err instanceof MissingAgentCredsError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
      const maxRunningOverride = parseMaxOption('--max-running', opts.maxRunning);
      const maxWorkingOverride = parseMaxOption('--max-working', opts.maxWorking);
      // Carry gate runs here on the host (same gate as the foreground path); the
      // approved entries ride the queue job and the worker applies them.
      const carryForQueue = await runQueuedCarryGate({
        projectRoot,
        opts,
        onLog: (line) => cmdLog.write(line),
        onClose: () => cmdLog.close(),
      });
      const result = await submitQueueJob({
        agent: 'opencode',
        boxName: opts.name ?? '',
        providerName,
        prompt: opts.initialPrompt,
        agentArgs: opencodeArgs,
        createOpts: { ...pickOpencodeCreateOpts(opts), carry: carryForQueue },
        maxRunningOverride,
        maxWorkingOverride,
        openTerminal: captureOpenTerminalContext(cfg.effective.queue.openIn),
      });
      outro(
        `job ${result.job.id} queued (${String(result.runningCount)}/${String(result.maxConcurrent)} running); log: ${result.job.logPath}`,
      );
      cmdLog.close();
      return;
    }

    // Carry gate (agentbox.yaml's `carry:` block): resolve + ask before any
    // box work. Cancel aborts; skip proceeds with no carry payload.
    let carryEntries: import('@agentbox/core').ResolvedCarryEntry[] = [];
    try {
      const gate = await runCarryGate({
        projectRoot,
        yes: !!opts.yes,
        carryYesFlag: opts.carryYes ? true : undefined,
        carrySkipFlag: opts.carry === 'skip' ? true : undefined,
        onLog: (line) => cmdLog.write(line),
      });
      if (gate.decision === 'cancel') {
        log.warn('carry: cancelled — not creating the box');
        cmdLog.close();
        process.exit(0);
      }
      if (gate.decision === 'approve') carryEntries = gate.entries;
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      cmdLog.close();
      process.exit(1);
    }

    let fromBranch: string | undefined;
    let useBranch: string | undefined;
    try {
      ({ fromBranch, useBranch } = await resolveBranchSelection({
        useBranch: opts.useBranch,
        fromBranch: opts.fromBranch,
        repo: opts.workspace,
        providerName,
        cloudUseCurrentBranch: cfg.effective.cloud.useCurrentBranch,
        log: (m) => cmdLog.write(m),
      }));
    } catch (err) {
      if (err instanceof FromBranchError || err instanceof UseBranchError) {
        log.error(err.message);
        cmdLog.close();
        process.exit(2);
      }
      throw err;
    }

    if (isCloud) {
      // Cloud sign-in offer: capture a host login to ~/.agentbox so the per-box
      // push seeds it (docker's offer below only seeds via the shared volume).
      // Uses the default docker image — the login runs in a docker container,
      // and `box.image` on the cloud path can be a snapshot ref docker rejects.
      await maybeRunCloudOpencodeLogin({ image: DEFAULT_BOX_IMAGE, yes: !!opts.yes });
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
          carry: carryEntries,
          vnc: { enabled: cfg.effective.box.vnc },
          limits: resolveLimits(cfg.effective.box, opts),
          fromBranch,
          useBranch,
          resyncOnStart: opts.resync,
          projectRoot,
          // Per-provider session-lifetime (e2b/vercel timeout); mirrors create.
          providerOptions: cloudSizingProviderOptions(provider.name, cfg.effective),
        },
        binary: 'opencode',
        sessionName: cfg.effective.opencode.sessionName,
        mode: 'opencode',
        // opencode surfaces the resync warning on stderr (matches its docker
        // path, which never injects it as an opening turn).
        hasSeedPrompt: true,
        extraArgs: opencodeArgs,
        verbose: opts.verbose === true,
        openIn: hostAwareOpenIn(cfg),
        attach: opts.attach !== false,
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

    const s = makeProgressReporter(opts.verbose === true);
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
        fromBranch,
        useBranch,
        resyncOnStart: opts.resync,
        image: cfg.effective.box.image,
        opencodeConfig: { isolate: cfg.effective.box.isolateOpencodeConfig },
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        carry: carryEntries,
        vnc: { enabled: cfg.effective.box.vnc },
        docker: { sharedCache: cfg.effective.box.dockerCacheShared },
        portless: portlessEnabled,
        portlessStateDir: cfg.effective.portless.stateDir || undefined,
        limits: resolveLimits(cfg.effective.box, opts),
        projectRoot,
        onLog: (line) => {
          s.message(line);
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
          s.message(line);
          cmdLog.write(line);
        },
      });

      s.message('starting opencode session');
      await startOpencodeSession({
        container: result.record.container,
        opencodeArgs,
        sessionName,
      });
      // Remember this box was launched as opencode for `agentbox recover`.
      await recordLastAgent(result.record.id, 'opencode').catch(() => {});
      const createResyncWarning = result.resync ? buildResyncWarning(result.resync) : null;

      const nSuffix =
        typeof result.record.projectIndex === 'number'
          ? `  ·  n ${String(result.record.projectIndex)}`
          : '';
      s.stop(`box ready${nSuffix}`);
      if (createResyncWarning) log.warn(createResyncWarning);

      await printLaunchRecap({
        record: result.record,
        mode: 'opencode',
        reattach: reattachRef(result.record),
        workspacePath: opts.workspace,
        fromBranch,
        useBranch,
        checkpointRef,
        attaching: opts.attach !== false,
      });
      if (opts.attach === false) {
        return;
      }
      await attachOpencodeWrapped(
        result.record,
        sessionName,
        reattachRef(result.record),
        (m) => cmdLog.write(m),
        hostAwareOpenIn(cfg),
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
  resync?: boolean; // commander: --no-resync => false; default true (config box.resyncOnStart)
  syncConfig?: boolean; // commander: --no-sync-config => false; default true
  attachIn?: string; // raw `--attach-in <mode>` value, validated below.
  inline?: boolean; // -i / --inline: shortcut for --attach-in same.
  attach?: boolean; // commander: --no-attach => false; default true.
  continue?: boolean;
  resume?: string;
}

// Shared by `opencode start` and `opencode attach`: if a session is already
// running, just attach; otherwise auto-unpause/start the box, (optionally)
// resync the OpenCode config, launch opencode, then attach.
async function startOrAttachOpencode(
  box: BoxRecord,
  opencodeArgs: string[],
  opts: OpencodeStartOptions,
): Promise<void> {
  const attachIn = resolveAttachInOption(opts);
  const cliOverrides: Partial<UserConfig> = {};
  if (opts.sessionName) cliOverrides.opencode = { sessionName: opts.sessionName };
  if (attachIn !== undefined) cliOverrides.attach = { openIn: attachIn };
  if (opts.resync !== undefined) cliOverrides.box = { resyncOnStart: opts.resync };
  const cfg = await loadEffectiveConfig(box.workspacePath, { cliOverrides });
  const sessionName = cfg.effective.opencode.sessionName;
  const openIn = hostAwareOpenIn(cfg);
  const wantAttach = opts.attach !== false;

  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }
  // Record this attach/launch as an opencode session for `agentbox recover`.
  await recordLastAgent(box.id, 'opencode').catch(() => {});

  // If a tmux session already exists, just attach — no resync, ignore any
  // post-`--` args (they only apply to a fresh opencode).
  const existing = await opencodeSessionInfo(box.container, sessionName);
  if (existing.running) {
    if (!wantAttach) {
      outro(
        `session "${sessionName}" already running — attach with: agentbox opencode attach ${reattachRef(box)}`,
      );
      return;
    }
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachOpencodeWrapped(box, sessionName, reattachRef(box), undefined, openIn);
    return;
  }

  // First-run sign-in offer — before any box prep.
  await maybeRunOpencodeLogin({ image: box.image, yes: false });

  const s = spinner();
  s.start('preparing box');

  // Auto-unpause/start. `startBox` relaunches ctl/vnc/dockerd.
  const wasDown = insp.state === 'paused' || insp.state === 'stopped';
  if (insp.state === 'paused') {
    s.message('unpausing box');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    s.message('starting box');
    await startBox(box.id);
  }

  // Resync the workspace with the host (docker-only, down→up transition only).
  // OpenCode's interactive launch takes no seed prompt, so any conflict warning
  // is surfaced on stderr rather than injected.
  const resyncWarning = await maybeResyncWorkspace({
    box,
    enabled: cfg.effective.box.resyncOnStart && wasDown,
    projectRoot: cfg.projectRoot,
    spinner: s,
  });

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
  if (resyncWarning) log.warn(resyncWarning);

  if (!wantAttach) {
    outro(
      `session "${sessionName}" started — attach with: agentbox opencode attach ${reattachRef(box)}`,
    );
    return;
  }
  outro('attaching — Control+a d to detach, leaves opencode running');
  await attachOpencodeWrapped(box, sessionName, reattachRef(box), undefined, openIn);
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
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .action(async function (this: Command, idOrName: string | undefined) {
    const opts = this.optsWithGlobals() as OpencodeStartOptions;
    intro('Attaching to OpenCode session...');
    try {
      const attachIn = resolveAttachInOption(opts);
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        await cloudAgentAttach({
          box,
          binary: 'opencode',
          sessionName: opts.sessionName ?? 'opencode',
          mode: 'opencode',
          openIn: hostAwareOpenIn(cfg),
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
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .option('-d, --no-attach', NO_ATTACH_HELP)
  .option(
    '-c, --continue',
    'session teleport (not yet supported for opencode in v1; emits a friendly error)',
  )
  .option(
    '--resume <id>',
    'session teleport (not yet supported for opencode in v1; emits a friendly error)',
  )
  .argument(
    '[opencode-args...]',
    "extra args passed to opencode when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox opencode start 1 -- -m anthropic/claude-sonnet-4-5`",
  )
  .action(async function (this: Command, idOrName: string | undefined, opencodeArgs: string[]) {
    const opts = this.optsWithGlobals() as OpencodeStartOptions;
    intro('Starting OpenCode in a box...');
    try {
      const attachIn = resolveAttachInOption(opts);
      // Two positionals make commander bind the first post-`--` token to
      // `[box]`; resolveBoxOrShift detects that and auto-picks the box.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const effectiveOpencodeArgs = shifted && idOrName ? [idOrName, ...opencodeArgs] : opencodeArgs;
      if (opts.continue === true || opts.resume) {
        try {
          await prepareTeleport({
            agent: 'opencode',
            hostCwd: box.workspacePath,
            mode:
              opts.continue === true
                ? { kind: 'continue' }
                : { kind: 'resume', id: opts.resume! },
          });
        } catch (err) {
          if (err instanceof TeleportError) {
            log.error(err.message);
            process.exit(2);
          }
          throw err;
        }
      }
      if ((box.provider ?? 'docker') !== 'docker') {
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        const sessionName = opts.sessionName ?? 'opencode';
        if (opts.attach === false) {
          // Background mode: start the detached session (matches docker) instead
          // of deferring the agent until the next attach.
          await cloudAgentStartDetached({
            box,
            binary: 'opencode',
            sessionName,
            extraArgs: effectiveOpencodeArgs,
          });
          outro(
            `--no-attach: opencode started in background. Attach: agentbox opencode attach ${reattachRef(box)}`,
          );
          return;
        }
        await cloudAgentAttach({
          box,
          binary: 'opencode',
          sessionName,
          mode: 'opencode',
          extraArgs: effectiveOpencodeArgs,
          openIn: hostAwareOpenIn(cfg),
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
