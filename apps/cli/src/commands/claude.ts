import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type AttachOpenIn,
  type UserConfig,
} from '@agentbox/config';
import {
  buildClaudeAttachArgv,
  buildClaudeLoginRunArgv,
  ClaudeSessionError,
  claudeSessionInfo,
  createBox,
  DEFAULT_RELAY_PORT,
  detectEngine,
  ensureClaudeVolume,
  ensureImage,
  formatDetachNotice,
  hostBackupHasCredentials,
  inspectBox,
  rebuildPluginNativeDeps,
  runInteractiveClaudeLogin,
  seedSetupSkillIntoVolume,
  SHARED_CLAUDE_VOLUME,
  startBox,
  startClaudeSession,
  syncClaudeCredentials,
  unpauseBox,
  warmUpClaudeCredentials,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveClaudeAuth, type ResolvedClaudeAuth } from '../auth.js';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import {
  assertAgentCredsAvailable,
  MissingAgentCredsError,
} from '../lib/queue/assert-creds.js';
import { buildPromptArgs } from '../lib/queue/build-prompt-args.js';
import { submitQueueJob } from '../lib/queue/submit.js';
import {
  ATTACH_IN_HELP,
  INLINE_HELP,
  NO_ATTACH_HELP,
  resolveAttachInOption,
} from './_attach-in.js';
import { cloudAgentAttach } from './_cloud-attach.js';
import { cloudAgentCreate } from './_cloud-agent-create.js';
import { providerForCreate } from '../provider/registry.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { makeProgressReporter } from '../lib/progress.js';
import { openCommandLog } from '../lib/log-file.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { maybeRunSetupWizard } from '../wizard.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

