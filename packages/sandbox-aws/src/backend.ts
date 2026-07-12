/**
 * The AWS EC2 `CloudBackend` — the provider-neutral cloud primitives mapped onto
 * OpenSSH + the EC2 API. Same shape as hetzner/digitalocean (1 instance per box,
 * an SSH ControlMaster for all I/O, a per-box firewall locked to the host's
 * egress IP, snapshot-based checkpoints); everything above it is supplied by
 * `createCloudProvider` in `@agentbox/sandbox-cloud`.
 *
 * The EC2-specific wrinkles, all of which are load-bearing:
 *
 *   - **`sandboxId` is a string** (`i-0abc…`), not a number. The sibling
 *     providers `Number.parseInt` theirs; every one of those guards is gone here.
 *
 *   - **The public IP changes across stop/start.** An EC2 instance without an
 *     Elastic IP gets a *new* public address every time it is started. So the IP
 *     is re-read from the API on every call, and the ControlMaster is torn down
 *     whenever it was opened against a different address — otherwise every
 *     post-resume exec would try to reach a machine that no longer answers there.
 *
 *   - **A security group cannot be deleted while its ENI is attached.** On
 *     destroy we terminate, wait for `terminated`, and only then delete the SG
 *     (with its own retry loop, since the ENI detach lags the state change).
 *
 *   - **A checkpoint is an AMI**, and an AMI's backing EBS snapshots are separate
 *     billable objects. Deregistering an AMI without deleting them leaks storage
 *     forever, so `deleteSnapshot` does both.
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { execa } from 'execa';
import type {
  CloudBackend,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
  InboundPolicy,
} from '@agentbox/core';
import { describeInbound, parseInboundSpec, resolveInboundSources } from '@agentbox/sandbox-core';
import { makeAwsClient, type AwsClient, type AwsInstance } from './client.js';
import { cloudInitBoxEnv, generateBoxCloudInit } from './cloud-init.js';
import { detectEgressIp } from './egress-ip.js';
import { pollUntil } from './poll.js';
import { mapAwsProvisionError, validateInstanceChoice } from './preflight.js';
import { ensureAwsBaseAmi } from './prepare.js';
import { readPreparedState } from './prepared-state.js';
import { withAwsRetry } from './retry.js';
import {
  allowedSshSources,
  createPerBoxSecurityGroup,
  deletePerBoxSecurityGroup,
  normalizeSourceCidr,
  resolveFirewallSource,
  securityGroupIdFromTags,
  syncSecurityGroupSources,
  TAG_BOX,
  TAG_FIREWALL,
  TAG_MANAGED,
  TAG_ROLE,
} from './security-group.js';
import { sshOptArgs, waitForSsh, type SshTargetArgs } from './ssh-cli.js';
import { SshTunnelManager, defaultBoxSshDir } from './ssh-tunnel.js';
import { resolveDefaultSubnet } from './subnet.js';

export const AWS_DEFAULT_BOX_IMAGE_REF = 'agentbox-base';

/**
 * The cloud scaffolding defaults `req.image` to `'agentbox/box:dev'` (the docker
 * provider's local image tag) when nothing else is set. That is meaningless on
 * EC2 — we recognize it, our own sentinel, and plain `undefined` as "boot from
 * the prepared base AMI".
 */
const SCAFFOLDING_FALLBACK_IMAGE = 'agentbox/box:dev';
const VPS_USER = 'vscode';

const PROVISION_INSTANCE_DEADLINE_MS = 5 * 60_000;
const PROVISION_SSH_DEADLINE_MS = 10 * 60_000;
const TERMINATE_DEADLINE_MS = 3 * 60_000;
const AMI_DEADLINE_MS = 30 * 60_000;
const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const SCP_TIMEOUT_MS = 300_000;

/** t3.medium = 2 vCPU / 4 GB — the closest match to hetzner cx23 / DO s-2vcpu-4gb. */
const AWS_DEFAULT_INSTANCE_TYPE = 't3.medium';
const AWS_DEFAULT_REGION = 'us-east-1';
const AWS_DEFAULT_DISK_GB = 40;

/** One ControlMaster per box, for this process. */
const tunnels = new SshTunnelManager();

