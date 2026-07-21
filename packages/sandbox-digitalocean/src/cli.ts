/**
 * `agentbox digitalocean` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `hetznerCommand`).
 *
 * Subcommands:
 *   - `login`               — interactive `DIGITALOCEAN_TOKEN` setup + persist.
 *   - `login --status`      — show the currently-configured token (masked).
 *   - `firewall sync <box>` — re-detect egress IP, update the box's firewall
 *                             inbound rule (no droplet restart).
 *   - `firewall show <box>` — diagnostic: print the box's firewall rules.
 *
 * Unlike Hetzner (which stores the firewall id in server labels), DigitalOcean
 * droplets carry no arbitrary labels — we discover the per-box firewall by the
 * unique tag the create flow stamped onto both the droplet and the firewall.
 */

import { log } from '@clack/prompts';
import { findProjectRoot, loadEffectiveConfig } from '@agentbox/config';
import { readState, resolveBoxRef } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { makeDigitalOceanClient, type DigitalOceanDroplet } from './client.js';
import {
  ensureDigitalOceanCredentials,
  maskKey,
  readDigitalOceanCredStatus,
  secretsPath,
} from './credentials.js';
import { detectEgressIp } from './egress-ip.js';
import { findFirewallForDroplet, normalizeSourceCidr, syncFirewallSource } from './firewall.js';
import { readPreparedState } from './prepared-state.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

