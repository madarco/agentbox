import { confirm, intro, isCancel, log, outro, password, spinner } from '@clack/prompts';
import {
  AmbiguousBoxError,
  attachClaudeSession,
  BoxNotFoundError,
  ClaudeSessionError,
  claudeSessionInfo,
  createBox,
  DEFAULT_CLAUDE_SESSION,
  findBox,
  readState,
  rebuildPluginNativeDeps,
  startClaudeSession,
  type FindBoxResult,
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
import { clampSpinnerLine } from '../spinner-line.js';
import { handleLifecycleError } from './_errors.js';

interface ClaudeCreateOptions {
  workspace: string;
  name?: string;
  snapshot?: boolean;
  image?: string;
  yes?: boolean;
  isolateClaudeConfig?: boolean;
  withPlaywright?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
  sessionName: string;
}

interface ClaudeAttachOptions {
  sessionName: string;
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
  .option('--snapshot', 'use a frozen APFS clone of the workspace as the overlay lower')
  .option('--no-snapshot', 'bind the live workspace directly (host edits leak into reads)')
  .option('--image <ref>', 'override the box image')
  .option('-y, --yes', 'skip prompts, accept defaults (snapshot=on)')
  .option(
    '--isolate-claude-config',
    'use a per-box ~/.claude volume instead of the shared agentbox-claude-config',
  )
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
  .option('--session-name <name>', 'tmux session name', DEFAULT_CLAUDE_SESSION)
  .argument(
    '[claude-args...]',
    "extra args passed to claude inside the box; place after `--`, e.g. `agentbox claude -- --model sonnet`",
  )
  .action(async (claudeArgs: string[], opts: ClaudeCreateOptions) => {
    intro('agentbox claude');

    // For the create-and-launch verb the default is snapshot=on; explicit
    // --no-snapshot still works. We don't prompt — `agentbox claude` is the
    // "just run it" entrypoint.
    const useSnapshot = opts.snapshot !== false;

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
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        image: opts.image,
        claudeConfig: { isolate: !!opts.isolateClaudeConfig },
        claudeEnv: resolved.env,
        withPlaywright: !!opts.withPlaywright,
        vnc: { enabled: opts.vnc !== false },
        onLog: (line) => s.message(clampSpinnerLine(line)),
      });
      containerName = result.record.container;
      s.stop(`box ${result.record.container} ready`);

      log.info(`id:        ${result.record.id}`);
      log.info(`container: ${result.record.container}`);
      log.info(`claude volume: ${result.record.claudeConfigVolume ?? '(none)'}`);

      // Plugin native deps: the sync excludes `node_modules` (host darwin
      // binaries don't run on linux/amd64). First claude session in a fresh
      // box pays the npm-install cost for each plugin that ships a
      // package.json; subsequent attaches see node_modules already present
      // and exit immediately.
      s.start('rebuilding plugin native deps (first run for this box)');
      const rebuild = await rebuildPluginNativeDeps(result.record.container, {
        onProgress: (line) => s.message(clampSpinnerLine(line)),
      });
      if (rebuild.rebuilt.length === 0 && rebuild.failed.length === 0) {
        s.stop('plugins ready (nothing to rebuild)');
      } else {
        s.stop(`plugins ready (rebuilt ${String(rebuild.rebuilt.length)})`);
      }
      for (const f of rebuild.failed) {
        log.warn(`plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`);
      }

      s.start('starting claude session');
      await startClaudeSession({
        container: result.record.container,
        claudeArgs,
        sessionName: opts.sessionName,
      });
      s.stop(`tmux session "${opts.sessionName}" started`);

      outro('attaching — Ctrl-b d to detach, leaves claude running');
      attachClaudeSession(result.record.container, opts.sessionName);
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

const claudeAttachCommand = new Command('attach')
  .description('Reattach to a running Claude Code tmux session in a box')
  .argument('<box>', 'box id, id prefix, name, or container name')
  .option('--session-name <name>', 'tmux session name', DEFAULT_CLAUDE_SESSION)
  .action(async (idOrName: string, opts: ClaudeAttachOptions) => {
    try {
      const state = await readState();
      const r: FindBoxResult = findBox(idOrName, state);
      if (r.kind === 'none') throw new BoxNotFoundError(idOrName);
      if (r.kind === 'ambiguous') throw new AmbiguousBoxError(idOrName, r.matches);

      const info = await claudeSessionInfo(r.box.container, opts.sessionName);
      if (!info.running) {
        log.error(`no tmux session "${opts.sessionName}" in ${r.box.container}`);
        log.info(`Start one with: agentbox claude -n ${r.box.name}`);
        process.exit(2);
      }
      attachClaudeSession(r.box.container, opts.sessionName);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

claudeCommand.addCommand(claudeAttachCommand);