/** Ref shown in the detach notice: the per-project index `n` when set
 *  (resolves from inside the project dir), else the globally-unique name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
}

/** Validate `--max-running <n>` from commander into a positive integer; throws on garbage. */
function parseMaxRunningOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-running: expected a positive integer, got "${raw}"`);
  }
  return n;
}

/** Project an agent-create options struct down to what the queue worker needs. */
function pickCreateOpts(opts: ClaudeCreateOptions): import('@agentbox/relay').QueueJobCreateOpts {
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

/** Log how much the plugin-cache prune reclaimed, when it reclaimed anything. */
function logPrune(rebuild: { pruned: string[]; prunedBytes: number }): void {
  if (rebuild.prunedBytes <= 0) return;
  const mb = Math.round(rebuild.prunedBytes / 1024 / 1024);
  const n = rebuild.pruned.length;
  log.info(`pruned ${String(n)} stale plugin cache${n === 1 ? '' : 's'} (${String(mb)} MB freed)`);
}

/** Host-side URL for the relay (always loopback for the wrapper's SSE subscription). */
const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

/**
 * Replacement for the old `attachClaudeSession`: builds the docker tmux-
 * attach argv, hands it to the node-pty wrapper for the footer + prompt
 * channel, then exits with the inner pty's exit code. Falls back
 * transparently to plain spawnSync inside `runWrappedAttach` when stdio
 * isn't a TTY or node-pty isn't installed.
 */
async function attachClaudeWrapped(
  box: { id: string; name: string; container: string; projectIndex?: number },
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
): Promise<never> {
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildClaudeAttachArgv(box.container, sessionName),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'claude',
    detachNotice: formatDetachNotice(reattach),
    onError,
    openIn,
  });
  process.exit(code);
}

interface ClaudeCreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  yes?: boolean;
  isolateClaudeConfig?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
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
  /**
   * `-i, --initial-prompt <text>`: seed the claude TUI with this user turn
   * and run in background mode (no attach). Jobs go through the host-wide
   * queue; `--max-running` overrides `queue.maxConcurrent` for this job.
   */
  initialPrompt?: string;
  /** Per-invocation override of `queue.maxConcurrent` (number string from commander). */
  maxRunning?: string;
}

function buildClaudeCliOverrides(opts: ClaudeCreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.isolateClaudeConfig === true) box.isolateClaudeConfig = true;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  const claude: NonNullable<UserConfig['claude']> = {};
  if (opts.sessionName !== undefined) claude.sessionName = opts.sessionName;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (Object.keys(claude).length > 0) out.claude = claude;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  const attachIn = resolveAttachInOption(opts);
  if (attachIn !== undefined) out.attach = { openIn: attachIn };
  return out;
}

/**
 * Run `claude auth login` in a throwaway container against the shared
 * claude-config volume, then extract the result to the host backup so every
 * future box (shared or isolate) is seeded from it. Returns the login
 * command's exit code.
 */
async function runClaudeLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractiveClaudeLogin(
    buildClaudeLoginRunArgv({ volume: SHARED_CLAUDE_VOLUME, image, extraArgs }),
  );
  if (exitCode === 0) {
    // Absorb the fresh-token first-request 400 in a throwaway container before
    // any box uses these credentials (see warmUpClaudeCredentials). Runs before
    // syncClaudeCredentials so the host backup captures any token the warm-up
    // refreshes.
    const s = spinner();
    s.start('checking credentials');
    const warm = await warmUpClaudeCredentials(SHARED_CLAUDE_VOLUME, image, {
      onProgress: (line) => s.message(clampSpinnerLine(line)),
    });
    s.stop(warm.warmed ? 'credentials ready' : 'credentials check incomplete — continuing');
    await syncClaudeCredentials({ volume: SHARED_CLAUDE_VOLUME }, { image, isolate: false });
  }
  return exitCode;
}

/**
 * First-run sign-in offer, shown before box creation / the setup wizard. When
 * no credentials are available yet, prompts the user and (on confirm) runs
 * `claude auth login` in a throwaway container — the result seeds every future
 * box via the host backup. Silent no-op when credentials already exist, in
 * non-interactive runs, or when the user provided auth via host env.
 */
async function maybeRunClaudeLogin(args: {
  image: string;
  authSource: ResolvedClaudeAuth['source'];
  yes: boolean;
  /** Host workspace path — seeds the project-scoped `/workspace` alias into
   *  the volume's `_claude.json` before the login container runs. */
  hostWorkspace: string;
}): Promise<void> {
  // Skip when: non-interactive / --yes; the user explicitly provided auth via
  // host env (respect an intentional ANTHROPIC_API_KEY); or the host backup
  // already holds real credentials (every box gets seeded from it). A legacy
  // auth.json setup-token (`auth-file`) still gets the offer — that is the
  // "Claude API" -> subscription upgrade.
  if (!process.stdin.isTTY || args.yes) return;
  if (args.authSource === 'host-env') return;
  if (await hostBackupHasCredentials()) return;

  const message =
    args.authSource === 'auth-file'
      ? "You're on a legacy API token (shows as 'Claude API'). Sign in with your Claude subscription instead?"
      : 'Sign in with your Claude subscription? (saved and reused by every box)';
  const answer = await confirm({ message, initialValue: true });
  if (isCancel(answer) || !answer) {
    log.info('Skipped sign-in — claude will prompt you to /login inside the box.');
    return;
  }

  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(args.image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
  // Seed the shared claude-config volume from the host's ~/.claude *before*
  // the login container runs, so `claude auth login` writes its oauthAccount
  // on top of the host config (trust, installMethod, project alias) rather
  // than into an empty volume. ensureClaudeVolume is write-once for
  // _claude.json, so the later createBox sync can't clobber the login's work.
  s.message('preparing claude config');
  await ensureClaudeVolume(
    { volume: SHARED_CLAUDE_VOLUME },
    { syncFromHost: true, image: args.image, hostWorkspace: args.hostWorkspace },
  );
  s.stop('image ready');

  const exitCode = await runClaudeLoginContainer(args.image, ['--claudeai']);
  if (exitCode !== 0) {
    log.warn('Claude login did not complete; continuing — run `agentbox claude login` to retry.');
    return;
  }
  log.success('Signed in with your Claude subscription — saved for future boxes.');
}

export const claudeCommand = new Command('claude')
  .description('Create a sandboxed box and launch Claude Code in a detachable tmux session')
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
    '--isolate-claude-config',
    'use a per-box ~/.claude volume instead of the shared agentbox-claude-config',
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
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
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
    'bypass the spinner and stream raw provider output (docker build / Daytona snapshot create) to stderr. The same content always lands in ~/.agentbox/logs/claude.log.',
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('--inline', INLINE_HELP)
  .option('-b, --no-attach', NO_ATTACH_HELP)
  .option(
    '-i, --initial-prompt <text>',
    'seed the claude session with this initial user turn and run in background (no attach). Jobs go through the host-wide queue (queue.maxConcurrent). NOTE: this is NOT claude\'s own `-p` headless print mode — for that, pass `-- -p ...`.',
  )
  .option(
    '--max-running <n>',
    'per-invocation override of queue.maxConcurrent; only honored when `-i` is set',
  )
  .argument(
    '[claude-args...]',
    "extra args passed to claude inside the box; place after `--`, e.g. `agentbox claude -- --model sonnet`",
  )
  .action(async (claudeArgs: string[], opts: ClaudeCreateOptions) => {
    const cmdLog = openCommandLog('claude');
    process.stderr.write(`log: ${cmdLog.path}\n`);
    intro('Starting Claude in a box...');

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildClaudeCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    // Resolve provider once. The --provider flag wins, then box.provider config,
    // then default 'docker'. The Docker-only fast path below skips entirely on
    // cloud — we delegate to the cloud-agent-create helper after running the
    // (provider-agnostic) setup wizard.
    const providerName = opts.provider ?? cfg.effective.box.provider ?? 'docker';
    const isCloud = providerName !== 'docker';

    // -i / --initial-prompt: background mode. Write a queue manifest and exit;
    // the relay's queue loop spawns the worker as a slot frees. Docker-only
    // for v1 — the cloud `cloudAgentCreate` path starts the tmux session
    // lazily on first attach, so a "create but don't attach" cloud run has no
    // chance to seed the prompt.
    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      if (isCloud) {
        log.error('-i / --initial-prompt is currently docker-only (cloud sessions only start on attach).');
        cmdLog.close();
        process.exit(2);
      }
      try {
        await assertAgentCredsAvailable({
          agent: 'claude-code',
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
        agent: 'claude-code',
        boxName: opts.name ?? '',
        providerName,
        prompt: opts.initialPrompt,
        agentArgs: claudeArgs,
        createOpts: pickCreateOpts(opts),
        maxRunningOverride,
      });
      outro(
        `job ${result.job.id} queued (${String(result.runningCount)}/${String(result.maxConcurrent)} running); log: ${result.job.logPath}`,
      );
      cmdLog.close();
      return;
    }
    const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
    const checkpointRef =
      opts.snapshot && opts.snapshot.length > 0
        ? opts.snapshot
        : providerDefault.length > 0
          ? providerDefault
          : undefined;

    // Resolve auth from host env or the legacy ~/.agentbox/auth.json
    // setup-token (the dormant CI fallback).
    const resolved = await resolveClaudeAuth(process.env);

    // First-run sign-in offer is Docker-only — the cloud path seeds creds via
    // the per-agent Daytona volume (see ensureAgentVolumesForCloud).
    if (!isCloud) {
      await maybeRunClaudeLogin({
        image: cfg.effective.box.image,
        authSource: resolved.source,
        yes: !!opts.yes,
        hostWorkspace: opts.workspace,
      });
    }

    // Portless is Docker Desktop-only — skip on cloud.
    const portlessEnabled = isCloud
      ? undefined
      : await maybePromptPortless({
          engine: await detectEngine(),
          enabled: cfg.effective.portless.enabled,
          yes: !!opts.yes,
          cwd: opts.workspace,
        });

    // First-run wizard: when no agentbox.yaml exists, offer to inject an
    // initial user-message so claude reads /agentbox-setup and writes one.
    // Skipped when starting from a checkpoint (it already carries the config).
    const wiz = await maybeRunSetupWizard({
      workspace: opts.workspace,
      yes: !!opts.yes,
      command: 'claude',
      checkpointRef,
      provider: providerName,
      withEnv: cfg.effective.box.withEnv,
    });
    let effectiveClaudeArgs = claudeArgs;
    if (wiz.action === 'launch-with-prompt' && wiz.initialPrompt) {
      effectiveClaudeArgs = buildPromptArgs('claude-code', wiz.initialPrompt, claudeArgs);
    }

    if (isCloud) {
      const provider = await providerForCreate({ flag: opts.provider, config: cfg.effective });
      // browser.default = 'playwright' | 'both' implies installing playwright
      // even if box.withPlaywright wasn't explicitly set.
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
          envFilesToImport: wiz.envFilesToImport,
          vnc: { enabled: cfg.effective.box.vnc },
          limits: resolveLimits(cfg.effective.box, opts),
          projectRoot,
        },
        binary: 'claude',
        sessionName: cfg.effective.claude.sessionName,
        mode: 'claude',
        extraArgs: effectiveClaudeArgs,
        verbose: opts.verbose === true,
        openIn: cfg.effective.attach.openIn,
        attach: opts.attach !== false,
      });
      return;
    }

    // host-snapshot default off: with the overlay retired, the snapshot is
    // only the tar-pipe source for the no-git case, and skipped entirely for
    // git-detected workspaces. Explicit flag/config still wins.
    const useSnapshot =
      opts.hostSnapshot === false
        ? false
        : opts.hostSnapshot === true
          ? true
          : (cfg.effective.box.hostSnapshot ?? false);
    const sessionName = cfg.effective.claude.sessionName;

    const s = makeProgressReporter(opts.verbose === true);
    s.start('creating box');
    let containerName = '';
    try {
      // browser.default = 'playwright' | 'both' implies installing playwright
      // even if box.withPlaywright wasn't explicitly set in any layer.
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        checkpointRef,
        image: cfg.effective.box.image,
        claudeConfig: { isolate: cfg.effective.box.isolateClaudeConfig },
        claudeEnv: resolved.env,
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        envFilesToImport: wiz.envFilesToImport,
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

      // Plugin native deps: the sync excludes `node_modules` (host darwin
      // binaries don't run on linux/amd64). First claude session in a fresh
      // box pays the npm-install cost for each plugin that ships a
      // package.json; subsequent attaches see node_modules already present
      // and exit immediately. Keep the same spinner alive — every phase
      // overwrites the one line instead of leaving a scroll of `●`/`◇` rows.
      s.message('checking plugin native deps');
      cmdLog.write('checking plugin native deps');
      const rebuild = await rebuildPluginNativeDeps(result.record.container, {
        volume: result.record.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
        onProgress: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });

      s.message('starting claude session');
      await startClaudeSession({
        container: result.record.container,
        claudeArgs: effectiveClaudeArgs,
        sessionName,
        boxName: result.record.name,
      });

      const nSuffix =
        typeof result.record.projectIndex === 'number'
          ? `  ·  n ${String(result.record.projectIndex)}`
          : '';
      s.stop(`box ${result.record.container} ready${nSuffix}`);
      logPrune(rebuild);
      for (const f of rebuild.failed) {
        log.warn(`plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`);
      }

      if (opts.attach === false) {
        outro(
          `session started — attach with: agentbox claude attach ${reattachRef(result.record)}`,
        );
        return;
      }
      outro('attaching — Control+a d to detach, leaves claude running');
      await attachClaudeWrapped(
        result.record,
        sessionName,
        reattachRef(result.record),
        (m) => cmdLog.write(m),
        cfg.effective.attach.openIn,
      );
    } catch (err) {
      s.stop('failed');
      cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (err instanceof ClaudeSessionError) {
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

interface ClaudeStartOptions {
  sessionName?: string;
  syncConfig?: boolean; // commander: --no-sync-config => false; default true
  attachIn?: string; // raw `--attach-in <mode>` value, validated below.
  inline?: boolean; // -i / --inline: shortcut for --attach-in same.
  attach?: boolean; // commander: --no-attach => false; default true.
}

// Shared by `claude start` and `claude attach`: if a session is already
// running, just attach; otherwise auto-unpause/start the box, (optionally)
// resync ~/.claude, rebuild plugin native deps, launch claude, then attach.
async function startOrAttachClaude(
  box: BoxRecord,
  claudeArgs: string[],
  opts: ClaudeStartOptions,
): Promise<void> {
  const attachIn = resolveAttachInOption(opts);
  const cliOverrides: Partial<UserConfig> = {};
  if (opts.sessionName) cliOverrides.claude = { sessionName: opts.sessionName };
  if (attachIn !== undefined) cliOverrides.attach = { openIn: attachIn };
  const cfg = await loadEffectiveConfig(box.workspacePath, { cliOverrides });
  const sessionName = cfg.effective.claude.sessionName;
  const openIn = cfg.effective.attach.openIn;
  const wantAttach = opts.attach !== false;
  // Read-only — used to gate the first-run login offer (respect an intentional
  // host ANTHROPIC_API_KEY). The box already exists, so `resolved.env` is not
  // forwarded here.
  const resolved = await resolveClaudeAuth(process.env);

  // Auto-unpause/start. Mirrors `agentbox shell` / `agentbox code`.
  // `startBox` relaunches ctl/vnc/dockerd
  // because those processes die with the container.
  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }

  // If a tmux session already exists, just attach — no resync, no plugin
  // rebuild, ignore any post-`--` args (they only apply to a fresh claude).
  // A login can't be inserted into a live session; an unauthenticated one
  // shows claude's own in-TUI `/login` on attach.
  const existing = await claudeSessionInfo(box.container, sessionName);
  if (existing.running) {
    if (!wantAttach) {
      outro(
        `session "${sessionName}" already running — attach with: agentbox claude attach ${reattachRef(box)}`,
      );
      return;
    }
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachClaudeWrapped(box, sessionName, reattachRef(box), undefined, openIn);
    return;
  }

  // First-run sign-in offer — before any box prep, so the user signs in up
  // front. No-op when credentials already exist or this isn't interactive.
  await maybeRunClaudeLogin({
    image: box.image,
    authSource: resolved.source,
    yes: false,
    hostWorkspace: box.workspacePath,
  });

  // One spinner for the whole prepare→attach sequence: every phase overwrites
  // the single line instead of leaving a scroll of `●`/`◇` rows.
  const s = spinner();
  s.start('preparing box');

  // Auto-unpause/start. `startBox` relaunches
  // ctl/vnc/dockerd because those processes die with the container.
  if (insp.state === 'paused') {
    s.message('unpausing box');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    s.message('starting box');
    await startBox(box.id);
  }

  // Re-sync the host's ~/.claude into the box volume so any updates the user
  // made on the host (new MCP servers, refreshed OAuth state in _claude.json,
  // …) reach the in-box claude. This runs for `claude start` (default; opt out
  // with --no-sync-config) — NOT for `claude attach`, which always passes
  // syncConfig: false: a plain reattach must never clobber the in-box claude's
  // accumulated _claude.json (prompt history) with the host copy.
  const syncConfig = opts.syncConfig !== false;
  if (syncConfig) {
    s.message('syncing ~/.claude into box volume');
    // Use the box's recorded volume so isolated boxes hit their own
    // agentbox-claude-config-<id>, not the shared one.
    const volume = box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME;
    await ensureClaudeVolume(
      { volume },
      {
        syncFromHost: true,
        image: box.image,
        hostWorkspace: box.workspacePath,
      },
    );
  }

  // Box-only: ensure /agentbox-setup is in the volume (image-seeded, never
  // on the host). Re-copied every run so an image upgrade propagates.
  const claudeVolume = box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME;
  await seedSetupSkillIntoVolume(claudeVolume, box.image);

  // Mirror the in-box OAuth credentials with the host backup. Runs regardless
  // of --no-sync-config (this is not the host ~/.claude rsync) — it keeps the
  // backup fresh as the in-box claude rotates its token, and seeds an isolate
  // box's volume from an up-front `maybeRunClaudeLogin`.
  await syncClaudeCredentials(
    { volume: claudeVolume },
    { image: box.image, isolate: claudeVolume !== SHARED_CLAUDE_VOLUME },
  );

  // Plugin native deps: idempotent — gated by a per-plugin marker. No-op
  // on subsequent starts unless a new plugin was synced just now.
  s.message('checking plugin native deps');
  const rebuild = await rebuildPluginNativeDeps(box.container, {
    volume: box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
    onProgress: (line) => s.message(clampSpinnerLine(line)),
  });

  s.message('starting claude session');
  await startClaudeSession({
    container: box.container,
    claudeArgs,
    sessionName,
    boxName: box.name,
  });

  s.stop(`box ${box.container} ready`);
  logPrune(rebuild);
  for (const f of rebuild.failed) {
    log.warn(`plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`);
  }

  if (!wantAttach) {
    outro(
      `session "${sessionName}" started — attach with: agentbox claude attach ${reattachRef(box)}`,
    );
    return;
  }
  outro('attaching — Control+a d to detach, leaves claude running');
  await attachClaudeWrapped(box, sessionName, reattachRef(box), undefined, openIn);
}

const claudeAttachCommand = new Command('attach')
  .description(
    'Attach to a Claude Code tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs ~/.claude — use `claude start` for that)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .action(async function (this: Command, idOrName: string | undefined) {
    // optsWithGlobals merges parent + own options — the parent `claude`
    // command also defines `--session-name`.
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Attaching to Claude session...');
    try {
      const attachIn = resolveAttachInOption(opts);
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        await cloudAgentAttach({
          box,
          binary: 'claude',
          sessionName: opts.sessionName ?? 'claude',
          mode: 'claude',
          openIn: cfg.effective.attach.openIn,
        });
        return;
      }
      // A plain reattach must never touch host config. Force syncConfig off so
      // the no-session path starts a fresh session without the host->volume
      // rsync (which would overwrite the in-box _claude.json / prompt history).
      await startOrAttachClaude(box, [], { ...opts, syncConfig: false });
    } catch (err) {
      if (err instanceof ClaudeSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const claudeStartCommand = new Command('start')
  .description(
    'Start a Claude Code tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
  .option(
    '--no-sync-config',
    "skip rsyncing the host's ~/.claude into the box's volume before starting (faster; use existing in-box state)",
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .option('-b, --no-attach', NO_ATTACH_HELP)
  .argument(
    '[claude-args...]',
    "extra args passed to claude when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox claude start 1 -- --model sonnet`",
  )
  .action(async function (this: Command, idOrName: string | undefined, claudeArgs: string[]) {
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Starting Claude in a box...');
    try {
      const attachIn = resolveAttachInOption(opts);
      // Two positionals (`[box] [claude-args...]`) make commander bind the
      // first post-`--` token (e.g. `--model`) to `[box]`. resolveBoxOrShift
      // detects that, auto-picks the project's single box, and tells us to
      // treat the bound `idOrName` as the first claude-args token instead.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const effectiveClaudeArgs = shifted && idOrName ? [idOrName, ...claudeArgs] : claudeArgs;
      if ((box.provider ?? 'docker') !== 'docker') {
        if (opts.attach === false) {
          outro(
            `--no-attach: cloud agent sessions are started lazily on attach. Run: agentbox claude attach ${reattachRef(box)}`,
          );
          return;
        }
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        await cloudAgentAttach({
          box,
          binary: 'claude',
          sessionName: opts.sessionName ?? 'claude',
          mode: 'claude',
          extraArgs: effectiveClaudeArgs,
          openIn: cfg.effective.attach.openIn,
        });
        return;
      }
      await startOrAttachClaude(box, effectiveClaudeArgs, opts);
    } catch (err) {
      if (err instanceof ClaudeSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const claudeLoginCommand = new Command('login')
  .description(
    'Sign in to Claude for use in sandboxes (forwards args to `claude auth login`, e.g. --sso, --console). Runs in a throwaway container against the shared claude-config volume — usable before the first `agentbox claude`.',
  )
  .argument(
    '[args...]',
    'extra args forwarded to `claude auth login`; place after `--`, e.g. `agentbox claude login -- --sso`',
  )
  .action(async (args: string[]) => {
    intro('Signing in to Claude...');
    if (!process.stdin.isTTY) {
      log.error('`agentbox claude login` needs an interactive terminal.');
      process.exit(1);
    }
    try {
      const cfg = await loadEffectiveConfig(process.cwd());
      const image = cfg.effective.box.image;

      const s = spinner();
      s.start('preparing sandbox image');
      await ensureImage(image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
      s.stop('image ready');

      // Throwaway `docker run` against the shared volume — the written
      // credentials persist there and `syncClaudeCredentials` mirrors them to
      // the host backup, so every later box (shared or isolate) is seeded.
      const exitCode = await runClaudeLoginContainer(image, args);
      if (exitCode !== 0) {
        log.warn(`\`claude auth login\` exited with code ${String(exitCode)}`);
        process.exit(exitCode);
      }
      outro('signed in — credentials saved for future boxes');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

claudeCommand.addCommand(claudeAttachCommand);
claudeCommand.addCommand(claudeStartCommand);
claudeCommand.addCommand(claudeLoginCommand);
