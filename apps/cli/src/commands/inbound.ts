import { confirm, isCancel, log } from '@clack/prompts';
import { describeInbound, parseInboundSpec } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface InboundOptions {
  show?: boolean;
  yes?: boolean;
}

export const inboundCommand = new Command('inbound')
  .description(
    "Set a VPS box's inbound-access policy (hetzner / digitalocean per-box firewall). " +
      '`open` = SSH reachable from anywhere (0.0.0.0/0, key-only — reach the box from a phone with the laptop off); ' +
      '`lock` = host egress IP only; a CIDR list = host egress plus those. `--show` prints the current policy.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .argument(
    '[spec...]',
    'open | lock | whitelist <cidr...> | a bare CIDR list (e.g. 203.0.113.5/32). Omit with --show.',
  )
  .option('--show', 'print the box\'s current inbound policy and exit')
  .option('-y, --yes', 'skip the confirmation prompt when opening the firewall to the world')
  .action(async (idOrName: string | undefined, spec: string[], opts: InboundOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const provider = await providerForBox(box);

      if (opts.show || spec.length === 0) {
        const policy = box.cloud?.inbound ?? { mode: 'locked' as const, sources: [] };
        process.stdout.write(`inbound: ${describeInbound(policy)}\n`);
        if (!opts.show) {
          process.stdout.write(
            'Pass a policy to change it: `agentbox inbound ' +
              `${box.name} open|lock|<cidr...>\`\n`,
          );
        }
        return;
      }

      if (!provider.setInbound) {
        log.error(
          `inbound access control isn't supported for provider '${box.provider ?? 'docker'}' — ` +
            'only hetzner / digitalocean boxes have a per-box firewall.',
        );
        process.exit(2);
      }

      const raw = spec.join(' ');
      const policy = parseInboundSpec(raw); // validates early (throws on a bad spec)

      if (policy.mode === 'open' && !opts.yes) {
        log.warn(
          `This opens SSH (port 22) on box '${box.name}' to the entire internet (0.0.0.0/0). ` +
            'Access stays key-only (password auth is disabled), but the port becomes publicly reachable.',
        );
        const ok = await confirm({ message: 'Open the firewall to the world?', initialValue: false });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const applied = await provider.setInbound(box, raw, (line) => log.step(line));
      process.stdout.write(`inbound set for ${box.name}: ${describeInbound(applied)}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
