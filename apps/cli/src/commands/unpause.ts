import { loadEffectiveConfig } from '@agentbox/config';
import { autoWriteSshConfig } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { restoreAgentSessions } from '../agent-sessions.js';
import { resolveBoxOrExit } from '../box-ref.js';
import { withHubClient } from '../control-plane/with-hub.js';
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
      // The hub's lifecycle action is `resume` (docker unpause, cloud re-hydrate);
      // runs through `/api/v1` in both modes.
      const ok = await withHubClient({}, async (client) => {
        await client.lifecycle(box.id, 'resume');
        return true;
      });
      if (!ok) return;
      const isDocker = (box.provider ?? 'docker') === 'docker';
      process.stdout.write(`unpaused ${isDocker ? (box.container ?? box.name) : box.name}\n`);

      // Docker unpause is a cgroup thaw — the agent tmux session survives, so no
      // restore is needed. Cloud resume reboots the sandbox, killing the agent
      // tmux session, so restore it (mirrors `agentbox start`) or detached agents
      // stay dead until a manual per-agent attach. Both are client-side IO,
      // re-resolving from the stable sandbox id; best-effort, never throw.
      if (!isDocker) {
        const provider = await providerForBox(box);
        const cfg = await loadEffectiveConfig(box.workspacePath);
        await autoWriteSshConfig(box, provider, cfg.effective.ssh.autoConfig, (m) =>
          process.stderr.write(`agentbox: ${m}\n`),
        );
        await restoreAgentSessions(box, provider, {
          onLog: (line) => process.stdout.write(`${line}\n`),
        });
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
