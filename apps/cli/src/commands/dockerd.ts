/**
 * `agentbox dockerd <box>` — launch the in-box `dockerd` daemon for an
 * already-created box. Docker provider runs dockerd at create time when
 * the user opts in; cloud boxes never auto-start it (per backlog 5.2),
 * so this command is the explicit on-demand launcher. Idempotent — if
 * dockerd is already running, the probe short-circuits.
 */

import { log } from '@clack/prompts';
import { Command } from 'commander';
import { launchDockerdDaemon } from '@agentbox/sandbox-docker';
import { launchCloudDockerdDaemon } from '@agentbox/sandbox-cloud';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DockerdOptions {
  timeout: string;
}

export const dockerdCommand = new Command('dockerd')
  .description('Launch the in-box dockerd (docker-in-docker) — explicit for cloud boxes')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--timeout <ms>', 'overall timeout in milliseconds', '60000')
  .action(async (idOrName: string | undefined, opts: DockerdOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const timeoutMs = Number.parseInt(opts.timeout, 10) || 60_000;
      const provider = box.provider ?? 'docker';

      if (provider === 'docker') {
        const result = await launchDockerdDaemon(box.container, timeoutMs);
        if (!result.up) {
          log.error(`dockerd not ready: ${result.reason ?? 'unknown reason'}`);
          process.exit(1);
        }
        process.stdout.write('dockerd ready (docker box)\n');
        return;
      }

      if (!box.cloud?.sandboxId) {
        log.error(`box ${box.name} has no cloud.sandboxId — record is malformed`);
        process.exit(2);
      }
      // Lazy-load the daytona backend the same way the relay does — keeps
      // the SDK out of the docker hot path.
      const pkg = '@agentbox/sandbox-' + 'daytona';
      const mod = (await import(pkg)) as { daytonaBackend: CloudBackend };
      const handle: CloudHandle = { sandboxId: box.cloud.sandboxId };
      const result = await launchCloudDockerdDaemon({
        backend: mod.daytonaBackend,
        handle,
        timeoutMs,
      });
      if (!result.up) {
        log.error(`dockerd not ready: ${result.reason ?? 'unknown reason'}`);
        process.exit(1);
      }
      process.stdout.write('dockerd ready (cloud box)\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
