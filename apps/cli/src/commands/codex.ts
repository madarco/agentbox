import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type AttachOpenIn,
  type UserConfig,
} from '@agentbox/config';
import {
  buildCodexAttachArgv,
  buildCodexLoginRunArgv,
  CodexSessionError,
  codexSessionInfo,
  createBox,
  DEFAULT_RELAY_PORT,
  detectEngine,
  ensureCodexInstalled,
  ensureCodexVolume,
  ensureImage,
  formatDetachNotice,
  inspectBox,
  runInteractiveCodexLogin,
  seedCodexHooks,
  SHARED_CODEX_VOLUME,
  startBox,
  startCodexSession,
  unpauseBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import {
  assertAgentCredsAvailable,
  codexAuthAvailable,
  MissingAgentCredsError,
} from '../lib/queue/assert-creds.js';
import { submitQueueJob } from '../lib/queue/submit.js';
import {
  ATTACH_IN_HELP,
  INLINE_HELP,
  NO_ATTACH_HELP,
  resolveAttachInOption,
} from './_attach-in.js';
import { cloudAgentAttach } from './_cloud-attach.js';
import { cloudAgentCreate } from './_cloud-agent-create.js';
import { runCarryGate } from '../lib/carry-gate.js';
import { providerForBox, providerForCreate } from '../provider/registry.js';
import {
  prepareTeleport,
  TeleportError,
  uploadTeleport,
  type ResolvedTeleport,
  type ResumeMode,
} from '../session-teleport/index.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { makeProgressReporter } from '../lib/progress.js';
import { openCommandLog } from '../lib/log-file.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

/** Ref shown in the detach notice: the per-project index `n` when set, else the name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
}

function parseMaxRunningOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-running: expected a positive integer, got "${raw}"`);
  }
  return n;
}

function pickCodexCreateOpts(opts: CodexCreateOptions): import('@agentbox/relay').QueueJobCreateOpts {
  return {
    workspace: opts.workspace,
    name: opts.name,
    hostSnapshot: opts.hostSnapshot,
    snapshot: opts.snapshot,
    image: opts.image,
    withPlaywright: opts.withPlaywright,
    withEnv: opts.withEnv,
    vnc: opts.vnc,
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
 * Attach to a box's Codex tmux session through the wrapped-pty footer (same
 * channel `agentbox claude` uses for the host-action prompts), then exit with
 * the inner pty's code. The footer + relay prompt channel are box-level, not
 * claude-specific, so codex reuses them with `mode: 'codex'`.
 */
async function attachCodexWrapped(
  box: { id: string; name: string; container: string; projectIndex?: number },
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
): Promise<never> {
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildCodexAttachArgv(box.container, sessionName),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'codex',
    detachable: true,
    detachNotice: formatDetachNotice(reattach, 'codex'),
    onError,
    openIn,
  });
  process.exit(code);
}

interface CodexCreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  yes?: boolean;
  isolateCodexConfig?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** --carry-yes (or AGENTBOX_CARRY_YES=1): auto-approve the carry: block. */
  carryYes?: boolean;
  /** --carry <mode>: 'skip' disables carry for this run (also AGENTBOX_CARRY=skip). */
  carry?: 'skip' | 'ask';
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
  /** -v / --verbose: bypass the spinner and stream raw provider output. */
  verbose?: boolean;
  /** Raw `--attach-in <mode>` value; validated by `parseAttachInOption`. */
  attachIn?: string;
  /** --inline: shortcut for `--attach-in same` (long-form only — `-i` is `--initial-prompt`). */
  inline?: boolean;
  /** Commander parses `-b, --no-attach` as `attach: false` (defaults true). */
  attach?: boolean;
  /** `-i, --initial-prompt <text>`: seed codex with this user turn; runs in background. */
  initialPrompt?: string;
  /** Per-invocation override of `queue.maxConcurrent`. */
  maxRunning?: string;
  /** `-c, --continue`: teleport and resume the most recent host codex session for this cwd. */
  continue?: boolean;
  /** `--resume <id>`: teleport and resume the specified host codex session uuid. */
  resume?: string;
}

function buildCodexCliOverrides(opts: CodexCreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.isolateCodexConfig === true) box.isolateCodexConfig = true;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  const codex: NonNullable<UserConfig['codex']> = {};
  if (opts.sessionName !== undefined) codex.sessionName = opts.sessionName;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (Object.keys(codex).length > 0) out.codex = codex;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  const attachIn = resolveAttachInOption(opts);
  if (attachIn !== undefined) out.attach = { openIn: attachIn };
  return out;
}

