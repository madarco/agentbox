import { loadEffectiveConfig } from '@agentbox/config';
import { autoWriteSshConfig } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { restoreAgentSessions } from '../agent-sessions.js';
import { resolveBoxOrExit } from '../box-ref.js';
import { withHubClient } from '../control-plane/with-hub.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

export const startCommand = new Command('start')
  .description(
    'Start a stopped box. Docker: docker start + relaunch ctl/dockerd/vnc daemons. Cloud: backend.start, then re-resolve preview URLs/tokens, re-launch in-sandbox ctl/dockerd daemons, and re-register with the host relay (so the CloudBoxPoller resumes).',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      // The box's compute lifecycle runs through the hub `/api/v1` in both modes.
      const ok = await withHubClient({}, async (client) => {
        await client.lifecycle(box.id, 'start');
        return true;
      });
      if (!ok) return;
      const isDocker = (box.provider ?? 'docker') === 'docker';
      process.stdout.write(`started ${isDocker ? (box.container ?? box.name) : box.name}\n`);

      // Client-side IO follow-up, kept on the direct IO plane (see the plan's
      // out-of-scope section): refresh THIS machine's ssh alias for a cloud box
      // (its public IP can change across stop/start) and resume whichever agent
      // (claude/codex) was running before the stop, so a later attach picks up
      // where it left off. Both re-resolve the box from its stable sandbox id, so
      // no fresh record is needed; both best-effort, never throw.
      const provider = await providerForBox(box);
      if (!isDocker) {
        const cfg = await loadEffectiveConfig(box.workspacePath);
        await autoWriteSshConfig(box, provider, cfg.effective.ssh.autoConfig, (m) =>
          process.stderr.write(`agentbox: ${m}\n`),
        );
      }
      await restoreAgentSessions(box, provider, {
        onLog: (line) => process.stdout.write(`${line}\n`),
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
