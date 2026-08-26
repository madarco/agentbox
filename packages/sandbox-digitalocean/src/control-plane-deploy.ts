/**
 * Deploy the AgentBox hosted control plane (the `apps/hub` Next.js +
 * Postgres app) to a fresh DigitalOcean Droplet, reachable over HTTPS at
 * `https://<ipv4>.sslip.io` (sslip.io resolves the host to the IP; Caddy auto-
 * provisions a Let's Encrypt cert — no domain or DNS setup needed).
 *
 * Shape (identical to the Hetzner deploy — see `@agentbox/sandbox-hetzner`):
 *   1. firewall — SSH from the host egress IP, :80/:443 open (ACME + serving).
 *      Created with a unique per-deploy tag BEFORE the droplet, and the droplet
 *      is created with the same tag, so DigitalOcean auto-applies the firewall
 *      the moment it boots — there is never an unprotected window.
 *   2. cloud-init — stock Ubuntu boots, installs Docker + git (+ clones the repo
 *      in source mode).
 *   3. over ssh (as root): scp the secret `.env` + compose stack, then
 *      `docker compose up -d --build`.
 *   4. poll `https://<domain>/healthz` until the cert + app are live.
 *
 * Everything after the ssh hop is the provider-agnostic `applyControlPlaneConfig`
 * shared with Hetzner — this module only owns the DigitalOcean-specific
 * provisioning (droplet + firewall + tag) and teardown.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HubDeploySource } from '@agentbox/sandbox-core';
import {
  applyControlPlaneConfig,
  resolveHubDeployAssets,
  type SshTargetArgs,
} from '@agentbox/sandbox-hetzner';
import {
  makeDigitalOceanClient,
  type CreateFirewallRequest,
  type DigitalOceanClient,
  type DigitalOceanDroplet,
} from './client.js';
import { controlPlaneCloudInit } from './cloud-init.js';
import { detectEgressIp } from './egress-ip.js';
import {
  allowAllOutboundRules,
  controlPlaneInboundRules,
  deletePerBoxFirewall,
  firewallNeedsSync,
  normalizeSourceCidr,
} from './firewall.js';
import { pollUntil } from './poll.js';
import { withDigitalOceanRetry } from './retry.js';
import { mintSshKey } from './ssh-key.js';
import { sshExec, waitForSsh } from './ssh-cli.js';

// Stock image the control-plane Droplet boots from. Same slug the box/prepare
// paths use — DigitalOcean spells Ubuntu 24.04 `ubuntu-24-04-x64`.
const STOCK_IMAGE_SLUG = 'ubuntu-24-04-x64';
const DEFAULT_SIZE = 's-2vcpu-4gb';
const DEFAULT_REGION = 'nyc3';

// The monorepo checkout cloud-init makes in source mode — what `hub update --ref`
// re-checks-out. Absent entirely in package mode.
const REMOTE_REPO_DIR = '/opt/agentbox';

const PROVISION_DROPLET_DEADLINE_MS = 5 * 60_000;

/** Single-quote a value for a remote `sh -c` command line. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Extract the droplet's public IPv4 address, if assigned yet. */
function publicIpv4(droplet: DigitalOceanDroplet): string | undefined {
  return droplet.networks.v4.find((n) => n.type === 'public')?.ip_address;
}

export interface ControlPlaneDigitalOceanDeployOptions {
  /** Contents of `control-plane.env` — GH_TOKEN / ADMIN_TOKEN / hub-auth. */
  envContent: string;
  /** Override the public hostname (default `<ipv4>.sslip.io`). */
  domain?: string;
  /** npm package vs. clone-and-build. See `HubDeploySource`. */
  source: HubDeploySource;
  size?: string;
  region?: string;
  serverImage?: string;
  onLog?: (line: string) => void;
  /**
   * Fired as soon as the Droplet exists and its IP + SSH key are known — BEFORE
   * the ssh wait, the compose build, and the healthz poll, all of which routinely
   * fail. The droplet + firewall are not rolled back on failure, so the caller
   * must be able to persist the connection details before they can be lost.
   */
  onProvisioned?: (info: ControlPlaneDigitalOceanDeployResult) => void | Promise<void>;
}

