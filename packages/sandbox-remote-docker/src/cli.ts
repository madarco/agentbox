/**
 * `agentbox remote-docker` — the provider's own commands.
 *
 * There is no `login` here, unlike every other cloud: the provider has no
 * credential of its own, it just uses your ssh. What it does need is a way to
 * answer "can AgentBox actually use that machine?" before you find out the hard
 * way in the middle of a create — hence `check`.
 */

import { Command } from 'commander';
import * as p from '@clack/prompts';
import { loadEffectiveConfig, setConfigValue } from '@agentbox/config';
import { probeRemoteEngine } from './remote-docker.js';
import { readPreparedState } from './prepared-state.js';

export const remoteDockerCommand = new Command('remote-docker')
  .description('Remote Docker provider — run boxes on your own machine over SSH')
  .addCommand(
    new Command('check')
      .description('Verify an SSH destination can host boxes (ssh reachable + docker present)')
      .argument('[host]', 'SSH destination (default: box.remoteDockerHost)')
      .action(async (host?: string) => {
        const target = (host ?? (await configuredHost())).trim();
        if (!target) {
          p.log.error(
            'no SSH destination — pass one (`agentbox remote-docker check user@host`) or set `box.remoteDockerHost`',
          );
          process.exitCode = 1;
          return;
        }
        const s = p.spinner();
        s.start(`probing ${target}`);
        const res = await probeRemoteEngine(target);
        if (!res.ok) {
          s.stop(`${target}: unusable`);
          p.log.error(res.error);
          process.exitCode = 1;
          return;
        }
        s.stop(`${target}: docker ${res.version} (${res.os}/${res.arch})`);

        const baked = readPreparedState()?.hosts[target];
        p.log.info(
          baked
            ? `box image baked: ${baked.imageRef}`
            : `box image not baked yet — the first create will do it, or run \`agentbox prepare --provider docker:${target}\``,
        );
      }),
  )
  .addCommand(
    new Command('use')
      .description('Set the default SSH destination for `--provider remote-docker`')
      .argument('<host>', 'SSH destination (~/.ssh/config alias or [user@]host[:port])')
      .option('-g, --global', 'write to the global config instead of this project')
      .action(async (host: string, opts: { global?: boolean }) => {
        const res = await probeRemoteEngine(host);
        if (!res.ok) {
          p.log.error(res.error);
          process.exitCode = 1;
          return;
        }
        await setConfigValue(
          opts.global ? 'global' : 'project',
          'box.remoteDockerHost',
          host,
          process.cwd(),
        );
        p.log.success(
          `box.remoteDockerHost = ${host} (${opts.global ? 'global' : 'project'}) — docker ${res.version}`,
        );
      }),
  )
  .addCommand(
    new Command('hosts')
      .description('List the remote engines this machine has baked a box image on')
      .action(() => {
        const state = readPreparedState();
        const hosts = Object.entries(state?.hosts ?? {});
        if (hosts.length === 0) {
          p.log.info('no remote engines prepared yet');
          return;
        }
        for (const [host, info] of hosts) {
          p.log.info(`${host}  ${info.imageRef}  (${info.cliVersion ?? '—'}, ${info.createdAt})`);
        }
      }),
  );

async function configuredHost(): Promise<string> {
  const cfg = await loadEffectiveConfig(process.cwd());
  return cfg.effective.box.remoteDockerHost || '';
}
