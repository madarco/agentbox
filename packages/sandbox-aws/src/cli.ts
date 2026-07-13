/**
 * `agentbox aws` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `hetznerCommand` / `digitaloceanCommand`).
 *
 * Subcommands:
 *   - `login`               — interactive credential setup (profile or keys) +
 *                             the IAM permission sweep.
 *   - `login --status`      — show what is currently configured (masked).
 *   - `firewall sync <box>` — re-detect the egress IP and update the box's
 *                             security group (no instance restart).
 *   - `firewall show <box>` — diagnostic: print the box's security-group rules.
 *
 * The per-box security group is found via the `agentbox.firewall` tag stamped on
 * the instance at create time (the Hetzner label trick — EC2 has real tags, so
 * we don't need DigitalOcean's discover-by-shared-tag dance).
 */

import { log } from '@clack/prompts';
import { findProjectRoot } from '@agentbox/config';
import { isAuthError } from '@agentbox/sandbox-cloud';
import { readState, resolveBoxRef } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { makeAwsClient, type AwsInstance } from './client.js';
import {
  ensureAwsCredentials,
  maskKey,
  readAwsCredStatus,
  secretsPath,
} from './credentials.js';
import { detectEgressIp } from './egress-ip.js';
import {
  allowedSshSources,
  normalizeSourceCidr,
  securityGroupIdFromTags,
  securityGroupNeedsSync,
  syncSecurityGroupSources,
} from './security-group.js';
import { readPreparedState } from './prepared-state.js';

interface LoginOpts {
  status?: boolean;
}

