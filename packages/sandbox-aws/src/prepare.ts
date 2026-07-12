/**
 * `agentbox prepare --provider aws` — bake the base AMI.
 *
 * EC2 cannot build an image from a Dockerfile, so (like hetzner/digitalocean) we
 * boot a throwaway instance from a stock Ubuntu AMI, scp the runtime assets in,
 * run `install-box.sh` over ssh, and capture the result as an AMI. Every box
 * then launches from that AMI in a few seconds instead of re-installing Node,
 * Docker, Chromium and the agents each time.
 *
 * Talks to the EC2 client directly (never through `provision`) so it slips past
 * the base-AMI gate it is itself satisfying.
 *
 * Two rules this file exists to enforce:
 *
 *   1. **Failure cleanup.** Every error path terminates the bake instance and
 *      deletes its security group. A leaked `t3.medium` bills ~$30/month, and
 *      nothing else in the system will ever clean it up.
 *   2. **Idempotent skip-fast.** A recorded AMI that still exists, whose build
 *      context hash is unchanged, is reused rather than re-baked (unless
 *      `--force`).
 */

import { join } from 'node:path';
import type { Provider } from '@agentbox/core';
import { UserFacingError } from '@agentbox/core';
import {
  stageAgentsStaticForUpload,
  stageClaudeStaticForUpload,
  stageCodexStaticForUpload,
  stageOpencodeStaticForUpload,
  type StageResult,
} from '@agentbox/sandbox-cloud';
import { claudeInstallFingerprint, computeContextSha256, readCliStamp } from '@agentbox/sandbox-core';
import { makeAwsClient, type AwsClient } from './client.js';
import { generatePrepareCloudInit } from './cloud-init.js';
import { ensureAwsCredentials } from './credentials.js';
import { pollUntil } from './poll.js';
import {
  preparedStatePath,
  readPreparedState,
  writePreparedState,
} from './prepared-state.js';
import {
  createPerBoxSecurityGroup,
  deletePerBoxSecurityGroup,
  resolveFirewallSource,
  TAG_MANAGED,
  TAG_ROLE,
} from './security-group.js';
import { scpUpload, sshExec, waitForSsh, type SshTargetArgs } from './ssh-cli.js';
import { mintPrepareKey } from './ssh-key.js';
import { resolveDefaultSubnet } from './subnet.js';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets, type ResolvedAsset } from './runtime-assets.js';

/** The bake instance is short-lived; a bigger box makes the install materially faster. */
const PREPARE_DEFAULT_INSTANCE_TYPE = 't3.large';
const PREPARE_INSTANCE_DEADLINE_MS = 5 * 60_000;
const PREPARE_SSH_DEADLINE_MS = 5 * 60_000;
const INSTALL_SCRIPT_TIMEOUT_MS = 30 * 60_000;
const AMI_DEADLINE_MS = 30 * 60_000;
/** The bake needs room for the install; the resulting AMI snapshot is what boxes inherit. */
const PREPARE_DISK_GB = 40;

export interface PrepareAwsOptions {
  name?: string;
  hostWorkspace?: string;
  force?: boolean;
  region?: string;
  /** Instance type for the throwaway bake instance (not for boxes). */
  size?: string;
  claudeInstall?: 'native' | 'npm';
  firewallSource?: string;
  cliRuntimeRoot?: string;
  repoRoot?: string;
  onLog?: (line: string) => void;
}

export interface PrepareAwsResult {
  /** The AMI id, written into `box.imageAws` by the CLI. */
  snapshotName?: string;
  amiId?: string;
  region?: string;
}

/** Is the recorded AMI still bootable? A transient API error must NOT force a re-bake. */
async function amiStillExists(client: AwsClient, amiId: string): Promise<boolean> {
  try {
    const img = await client.describeImage(amiId);
    return img !== null && img.state === 'available';
  } catch {
    // Can't reach the API — assume it's fine rather than burning 15 minutes on a
    // needless re-bake because of a network blip.
    return true;
  }
}

