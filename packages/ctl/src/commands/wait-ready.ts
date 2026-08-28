import { Command } from 'commander';
import { waitReady } from '../client.js';
import { DEFAULT_SOCKET_PATH } from '../types.js';

interface WaitReadyOptions {
  socket: string;
  timeout?: string;
  units?: string[];
  json?: boolean;
}

export const waitReadyCommand = new Command('wait-ready')
  .description('Block until all autostart units (or a specified subset) are ready')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--timeout <ms>', 'overall timeout in milliseconds', '60000')
  .option('--units <names...>', 'restrict to the named units (default: all autostart)')
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (opts: WaitReadyOptions) => {
    const timeoutMs = Number.parseInt(opts.timeout ?? '60000', 10);
    const result = await waitReady({ socketPath: opts.socket }, { timeoutMs, units: opts.units });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (result.ready) {
      process.stdout.write('ready\n');
    } else {
      const lines: string[] = ['not ready'];
      if (result.timedOut.length > 0) lines.push(`  timed out: ${result.timedOut.join(', ')}`);
      if (result.failed.length > 0) lines.push(`  failed: ${result.failed.join(', ')}`);
      process.stdout.write(lines.join('\n') + '\n');
    }
    process.exit(result.ready ? 0 : 1);
  });
