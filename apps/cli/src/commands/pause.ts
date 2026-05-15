import { pauseBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

export const pauseCommand = new Command('pause')
  .description('Freeze a box (docker pause — 0 CPU, RAM stays mapped)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const record = await pauseBox(box.id);
      process.stdout.write(`paused ${record.container}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
