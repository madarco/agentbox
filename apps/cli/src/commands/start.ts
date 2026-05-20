import { startBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

export const startCommand = new Command('start')
  .description('Start a stopped box (docker start + relaunch ctl/dockerd/vnc daemons)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const { record } = await startBox(box.id);
      process.stdout.write(`started ${record.container}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
