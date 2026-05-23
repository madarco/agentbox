import { stopBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

export const stopCommand = new Command('stop')
  .description(
    'Stop a box (Docker: docker stop; preserves upper + node_modules volumes. Cloud: backend.stop — sandbox stays in your account, disk preserved).',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') === 'docker') {
        const record = await stopBox(box.id);
        process.stdout.write(
          `stopped ${record.container}\nrestart with: agentbox start ${record.name}\n`,
        );
      } else {
        await (await providerForBox(box)).stop(box);
        process.stdout.write(
          `stopped ${box.name}\nrestart with: agentbox start ${box.name}\n`,
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
