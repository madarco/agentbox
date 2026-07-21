import { loadEffectiveConfig } from '@agentbox/config';
import { startBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { restoreAgentSessions } from '../agent-sessions.js';
import { resolveBoxOrExit } from '../box-ref.js';
import { autoWriteSshConfig } from '@agentbox/sandbox-core';
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
      if ((box.provider ?? 'docker') === 'docker') {
        const { record } = await startBox(box.id);
        process.stdout.write(`started ${record.container}\n`);
        // Resume whichever agent (claude/codex) was running before the stop, so
        // a later attach picks up where it left off. Best-effort, never throws.
        await restoreAgentSessions(record, await providerForBox(record), {
          onLog: (line) => process.stdout.write(`${line}\n`),
        });
      } else {
        const provider = await providerForBox(box);
        const record = await provider.start(box);
        process.stdout.write(`started ${box.name}\n`);
        // Refresh the box's `~/.agentbox/ssh/config` entry — a cloud box's public
        // IP can change across stop/start, so re-resolve now it's back online.
        const cfg = await loadEffectiveConfig(record.workspacePath);
        await autoWriteSshConfig(record, provider, cfg.effective.ssh.autoConfig, (m) =>
          process.stderr.write(`agentbox: ${m}\n`),
        );
        await restoreAgentSessions(record, provider, {
          onLog: (line) => process.stdout.write(`${line}\n`),
        });
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
