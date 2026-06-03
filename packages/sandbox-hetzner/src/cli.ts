/**
 * `agentbox hetzner` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `daytonaCommand`).
 *
 * Subcommands:
 *   - `login`              — interactive `HCLOUD_TOKEN` setup + persist.
 *   - `login --status`     — show the currently-configured token (masked).
 *   - `firewall sync <box>` — re-detect egress IP, update the box's
 *                            firewall rules (no VPS restart).
 *   - `firewall show <box>` — diagnostic: print the box's firewall.
 *
 * The firewall subcommands rely on `BoxRecord.cloud.hetzner.firewallId` /
 * `BoxRecord.cloud.hetzner.firewallSource` being populated by the create
 * flow — that wiring lands in Phase 4. Until then these subcommands throw
 * a clear error pointing at the backlog. The `login` subcommand is fully
 * functional now.
 */

import { log } from '@clack/prompts';
import { findProjectRoot } from '@agentbox/config';
import { readState, resolveBoxRef } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { makeHetznerClient } from './client.js';
import {
  ensureHetznerCredentials,
  maskKey,
  readHetznerCredStatus,
  secretsPath,
} from './credentials.js';
import { detectEgressIp } from './egress-ip.js';
import { normalizeSourceCidr, syncFirewallSource } from './firewall.js';
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
  .description('Set up (or rotate) Hetzner Cloud credentials for VPS boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'hetzner login needs an interactive terminal — set HCLOUD_TOKEN in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureHetznerCredentials({ force: true });
      // Credentials alone don't get a user a working box — they also need a
      // baked base snapshot. Nudge toward `prepare` so the login → first-create
      // path doesn't hit the (otherwise-clean) "no base snapshot" error from
      // the snapshot resolver. No layering break.
      if (readPreparedState().base === undefined) {
        log.info(
          'Base snapshot not built yet — run `agentbox prepare --provider hetzner` (or `agentbox install`) to bake it.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

function printStatus(): void {
  const s = readHetznerCredStatus();
  if (s.source === 'none') {
    process.stdout.write(
      'hetzner: not configured\n' +
        '  run `agentbox hetzner login` to set up credentials\n',
    );
    return;
  }
  const lines = ['hetzner: configured', `  source: ${s.source}`];
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  if (s.endpoint) lines.push(`  api:    ${s.endpoint}`);
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
      const { box, server } = await resolveHetznerBox(boxRef);
      const firewallId = parseFirewallIdFromServer(server.labels);
      if (firewallId === undefined) {
        throw new Error(
          `box '${boxRef}' has no recorded firewall id (label agentbox.firewall is missing on the Hetzner server). ` +
            `This is unusual — the box may have been provisioned outside agentbox.`,
        );
      }
      const source = opts.source
        ? normalizeSourceCidr(opts.source)
        : `${await detectEgressIp({ onLog: (l) => process.stdout.write(`hetzner: ${l}\n`) })}/32`;
      const client = makeHetznerClient();
      process.stdout.write(`hetzner: updating firewall ${String(firewallId)} for box '${box.name}' → source ${source}\n`);
      await syncFirewallSource(client, firewallId, source);
      process.stdout.write(`hetzner: firewall ${String(firewallId)} now allows SSH from ${source} only\n`);
    } catch (err) {
      reportError(err);
    }
  });

const firewallShowSub = new Command('show')
  .description('Print the Hetzner firewall rules currently attached to a box')
  .argument('<box>', 'box name or id')
  .action(async (boxRef: string) => {
    try {
      const { box, server } = await resolveHetznerBox(boxRef);
      const firewallId = parseFirewallIdFromServer(server.labels);
      if (firewallId === undefined) {
        throw new Error(`box '${boxRef}' has no recorded firewall id (label agentbox.firewall missing)`);
      }
      const client = makeHetznerClient();
      const firewall = await client.getFirewall(firewallId);
      if (!firewall) {
        process.stdout.write(`hetzner: firewall ${String(firewallId)} for box '${box.name}' is gone on Hetzner\n`);
        return;
      }
      const lines: string[] = [
        `box:      ${box.name}  (sandbox ${box.cloud?.sandboxId ?? '—'})`,
        `vpsIp:    ${server.public_net.ipv4?.ip ?? '—'}`,
        `firewall: ${firewall.name} (id ${String(firewall.id)})`,
        'rules:',
      ];
      for (const rule of firewall.rules) {
        const sources = rule.source_ips?.join(', ') ?? '—';
        const dests = rule.destination_ips?.join(', ') ?? '';
        lines.push(
          `  ${rule.direction} ${rule.protocol}${rule.port ? `:${rule.port}` : ''} from=${sources}${dests ? ` to=${dests}` : ''}`,
        );
      }
      // Show the host's current egress IP for comparison — common diagnostic
      // when the user's laptop moved networks and ssh started timing out.
      try {
        const currentEgress = await detectEgressIp({});
        lines.push(`host egress IP (now): ${currentEgress}/32`);
        const wantCidr = `${currentEgress}/32`;
        const allowed = firewall.rules.find(
          (r) => r.direction === 'in' && r.port === '22' && r.source_ips?.includes(wantCidr),
        );
        if (!allowed) {
          lines.push(
            `  WARN: current egress IP does not match the firewall — run \`agentbox hetzner firewall sync ${box.name}\` to update`,
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
 * Resolve a CLI box ref into the BoxRecord + the live Hetzner server.
 * Errors out cleanly if the box isn't a hetzner box or if it's already
 * destroyed on the Hetzner side.
 */
async function resolveHetznerBox(boxRef: string): Promise<{
  box: import('@agentbox/core').BoxRecord;
  server: import('./client.js').HetznerServer;
}> {
  const cwd = process.cwd();
  const project = await findProjectRoot(cwd);
  const state = await readState();
  const res = resolveBoxRef(boxRef, state, project.root);
  if (res.kind !== 'ok') {
    throw new Error(`no box matched '${boxRef}'`);
  }
  const box = res.box;
  if (box.provider !== 'hetzner') {
    throw new Error(`box '${box.name}' has provider '${box.provider ?? 'docker'}', not 'hetzner'`);
  }
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`box '${box.name}' has no recorded sandboxId`);
  }
  const id = Number.parseInt(sandboxId, 10);
  if (!Number.isFinite(id)) {
    throw new Error(`box '${box.name}' has non-numeric hetzner sandboxId '${sandboxId}'`);
  }
  const server = await makeHetznerClient().getServer(id);
  if (!server) {
    throw new Error(`hetzner server ${String(id)} for box '${box.name}' is gone (already destroyed?)`);
  }
  return { box, server };
}

function parseFirewallIdFromServer(labels: Record<string, string>): number | undefined {
  const raw = labels['agentbox.firewall'];
  if (!raw) return undefined;
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : undefined;
}

const firewallSub = new Command('firewall')
  .description('Manage the Hetzner Cloud Firewall attached to each box')
  .addCommand(firewallSyncSub)
  .addCommand(firewallShowSub);

export const hetznerCommand = new Command('hetzner')
  .description(
    'Hetzner Cloud VPS provider — credentials, firewall, plus sugar for `--provider hetzner` (e.g. `agentbox hetzner create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true })
  .addCommand(firewallSub);
