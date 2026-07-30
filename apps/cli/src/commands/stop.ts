import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import {
  boxOwningHubIsLocal,
  reportBoxNotOnAnyHub,
  withOwningHub,
} from '../control-plane/with-hub.js';
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
      // Lifecycle runs through the hub `/api/v1` in both modes, routed to the hub
      // that OWNS the box (see withOwningHub / boxOwningHubIsLocal).
      const r = await withOwningHub(box, (client) => client.lifecycle(box.id, 'stop'));
      if (r === undefined) return;
      if (r === 'not-found') {
        reportBoxNotOnAnyHub(box);
        return;
      }
      const label = boxOwningHubIsLocal(box) ? (box.container ?? box.name) : box.name;
      process.stdout.write(`stopped ${label}\nrestart with: agentbox start ${box.name}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