export interface ControlPlaneDigitalOceanDeployResult {
  url: string;
  /** Droplet id (numeric). */
  serverId: number;
  ip: string;
  domain: string;
  /** DigitalOcean firewall id — a UUID string. */
  firewallId: string;
  /** The unique per-deploy tag the firewall is bound to (deleted on destroy). */
  firewallTag: string;
  sshKeyDir: string;
}

/**
 * Provision the control-plane firewall (SSH host-only, :80/:443 open) and bind
 * it to a fresh unique tag. The tag is created FIRST — DigitalOcean rejects a
 * firewall referencing a tag that doesn't exist — so the droplet (created with
 * the same tag later) is protected the instant it boots.
 */
async function createControlPlaneFirewall(
  client: DigitalOceanClient,
  name: string,
  tag: string,
  hostCidr: string,
): Promise<string> {
  await withDigitalOceanRetry(
    { method: 'createTag', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.createTag(tag),
  );
  const body: CreateFirewallRequest = {
    name,
    inbound_rules: controlPlaneInboundRules(hostCidr),
    outbound_rules: allowAllOutboundRules(),
    tags: [tag],
  };
  const fw = await withDigitalOceanRetry(
    { method: 'createFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.createFirewall(body),
  );
  return fw.id;
}

export async function deployControlPlaneToDigitalOcean(
  opts: ControlPlaneDigitalOceanDeployOptions,
): Promise<ControlPlaneDigitalOceanDeployResult> {
  const log = opts.onLog ?? (() => {});
  const source = opts.source;
  const client = makeDigitalOceanClient();

  // Package mode ships the compose stack from the host, so resolve it BEFORE
  // spending money on a droplet — a partial dev build should fail here, not after.
  if (source.kind === 'package') resolveHubDeployAssets();

  const stamp = Date.now().toString(36);
  const name = `agentbox-control-plane-${stamp}`;
  const tag = name;

  log('detecting host egress IP for the firewall…');
  const hostCidr = normalizeSourceCidr(await detectEgressIp());

  log('creating the control-plane firewall (:22 host-only, :80/:443 open)…');
  const firewallId = await createControlPlaneFirewall(client, name, tag, hostCidr);

  const keyDir = join(homedir(), '.agentbox', 'control-plane', 'ssh', stamp);
  const key = await mintSshKey(keyDir, `agentbox-control-plane-${stamp}`);
  const knownHosts = join(keyDir, 'known_hosts');

  const size = opts.size ?? DEFAULT_SIZE;
  const region = opts.region ?? DEFAULT_REGION;
  log(
    source.kind === 'package'
      ? `provisioning ${size} Droplet in ${region} (hub from npm: @madarco/agentbox@${source.spec})…`
      : `provisioning ${size} Droplet in ${region} (hub from source: ${source.repoUrl}@${source.repoRef})…`,
  );
  // retryOnAmbiguous: false — a droplet is billable, so a hidden success on retry
  // would duplicate a paid resource.
  const created = await withDigitalOceanRetry(
    { method: 'createDroplet', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
    () =>
      client.createDroplet({
        name,
        region,
        size,
        image: opts.serverImage ?? STOCK_IMAGE_SLUG,
        user_data: controlPlaneCloudInit({
          sshPubkey: key.publicKey,
          // Package mode needs no repo on the droplet at all.
          ...(source.kind === 'source' ? { repo: { url: source.repoUrl, ref: source.repoRef } } : {}),
        }),
        tags: [tag, 'agentbox'],
        ipv6: false,
      }),
  );
  const dropletId = created.droplet.id;
  log(`droplet ${String(dropletId)} created; waiting for it to boot…`);

  const droplet = await pollUntil(
    `droplet ${String(dropletId)} active`,
    async () => {
      const d = await client.getDroplet(dropletId);
      return d && d.status === 'active' && publicIpv4(d) ? d : null;
    },
    { deadlineMs: PROVISION_DROPLET_DEADLINE_MS, intervalMs: 3_000, maxIntervalMs: 10_000 },
  );
  const ip = publicIpv4(droplet);
  if (!ip) throw new Error(`digitalocean: droplet ${String(dropletId)} came up without a public IPv4`);

  const domain = opts.domain ?? `${ip}.sslip.io`;
  const url = `https://${domain}`;
  const target: SshTargetArgs = { host: ip, user: 'root', identity: key.privatePath, knownHosts };

  const provisioned: ControlPlaneDigitalOceanDeployResult = {
    url,
    serverId: dropletId,
    ip,
    domain,
    firewallId,
    firewallTag: tag,
    sshKeyDir: keyDir,
  };
  // Best-effort: a caller's bookkeeping failure must not abort a deploy that is
  // otherwise fine (the record is a debugging aid, not part of the contract).
  try {
    await opts.onProvisioned?.(provisioned);
  } catch {
    /* best-effort */
  }

  log(`droplet ${ip} up; waiting for ssh…`);
  if (!(await waitForSsh(target, 5 * 60_000))) {
    throw new Error(`ssh never came up on ${ip}`);
  }
  log(
    source.kind === 'package'
      ? 'waiting for cloud-init (Docker)…'
      : 'waiting for cloud-init (Docker + repo clone)…',
  );
  await sshExec(target, 'cloud-init status --wait || true', { timeoutMs: 12 * 60_000, onLine: log });

  await applyControlPlaneConfig({
    target,
    source,
    envContent: opts.envContent,
    url,
    domain,
    hostCidr,
    stamp,
    onLog: log,
    requireClonedRepo: true,
  });

  return provisioned;
}

export interface ControlPlaneDigitalOceanUpdateOptions {
  /** The existing control box, from `deploy.json`. */
  record: { ip: string; sshKeyDir: string; url: string; domain?: string; firewallId?: string };
  /** The version to move to. */
  source: HubDeploySource;
  /** Contents of `control-plane.env`. */
  envContent: string;
  onLog?: (line: string) => void;
}

/**
 * Move an existing control box to a different build, in place. Everything after
 * the ssh hop is the same code a fresh deploy runs (`applyControlPlaneConfig`),
 * so an update stays equivalent to a redeploy. The data volume is never touched,
 * so the store, logins, custody and box SSH keys survive.
 */
export async function updateControlPlaneOnDigitalOcean(
  opts: ControlPlaneDigitalOceanUpdateOptions,
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const { record, source } = opts;
  const stamp = Date.now().toString(36);
  const domain = record.domain ?? new URL(record.url).hostname;

  // Only :22 is locked to an IP (:80/:443 stay open so boxes can reach the hub),
  // so a laptop that changed networks since the deploy cannot ssh in at all.
  // Re-sync over the DigitalOcean API FIRST — that path still works when ssh
  // doesn't, which is exactly the situation that needs fixing.
  const hostCidr = normalizeSourceCidr(await detectEgressIp());
  if (record.firewallId !== undefined) {
    const client = makeDigitalOceanClient();
    const fw = await client.getFirewall(record.firewallId);
    const sshRule = fw?.inbound_rules.find((r) => r.protocol === 'tcp' && r.ports === '22');
    if (fw && firewallNeedsSync(sshRule?.sources.addresses, hostCidr)) {
      log(`egress IP changed — re-locking SSH to ${hostCidr}…`);
      await withDigitalOceanRetry(
        { method: 'updateFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
        () =>
          client.updateFirewall(record.firewallId as string, {
            name: fw.name,
            inbound_rules: controlPlaneInboundRules(hostCidr),
            outbound_rules: allowAllOutboundRules(),
            droplet_ids: fw.droplet_ids,
            tags: fw.tags,
          }),
      );
    }
  }

  const target: SshTargetArgs = {
    host: record.ip,
    user: 'root',
    identity: join(record.sshKeyDir, 'id_ed25519'),
    knownHosts: join(record.sshKeyDir, 'known_hosts'),
  };
  log(`connecting to ${record.ip}…`);
  if (!(await waitForSsh(target, 2 * 60_000))) {
    throw new Error(
      `ssh did not come up on ${record.ip} — the droplet may be off, or its firewall still allows a different IP than ${hostCidr}`,
    );
  }

  if (source.kind === 'source') {
    // A package-mode box has no repo at all — cloud-init skipped the clone — so
    // `git fetch` there would fail with a bare "not a git repository".
    const isRepo = await sshExec(target, `test -d ${REMOTE_REPO_DIR}/.git`);
    if (isRepo.exitCode !== 0) {
      throw new Error(
        `this control box was installed from npm, so there is no git checkout on it to update. ` +
          `\`hub update --ref\` only works on a box deployed with --ref; to switch, deploy a new one ` +
          `(\`agentbox hub deploy digitalocean --ref ${source.repoRef}\`) and destroy this one.`,
      );
    }
    log(`checking out ${source.repoRef} on the droplet…`);
    const co = await sshExec(
      target,
      `cd ${REMOTE_REPO_DIR} && git remote set-url origin ${shQuote(source.repoUrl)} && git fetch --depth 1 origin ${shQuote(source.repoRef)} && git checkout --force FETCH_HEAD`,
      { timeoutMs: 5 * 60_000, onLine: log },
    );
    if (co.exitCode !== 0) {
      throw new Error(
        `could not check out ${source.repoRef} on the droplet (exit ${String(co.exitCode)}): ${co.stderr || co.stdout}`,
      );
    }
  }

  await applyControlPlaneConfig({
    target,
    source,
    envContent: opts.envContent,
    url: record.url,
    domain,
    hostCidr,
    stamp,
    onLog: log,
  });
}

export interface ControlPlaneDestroyResult {
  serverDeleted: boolean;
  firewallDeleted: boolean;
  /** Non-fatal problems worth reporting (already-gone resources, API errors). */
  warnings: string[];
}

/**
 * Delete a control box's DigitalOcean resources. Needs no ssh — which matters,
 * because `:22` is locked to whichever egress IP deployed the box, so a user on
 * a different network can still tear it down.
 *
 * Never throws for a resource that is already gone: the local state must still
 * be purged afterwards, or a half-deleted control box leaves the user with
 * config pointing at nothing and no command that will clear it.
 */
export async function destroyControlPlaneOnDigitalOcean(opts: {
  serverId?: number;
  firewallId?: string;
  firewallTag?: string;
  onLog?: (line: string) => void;
  /** Seam for tests; defaults to the real DigitalOcean client. */
  client?: Pick<DigitalOceanClient, 'deleteDroplet' | 'deleteFirewall' | 'deleteTag'>;
}): Promise<ControlPlaneDestroyResult> {
  const log = opts.onLog ?? (() => {});
  const warnings: string[] = [];
  // Built lazily: a record with nothing to delete must not demand a token it will
  // never use (makeDigitalOceanClient throws when the token is empty).
  let lazyClient: Pick<DigitalOceanClient, 'deleteDroplet' | 'deleteFirewall' | 'deleteTag'> | undefined =
    opts.client;
  const client = (): Pick<DigitalOceanClient, 'deleteDroplet' | 'deleteFirewall' | 'deleteTag'> =>
    (lazyClient ??= makeDigitalOceanClient());
  let serverDeleted = false;
  let firewallDeleted = false;

  if (opts.serverId !== undefined) {
    try {
      log(`deleting droplet ${String(opts.serverId)}…`);
      await client().deleteDroplet(opts.serverId);
      serverDeleted = true;
    } catch (e) {
      warnings.push(`droplet ${String(opts.serverId)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (opts.firewallId !== undefined) {
    try {
      log(`deleting firewall ${opts.firewallId}…`);
      // Handles the 409 "still attached to a just-deleted droplet" window and
      // cleans up the per-deploy tag once the firewall (its last referrer) is gone.
      await deletePerBoxFirewall(client() as DigitalOceanClient, opts.firewallId, {
        ...(opts.firewallTag ? { tags: [opts.firewallTag] } : {}),
      });
      firewallDeleted = true;
    } catch (e) {
      warnings.push(`firewall ${opts.firewallId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { serverDeleted, firewallDeleted, warnings };
}