export async function prepareAws(opts: PrepareAwsOptions = {}): Promise<PrepareAwsResult> {
  const log = opts.onLog ?? (() => {});
  const progress = (s: string) => log(`prepare-aws: ${s}`);

  await ensureAwsCredentials();

  const region = opts.region?.trim() || process.env.AWS_REGION || 'us-east-1';
  const client = makeAwsClient({ region });
  const claudeInstall = opts.claudeInstall ?? 'native';

  const assets: ResolvedAsset[] = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  const contextSha = claudeInstallFingerprint(
    await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
    claudeInstall,
  );

  // Skip-fast: a usable AMI already exists for this exact build context.
  const existing = readPreparedState();
  if (
    !opts.force &&
    existing.base &&
    existing.base.contextSha256 === contextSha &&
    existing.base.region === region &&
    (await amiStillExists(client, existing.base.amiId))
  ) {
    progress(
      `base AMI ${existing.base.amiId} is current (context unchanged) — nothing to do. ` +
        'Use --force to re-bake.',
    );
    return {
      snapshotName: existing.base.amiId,
      amiId: existing.base.amiId,
      region: existing.base.region,
    };
  }
  // An AMI baked in another region cannot boot an instance here. Say so plainly
  // rather than letting the create path fail later with InvalidAMIID.NotFound.
  if (existing.base && existing.base.region !== region) {
    progress(
      `the recorded base AMI is in ${existing.base.region}, but this bake targets ${region} — ` +
        'AMIs are region-scoped, so a new one will be baked.',
    );
  }

  const stamp = Date.now().toString(36);
  const instanceType = opts.size?.trim() || PREPARE_DEFAULT_INSTANCE_TYPE;
  const amiName = opts.name ?? `agentbox-base-${stamp}`;

  const key = await mintPrepareKey();
  let instanceId: string | null = null;
  let securityGroupId: string | null = null;

  try {
    // 1. Where can the bake instance live? Same default-VPC resolution as a box.
    const subnet = await resolveDefaultSubnet(client);

    // 2. Lock inbound SSH to this host before anything is running.
    const sourceCidr = opts.firewallSource
      ? opts.firewallSource
      : await resolveFirewallSource();
    progress(`locking bake instance SSH to ${sourceCidr}`);
    securityGroupId = await createPerBoxSecurityGroup(client, {
      name: `agentbox-prepare-${stamp}`,
      vpcId: subnet.vpcId,
      sourceCidr,
      tags: { [TAG_ROLE]: 'prepare' },
    });

    // 3. Boot the bake instance from the stock Ubuntu AMI.
    const stock = await client.latestUbuntuAmi('x86_64');
    progress(`launching bake instance (${instanceType}, ${region}) from ${stock.imageId}`);
    const launched = await client.runInstance({
      name: `agentbox-prepare-${stamp}`,
      imageId: stock.imageId,
      instanceType,
      subnetId: subnet.subnetId,
      securityGroupId,
      userData: generatePrepareCloudInit({ sshPubkey: key.publicKey }),
      diskGb: PREPARE_DISK_GB,
      tags: {
        Name: `agentbox-prepare-${stamp}`,
        [TAG_MANAGED]: 'true',
        [TAG_ROLE]: 'prepare',
      },
    });
    instanceId = launched.instanceId;

    // 4. Wait for it to run and get a public IP, then for sshd.
    progress(`instance ${instanceId} launched; waiting for it to boot`);
    const ip = await pollUntil(
      `instance ${instanceId} running`,
      async () => {
        const i = await client.describeInstance(instanceId as string);
        return i && i.state === 'running' && i.publicIp ? i.publicIp : null;
      },
      {
        deadlineMs: PREPARE_INSTANCE_DEADLINE_MS,
        intervalMs: 3_000,
        maxIntervalMs: 10_000,
        onPoll: (l) => log(`prepare-aws: ${l}`),
      },
    );

    // We log in as ROOT, not `ubuntu`: install-box.sh renames the UID-1000 user
    // (which IS `ubuntu` on a Canonical AMI) to `vscode`, and `usermod -l` refuses
    // to rename an account that has running processes — our own login shell would
    // block it. See cloud-init.ts for how root key auth is set up.
    const sshTarget: SshTargetArgs = {
      host: ip,
      user: 'root',
      identity: key.privatePath,
      knownHosts: join(key.dir, 'known_hosts'),
    };
    progress(`waiting for ssh on ${ip} (deadline ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s)`);
    const up = await waitForSsh(sshTarget, PREPARE_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(
        `aws: ssh (root) on ${ip} did not come up within ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s. ` +
          'The cloud-init runcmd that installs root\'s authorized_keys may not have run — check the ' +
          'instance system log in the EC2 console.',
      );
    }
    progress("ssh up — scp'ing runtime assets");

    // 5. scp the assets in SEQUENTIALLY. Parallel uploads open a fresh ssh
    // connection each and trip sshd's MaxStartups on a freshly-booted VPS.
    for (const asset of assets) {
      const remote = `/tmp/${asset.remoteBasename}`;
      log(`prepare-aws: scp ${asset.name} -> ${remote}`);
      await scpUpload(sshTarget, asset.localPath, remote);
      if (asset.remoteMode !== undefined) {
        await sshExec(sshTarget, `chmod ${asset.remoteMode.toString(8)} ${remote}`);
      }
    }

    // 6. Run the installer, teeing the trace to /var/log/agentbox/install.log so
    // it survives INTO the AMI (every box then carries its own build log).
    progress('running install-box.sh on the bake instance (this takes ~5-15 min)');
    const installRes = await sshExec(
      sshTarget,
      `mkdir -p /var/log/agentbox && set -o pipefail && AGENTBOX_CLAUDE_INSTALL=${claudeInstall} bash -x /tmp/agentbox-install.sh 2>&1 | tee /var/log/agentbox/install.log`,
      { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS, onLine: (line) => log(`[install] ${line}`) },
    );
    if (installRes.exitCode !== 0) {
      throw new Error(
        `install-box.sh failed on the bake instance (exit ${String(installRes.exitCode)})\n` +
          `Last stderr: ${installRes.stderr.slice(-500) || '(empty)'}\n` +
          "The full trace is in the '[install] …' lines above (and ~/.agentbox/logs/latest.log). " +
          'No AMI was created and the bake instance is being terminated, so the in-box ' +
          '/var/log/agentbox/install.log does not survive this failure.',
      );
    }
    progress('install script complete');

    // 6b. Bake the host's agent static config (~/.claude, ~/.codex, opencode,
    // ~/.agents) into the image, so in-box agents boot with the user's plugins,
    // skills and settings already present.
    await stageAgentStatics(sshTarget, opts.hostWorkspace, log, progress);

    // 7. Capture the AMI. NoReboot:true is the live-snapshot equivalent of
    // `docker commit`; we `sync` first so the filesystem is consistent on disk.
    await sshExec(sshTarget, 'sync');
    progress(`creating AMI '${amiName}' from instance ${instanceId}`);
    const amiId = await client.createImage(
      instanceId,
      amiName,
      'AgentBox base image (Ubuntu 24.04 + node + docker + agents)',
    );
    progress(`AMI ${amiId} requested; waiting for it to become available`);
    await pollUntil(
      `AMI ${amiId} available`,
      async () => {
        const img = await client.describeImage(amiId);
        if (img?.state === 'failed') {
          throw new Error(`aws: AMI ${amiId} entered state 'failed'`);
        }
        return img?.state === 'available' ? img : null;
      },
      {
        deadlineMs: AMI_DEADLINE_MS,
        intervalMs: 5_000,
        maxIntervalMs: 15_000,
        onPoll: (l) => log(`prepare-aws: ${l}`),
      },
    );

    // 8. Persist BEFORE teardown — if cleanup then fails we still know the AMI
    // exists, instead of orphaning it.
    progress('persisting aws-prepared.json');
    const state = readPreparedState();
    const cliStamp = readCliStamp();
    state.base = {
      amiId,
      region,
      description: amiName,
      createdAt: new Date().toISOString(),
      contextSha256: contextSha,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
    };
    writePreparedState(state);
    log(`prepare-aws: wrote ${preparedStatePath()}`);

    // 9. Teardown. Terminate first (it costs money), then the security group —
    // which cannot be deleted until the instance's ENI has detached.
    progress(`terminating the bake instance ${instanceId}`);
    await client.terminateInstance(instanceId);
    await waitForTerminated(client, instanceId, log);
    instanceId = null;

    progress(`deleting the bake security group ${securityGroupId}`);
    await deletePerBoxSecurityGroup(client, securityGroupId, { onLog: log });
    securityGroupId = null;

    progress(`prepare complete — base AMI ${amiId} (${amiName}) in ${region}`);
    return { snapshotName: amiId, amiId, region };
  } catch (err) {
    // Failure cleanup, best-effort. ALWAYS terminate the instance first — a
    // forgotten t3.large bills ~$60/month. Surface the original error.
    if (instanceId !== null) {
      log(`prepare-aws: cleanup — terminating the bake instance ${instanceId} after failure`);
      try {
        await client.terminateInstance(instanceId);
        await waitForTerminated(client, instanceId, log);
      } catch (cleanupErr) {
        log(
          `prepare-aws: WARN could not terminate the bake instance ${instanceId} ` +
            `(${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}). ` +
            'CHECK THE EC2 CONSOLE — it is still billing.',
        );
      }
    }
    if (securityGroupId !== null) {
      try {
        await deletePerBoxSecurityGroup(client, securityGroupId, { onLog: log });
      } catch {
        log(`prepare-aws: WARN could not delete the bake security group ${securityGroupId}`);
      }
    }
    throw err;
  } finally {
    await key.cleanup();
  }
}

