import { Command } from 'commander';
import { HistoryLoop } from '../history-shipper.js';
import { MemorySync } from '../memory-sync.js';

/**
 * `agentbox-ctl history flush` — ship everything this box's bound sessions hold,
 * a trailing partial line included, and any memory file changed since the last
 * pass. The host runs it right before destroying a box, so the last turn and
 * the last memory write are not lost with the disk.
 */
export const historyCommand = new Command('history').description(
  'Session history shipping (used by the host)',
);

historyCommand
  .command('flush')
  .description("Ship this box's remaining agent transcript bytes to the hub")
  .action(async () => {
    const mem = await new MemorySync().pass({ noSeed: true });
    process.stdout.write(`memory: ${String(mem.shipped)} file(s) shipped\n`);
    for (const e of mem.errors) process.stderr.write(`memory: ${e}\n`);
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
