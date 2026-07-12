import { pauseBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

export const pauseCommand = new Command('pause')
  .description(
    'Pause a box. Docker: `docker pause` (cgroup freeze — sub-second resume). Cloud: backend.pause (Daytona archive — cold storage; resume is slower but uses no quota while archived).',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') === 'docker') {
        const record = await pauseBox(box.id);
        process.stdout.write(`paused ${record.container}\n`);
      } else {
        await (await providerForBox(box)).pause(box);
        // What "pause" costs you differs by backend, and the difference is the
        // thing a user needs to know before walking away: a daytona linux-vm box
        // freezes CPU + memory, so running processes survive the resume; every
        // other cloud shape is cold storage (filesystem only).
        const frozen = box.cloud?.sandboxClass === 'linux-vm';
        process.stdout.write(
          frozen
            ? `paused ${box.name} (${box.provider} VM frozen — memory and running processes preserved)\n`
            : `paused ${box.name} (${box.provider} sandbox archived)\n`,
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
