import { confirm, intro, isCancel, log, outro, password, spinner } from '@clack/prompts';
import { findProjectRoot, loadEffectiveConfig, type UserConfig } from '@agentbox/config';
import {
  buildClaudeAttachArgv,
  ClaudeSessionError,
  claudeSessionInfo,
  createBox,
  DEFAULT_RELAY_PORT,
  ensureClaudeVolume,
  formatDetachNotice,
  inspectBox,
  rebuildPluginNativeDeps,
  seedSetupSkillIntoVolume,
  SHARED_CLAUDE_VOLUME,
  startBox,
  startClaudeSession,
  unpauseBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import {
  AUTH_FILE,
  hostClaudeAvailable,
  isPlausibleOauthToken,
  resolveClaudeAuth,
  runHostSetupToken,
  writeAuthFile,
  type ResolvedClaudeAuth,
} from '../auth.js';
import { resolveAgentLauncher } from '@agentbox/core';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { resolveLimits } from '../limits.js';
import { maybeRunSetupWizard } from '../wizard.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

/** Ref shown in the detach notice: the per-project index `n` when set
 *  (resolves from inside the project dir), else the globally-unique name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
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
  return out;
}


/**
 * First-run onboarding. Spawn `claude setup-token` interactively (if the host has
 * Claude Code installed), then prompt the user to paste the token. Save it to
 * ~/.agentbox/auth.json (mode 0600) and return the env shape that should be
 * forwarded to the box. Returns null when the user declines or skips.
 */
async function offerSetupToken(): Promise<ResolvedClaudeAuth | null> {
  log.info('first time setup: setup token for Claude Code');

  const canRun = hostClaudeAvailable();
  if (canRun) {
    const yes = await confirm({
      message: 'Run `claude setup-token` now to save a token?',
      initialValue: true,
    });
    if (isCancel(yes) || !yes) {
      log.info('ok, continuing without a saved token; /login inside the box once and it persists in the shared volume.');
      return null;
    }
    const { exitCode } = runHostSetupToken();
    if (exitCode !== 0) {
      log.warn(`\`claude setup-token\` exited with code ${String(exitCode)}; you can still paste a token below if you have one.`);
    }
  } else {
    log.warn(
      'Claude Code is not installed on the host, so I cannot run `claude setup-token` for you. ' +
        'Run it on a machine that has Claude Code installed, then paste the token below — or skip and /login inside the box.',
    );
  }

  const pasted = await password({ message: 'Paste OAuth token (or empty to skip):' });
  if (isCancel(pasted) || !pasted) {
    log.info('ok, continuing without a saved token; /login inside the box once and it persists in the shared volume.');
    return null;
  }
  const token = pasted.trim();
  if (!isPlausibleOauthToken(token)) {
    log.warn("That doesn't look like an OAuth token (expected `sk-ant-oat…`); saving anyway — verify inside the box.");
  }
  await writeAuthFile({ claudeCodeOauthToken: token });
  log.success(`saved to ${AUTH_FILE} (mode 0600)`);
  return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, source: 'auth-file' };
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

    // Resolve auth from env or the saved auth file. On first run (nothing
    // saved, nothing in env), drive the user through `claude setup-token`
    // interactively — but only when we have a real TTY and the user didn't
    // pass `--yes` (which means "no prompts; CI-friendly").
    let resolved = await resolveClaudeAuth(process.env);
    if (resolved.source === 'none' && process.stdin.isTTY && !opts.yes) {
      const next = await offerSetupToken();
      if (next) resolved = next;
    }

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
      for (const f of rebuild.failed) {
        log.warn(`plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`);
      }

      outro('attaching — Control+a q to detach, leaves claude running');
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

  // Auto-unpause/start. Mirrors `agentbox shell` / `agentbox code`.
  // `startBox` relaunches ctl/vnc/dockerd
  // because those processes die with the container.
  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }

  // If a tmux session already exists, just attach — no resync, no plugin
  // rebuild, ignore any post-`--` args (they only apply to a fresh claude).
  const existing = await claudeSessionInfo(box.container, sessionName);
  if (existing.running) {
    outro(`session "${sessionName}" already running — attaching (Control+a q to detach)`);
    await attachClaudeWrapped(box, sessionName, reattachRef(box));
    return;
  }

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

  // Default: re-sync the host's ~/.claude into the box volume so any
  // updates the user made on the host (new MCP servers, refreshed
  // OAuth state in _claude.json, …) reach the in-box claude. Slow on
  // first sync; opt out with --no-sync-config to skip.
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
  // on the host). Idempotent — skipped when a copy already exists.
  await seedSetupSkillIntoVolume(box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME, box.image);

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
  for (const f of rebuild.failed) {
    log.warn(`plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`);
  }

  outro('attaching — Control+a q to detach, leaves claude running');
  await attachClaudeWrapped(box, sessionName, reattachRef(box));
}

const claudeAttachCommand = new Command('attach')
  .description(
    'Attach to a Claude Code tmux session in a box, starting one if none is running (auto-unpause/start)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
  .option(
    '--no-sync-config',
    "when starting a fresh session, skip rsyncing the host's ~/.claude into the box's volume (faster)",
  )
  .action(async function (this: Command, idOrName: string | undefined) {
    // optsWithGlobals merges parent + own options — the parent `claude`
    // command also defines `--session-name`.
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Attaching to Claude session...');
    try {
      const box = await resolveBoxOrExit(idOrName);
      await startOrAttachClaude(box, [], opts);
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

claudeCommand.addCommand(claudeAttachCommand);
claudeCommand.addCommand(claudeStartCommand);
