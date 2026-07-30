import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import {
  boxOwningHubIsLocal,
  reportBoxNotOnAnyHub,
  withOwningHub,
} from '../control-plane/with-hub.js';
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
      // Lifecycle runs through the hub `/api/v1` in both modes, routed to the box's
      // owning hub (see withOwningHub / boxOwningHubIsLocal).
      const r = await withOwningHub(box, (client) => client.lifecycle(box.id, 'pause'));
      if (r === undefined) return;
      if (r === 'not-found') {
        reportBoxNotOnAnyHub(box);
        return;
      }
      if (boxOwningHubIsLocal(box)) {
        process.stdout.write(`paused ${box.container ?? box.name}\n`);
      } else {
        // What "pause" costs you differs by backend, and the difference is the
        // thing a user needs to know before walking away: a daytona linux-vm box
        // freezes CPU + memory, so running processes survive the resume; every
        // other cloud shape is cold storage (filesystem only). Computed from the
        // local record — no extra round-trip.
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
