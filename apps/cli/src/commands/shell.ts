import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { loadEffectiveConfig, type UserConfig } from '@agentbox/config';
import { inspectBox, startBox, unpauseBox } from '@agentbox/sandbox-docker';
import { resolveBoxOrShift } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface ShellOptions {
  user?: string;
  login?: boolean;
}

function buildShellCliOverrides(opts: ShellOptions): Partial<UserConfig> {
  const shell: NonNullable<UserConfig['shell']> = {};
  if (opts.user !== undefined) shell.user = opts.user;
  if (opts.login === false) shell.login = false;
  return Object.keys(shell).length > 0 ? { shell } : {};
}

export const shellCommand = new Command('shell')
  .description('Open an interactive bash shell in a box (auto-unpause/start)')
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

      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info('box is paused; unpausing');
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info('box is stopped; starting (remounting overlay)');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      // Inherit TERM so bash declares the outer terminal's true-color +
      // hyperlink capabilities (docker exec defaults to TERM=xterm).
      const term = process.env['TERM'] ?? 'xterm-256color';
      const bashArgs: string[] = [];
      if (login) bashArgs.push('-l');
      if (effectiveCmd.length > 0) bashArgs.push('-c', effectiveCmd.join(' '));

      // -i always (so stdin pipes / heredocs work). -t only when stdout is a
      // real TTY — `docker exec -t` errors with "cannot attach stdin to a
      // TTY-enabled container because stdin is not a terminal" when run under
      // a script or another agent that piped its output.
      const ttyFlag = process.stdout.isTTY && process.stdin.isTTY ? '-it' : '-i';
      const child = spawnSync(
        'docker',
        [
          'exec',
          ttyFlag,
          '-e',
          `TERM=${term}`,
          '--user',
          user,
          box.container,
          'bash',
          ...bashArgs,
        ],
        { stdio: 'inherit' },
      );
      process.exit(child.status ?? 0);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
