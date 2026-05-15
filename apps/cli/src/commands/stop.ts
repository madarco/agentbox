import { stopBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

export const stopCommand = new Command('stop')
  .description('Stop a box (docker stop; preserves upper + node_modules volumes)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const record = await stopBox(box.id);
      process.stdout.write(
        `stopped ${record.container}\nrestart with: agentbox start ${record.name}\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });
