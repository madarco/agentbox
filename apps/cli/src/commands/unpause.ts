import { unpauseBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { restoreAgentSessions } from '../agent-sessions.js';
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
        // Docker unpause is a cgroup thaw — the agent tmux session survives, so
        // no restore is needed.
        const record = await unpauseBox(box.id);
        process.stdout.write(`unpaused ${record.container}\n`);
      } else {
        // Cloud resume reboots the sandbox, killing the agent tmux session — so
        // restore it (mirrors `agentbox start`), or detached agents stay dead
        // until a manual per-agent attach.
        const provider = await providerForBox(box);
        await provider.resume(box);
        process.stdout.write(`unpaused ${box.name}\n`);
        await restoreAgentSessions(box, provider, {
          onLog: (line) => process.stdout.write(`${line}\n`),
        });
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
