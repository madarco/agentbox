import { Command } from 'commander';
import { reload, restart, start, stop } from '../client.js';
import { DEFAULT_SOCKET_PATH, type ServiceStatus } from '../types.js';

interface ControlOptions {
  socket: string;
}

function printStatus(s: ServiceStatus): void {
  process.stdout.write(`${s.name}: ${s.state}` + (s.pid ? ` (pid ${String(s.pid)})` : '') + '\n');
}

export const restartCommand = new Command('restart')
  .description('Restart a service')
  .argument('<service>')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .action(async (service: string, opts: ControlOptions) => {
    printStatus(await restart({ socketPath: opts.socket }, service));
  });

export const stopServiceCommand = new Command('stop')
  .description('Stop a service (does not exit the daemon)')
  .argument('<service>')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .action(async (service: string, opts: ControlOptions) => {
    printStatus(await stop({ socketPath: opts.socket }, service));
  });

export const startServiceCommand = new Command('start')
  .description('Start a previously-stopped service')
  .argument('<service>')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .action(async (service: string, opts: ControlOptions) => {
    printStatus(await start({ socketPath: opts.socket }, service));
  });

export const reloadCommand = new Command('reload')
  .description('Re-read agentbox.yaml and apply the diff')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option(
    '--agents',
    're-ask the host which agents this box runs first (an agent added to a running box)',
  )
  .action(async (opts: ControlOptions & { agents?: boolean }) => {
    const diff = await reload({ socketPath: opts.socket }, { refreshAgents: opts.agents === true });
    process.stdout.write(
      `added: ${diff.added.join(', ') || '(none)'}\n` +
        `removed: ${diff.removed.join(', ') || '(none)'}\n` +
        `changed: ${diff.changed.join(', ') || '(none)'}\n`,
    );
  });
