import { Command } from 'commander';
import { HistoryLoop } from '../history-shipper.js';

/**
 * `agentbox-ctl history flush` — ship everything this box's bound sessions hold,
 * a trailing partial line included. The host runs it right before destroying a
 * non-docker box, so the last turn is not lost with the disk.
 */
export const historyCommand = new Command('history').description(
  'Session history shipping (used by the host)',
);

historyCommand
  .command('flush')
  .description("Ship this box's remaining agent transcript bytes to the hub")
  .action(async () => {
    const stats = await new HistoryLoop().tick(true);
    if (!stats) {
      process.stdout.write('history: capture disabled or hub unreachable\n');
      process.exit(0);
    }
    process.stdout.write(
      `history: ${String(stats.frames)} frame(s), ${String(stats.bytes)} byte(s) from ${String(stats.files)} file(s)\n`,
    );
    for (const e of stats.errors) process.stderr.write(`history: ${e}\n`);
    process.exit(stats.errors.length > 0 ? 1 : 0);
  });