interface FirewallSyncOpts {
  source?: string;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

const loginSub = new Command('login')
  .description('Set up (or rotate) AWS credentials for EC2 boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        await printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'aws login needs an interactive terminal — set AWS_PROFILE (or AWS_ACCESS_KEY_ID + ' +
            'AWS_SECRET_ACCESS_KEY) in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureAwsCredentials({ force: true });
      // Credentials alone don't get a user a working box — they also need a
      // baked base AMI. Nudge toward `prepare`.
      if (readPreparedState().base === undefined) {
        log.info(
          'Base AMI not baked yet — run `agentbox prepare --provider aws` (or `agentbox install`) to bake it.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

async function printStatus(): Promise<void> {
  const s = readAwsCredStatus();
  if (s.source === 'none') {
    process.stdout.write(
      'aws: not configured\n  run `agentbox aws login` to set up credentials\n',
    );
    return;
  }
  const lines = ['aws: configured', `  source: ${s.source}`];
  if (s.profile) lines.push(`  profile: ${s.profile}`);
  if (s.accessKeyId) lines.push(`  access key: ${maskKey(s.accessKeyId)}`);
  if (s.region) lines.push(`  region: ${s.region}`);
  lines.push(`  file: ${secretsPath()}`);

  // "Configured" and "working" are different claims — an SSO session expires
  // daily while the AWS_PROFILE pointer stays valid forever. One cheap
  // DescribeVpcs answers which one this is.
  lines.push(`  session: ${await describeSessionValidity(s.profile)}`);

  const base = readPreparedState().base;
  lines.push(
    base
      ? `  base AMI: ${base.amiId} (${base.region})`
      : '  base AMI: not baked — run `agentbox prepare --provider aws`',
  );
  process.stdout.write(lines.join('\n') + '\n');
}

async function describeSessionValidity(profile?: string): Promise<string> {
  try {
    const vpc = await makeAwsClient().describeDefaultVpc();
    return `valid${vpc?.ownerId ? ` (account ${vpc.ownerId})` : ''}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthError(err)) {
      return (
        `EXPIRED or rejected (${message})\n` +
        `    fix: aws sso login --profile ${profile ?? '<profile>'}  (or re-run \`agentbox aws login\`)`
      );
    }
    return `could not verify (${message})`;
  }
}

const firewallSyncSub = new Command('sync')
  .description('Re-detect the host egress IP and update the box security group (no reboot)')
  .argument('<box>', 'box name or id')
  .option(
    '--source <cidr>',
    'override the auto-detected egress IP (e.g. 1.2.3.4/32, or 0.0.0.0/0 for open opt-in)',
  )
  .action(async (boxRef: string, opts: FirewallSyncOpts) => {
    try {
      const { box, instance } = await resolveAwsBox(boxRef);
      const groupId = securityGroupIdFromTags(instance.tags);
      if (!groupId) {
        throw new Error(
          `box '${boxRef}' has no security group recorded on its \`agentbox.firewall\` tag. ` +
            'This is unusual — the box may have been provisioned outside agentbox.',
        );
      }
      const source = opts.source
        ? normalizeSourceCidr(opts.source)
        : normalizeSourceCidr(
            await detectEgressIp({ onLog: (l) => process.stdout.write(`aws: ${l}\n`) }),
          );
      process.stdout.write(
        `aws: updating security group ${groupId} for box '${box.name}' -> source ${source}\n`,
      );
      const { removed } = await syncSecurityGroupSources(makeAwsClient(), groupId, [source]);
      process.stdout.write(
        `aws: security group ${groupId} now allows SSH from ${source}` +
          (removed.length > 0 ? ` (revoked ${removed.join(', ')})` : '') +
          '\n',
      );
    } catch (err) {
      reportError(err);
    }
  });

const firewallShowSub = new Command('show')
  .description('Print the EC2 security-group rules currently attached to a box')
  .argument('<box>', 'box name or id')
  .action(async (boxRef: string) => {
    try {
      const { box, instance } = await resolveAwsBox(boxRef);
      const groupId = securityGroupIdFromTags(instance.tags);
      const vpsIp = instance.publicIp ?? '—';
      if (!groupId) {
        process.stdout.write(`aws: box '${box.name}' (${vpsIp}) has no security group recorded\n`);
        return;
      }
      const sg = await makeAwsClient().describeSecurityGroup(groupId);
      if (!sg) {
        process.stdout.write(
          `aws: security group ${groupId} for box '${box.name}' no longer exists\n`,
        );
        return;
      }

      const lines: string[] = [
        `box:      ${box.name}  (instance ${instance.instanceId})`,
        `publicIp: ${vpsIp}`,
        `firewall: ${sg.groupName ?? '—'} (id ${sg.groupId})`,
        'inbound:',
      ];
      for (const perm of sg.ipPermissions) {
        const ports =
          perm.FromPort === perm.ToPort
            ? String(perm.FromPort ?? 'all')
            : `${String(perm.FromPort)}-${String(perm.ToPort)}`;
        const sources = (perm.IpRanges ?? []).map((r) => r.CidrIp).filter(Boolean).join(', ');
        lines.push(`  in ${perm.IpProtocol ?? 'all'}:${ports} from=${sources || '—'}`);
      }
      // EC2 security groups carry an implicit allow-all egress rule; we never
      // add outbound rules, so saying so beats printing an empty section.
      lines.push('outbound: allow all (EC2 default)');

      // The host's current egress IP, for comparison — the usual diagnostic when
      // a laptop moved networks and ssh started timing out.
      try {
        const currentEgress = await detectEgressIp({});
        const wantCidr = normalizeSourceCidr(currentEgress);
        lines.push(`host egress IP (now): ${wantCidr}`);
        if (securityGroupNeedsSync(allowedSshSources(sg), wantCidr)) {
          lines.push(
            `  WARN: current egress IP does not match the security group — run ` +
              `\`agentbox aws firewall sync ${box.name}\` to update`,
          );
        }
      } catch (egressErr) {
        lines.push(
          `host egress IP: <detection failed: ${egressErr instanceof Error ? egressErr.message : String(egressErr)}>`,
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
    } catch (err) {
      reportError(err);
    }
  });

/**
 * Resolve a CLI box ref into the BoxRecord + the live EC2 instance. Errors out
 * cleanly if the box isn't an aws box or is already terminated.
 */
async function resolveAwsBox(boxRef: string): Promise<{
  box: import('@agentbox/core').BoxRecord;
  instance: AwsInstance;
}> {
  const project = await findProjectRoot(process.cwd());
  const state = await readState();
  const res = resolveBoxRef(boxRef, state, project.root);
  if (res.kind !== 'ok') {
    throw new Error(`no box matched '${boxRef}'`);
  }
  const box = res.box;
  if (box.provider !== 'aws') {
    throw new Error(`box '${box.name}' has provider '${box.provider ?? 'docker'}', not 'aws'`);
  }
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`box '${box.name}' has no recorded sandboxId`);
  }
  const instance = await makeAwsClient().describeInstance(sandboxId);
  if (!instance || instance.state === 'terminated') {
    throw new Error(`aws instance ${sandboxId} for box '${box.name}' is gone (already destroyed?)`);
  }
  return { box, instance };
}

const firewallSub = new Command('firewall')
  .description('Inspect / re-sync the per-box EC2 security group')
  .addCommand(firewallSyncSub)
  .addCommand(firewallShowSub);

export const awsCommand = new Command('aws')
  .description('AWS EC2 provider: credentials + per-box firewall')
  .addCommand(loginSub)
  .addCommand(firewallSub);
