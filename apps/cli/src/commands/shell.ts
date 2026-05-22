import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { loadEffectiveConfig, type UserConfig } from '@agentbox/config';
import {
  buildShellSessionAttachArgv,
  DEFAULT_RELAY_PORT,
  formatDetachNotice,
  inspectBox,
  shellSessionInfo,
  startBox,
  startShellSession,
  unpauseBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

interface ShellOptions {
  user?: string;
  login?: boolean;
  tmux?: boolean; // commander: --no-tmux => false; default true
  sessionName?: string;
}

function buildShellCliOverrides(opts: ShellOptions): Partial<UserConfig> {
  const shell: NonNullable<UserConfig['shell']> = {};
  if (opts.user !== undefined) shell.user = opts.user;
  if (opts.login === false) shell.login = false;
  if (opts.tmux === false) shell.tmux = false;
  if (opts.sessionName !== undefined) shell.sessionName = opts.sessionName;
  return Object.keys(shell).length > 0 ? { shell } : {};
}

/** Ref shown in the detach notice: the per-project index `n` when set
 *  (resolves from inside the project dir), else the globally-unique name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
}

/** Auto-unpause/start the box so it's running. Mirrors `agentbox code` /
 *  `agentbox claude start`. `startBox` relaunches ctl/vnc/dockerd. */
async function ensureBoxRunning(box: BoxRecord): Promise<void> {
  const insp = await inspectBox(box.id);
  if (insp.state === 'paused') {
    log.info('box is paused; unpausing');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    log.info('box is stopped; starting');
    await startBox(box.id);
  } else if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }
}

interface ShellSessionCfg {
  user: string;
  login: boolean;
  sessionName: string;
}

/**
 * Start-or-attach the box's shell tmux session, then hand the docker
 * tmux-attach argv to the node-pty wrapper (footer + `Ctrl+a q` detach).
 * Process-exits with the inner pty's code. The box must already be running.
 */
async function startOrAttachShell(box: BoxRecord, cfg: ShellSessionCfg): Promise<never> {
  const info = await shellSessionInfo(box.container, cfg.sessionName, cfg.user);
  if (info.running) {
    log.info(`reattaching to shell session "${cfg.sessionName}" — Control+a q to detach`);
  } else {
    await startShellSession({
      container: box.container,
      sessionName: cfg.sessionName,
      user: cfg.user,
      login: cfg.login,
    });
    log.info('attaching — Control+a q to detach, leaves the shell running');
  }
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildShellSessionAttachArgv(box.container, cfg.sessionName, cfg.user),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'shell',
    detachable: true,
    detachNotice: formatDetachNotice(reattachRef(box), 'shell'),
  });
  process.exit(code);
}

export const shellCommand = new Command('shell')
  .description(
    'Open an interactive shell in a box, in a detachable tmux session (auto-unpause/start)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .argument(
    '[cmd...]',
    'optional one-shot command to run instead of an interactive shell; place after `--`, e.g. `agentbox shell smoke -- ls /workspace`',
  )
  .option('--user <name>', 'user inside the container (default from config; built-in: vscode)')
  .option('--no-login', 'invoke `bash` instead of `bash -l` (skip login profile)')
  .option('--no-tmux', 'run a plain docker exec shell instead of a detachable tmux session')
  .option('--session-name <name>', 'tmux session name (default from config; built-in: shell)')
  .action(async (idOrName: string | undefined, cmd: string[], opts: ShellOptions) => {
    try {
      // resolveBoxOrShift handles the `agentbox shell -- ls` case: commander
      // binds "ls" to [box], which doesn't resolve; if auto-pick succeeds we
      // treat "ls" as the first cmd token instead.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const effectiveCmd = shifted && idOrName ? [idOrName, ...cmd] : cmd;

      const cfg = await loadEffectiveConfig(box.workspacePath, {
        cliOverrides: buildShellCliOverrides(opts),
      });
      const user = cfg.effective.shell.user;
      const login = cfg.effective.shell.login;
      const tmux = cfg.effective.shell.tmux;
      const sessionName = cfg.effective.shell.sessionName;

      await ensureBoxRunning(box);

      // Inherit TERM so bash declares the outer terminal's true-color +
      // hyperlink capabilities (docker exec defaults to TERM=xterm).
      const term = process.env['TERM'] ?? 'xterm-256color';

      // -i always (so stdin pipes / heredocs work). -t only when stdout is a
      // real TTY — `docker exec -t` errors with "cannot attach stdin to a
      // TTY-enabled container because stdin is not a terminal" when run under
      // a script or another agent that piped its output.
      const isInteractive = process.stdout.isTTY && process.stdin.isTTY;

      // Plain `docker exec` argv — used for one-shot `-- cmd`, non-interactive
      // runs, and the interactive `--no-tmux` shell. One-shot/piped use is
      // never tmux-wrapped: machine-readable stdout and heredocs must stay
      // clean.
      const bashArgs: string[] = [];
      if (login) bashArgs.push('-l');
      if (effectiveCmd.length > 0) bashArgs.push('-c', effectiveCmd.join(' '));
      const ttyFlag = isInteractive ? '-it' : '-i';
      const plainArgv = [
        'exec',
        ttyFlag,
        '-e',
        `TERM=${term}`,
        '--user',
        user,
        box.container,
        'bash',
        ...bashArgs,
      ];

      // One-shot exec (`agentbox shell box -- cmd…`) and any piped use both
      // need machine-readable stdout — the wrapped pty would corrupt it with
      // a footer, and a tmux session makes no sense. Stay on the plain
      // spawnSync path in those cases.
      if (!isInteractive || effectiveCmd.length > 0) {
        const child = spawnSync('docker', plainArgv, { stdio: 'inherit' });
        process.exit(child.status ?? 0);
      }

      // Interactive shell. Default: run inside a detachable tmux session so
      // `Ctrl+a q` leaves it running (reattach with `agentbox shell attach`).
      // `--no-tmux` keeps the plain wrapped `docker exec` shell — closing the
      // terminal kills it.
      if (tmux) {
        await startOrAttachShell(box, { user, login, sessionName });
      }
      const code = await runWrappedAttach({
        container: box.container,
        dockerArgv: plainArgv,
        relayBaseUrl: RELAY_HOST_URL,
        boxId: box.id,
        boxName: box.name,
        projectIndex: box.projectIndex,
        mode: 'shell',
      });
      process.exit(code);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const shellAttachCommand = new Command('attach')
  .description(
    'Attach to a shell tmux session in a box, starting one if none is running (auto-unpause/start)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--user <name>', 'user inside the container (default from config; built-in: vscode)')
  .option('--no-login', 'invoke `bash` instead of `bash -l` (skip login profile)')
  .option('--session-name <name>', 'tmux session name (default from config; built-in: shell)')
  .action(async (idOrName: string | undefined, opts: ShellOptions) => {
    try {
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        throw new Error('`agentbox shell attach` needs an interactive terminal.');
      }
      const box = await resolveBoxOrExit(idOrName);
      const cfg = await loadEffectiveConfig(box.workspacePath, {
        cliOverrides: buildShellCliOverrides(opts),
      });
      await ensureBoxRunning(box);
      await startOrAttachShell(box, {
        user: cfg.effective.shell.user,
        login: cfg.effective.shell.login,
        sessionName: cfg.effective.shell.sessionName,
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

shellCommand.addCommand(shellAttachCommand);