/**
 * Run `codex login` in a throwaway container against the shared codex-config
 * volume — credentials persist there and seed every later box. Defaults to the
 * `--device-auth` device-code flow (see {@link buildCodexLoginRunArgv}).
 */
async function runCodexLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractiveCodexLogin(
    buildCodexLoginRunArgv({ volume: SHARED_CODEX_VOLUME, image, extraArgs }),
  );
  return exitCode;
}

/**
 * First-run sign-in offer, shown before box creation. When no Codex
 * credentials are available, prompts the user and (on confirm) runs
 * `codex login` in a throwaway container — the result seeds every future box
 * via the shared volume. Silent no-op when already authenticated, in
 * non-interactive runs, or with `--yes`.
 */
async function maybeRunCodexLogin(args: { image: string; yes: boolean }): Promise<void> {
  if (!process.stdin.isTTY || args.yes) return;
  if (await codexAuthAvailable(args.image)) return;

  const answer = await confirm({
    message: 'Sign in to Codex? (saved and reused by every box)',
    initialValue: true,
  });
  if (isCancel(answer) || !answer) {
    log.info('Skipped sign-in — codex will prompt you to sign in inside the box.');
    return;
  }

  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(args.image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
  // Ensure the shared volume exists (and is vscode-writable) before the login
  // container writes auth.json into it.
  s.message('preparing codex config');
  await ensureCodexVolume({ volume: SHARED_CODEX_VOLUME }, { syncFromHost: true, image: args.image });
  s.stop('image ready');

  const exitCode = await runCodexLoginContainer(args.image, []);
  if (exitCode !== 0) {
    log.warn('Codex login did not complete; continuing — run `agentbox codex login` to retry.');
    return;
  }
  log.success('Signed in to Codex — saved for future boxes.');
}

export const codexCommand = new Command('codex')
  .description('Create a sandboxed box and launch OpenAI Codex in a detachable tmux session')
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
    '--isolate-codex-config',
    'use a per-box ~/.codex volume instead of the shared agentbox-codex-config',
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
  .option('--session-name <name>', 'tmux session name (default from config; built-in: codex)')
  .option('--memory <size>', 'memory ceiling (e.g. 512m, 2g); unset = unlimited')
  .option('--cpus <n>', 'CPU count cap (fractional ok, e.g. 1.5); unset = unlimited')
  .option('--pids-limit <n>', 'max process count (PIDs cgroup); unset = unlimited')
  .option('--disk <size>', 'best-effort writable-layer size (e.g. 10g); no-op on overlay2/macOS')
  .option(
    '--provider <name>',
    "sandbox backend: 'docker' (default) or 'daytona' for a cloud box",
  )
  .option(
    '-v, --verbose',
    'bypass the spinner and stream raw provider output to stderr. The same content always lands in ~/.agentbox/logs/codex.log.',
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('--inline', INLINE_HELP)
  .option('-b, --no-attach', NO_ATTACH_HELP)
  .option(
    '-i, --initial-prompt <text>',
    'seed the codex session with this initial user turn and run in background (no attach). Jobs go through the host-wide queue (queue.maxConcurrent).',
  )
  .option(
    '--max-running <n>',
    'per-invocation override of queue.maxConcurrent; only honored when `-i` is set',
  )
  .option(
    '-c, --continue',
    'teleport the most recent host Codex session for this cwd into the box and resume from it',
  )
  .option(
    '--resume <id>',
    'teleport the specified host Codex session uuid into the box and resume from it',
  )
  .argument(
    '[codex-args...]',
    "extra args passed to codex inside the box; place after `--`, e.g. `agentbox codex -- -m gpt-5.4`",
  )
  .action(async (codexArgs: string[], opts: CodexCreateOptions) => {
    const cmdLog = openCommandLog('codex');
    process.stderr.write(`log: ${cmdLog.path}\n`);
    intro('Starting Codex in a box...');

    let resumeMode: ResumeMode | null = null;
    if (opts.continue === true && opts.resume) {
      log.error('only one of -c / --continue / --resume can be passed');
      cmdLog.close();
      process.exit(2);
    }
    if (opts.continue === true) resumeMode = { kind: 'continue' };
    else if (opts.resume) resumeMode = { kind: 'resume', id: opts.resume };
    if (resumeMode && opts.initialPrompt && opts.initialPrompt.length > 0) {
      log.error('-i / --initial-prompt cannot be combined with -c / --resume.');
      cmdLog.close();
      process.exit(2);
    }
    let resumePrepared: ResolvedTeleport | null = null;
    if (resumeMode) {
      try {
        resumePrepared = await prepareTeleport({
          agent: 'codex',
          hostCwd: opts.workspace,
          mode: resumeMode,
          log: (line) => cmdLog.write(line),
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
      cliOverrides: buildCodexCliOverrides(opts),
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

    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      if (isCloud) {
        log.error('-i / --initial-prompt is currently docker-only (cloud sessions only start on attach).');
        cmdLog.close();
        process.exit(2);
      }
      try {
        await assertAgentCredsAvailable({
          agent: 'codex',
          image: cfg.effective.box.image,
        });
      } catch (err) {
        if (err instanceof MissingAgentCredsError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
      const maxRunningOverride = parseMaxRunningOption(opts.maxRunning);
      const result = await submitQueueJob({
        agent: 'codex',
        boxName: opts.name ?? '',
        providerName,
        prompt: opts.initialPrompt,
        agentArgs: codexArgs,
        createOpts: pickCodexCreateOpts(opts),
        maxRunningOverride,
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
          carry: carryEntries,
          vnc: { enabled: cfg.effective.box.vnc },
          limits: resolveLimits(cfg.effective.box, opts),
          projectRoot,
        },
        binary: 'codex',
        sessionName: cfg.effective.codex.sessionName,
        mode: 'codex',
        extraArgs: codexArgs,
        verbose: opts.verbose === true,
        openIn: cfg.effective.attach.openIn,
        attach: opts.attach !== false,
        beforeStart: resumePrepared
          ? async (box) => {
              try {
                await uploadTeleport({
                  box,
                  provider,
                  resolved: resumePrepared!,
                  log: (line) => cmdLog.write(line),
                });
                return { agentArgsPrefix: resumePrepared!.forwardArgs };
              } catch (err) {
                if (err instanceof TeleportError) {
                  log.error(err.message);
                  cmdLog.close();
                  process.exit(2);
                }
                throw err;
              }
            }
          : undefined,
      });
      return;
    }

    // First-run sign-in offer — before any box work, so the user signs in up
    // front. Uses a throwaway container; the result seeds every future box.
    await maybeRunCodexLogin({ image: cfg.effective.box.image, yes: !!opts.yes });

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
    const sessionName = cfg.effective.codex.sessionName;

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
        image: cfg.effective.box.image,
        codexConfig: { isolate: cfg.effective.box.isolateCodexConfig },
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

      // Codex is baked into the current base image, but a box built from a
      // checkpoint captured before Codex support won't have it — install it
      // into the box's writable layer in that case (fast no-op otherwise).
      s.message('checking codex');
      cmdLog.write('checking codex');
      await ensureCodexInstalled(result.record.container, {
        onProgress: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });

      let effectiveCodexArgs = codexArgs;
      if (resumePrepared) {
        s.message('uploading codex session into box');
        cmdLog.write('uploading codex session into box');
        try {
          const provider = await providerForBox(result.record);
          await uploadTeleport({
            box: result.record,
            provider,
            resolved: resumePrepared,
            log: (line) => {
              s.message(clampSpinnerLine(line));
              cmdLog.write(line);
            },
          });
          effectiveCodexArgs = [...resumePrepared.forwardArgs, ...effectiveCodexArgs];
        } catch (err) {
          if (err instanceof TeleportError) {
            s.stop('teleport failed');
            log.error(err.message);
            log.info(
              `The box ${result.record.container} is up but unused. Destroy it with: agentbox destroy ${result.record.container} -y`,
            );
            cmdLog.close();
            process.exit(2);
          }
          throw err;
        }
      }

      s.message('starting codex session');
      await startCodexSession({
        container: result.record.container,
        codexArgs: effectiveCodexArgs,
        sessionName,
      });

      const nSuffix =
        typeof result.record.projectIndex === 'number'
          ? `  ·  n ${String(result.record.projectIndex)}`
          : '';
      s.stop(`box ${result.record.container} ready${nSuffix}`);

      if (opts.attach === false) {
        outro(
          `session started — attach with: agentbox codex attach ${reattachRef(result.record)}`,
        );
        return;
      }
      outro('attaching — Control+a d to detach, leaves codex running');
      await attachCodexWrapped(
        result.record,
        sessionName,
        reattachRef(result.record),
        (m) => cmdLog.write(m),
        cfg.effective.attach.openIn,
      );
    } catch (err) {
      s.stop('failed');
      cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (err instanceof CodexSessionError) {
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

interface CodexStartOptions {
  sessionName?: string;
  syncConfig?: boolean; // commander: --no-sync-config => false; default true
  attachIn?: string; // raw `--attach-in <mode>` value, validated below.
  inline?: boolean; // -i / --inline: shortcut for --attach-in same.
  attach?: boolean; // commander: --no-attach => false; default true.
  continue?: boolean;
  resume?: string;
}

// Shared by `codex start` and `codex attach`: if a session is already running,
// just attach; otherwise auto-unpause/start the box, (optionally) resync
// ~/.codex, launch codex, then attach.
async function startOrAttachCodex(
  box: BoxRecord,
  codexArgs: string[],
  opts: CodexStartOptions,
  resumePrepared?: ResolvedTeleport | null,
): Promise<void> {
  const attachIn = resolveAttachInOption(opts);
  const cliOverrides: Partial<UserConfig> = {};
  if (opts.sessionName) cliOverrides.codex = { sessionName: opts.sessionName };
  if (attachIn !== undefined) cliOverrides.attach = { openIn: attachIn };
  const cfg = await loadEffectiveConfig(box.workspacePath, { cliOverrides });
  const sessionName = cfg.effective.codex.sessionName;
  const openIn = cfg.effective.attach.openIn;
  const wantAttach = opts.attach !== false;

  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }

  // If a tmux session already exists, just attach — no resync, ignore any
  // post-`--` args (they only apply to a fresh codex).
  const existing = await codexSessionInfo(box.container, sessionName);
  if (existing.running) {
    if (resumePrepared) {
      throw new Error(
        `cannot resume into ${box.name}: a Codex session is already running. Kill it first or use \`agentbox codex attach\`.`,
      );
    }
    if (!wantAttach) {
      outro(
        `session "${sessionName}" already running — attach with: agentbox codex attach ${reattachRef(box)}`,
      );
      return;
    }
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachCodexWrapped(box, sessionName, reattachRef(box), undefined, openIn);
    return;
  }

  // First-run sign-in offer — before any box prep.
  await maybeRunCodexLogin({ image: box.image, yes: false });

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

  // Re-sync host ~/.codex into the box volume (default; opt out with
  // --no-sync-config). Skipped for `codex attach`, and for boxes that have no
  // codex volume mounted (created via a plain `agentbox create` on a host
  // without ~/.codex) — codex still runs against the container-local ~/.codex.
  const syncConfig = opts.syncConfig !== false;
  if (syncConfig && box.codexConfigVolume) {
    s.message('syncing ~/.codex into box volume');
    await ensureCodexVolume(
      { volume: box.codexConfigVolume },
      { syncFromHost: true, image: box.image },
    );
  }
  // Re-seed the Codex activity hooks (box-only, image-versioned — runs even
  // with --no-sync-config so an image upgrade still propagates).
  if (box.codexConfigVolume) {
    await seedCodexHooks(box.codexConfigVolume, box.image);
  }

  // Install codex if the box image lacks it (checkpoint predating Codex).
  s.message('checking codex');
  await ensureCodexInstalled(box.container, {
    onProgress: (line) => s.message(clampSpinnerLine(line)),
  });

  let effectiveArgs = codexArgs;
  if (resumePrepared) {
    s.message('uploading codex session into box');
    try {
      const provider = await providerForBox(box);
      await uploadTeleport({
        box,
        provider,
        resolved: resumePrepared,
        log: (line) => s.message(clampSpinnerLine(line)),
      });
      effectiveArgs = [...resumePrepared.forwardArgs, ...effectiveArgs];
    } catch (err) {
      if (err instanceof TeleportError) {
        s.stop('teleport failed');
        log.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  }

  s.message('starting codex session');
  await startCodexSession({ container: box.container, codexArgs: effectiveArgs, sessionName });

  s.stop(`box ${box.container} ready`);

  if (!wantAttach) {
    outro(
      `session "${sessionName}" started — attach with: agentbox codex attach ${reattachRef(box)}`,
    );
    return;
  }
  outro('attaching — Control+a d to detach, leaves codex running');
  await attachCodexWrapped(box, sessionName, reattachRef(box), undefined, openIn);
}

const codexAttachCommand = new Command('attach')
  .description(
    'Attach to a Codex tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs ~/.codex — use `codex start` for that)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: codex)')
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .action(async function (this: Command, idOrName: string | undefined) {
    const opts = this.optsWithGlobals() as CodexStartOptions;
    intro('Attaching to Codex session...');
    try {
      const attachIn = resolveAttachInOption(opts);
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        await cloudAgentAttach({
          box,
          binary: 'codex',
          sessionName: opts.sessionName ?? 'codex',
          mode: 'codex',
          openIn: cfg.effective.attach.openIn,
        });
        return;
      }
      await startOrAttachCodex(box, [], { ...opts, syncConfig: false });
    } catch (err) {
      if (err instanceof CodexSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const codexStartCommand = new Command('start')
  .description(
    'Start a Codex tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: codex)')
  .option(
    '--no-sync-config',
    "skip rsyncing the host's ~/.codex into the box's volume before starting (faster; use existing in-box state)",
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .option('-b, --no-attach', NO_ATTACH_HELP)
  .option(
    '-c, --continue',
    'teleport the most recent host Codex session for this cwd into the box and resume',
  )
  .option(
    '--resume <id>',
    'teleport the specified host Codex session uuid into the box and resume',
  )
  .argument(
    '[codex-args...]',
    "extra args passed to codex when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox codex start 1 -- -m gpt-5.4`",
  )
  .action(async function (this: Command, idOrName: string | undefined, codexArgs: string[]) {
    const opts = this.optsWithGlobals() as CodexStartOptions;
    intro('Starting Codex in a box...');
    try {
      const attachIn = resolveAttachInOption(opts);
      // Two positionals make commander bind the first post-`--` token to
      // `[box]`; resolveBoxOrShift detects that and auto-picks the box.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      let effectiveCodexArgs = shifted && idOrName ? [idOrName, ...codexArgs] : codexArgs;
      let resumeMode: ResumeMode | null = null;
      if (opts.continue === true && opts.resume) {
        log.error('only one of -c / --continue / --resume can be passed');
        process.exit(2);
      }
      if (opts.continue === true) resumeMode = { kind: 'continue' };
      else if (opts.resume) resumeMode = { kind: 'resume', id: opts.resume };
      let resumePrepared: ResolvedTeleport | null = null;
      if (resumeMode) {
        try {
          resumePrepared = await prepareTeleport({
            agent: 'codex',
            hostCwd: box.workspacePath,
            mode: resumeMode,
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
        if (opts.attach === false) {
          outro(
            `--no-attach: cloud agent sessions are started lazily on attach. Run: agentbox codex attach ${reattachRef(box)}`,
          );
          return;
        }
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        if (resumePrepared) {
          try {
            const provider = await providerForBox(box);
            await uploadTeleport({ box, provider, resolved: resumePrepared });
            effectiveCodexArgs = [...resumePrepared.forwardArgs, ...effectiveCodexArgs];
          } catch (err) {
            if (err instanceof TeleportError) {
              log.error(err.message);
              process.exit(2);
            }
            throw err;
          }
        }
        await cloudAgentAttach({
          box,
          binary: 'codex',
          sessionName: opts.sessionName ?? 'codex',
          mode: 'codex',
          extraArgs: effectiveCodexArgs,
          openIn: cfg.effective.attach.openIn,
        });
        return;
      }
      await startOrAttachCodex(box, effectiveCodexArgs, opts, resumePrepared);
    } catch (err) {
      if (err instanceof CodexSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const codexLoginCommand = new Command('login')
  .description(
    'Sign in to Codex for use in sandboxes. Runs `codex login` in a throwaway container against the shared codex-config volume (default: --device-auth; pass e.g. `-- --api-key`). Usable before the first `agentbox codex`.',
  )
  .argument(
    '[args...]',
    'extra args forwarded to `codex login` (default: --device-auth); place after `--`, e.g. `agentbox codex login -- --api-key`',
  )
  .action(async (args: string[]) => {
    intro('Signing in to Codex...');
    if (!process.stdin.isTTY) {
      log.error('`agentbox codex login` needs an interactive terminal.');
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
      s.message('preparing codex config');
      await ensureCodexVolume({ volume: SHARED_CODEX_VOLUME }, { syncFromHost: true, image });
      s.stop('image ready');

      const exitCode = await runCodexLoginContainer(image, args);
      if (exitCode !== 0) {
        log.warn(`\`codex login\` exited with code ${String(exitCode)}`);
        process.exit(exitCode);
      }
      outro('signed in — credentials saved for future boxes');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

codexCommand.addCommand(codexAttachCommand);
codexCommand.addCommand(codexStartCommand);
codexCommand.addCommand(codexLoginCommand);