/**
 * Wait for a terminated instance to actually reach `terminated`. Required before
 * the security group can be deleted (EC2 rejects the delete with
 * `DependencyViolation` while the ENI is still attached). Best-effort: on
 * timeout we log and move on, and `deletePerBoxSecurityGroup` has its own
 * deadline loop as the second line of defence.
 */
async function waitForTerminated(
  client: AwsClient,
  instanceId: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await pollUntil(
      `instance ${instanceId} terminated`,
      async () => {
        const i = await client.describeInstance(instanceId);
        // A garbage-collected instance describes as null — also "terminated".
        return i === null || i.state === 'terminated' ? true : null;
      },
      { deadlineMs: 3 * 60_000, intervalMs: 3_000, maxIntervalMs: 10_000 },
    );
  } catch {
    log(`prepare-aws: instance ${instanceId} did not report 'terminated' in time; continuing`);
  }
}

/**
 * Upload + extract the host's agent static config into the image. Each staging
 * is a tarball in a temp dir the helper owns, so every one is cleaned up in the
 * `finally` regardless of what fails.
 */
async function stageAgentStatics(
  sshTarget: SshTargetArgs,
  hostWorkspace: string | undefined,
  log: (line: string) => void,
  progress: (s: string) => void,
): Promise<void> {
  progress('staging host agent static config');
  const stagings: { kind: string; tar: StageResult; dest: string }[] = [];
  try {
    const claudeTar = await stageClaudeStaticForUpload({ hostWorkspace });
    for (const w of claudeTar.warnings) log(`prepare-aws: ${w}`);
    if (claudeTar.tarballPath) stagings.push({ kind: 'claude', tar: claudeTar, dest: '/home/vscode/.claude' });
    else await claudeTar.cleanup();

    const codexTar = await stageCodexStaticForUpload();
    for (const w of codexTar.warnings) log(`prepare-aws: ${w}`);
    if (codexTar.tarballPath) stagings.push({ kind: 'codex', tar: codexTar, dest: '/home/vscode/.codex' });
    else await codexTar.cleanup();

    const opencodeTar = await stageOpencodeStaticForUpload();
    for (const w of opencodeTar.warnings) log(`prepare-aws: ${w}`);
    if (opencodeTar.tarballPath)
      stagings.push({ kind: 'opencode', tar: opencodeTar, dest: '/home/vscode/.local/share/opencode' });
    else await opencodeTar.cleanup();

    const agentsTar = await stageAgentsStaticForUpload();
    for (const w of agentsTar.warnings) log(`prepare-aws: ${w}`);
    if (agentsTar.tarballPath) stagings.push({ kind: 'agents', tar: agentsTar, dest: '/home/vscode/.agents' });
    else await agentsTar.cleanup();

    for (const s of stagings) {
      const remote = `/tmp/agentbox-${s.kind}-static.tar.gz`;
      log(`prepare-aws: scp ${s.kind} static -> ${remote}`);
      await scpUpload(sshTarget, s.tar.tarballPath as string, remote);
      // Extract AS vscode: the tarball carries the host user's uid/gid, and
      // without --no-same-owner root would recreate those numeric owners inside
      // the image, leaving ~/.claude unreadable to the in-box user.
      const extractCmd =
        `sudo -u vscode mkdir -p ${s.dest} && ` +
        `sudo -u vscode tar -xzf ${remote} -C ${s.dest} --no-same-permissions --no-same-owner -m && ` +
        `rm -f ${remote}`;
      const r = await sshExec(sshTarget, extractCmd, {
        onLine: (line) => log(`[stage:${s.kind}] ${line}`),
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `prepare-aws: ${s.kind} static extract failed (exit ${String(r.exitCode)}): ${r.stderr.slice(-300)}`,
        );
      }
      progress(`baked ${s.kind} static config into the AMI`);
    }
  } finally {
    for (const s of stagings) await s.tar.cleanup();
  }
}

