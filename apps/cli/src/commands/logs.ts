import { log } from '@clack/prompts';
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { execInBox } from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface LogsOptions {
  tail: string;
  follow?: boolean;
}

export const logsCommand = new Command('logs')
  .description('Print recent log lines from a box service; -f to stream')
  // Both args optional so we can support `agentbox logs <service>` (auto-pick
  // the box) AND the original `agentbox logs <box> <service>`. Validation +
  // smart re-binding happens in the action handler.
  .argument(
    '[box]',
    'box ref (optional when cwd has exactly 1 box): project index, id, id prefix, name, or container',
  )
  .argument('[service]', 'service name from agentbox.yaml')
  .option('-n, --tail <n>', 'how many recent lines to print first', '200')
  .option('-f, --follow', 'keep the connection open and stream new lines')
  .action(async (boxArg: string | undefined, serviceArg: string | undefined, opts: LogsOptions) => {
    try {
      // Smart parse: if only one positional was given, commander binds it to
      // `boxArg` (the first positional). Treat that as the service and
      // auto-pick the box from the current project.
      let idOrName: string | undefined;
      let service: string | undefined;
      if (serviceArg !== undefined) {
        idOrName = boxArg;
        service = serviceArg;
      } else {
        idOrName = undefined;
        service = boxArg;
      }
      if (!service) {
        log.error('missing <service> argument');
        log.info('usage: agentbox logs [box] <service> [-n N] [-f]');
        process.exit(2);
      }

      const box = await resolveBoxOrExit(idOrName);

      const tail = String(Number.parseInt(opts.tail, 10) || 200);
      const args = ['agentbox-ctl', 'logs', service, '--tail', tail];
      if (opts.follow) args.push('--follow');

      if (!opts.follow) {
        const proc = await execInBox(box.container, args, { user: 'vscode' });
        if (proc.exitCode !== 0) {
          log.error(`agentbox-ctl logs failed: ${proc.stderr || proc.stdout}`);
          process.exit(1);
        }
        process.stdout.write(proc.stdout);
        if (!proc.stdout.endsWith('\n')) process.stdout.write('\n');
        return;
      }

      // Streaming: hand stdio to `docker exec` directly so the user sees lines
      // as the daemon emits them, and Ctrl-C kills both ends cleanly.
      const child = spawn('docker', ['exec', '--user', 'vscode', box.container, ...args], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('exit', (code) => process.exit(code ?? 0));
    } catch (err) {
      handleLifecycleError(err);
    }
  });