/**
 * The public IP each box's ControlMaster was opened against.
 *
 * EC2 hands out a NEW public IP on every start (there is no Elastic IP here), so
 * a master opened before a pause points at an address that now belongs to
 * somebody else — or to nothing. Without this check `tunnels.has(id)` would
 * happily reuse it and every exec after a resume would hang until it timed out.
 */
const tunnelIps = new Map<string, string>();

function client(region?: string): AwsClient {
  return makeAwsClient({ region });
}

/**
 * Map an EC2 instance state onto the four-value `CloudState` everyone else
 * consumes. `pending` reports as 'running' so callers don't ping-pong;
 * `stopping`/`stopped` are 'paused' (an EC2 stop is a power-off, like hetzner's,
 * not Daytona's archive); `shutting-down`/`terminated`/absent are 'missing'.
 */
export function mapState(s: string | undefined): CloudState {
  switch (s) {
    case 'pending':
    case 'running':
      return 'running';
    case 'stopping':
    case 'stopped':
      return 'paused';
    case 'shutting-down':
    case 'terminated':
      return 'missing';
    default:
      return 'missing';
  }
}

/**
 * Resolve the AMI a box should boot from.
 *
 * Precedence: `req.snapshot` (a checkpoint) ?? `req.image`. The sentinels
 * (`agentbox-base`, the docker fallback tag, or nothing at all) mean "the
 * prepared base AMI". An `ami-…` string is used verbatim. Anything else is
 * treated as an AMI *name* — that's how a cloud checkpoint round-trips, since
 * `createSnapshot` names the image rather than returning an id to the caller.
 */
export async function resolveImageRef(c: AwsClient, req: CloudProvisionRequest): Promise<string> {
  const ref = req.snapshot ?? req.image;

  if (!ref || ref === AWS_DEFAULT_BOX_IMAGE_REF || ref === SCAFFOLDING_FALLBACK_IMAGE) {
    const base = readPreparedState().base;
    if (!base) {
      // Should be unreachable — provision() gates on ensureAwsBaseAmi() first.
      throw new Error('aws: no base AMI recorded; run `agentbox prepare --provider aws`');
    }
    return base.amiId;
  }

  if (ref.startsWith('ami-')) return ref;

  const byName = await c.findImageByName(ref);
  if (!byName) {
    throw new Error(
      `aws: no AMI named '${ref}' in ${c.region}. AMIs are region-scoped — a checkpoint taken in ` +
        'another region is not visible here.',
    );
  }
  return byName.imageId;
}

// ---- per-box SSH state ----

interface PerBoxState {
  dir: string;
  identity: string;
  knownHosts: string;
}

function perBoxDir(sandboxId: string): string {
  return resolvePath(defaultBoxSshDir(sandboxId), '..');
}

async function ensurePerBoxState(sandboxId: string): Promise<PerBoxState> {
  const dir = perBoxDir(sandboxId);
  const sshDir = join(dir, 'ssh');
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  return {
    dir,
    identity: join(sshDir, 'id_ed25519'),
    knownHosts: join(sshDir, 'known_hosts'),
  };
}