const loginSub = new Command('login')
  .description('Set up (or rotate) DigitalOcean credentials for Droplet boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        await printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'digitalocean login needs an interactive terminal — set DIGITALOCEAN_TOKEN in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureDigitalOceanCredentials({ force: true });
      // Credentials alone don't get a user a working box — they also need a
      // baked base snapshot. Nudge toward `prepare`.
      if (readPreparedState().base === undefined) {
        log.info(
          'Base snapshot not built yet — run `agentbox prepare --provider digitalocean` (or `agentbox install`) to bake it.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

async function printStatus(): Promise<void> {
  const s = readDigitalOceanCredStatus();
  if (s.source === 'none') {
    process.stdout.write(
      'digitalocean: not configured\n' +
        '  run `agentbox digitalocean login` to set up credentials\n',
    );
    return;
  }
  const lines = ['digitalocean: configured', `  source: ${s.source}`];
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  if (s.endpoint) lines.push(`  api:    ${s.endpoint}`);
  // Where boxes land. An unset key is meaningful (DigitalOcean's own default
  // project), so state it rather than omitting the line — which project boxes
  // went into being invisible is the whole reason for this feature.
  const project = (await loadEffectiveConfig(process.cwd())).effective.box.digitaloceanProject;
  lines.push(`  project: ${project || '(account default)'}`);
  process.stdout.write(lines.join('\n') + '\n');
}

interface FirewallSyncOpts {
  source?: string;
}

const firewallSyncSub = new Command('sync')
  .description('Re-detect the host egress IP and update the box firewall (no reboot)')
  .argument('<box>', 'box name or id')
  .option(
    '--source <cidr>',
    'override the auto-detected egress IP (e.g. 1.2.3.4/32, or 0.0.0.0/0 for open opt-in)',
  )
  .action(async (boxRef: string, opts: FirewallSyncOpts) => {
    try {
      const { box, droplet } = await resolveDigitalOceanBox(boxRef);
      const client = makeDigitalOceanClient();
      const firewall = await findFirewallForDroplet(client, droplet.id, droplet.tags);
      if (!firewall) {
        throw new Error(
          `box '${boxRef}' has no DigitalOcean firewall attached (none matched the droplet's tags). ` +
            `This is unusual — the box may have been provisioned outside agentbox.`,
        );
      }
      const source = opts.source
        ? normalizeSourceCidr(opts.source)
        : `${await detectEgressIp({ onLog: (l) => process.stdout.write(`digitalocean: ${l}\n`) })}/32`;
      process.stdout.write(`digitalocean: updating firewall ${firewall.id} for box '${box.name}' → source ${source}\n`);
      await syncFirewallSource(client, firewall, source);
      process.stdout.write(`digitalocean: firewall ${firewall.id} now allows SSH from ${source} only\n`);
    } catch (err) {
      reportError(err);
    }
  });

const firewallShowSub = new Command('show')
  .description('Print the DigitalOcean firewall rules currently attached to a box')
  .argument('<box>', 'box name or id')
  .action(async (boxRef: string) => {
    try {
      const { box, droplet } = await resolveDigitalOceanBox(boxRef);
      const client = makeDigitalOceanClient();
      const firewall = await findFirewallForDroplet(client, droplet.id, droplet.tags);
      const vpsIp = droplet.networks.v4.find((n) => n.type === 'public')?.ip_address ?? '—';
      if (!firewall) {
        process.stdout.write(`digitalocean: box '${box.name}' (${vpsIp}) has no firewall attached\n`);
        return;
      }
      const lines: string[] = [
        `box:      ${box.name}  (sandbox ${box.cloud?.sandboxId ?? '—'})`,
        `vpsIp:    ${vpsIp}`,
        `firewall: ${firewall.name} (id ${firewall.id})`,
        'inbound:',
      ];
      for (const rule of firewall.inbound_rules) {
        const sources = rule.sources.addresses?.join(', ') ?? '—';
        lines.push(`  in ${rule.protocol}${rule.ports ? `:${rule.ports}` : ''} from=${sources}`);
      }
      lines.push('outbound:');
      for (const rule of firewall.outbound_rules) {
        const dests = rule.destinations.addresses?.join(', ') ?? '—';
        lines.push(`  out ${rule.protocol}${rule.ports ? `:${rule.ports}` : ''} to=${dests}`);
      }
      // Show the host's current egress IP for comparison — common diagnostic
      // when the user's laptop moved networks and ssh started timing out.
      try {
        const currentEgress = await detectEgressIp({});
        lines.push(`host egress IP (now): ${currentEgress}/32`);
        const wantCidr = `${currentEgress}/32`;
        const sshSources = firewall.inbound_rules
          .filter((r) => r.protocol === 'tcp' && r.ports === '22')
          .flatMap((r) => r.sources.addresses ?? []);
        // Reachable if the host IP is explicitly allowed OR the firewall is open
        // (0.0.0.0/0 — an `agentbox inbound … open` box). Only an actual mismatch
        // (host IP not covered) warrants the sync hint; narrowing an open box to
        // the host IP would be the opposite of what the user set.
        const reachable = sshSources.includes(wantCidr) || sshSources.includes('0.0.0.0/0');
        if (!reachable) {
          lines.push(
            `  WARN: current egress IP does not match the firewall — run \`agentbox digitalocean firewall sync ${box.name}\` to update`,
          );
        }
      } catch (egressErr) {
        lines.push(`host egress IP: <detection failed: ${egressErr instanceof Error ? egressErr.message : String(egressErr)}>`);
      }
      process.stdout.write(lines.join('\n') + '\n');
    } catch (err) {
      reportError(err);
    }
  });

/**
 * Resolve a CLI box ref into the BoxRecord + the live DigitalOcean droplet.
 * Errors out cleanly if the box isn't a digitalocean box or if it's already
 * destroyed on the DigitalOcean side.
 */
async function resolveDigitalOceanBox(boxRef: string): Promise<{
  box: import('@agentbox/core').BoxRecord;
  droplet: DigitalOceanDroplet;
}> {
  const cwd = process.cwd();
  const project = await findProjectRoot(cwd);
  const state = await readState();
  const res = resolveBoxRef(boxRef, state, project.root);
  if (res.kind !== 'ok') {
    throw new Error(`no box matched '${boxRef}'`);
  }
  const box = res.box;
  if (box.provider !== 'digitalocean') {
    throw new Error(`box '${box.name}' has provider '${box.provider ?? 'docker'}', not 'digitalocean'`);
  }
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`box '${box.name}' has no recorded sandboxId`);
  }
  const id = Number.parseInt(sandboxId, 10);
  if (!Number.isFinite(id)) {
    throw new Error(`box '${box.name}' has non-numeric digitalocean sandboxId '${sandboxId}'`);
  }
  const droplet = await makeDigitalOceanClient().getDroplet(id);
  if (!droplet) {
    throw new Error(`digitalocean droplet ${String(id)} for box '${box.name}' is gone (already destroyed?)`);
  }
  return { box, droplet };
}

const firewallSub = new Command('firewall')
  .description('Manage the DigitalOcean Cloud Firewall attached to each box')
  .addCommand(firewallSyncSub)
  .addCommand(firewallShowSub);

export const digitaloceanCommand = new Command('digitalocean')
  .description(
    'DigitalOcean Droplet provider — credentials, firewall, plus sugar for `--provider digitalocean` (e.g. `agentbox digitalocean create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true })
  .addCommand(firewallSub);
