import { unpauseBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

export const unpauseCommand = new Command('unpause')
  .description('Resume a paused box (docker unpause — sub-second)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const record = await unpauseBox(box.id);
      process.stdout.write(`unpaused ${record.container}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
