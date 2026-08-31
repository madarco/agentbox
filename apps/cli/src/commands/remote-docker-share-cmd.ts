/**
 * `agentbox remote-docker share|unshare` — the control-box half of the host
 * registry.
 *
 * These live in the CLI rather than in `@agentbox/sandbox-remote-docker` (which
 * owns `add`/`update`/`remove`/`list`/`doctor`) for the same reason the
 * credential publisher does: hub target resolution and the API client are CLI
 * concerns, and a provider package must not depend on them.
 */

import { Command } from 'commander';
import { localExposedLoopbackUrl, resolveHubApiClient } from './control-plane.js';
import {
  shareHostWith,
  unshareHostFrom,
  type ShareOutcome,
} from '../control-plane/remote-docker-share.js';
import { log, spinner } from '@agentbox/cli-kit';

/**
 * A control box that IS this machine reads the very same
 * `~/.agentbox/remote-docker-hosts.json`, so there is nothing to share — and
 * "sharing" would install a second key on the engine for no reason.
 */
async function refuseIfCoLocated(): Promise<boolean> {
  if ((await localExposedLoopbackUrl().catch(() => null)) === null) return false;
  log.info(
    'The control box is this machine, so it already reads the same host registry — nothing to share.',
  );
  return true;
}

function report(outcome: ShareOutcome): void {
  if (!outcome.ok) {
    log.error(outcome.message);
    process.exitCode = 1;
    return;
  }
  if (outcome.skipped) log.info(outcome.message);
  else log.success(outcome.message);
}

export const remoteDockerShareSubcommands: Command[] = [
  new Command('share')
    .description('Let the control box run boxes on this host (sends a connection + its own key)')
    .argument('<alias>', 'a registered host alias')
    .option('--url <url>', 'control box URL (default: relay.controlPlaneUrl)')
    .option(
      '--use-existing-key',
      'send the key ssh already uses for this host instead of minting a dedicated one',
    )
    .action(async (alias: string, opts: { url?: string; useExistingKey?: boolean }) => {
      if (await refuseIfCoLocated()) return;
      const client = await resolveHubApiClient(opts.url, {});
      if (!client) {
        log.error('No control box configured — `agentbox hub setup` first.');
        process.exitCode = 1;
        return;
      }
      const s = spinner();
      s.start(`sharing ${alias} with the control box`);
      const outcome = await shareHostWith(
        alias,
        { client },
        { useExistingKey: opts.useExistingKey === true },
      );
      s.stop(outcome.ok ? `${alias}: done` : `${alias}: failed`, outcome.ok ? 0 : 1);
      report(outcome);
      if (outcome.ok && !outcome.skipped) {
        log.info(
          `Bake it there with \`agentbox prepare --provider docker:${alias}\`, then create with \`agentbox docker:${alias} claude\`.`,
        );
      }
    }),

  new Command('unshare')
    .description('Stop the control box using this host, and revoke the key minted for it')
    .argument('<alias>', 'a shared host alias')
    .option('--url <url>', 'control box URL (default: relay.controlPlaneUrl)')
    .action(async (alias: string, opts: { url?: string }) => {
      if (await refuseIfCoLocated()) return;
      const client = await resolveHubApiClient(opts.url, {});
      if (!client) {
        log.error('No control box configured.');
        process.exitCode = 1;
        return;
      }
      report(await unshareHostFrom(alias, { client }));
    }),
];
