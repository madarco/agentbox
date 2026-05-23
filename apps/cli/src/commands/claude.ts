import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import { findProjectRoot, loadEffectiveConfig, type UserConfig } from '@agentbox/config';
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
import { resolveAgentLauncher } from '@agentbox/core';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { maybeRunSetupWizard } from '../wizard.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';
import { requireDockerProvider } from './_provider-guard.js';

/** Ref shown in the detach notice: the per-project index `n` when set
 *  (resolves from inside the project dir), else the globally-unique name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
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
  .argument(
    '[claude-args...]',
    "extra args passed to claude inside the box; place after `--`, e.g. `agentbox claude -- --model sonnet`",
  )
  .action(async (claudeArgs: string[], opts: ClaudeCreateOptions) => {
    intro('Starting Claude in a box...');

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildClaudeCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    const checkpointRef =
      opts.snapshot && opts.snapshot.length > 0
        ? opts.snapshot
        : cfg.effective.box.defaultCheckpoint.length > 0
          ? cfg.effective.box.defaultCheckpoint
          : undefined;

    // Resolve auth from host env or the legacy ~/.agentbox/auth.json
    // setup-token (the dormant CI fallback).
    const resolved = await resolveClaudeAuth(process.env);

    // First-run sign-in offer — before the env-file picker and the setup
    // wizard, and before any box work, so the user signs in up front. Uses a
    // throwaway container; the result seeds every future box via the host
    // backup. No-op when credentials already exist or this isn't interactive.
    await maybeRunClaudeLogin({
      image: cfg.effective.box.image,
      authSource: resolved.source,
      yes: !!opts.yes,
      hostWorkspace: opts.workspace,
    });

    // First-run Portless opt-in (Docker Desktop only). Persists once per
    // machine to the global config; the resolved flag goes into createBox.
    const portlessEnabled = await maybePromptPortless({
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
      withEnv: cfg.effective.box.withEnv,
    });
    let effectiveClaudeArgs = claudeArgs;
    if (wiz.action === 'launch-with-prompt' && wiz.initialPrompt) {
      effectiveClaudeArgs = resolveAgentLauncher('claude-code').buildArgs(
        wiz.initialPrompt,
        claudeArgs,
      );
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

    const s = spinner();
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
        onLog: (line) => s.message(clampSpinnerLine(line)),
      });
      containerName = result.record.container;

      // Plugin native deps: the sync excludes `node_modules` (host darwin
      // binaries don't run on linux/amd64). First claude session in a fresh
      // box pays the npm-install cost for each plugin that ships a
      // package.json; subsequent attaches see node_modules already present
      // and exit immediately. Keep the same spinner alive — every phase
      // overwrites the one line instead of leaving a scroll of `●`/`◇` rows.
      s.message('checking plugin native deps');
      const rebuild = await rebuildPluginNativeDeps(result.record.container, {
        volume: result.record.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
        onProgress: (line) => s.message(clampSpinnerLine(line)),
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

      outro('attaching — Control+a d to detach, leaves claude running');
      await attachClaudeWrapped(result.record, sessionName, reattachRef(result.record));
    } catch (err) {
      s.stop('failed');
      if (err instanceof ClaudeSessionError) {
        log.error(err.message);
        if (containerName) {
          log.info(`The box ${containerName} is still running. Destroy it with:`);
          log.info(`  agentbox destroy ${containerName} -y`);
        }
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

interface ClaudeStartOptions {
  sessionName?: string;
  syncConfig?: boolean; // commander: --no-sync-config => false; default true
}

// Shared by `claude start` and `claude attach`: if a session is already
// running, just attach; otherwise auto-unpause/start the box, (optionally)
// resync ~/.claude, rebuild plugin native deps, launch claude, then attach.
async function startOrAttachClaude(
  box: BoxRecord,
  claudeArgs: string[],
  opts: ClaudeStartOptions,
): Promise<void> {
  const cfg = await loadEffectiveConfig(box.workspacePath, {
    cliOverrides: opts.sessionName ? { claude: { sessionName: opts.sessionName } } : {},
  });
  const sessionName = cfg.effective.claude.sessionName;
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
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachClaudeWrapped(box, sessionName, reattachRef(box));
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

  outro('attaching — Control+a d to detach, leaves claude running');
  await attachClaudeWrapped(box, sessionName, reattachRef(box));
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
  .action(async function (this: Command, idOrName: string | undefined) {
    // optsWithGlobals merges parent + own options — the parent `claude`
    // command also defines `--session-name`.
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Attaching to Claude session...');
    try {
      const box = await resolveBoxOrExit(idOrName);
      requireDockerProvider(box, 'claude');
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
  .argument(
    '[claude-args...]',
    "extra args passed to claude when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox claude start 1 -- --model sonnet`",
  )
  .action(async function (this: Command, idOrName: string | undefined, claudeArgs: string[]) {
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Starting Claude in a box...');
    try {
      // Two positionals (`[box] [claude-args...]`) make commander bind the
      // first post-`--` token (e.g. `--model`) to `[box]`. resolveBoxOrShift
      // detects that, auto-picks the project's single box, and tells us to
      // treat the bound `idOrName` as the first claude-args token instead.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      requireDockerProvider(box, 'claude');
      const effectiveClaudeArgs = shifted && idOrName ? [idOrName, ...claudeArgs] : claudeArgs;
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