function bashScript(s: string): string {
  // Always run remote commands under `bash -lc` so /etc/profile.d/agentbox.sh
  // (and the PATH prepend / DISPLAY / AGENT_BROWSER_* it sets) get sourced.
  return `bash -lc ${shellQuote(s)}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildSshTarget(state: PerBoxState, host: string, controlPath?: string): SshTargetArgs {
  return {
    host,
    user: VPS_USER,
    identity: state.identity,
    knownHosts: state.knownHosts,
    controlPath,
  };
}

/**
 * Open the ControlMaster if needed — and tear down a stale one first.
 *
 * The IP check is the EC2-specific part: see `tunnelIps`.
 */
async function ensureTunnel(sandboxId: string, state: PerBoxState, ip: string): Promise<void> {
  if (tunnels.has(sandboxId)) {
    if (tunnelIps.get(sandboxId) === ip) return;
    // The instance came back on a different address (a pause/resume). The old
    // master is pointed at a dead host; drop it rather than time out on it.
    await tunnels.close(sandboxId);
  }
  await tunnels.open({ boxId: sandboxId, vpsHost: ip, identity: state.identity });
  tunnelIps.set(sandboxId, ip);
}

/** The live public IP of an instance, or throw a clear error. */
async function liveIp(c: AwsClient, sandboxId: string): Promise<string> {
  const inst = await c.describeInstance(sandboxId);
  if (!inst) {
    throw new Error(`aws: instance ${sandboxId} not found (already destroyed?)`);
  }
  if (!inst.publicIp) {
    throw new Error(
      `aws: instance ${sandboxId} has no public IP (state '${inst.state}'). ` +
        (mapState(inst.state) === 'paused'
          ? 'It is stopped — start it first (`agentbox start`).'
          : 'It may still be booting.'),
    );
  }
  return inst.publicIp;
}

/**
 * Resolve the box's live address, open (or refresh) the ControlMaster, and return
 * an ssh target wired to it. Every exec / scp / forward starts here.
 */
async function ensureLiveTarget(sandboxId: string): Promise<{
  target: SshTargetArgs;
  state: PerBoxState;
  ip: string;
}> {
  const ip = await liveIp(client(), sandboxId);
  const state = await ensurePerBoxState(sandboxId);
  if (!existsSync(state.identity)) {
    throw new Error(
      `aws: per-box SSH key missing for instance ${sandboxId} (expected at ${state.identity}). ` +
        "If this box was created on a different host, you'll need to re-create it here.",
    );
  }
  await ensureTunnel(sandboxId, state, ip);
  return { target: buildSshTarget(state, ip, tunnels.controlPath(sandboxId)), state, ip };
}

/** Wait for an instance to actually reach `terminated` (or vanish). */
async function waitForTerminated(c: AwsClient, sandboxId: string): Promise<void> {
  await pollUntil(
    `instance ${sandboxId} terminated`,
    async () => {
      const i = await c.describeInstance(sandboxId);
      return i === null || i.state === 'terminated' ? true : null;
    },
    { deadlineMs: TERMINATE_DEADLINE_MS, intervalMs: 3_000, maxIntervalMs: 10_000 },
  ).catch(() => {
    // The SG delete has its own deadline loop; don't fail destroy over this.
  });
}

function summarize(i: AwsInstance): CloudSandboxSummary {
  return {
    sandboxId: i.instanceId,
    name: i.tags[TAG_BOX] ?? i.tags.Name,
    createdAt: i.launchTime,
    state: mapState(i.state),
  };
}

export const awsBackend: CloudBackend = {
  name: 'aws',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const onLog = req.onLog ?? (() => {});
    const progress = (s: string) => onLog(`aws: ${s}`);

    const region =
      (req.location && req.location.trim()) ||
      req.env?.AGENTBOX_AWS_REGION ||
      process.env.AWS_REGION ||
      AWS_DEFAULT_REGION;
    const c = client(region);

    // 1. Gate on the base AMI — including the region check, because an AMI baked
    // elsewhere simply cannot boot here.
    await ensureAwsBaseAmi(region);
    const imageId = await resolveImageRef(c, req);

    const instanceType = (req.size && req.size.trim()) || AWS_DEFAULT_INSTANCE_TYPE;
    const diskGb = req.diskGb ?? AWS_DEFAULT_DISK_GB;
    const choice = { instanceType, region, diskGb };

    // 2. Preflight BEFORE any billable resource exists. A bad instance type, a
    // Graviton/x86 mismatch or an undersized root volume fails here with a fix,
    // not fifteen minutes later behind a half-built box.
    const [typeInfo, offered, ami] = await Promise.all([
      c.describeInstanceType(instanceType),
      c.instanceTypeOfferedInRegion(instanceType),
      c.describeImage(imageId),
    ]);
    validateInstanceChoice(choice, typeInfo, offered, ami);

    // 3. Where it lives.
    const subnet = await resolveDefaultSubnet(c, req.subnetId);

    // 4. The inbound policy -> the SG's SSH sources. `locked`/`whitelist` need
    // the host egress IP; `open` (0.0.0.0/0) skips detection entirely.
    const inboundPolicy = parseInboundSpec(req.inbound);
    const hostEgress =
      inboundPolicy.mode === 'open' ? null : await resolveFirewallSource(req.env, onLog);
    const sources = resolveInboundSources(inboundPolicy, hostEgress);
    progress(`firewall inbound: ${describeInbound(inboundPolicy)} -> ${sources.join(', ')}`);

    // 5. Mint the per-box key into a temp dir; we only learn the instance id
    // afterwards, and the key has to exist before the instance boots (it goes in
    // via user-data).
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pendingDir = resolvePath(
      process.env.HOME ?? process.cwd(),
      '.agentbox',
      'aws',
      `pending-${stamp}`,
    );
    const { mintSshKey } = await import('./ssh-key.js');
    const key = await mintSshKey(join(pendingDir, 'ssh'), `agentbox-${req.name}`);

    let instanceId: string | null = null;
    let securityGroupId: string | null = null;

    try {
      // 6. The security group comes FIRST and is passed to RunInstances, so the
      // box is never up-but-unprotected.
      securityGroupId = await createPerBoxSecurityGroup(c, {
        name: `agentbox-${sanitizeName(req.name)}-${stamp}`,
        vpcId: subnet.vpcId,
        sourceCidrs: sources,
        tags: { [TAG_BOX]: req.name },
      });

      const boxEnv = cloudInitBoxEnv(req.env);
      const userData = generateBoxCloudInit({
        sshPubkey: key.publicKey,
        boxName: req.name,
        boxEnv: Object.keys(boxEnv).length > 0 ? boxEnv : undefined,
      });

      progress(`launching ${instanceType} in ${region} from ${imageId}`);
      const launched = await withAwsRetry(
        // NOT idempotent: a retry after an ambiguous failure could launch a
        // SECOND billable instance we'd never track.
        { method: 'RunInstances', retryOnAmbiguous: false },
        () =>
          c.runInstance({
            name: req.name,
            imageId,
            instanceType,
            subnetId: subnet.subnetId,
            securityGroupId: securityGroupId as string,
            userData,
            diskGb,
            tags: {
              Name: `agentbox-${req.name}`,
              [TAG_MANAGED]: 'true',
              [TAG_ROLE]: 'box',
              [TAG_BOX]: req.name,
              // Record the SG on the instance so destroy / `firewall sync` can
              // find it again without a name lookup (the Hetzner label trick).
              [TAG_FIREWALL]: securityGroupId as string,
            },
          }),
      ).catch((err: unknown) => {
        throw mapAwsProvisionError(err, choice);
      });
      instanceId = launched.instanceId;

      // 7. Wait for a running instance with a public IP.
      progress(`instance ${instanceId} launched; waiting for it to boot`);
      const ip = await pollUntil(
        `instance ${instanceId} running`,
        async () => {
          const i = await c.describeInstance(instanceId as string);
          return i && i.state === 'running' && i.publicIp ? i.publicIp : null;
        },
        {
          deadlineMs: PROVISION_INSTANCE_DEADLINE_MS,
          intervalMs: 3_000,
          maxIntervalMs: 10_000,
          onPoll: (l) => onLog(`aws: ${l}`),
        },
      );

      // 8. Move the key into its permanent, sandboxId-keyed home now that we
      // know the id.
      const state = await ensurePerBoxState(instanceId);
      await rename(key.privatePath, state.identity);
      await rename(key.publicPath, `${state.identity}.pub`);
      await rm(pendingDir, { recursive: true, force: true });

      progress(`waiting for ssh on ${ip}`);
      const up = await waitForSsh(buildSshTarget(state, ip), PROVISION_SSH_DEADLINE_MS);
      if (!up) {
        throw new Error(
          `aws: ssh on ${ip} did not come up within ${String(PROVISION_SSH_DEADLINE_MS / 1000)}s.\n` +
            "If this persists, check that the host's egress IP is stable — the box's security group " +
            'is locked to it, so an IP change blocks ssh (`agentbox aws firewall sync <box>`).',
        );
      }
      await ensureTunnel(instanceId, state, ip);

      return {
        sandboxId: instanceId,
        // Report what was actually provisioned, read back from the type catalog
        // (the disk is ours — it's the root volume we asked for).
        resources: {
          cpu: typeInfo?.vcpus,
          memory: typeInfo?.memoryGb,
          disk: diskGb,
        },
        inbound: inboundPolicy,
      };
    } catch (err) {
      // Cleanup, best-effort, in dependency order: the instance first (it bills),
      // then the SG (which cannot go until the ENI detaches), then the key.
      if (instanceId !== null) {
        onLog(`aws: cleanup — terminating instance ${instanceId} after a failed create`);
        await c.terminateInstance(instanceId).catch(() => {
          onLog(`aws: WARN could not terminate ${instanceId} — CHECK THE EC2 CONSOLE, it is billing.`);
        });
        await waitForTerminated(c, instanceId);
        await rm(perBoxDir(instanceId), { recursive: true, force: true }).catch(() => {});
      }
      if (securityGroupId !== null) {
        await deletePerBoxSecurityGroup(c, securityGroupId, { onLog }).catch(() => {});
      }
      await rm(pendingDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const i = await client().describeInstance(sandboxId);
    if (!i || i.state === 'terminated') return null;
    return { sandboxId };
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const instances = await client().listInstances([
      { Name: `tag:${TAG_MANAGED}`, Values: ['true'] },
      // A terminated instance lingers in DescribeInstances for ~an hour; it is
      // not an orphan, so `agentbox prune` must not offer to delete it.
      {
        Name: 'instance-state-name',
        Values: ['pending', 'running', 'stopping', 'stopped'],
      },
    ]);
    return instances.map(summarize);
  },

  async start(h: CloudHandle): Promise<void> {
    const c = client();
    await c.startInstance(h.sandboxId);

    const ip = await pollUntil(
      `instance ${h.sandboxId} running`,
      async () => {
        const i = await c.describeInstance(h.sandboxId);
        return i && i.state === 'running' && i.publicIp ? i.publicIp : null;
      },
      { deadlineMs: PROVISION_INSTANCE_DEADLINE_MS, intervalMs: 3_000, maxIntervalMs: 8_000 },
    );

    // The instance is `running` a little before sshd accepts connections, so wait
    // for ssh rather than letting the provider's relaunch exec hit ECONNREFUSED.
    const state = await ensurePerBoxState(h.sandboxId);
    const up = await waitForSsh(buildSshTarget(state, ip), PROVISION_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(
        `aws: ssh on ${ip} did not come up within ${String(PROVISION_SSH_DEADLINE_MS / 1000)}s after start. ` +
          "This is usually transient — retry. If it persists, check that the host's egress IP hasn't " +
          'changed (`agentbox aws firewall sync <box>`).',
      );
    }
    // NB: the IP above is almost certainly NOT the one this box had before it was
    // stopped. `ensureTunnel` notices and rebuilds the master against the new one.
    await ensureTunnel(h.sandboxId, state, ip);
  },

  async stop(h: CloudHandle): Promise<void> {
    await client().stopInstance(h.sandboxId);
    await tunnels.close(h.sandboxId);
    tunnelIps.delete(h.sandboxId);
  },

  async pause(h: CloudHandle): Promise<void> {
    // EC2 has no archive primitive. Pause === stop (power off). Note this still
    // bills for the EBS volume — see docs/aws_backlog.md.
    await this.stop(h);
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    const c = client();
    await tunnels.close(h.sandboxId);
    tunnelIps.delete(h.sandboxId);

    // Read the SG off the instance's tag BEFORE terminating — once the instance
    // is gone the tag goes with it, and the SG would be orphaned with no way to
    // find it except by name.
    let securityGroupId: string | undefined;
    try {
      const inst = await c.describeInstance(h.sandboxId);
      if (inst) securityGroupId = securityGroupIdFromTags(inst.tags);
    } catch {
      // ignore — still try to terminate.
    }

    await c.terminateInstance(h.sandboxId);

    if (securityGroupId) {
      // The SG cannot be deleted until the ENI has detached, which lags
      // `terminated`. Wait, then delete (which retries through
      // DependencyViolation anyway).
      await waitForTerminated(c, h.sandboxId);
      await deletePerBoxSecurityGroup(c, securityGroupId);
    }

    await rm(perBoxDir(h.sandboxId), { recursive: true, force: true }).catch(() => {});
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const i = await client().describeInstance(h.sandboxId);
    return i ? mapState(i.state) : 'missing';
  },

  async exec(h, cmd, opts): Promise<CloudExecResult> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    const argv = [
      ...sshOptArgs(target),
      `${target.user}@${target.host}`,
      bashScript(opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${cmd}` : cmd),
    ];
    const res = await execa('ssh', argv, {
      reject: false,
      timeout: opts?.attemptTimeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
      env: opts?.env,
    });
    return {
      exitCode: res.exitCode ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  },

  async uploadFile(h, localPath, remotePath): Promise<void> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    const res = await execa(
      'scp',
      [...sshOptArgs(target), localPath, `${target.user}@${target.host}:${remotePath}`],
      { reject: false, timeout: SCP_TIMEOUT_MS },
    );
    if (res.exitCode !== 0) {
      throw new Error(`aws: scp upload failed (exit ${String(res.exitCode)}): ${res.stderr}`);
    }
  },

  async downloadFile(h, remotePath, localPath): Promise<void> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    const res = await execa(
      'scp',
      [...sshOptArgs(target), `${target.user}@${target.host}:${remotePath}`, localPath],
      { reject: false, timeout: SCP_TIMEOUT_MS },
    );
    if (res.exitCode !== 0) {
      throw new Error(`aws: scp download failed (exit ${String(res.exitCode)}): ${res.stderr}`);
    }
  },

  async listFiles(h, remoteDir): Promise<CloudFileEntry[]> {
    const res = await this.exec(h, `find ${shellQuote(remoteDir)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n'`);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, type] = line.split('\t');
        return { name: name ?? '', isDir: type === 'd' };
      })
      .filter((e) => e.name.length > 0);
  },

  async previewUrl(h, port): Promise<CloudPreviewUrl> {
    await ensureLiveTarget(h.sandboxId);
    const localPort = await tunnels.forward(h.sandboxId, port);
    // The ssh -L forward IS the auth — no token needed.
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  async signedPreviewUrl(h, port): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  async refreshPreviewUrl(h, port): Promise<CloudPreviewUrl> {
    // Called by the host poller when a forwarded port stops answering — usually
    // a ControlMaster that died across a host sleep/wake. Rebuild it against the
    // instance's CURRENT ip (which may also have changed) and re-mint.
    const c = client();
    const ip = await liveIp(c, h.sandboxId);
    const state = await ensurePerBoxState(h.sandboxId);
    await tunnels.refresh({ boxId: h.sandboxId, vpsHost: ip, identity: state.identity });
    tunnelIps.set(h.sandboxId, ip);
    const localPort = await tunnels.forward(h.sandboxId, port);
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  async setInbound(h: CloudHandle, policy: InboundPolicy): Promise<{ sources: string[] }> {
    const c = client();
    const groupId = await securityGroupFor(c, h.sandboxId);
    const hostEgress = policy.mode === 'open' ? null : normalizeSourceCidr(await detectEgressIp({}));
    const sources = resolveInboundSources(policy, hostEgress);
    await syncSecurityGroupSources(c, groupId, sources);
    return { sources };
  },

  async repairReachability(h: CloudHandle): Promise<{ changed: boolean; detail?: string }> {
    // Self-heal on a connection-ESTABLISHMENT failure: if the host's current
    // egress IP isn't in the SG's SSH sources (the laptop moved networks),
    // re-sync — merging the stored whitelist so an open/whitelisted box is never
    // narrowed. Hetzner has this; DigitalOcean dropped it.
    const c = client();
    const policy: InboundPolicy = h.inbound ?? { mode: 'locked', sources: [] };
    if (policy.mode === 'open') return { changed: false };

    const groupId = await securityGroupFor(c, h.sandboxId).catch(() => null);
    if (!groupId) return { changed: false };

    const sg = await c.describeSecurityGroup(groupId).catch(() => null);
    if (!sg) return { changed: false };

    const allowed = allowedSshSources(sg);
    if (allowed.includes('0.0.0.0/0')) return { changed: false };

    // Deliberately UNCACHED: this only runs on a connect failure, which is
    // exactly when a cached egress IP would be the stale thing misleading us.
    const currentEgress = normalizeSourceCidr(await detectEgressIp({}));
    if (allowed.includes(currentEgress)) return { changed: false };

    const sources = resolveInboundSources(policy, currentEgress);
    await syncSecurityGroupSources(c, groupId, sources);
    return {
      changed: true,
      detail: `security group updated: SSH now allowed from ${sources.join(', ')} (was ${allowed.join(', ') || '(no rule)'})`,
    };
  },

  async attachArgv(h: CloudHandle): Promise<string[]> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    return ['ssh', ...sshOptArgs(target), `${target.user}@${target.host}`];
  },

  async startInBoxPortless(h, opts): Promise<void> {
    // Mirror the host's Portless setup inside the box, so `<box>.localhost`
    // resolves to the same content from the host browser and from in-box clients.
    // Runs as ROOT: portless's :80/:443 proxy self-elevates and keeps its state in
    // /root/.portless, so a `vscode` alias would write to a disjoint state dir.
    const tlsFlag = opts.tls ? '' : ' --no-tls';
    const cmds = [
      `sudo portless proxy start${tlsFlag} -p ${String(opts.proxyPort)} || true`,
      `sudo portless alias ${shellQuote(opts.boxName)} ${String(opts.webPort)} || true`,
    ];
    if (opts.tls) {
      cmds.push('sudo agentbox-portless-trust /root/.portless/ca.pem || true');
    }
    // Best-effort: a failure here degrades the URL, it must not break create.
    await this.exec(h, cmds.join(' && ')).catch(() => undefined);
  },

  async createSnapshot(h: CloudHandle, snapshotName: string): Promise<void> {
    const c = client();
    // Flush the page cache first: CreateImage(NoReboot) captures the volume as-is,
    // so anything still buffered would be missing from the AMI.
    await this.exec(h, 'sync').catch(() => undefined);

    const amiId = await withAwsRetry(
      // Not idempotent — a retry would create a second AMI (and a second set of
      // billable EBS snapshots) under a name that must stay unique.
      { method: 'CreateImage', retryOnAmbiguous: false },
      () => c.createImage(h.sandboxId, snapshotName, `AgentBox checkpoint ${snapshotName}`),
    );

    await pollUntil(
      `AMI ${amiId} available`,
      async () => {
        const img = await c.describeImage(amiId);
        if (img?.state === 'failed') throw new Error(`aws: AMI ${amiId} entered state 'failed'`);
        return img?.state === 'available' ? img : null;
      },
      { deadlineMs: AMI_DEADLINE_MS, intervalMs: 5_000, maxIntervalMs: 15_000 },
    );
  },

  async deleteSnapshot(snapshotName: string): Promise<void> {
    const c = client();
    const img = await c.findImageByName(snapshotName);
    if (!img) return; // already gone — idempotent, like destroy.

    await c.deregisterImage(img.imageId);
    // Deregistering an AMI does NOT delete the EBS snapshots behind it. Skip this
    // and every checkpoint leaks storage that bills forever, invisibly.
    for (const snapshotId of img.snapshotIds) {
      await c.deleteSnapshot(snapshotId);
    }
  },

  async snapshotExists(snapshotName: string): Promise<boolean> {
    try {
      const img = await client().findImageByName(snapshotName);
      // Only an `available` AMI can actually boot an instance; a `pending` or
      // `failed` one would 400 at RunInstances.
      return img?.state === 'available';
    } catch {
      return false;
    }
  },
};

/** The per-box SG id, from the instance's `agentbox.firewall` tag. */
async function securityGroupFor(c: AwsClient, sandboxId: string): Promise<string> {
  const inst = await c.describeInstance(sandboxId);
  if (!inst) throw new Error(`aws: instance ${sandboxId} not found`);
  const groupId = securityGroupIdFromTags(inst.tags);
  if (!groupId) {
    throw new Error(
      `aws: instance ${sandboxId} has no security group on its \`${TAG_FIREWALL}\` tag ` +
        '(was it provisioned outside agentbox?)',
    );
  }
  return groupId;
}

/** EC2 security-group names allow a limited charset; box names are freer. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100);
}