/** The `Provider['prepare']` binding the CLI drives. */
export const prepareAwsProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareAws({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    // CLI `--location` / `box.awsRegion`.
    region: req.location,
    // CLI `--size` / `box.sizeAws` — the BAKE instance's type, not the box's.
    size: req.size,
    // The `npm` escape hatch, for when the native Claude installer's CDN 403s a
    // datacenter egress IP.
    claudeInstall: req.claudeInstall,
    onLog: req.onLog,
  });

/**
 * The first-use gate, called at the top of `backend.provision`. EC2 cannot build
 * from a Dockerfile, so the base AMI is a hard prerequisite rather than
 * something we can build on demand.
 */
export async function ensureAwsBaseAmi(region?: string): Promise<void> {
  const state = readPreparedState();
  if (state.base === undefined) {
    throw new UserFacingError(
      'no AWS base AMI found.\n' +
        'Run `agentbox prepare --provider aws` first (EC2 cannot build images from a Dockerfile, ' +
        'so baking the base AMI is a one-time prerequisite for cloud boxes on this backend).',
    );
  }
  const want = region?.trim();
  if (want && state.base.region !== want) {
    throw new UserFacingError(
      `the AWS base AMI (${state.base.amiId}) was baked in ${state.base.region}, but this box ` +
        `targets ${want}. AMIs are region-scoped and cannot boot an instance in another region.\n` +
        `Either create the box in ${state.base.region} (\`--location ${state.base.region}\`), or ` +
        `re-bake for ${want} with \`agentbox prepare --provider aws --location ${want}\`.`,
    );
  }
}
