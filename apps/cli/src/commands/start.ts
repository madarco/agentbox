import { loadEffectiveConfig } from '@agentbox/config';
import { autoWriteSshConfig } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { restoreAgentSessions } from '../agent-sessions.js';
import { resolveBoxOrExit } from '../box-ref.js';
import {
  boxOwningHubIsLocal,
  reportBoxNotOnAnyHub,
  withOwningHub,
} from '../control-plane/with-hub.js';
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
      // The box's compute lifecycle runs through the hub `/api/v1` in both modes,
      // routed to the hub that OWNS the box (local for docker/remote-docker, the
      // configured hub for cloud) with a retry on the other hub — see withOwningHub.
      const r = await withOwningHub(box, (client) => client.lifecycle(box.id, 'start'));
      if (r === undefined) return; // hub error; withOwningHub reported + set the exit code
      if (r === 'not-found') {
        reportBoxNotOnAnyHub(box);
        return;
      }
      const label = boxOwningHubIsLocal(box) ? (box.container ?? box.name) : box.name;
      process.stdout.write(`started ${label}\n`);

      // Client-side IO follow-up, kept on the direct IO plane (see the plan's
      // out-of-scope section): refresh THIS machine's ssh alias (a no-op for plain
      // docker, which has no ssh target; runs for remote-docker + cloud, whose
      // reachable target can change across a restart) and resume whichever agent
      // (claude/codex) was running before the stop — a full stop kills the tmux
      // session for every provider, so this runs unconditionally. Both re-resolve
      // the box from its stable sandbox id, so no fresh record is needed; both
      // best-effort, never throw.
      const provider = await providerForBox(box);
      const cfg = await loadEffectiveConfig(box.workspacePath);
      await autoWriteSshConfig(box, provider, cfg.effective.ssh.autoConfig, (m) =>
        process.stderr.write(`agentbox: ${m}\n`),
      );
      await restoreAgentSessions(box, provider, {
        onLog: (line) => process.stdout.write(`${line}\n`),
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
