import { unpauseBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

export const unpauseCommand = new Command('unpause')
  .description(
    'Resume a paused box. Docker: `docker unpause` (sub-second). Cloud: backend.resume (re-hydrates from archive — slower first time).',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') === 'docker') {
        const record = await unpauseBox(box.id);
        process.stdout.write(`unpaused ${record.container}\n`);
      } else {
        await (await providerForBox(box)).resume(box);
        process.stdout.write(`unpaused ${box.name}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
