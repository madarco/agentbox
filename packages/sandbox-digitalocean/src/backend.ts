/**
 * DigitalOcean `CloudBackend` — maps the provider-neutral cloud primitives
 * onto OpenSSH + the DigitalOcean API v2. Mirrors the Hetzner backend; the
 * shape is identical (1 Droplet per box, SSH ControlMaster for all I/O,
 * per-box Cloud Firewall locked to the host egress IP, snapshot-based
 * checkpoints). The DigitalOcean-specific wrinkles:
 *
 *   - `createDroplet` returns no IP — the droplet boots over ~30-60s, so we
 *     poll `getDroplet` until status `active` + a public IPv4 appears.
 *   - Droplet mutations (power_on/off, snapshot) return an *action id* that
 *     must be polled via `getAction` until `completed`.
 *   - The Cloud Firewall is created *before* the droplet and attached via a
 *     unique per-box tag, so DigitalOcean auto-applies it at boot. The
 *     firewall id is a UUID string, discovered at destroy/sync time by tag.
 */

import { existsSync } from 'node:fs';
import { rm, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { resolve as resolvePath } from 'node:path';
import type {
  CloudBackend,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@agentbox/core';
import { generateBoxCloudInit } from './cloud-init.js';
import {
  DigitalOceanApiError,
  makeDigitalOceanClient,
  type DigitalOceanClient,
  type DigitalOceanDroplet,
  type DigitalOceanDropletStatus,
} from './client.js';
import { detectEgressIp } from './egress-ip.js';
import { createPerBoxFirewall, deletePerBoxFirewall, findFirewallForDroplet, normalizeSourceCidr } from './firewall.js';
import { pollUntil } from './poll.js';
import { mapDigitalOceanProvisionError, validateSizeChoice } from './preflight.js';
import { readPreparedState } from './prepared-state.js';
import { ensureDigitalOceanBaseSnapshot } from './prepare.js';
import { mintSshKey } from './ssh-key.js';
import { waitForSsh, sshOptArgs, type SshTargetArgs } from './ssh-cli.js';
import { SshTunnelManager, defaultBoxSshDir } from './ssh-tunnel.js';
import { withDigitalOceanRetry } from './retry.js';

export const DIGITALOCEAN_DEFAULT_BOX_IMAGE_REF = 'agentbox-base';

/**
 * The cloud-provider scaffolding defaults `req.image` to `'agentbox/box:dev'`
 * (the docker provider's local image tag) when nothing else is specified.
 * That value is meaningless on DigitalOcean — we recognize it (alongside our
 * own sentinel + plain undefined) as "use the digitalocean base snapshot."
 */
const SCAFFOLDING_FALLBACK_IMAGE = 'agentbox/box:dev';
const VPS_USER = 'vscode';
const PROVISION_SSH_DEADLINE_MS = 10 * 60_000;
const PROVISION_DROPLET_DEADLINE_MS = 5 * 60_000;
const ACTION_DEADLINE_MS = 5 * 60_000;
const SNAPSHOT_DEADLINE_MS = 30 * 60_000;
// s-2vcpu-4gb: 2 vCPU / 4 GB / 80 GB SSD — the closest match to Hetzner's
// cx23 default. nyc3 is a broadly-available US region.
const DIGITALOCEAN_DEFAULT_SIZE = 's-2vcpu-4gb';
const DIGITALOCEAN_DEFAULT_REGION = 'nyc3';

/**
 * Secrets that must never land in the world-readable (0644) cloud-init
 * `/etc/agentbox/box.env`. The relay token reaches in-box ctl via the daemon's
 * 0600 `relay.env` (written by the bootstrap exec that carries these in its
 * process env); the bridge token stays in the daemon's process env. Mirrors the
 * Hetzner backend.
 */
const CLOUD_INIT_BOX_ENV_EXCLUDE = new Set<string>([
  'AGENTBOX_RELAY_URL',
  'AGENTBOX_RELAY_TOKEN',
  'AGENTBOX_BRIDGE_TOKEN',
]);

/**
 * Build the cloud-init `box.env` passthrough: the `AGENTBOX_*` identity/portless
 * vars, with the relay/bridge secrets in `CLOUD_INIT_BOX_ENV_EXCLUDE` stripped
 * (cloud-init writes box.env 0644 — those secrets travel via the daemon's 0600
 * `relay.env` / process env instead). Exported for unit testing.
 */
export function cloudInitBoxEnv(
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && k.startsWith('AGENTBOX_') && !CLOUD_INIT_BOX_ENV_EXCLUDE.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** Module-level tunnel manager — one ControlMaster per box for this process. */
const tunnels = new SshTunnelManager();

/**
 * Map a DigitalOcean droplet status onto the four-value `CloudState` everyone
 * else consumes. `new` (provisioning) reports as 'running' so callers don't
 * ping-pong; 'off' maps to 'paused' (DigitalOcean stop = power off, vs
 * Daytona's archive); 'archive' is a rare locked state we surface as paused.
 */
function mapState(s: DigitalOceanDropletStatus | string | undefined): CloudState {
  switch (s) {
    case 'active':
    case 'new':
      return 'running';
    case 'off':
    case 'archive':
      return 'paused';
    default:
      return 'missing';
  }
}

function client(): DigitalOceanClient {
  return makeDigitalOceanClient();
}

/** Extract the droplet's public IPv4 address, if assigned yet. */
function publicIpv4(droplet: DigitalOceanDroplet): string | undefined {
  return droplet.networks.v4.find((n) => n.type === 'public')?.ip_address;
}

async function getDropletStrict(id: number): Promise<DigitalOceanDroplet> {
  const d = await client().getDroplet(id);
  if (!d) {
    throw new Error(`digitalocean: droplet ${String(id)} not found (already destroyed?)`);
  }
  return d;
}

/** Sanitize a box name into a DigitalOcean tag fragment (alnum / dash / underscore). */
function sanitizeTag(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 200);
}

/**
 * Poll a DigitalOcean action id until it reaches `completed`. Throws if the
 * action ends `errored` or the deadline elapses.
 */
async function waitAction(
  c: DigitalOceanClient,
  actionId: number,
  label: string,
  deadlineMs: number,
): Promise<void> {
  await pollUntil(
    label,
    async () => {
      const a = await c.getAction(actionId);
      if (!a) return null;
      if (a.status === 'errored') {
        throw new Error(`digitalocean: action ${String(actionId)} (${label}) errored`);
      }
      return a.status === 'completed' ? a : null;
    },
    { deadlineMs, intervalMs: 2_000, maxIntervalMs: 8_000 },
  );
}

/**
 * Resolve a `CloudProvisionRequest.image|snapshot` into a DigitalOcean image
 * ref. Precedence: `req.snapshot` → `req.image`:
 *   - the sentinel `agentbox-base` (or the scaffolding fallback / undefined)
 *     → load the snapshot id from `digitalocean-prepared.json`.
 *   - a numeric string → use as a snapshot/image id.
 *   - any other string → treated as a snapshot name (checkpoint) and looked
 *     up via the API; falls through to a DigitalOcean stock image slug.
 */
async function resolveImageRef(c: DigitalOceanClient, req: CloudProvisionRequest): Promise<number | string> {
  const ref = req.snapshot ?? req.image;
  if (!ref || ref === DIGITALOCEAN_DEFAULT_BOX_IMAGE_REF || ref === SCAFFOLDING_FALLBACK_IMAGE) {
    await ensureDigitalOceanBaseSnapshot();
    const state = readPreparedState();
    if (!state.base) {
      throw new Error(
        'no DigitalOcean base snapshot found — run `agentbox prepare --provider digitalocean` to bake one.',
      );
    }
    return state.base.imageId;
  }
  if (/^\d+$/.test(ref)) {
    return Number.parseInt(ref, 10);
  }
  // Try snapshot-by-name first (checkpoints use that), then fall through to a
  // DigitalOcean stock image slug (the user passed e.g. `ubuntu-24-04-x64`).
  const snap = (await c.listSnapshots()).find((s) => s.name === ref);
  if (snap) return Number.parseInt(snap.id, 10);
  return ref;
}

/**
 * Per-box state we need across method calls. Lives on disk under
 * `~/.agentbox/digitalocean/boxes/<sandboxId>/` and is the source of truth
 * for the SSH identity.
 */
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
  // Always run remote commands under bash -lc so /etc/profile.d/agentbox.sh
  // (and the PATH prepend / DISPLAY / AGENT_BROWSER_* it sets) get sourced.
  return `bash -lc ${shellQuote(s)}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildSshTarget(state: PerBoxState, vpsIp: string, controlPath?: string): SshTargetArgs {
  return {
    host: vpsIp,
    user: VPS_USER,
    identity: state.identity,
    knownHosts: state.knownHosts,
    controlPath,
  };
}

async function ensureTunnel(sandboxId: string, state: PerBoxState, vpsIp: string): Promise<void> {
  if (tunnels.has(sandboxId)) return;
  await tunnels.open({
    boxId: sandboxId,
    vpsHost: vpsIp,
    identity: state.identity,
  });
}

/**
 * Open the ControlMaster (if not already up) and return an SshTargetArgs
 * whose `controlPath` is set to the live master so exec/scp reuse it.
 */
async function ensureLiveTarget(sandboxId: string): Promise<{
  target: SshTargetArgs;
  state: PerBoxState;
  vpsIp: string;
}> {
  const id = Number.parseInt(sandboxId, 10);
  if (!Number.isFinite(id)) {
    throw new Error(`digitalocean: invalid sandboxId ${sandboxId}`);
  }
  const droplet = await getDropletStrict(id);
  const vpsIp = publicIpv4(droplet);
  if (!vpsIp) {
    throw new Error(`digitalocean: droplet ${String(id)} has no public IPv4 address`);
  }
  const state = await ensurePerBoxState(sandboxId);
  if (!existsSync(state.identity)) {
    throw new Error(
      `digitalocean: per-box SSH key missing for sandbox ${sandboxId} (expected at ${state.identity}). ` +
        `If this box was created by a different host, you'll need to re-create it on this host.`,
    );
  }
  await ensureTunnel(sandboxId, state, vpsIp);
  const controlPath = tunnels.controlPath(sandboxId);
  return { target: buildSshTarget(state, vpsIp, controlPath), state, vpsIp };
}

export const digitaloceanBackend: CloudBackend = {
  name: 'digitalocean',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const c = client();
    const onLog = req.onLog ?? (() => {});
    const progress = (s: string) => onLog(`digitalocean: ${s}`);

    // 1. Gate on the base snapshot existing + resolve the image ref.
    await ensureDigitalOceanBaseSnapshot();
    const imageRef = await resolveImageRef(c, req);

    // 1b. Preflight the size + region choice against the live catalog BEFORE
    // creating any billable resources (firewall, SSH key, droplet). A bad
    // `--size s-99vcpu` / `--location atlantis` fails fast here with a clear
    // message instead of a late, opaque API error after cleanup churn.
    const size = (req.size && req.size.trim()) || DIGITALOCEAN_DEFAULT_SIZE;
    const region =
      (req.location && req.location.trim()) ||
      req.env?.AGENTBOX_DIGITALOCEAN_REGION ||
      process.env.AGENTBOX_DIGITALOCEAN_REGION ||
      DIGITALOCEAN_DEFAULT_REGION;
    const choice = { size, region };
    // The base snapshot's min_disk_size gates the min plan disk. We only have it
    // for numeric snapshot refs; stock string refs (e.g. `ubuntu-24-04-x64`)
    // skip the disk check (snapshot null).
    const snapshotMeta =
      typeof imageRef === 'number' ? await c.getSnapshot(String(imageRef)) : null;
    const sizeCatalog = await c.listSizes();
    validateSizeChoice(choice, sizeCatalog, snapshotMeta);
    const plan = sizeCatalog.find((s) => s.slug === size);

    // 2. Detect egress IP + normalize firewall source.
    const egressOverride =
      req.env?.AGENTBOX_DIGITALOCEAN_FIREWALL_SOURCE ?? process.env.AGENTBOX_DIGITALOCEAN_FIREWALL_SOURCE;
    const source = egressOverride
      ? normalizeSourceCidr(egressOverride)
      : `${await detectEgressIp({ onLog })}/32`;
    progress(`firewall source: ${source}`);

    // 3. Mint per-box SSH key into a temp dir keyed by a fresh stamp; we
    // rename it into the sandboxId-keyed dir once the droplet id is known.
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const tempDir = resolvePath(
      process.env.HOME ?? process.cwd(),
      '.agentbox',
      'digitalocean',
      `pending-${stamp}`,
      'ssh',
    );
    const key = await mintSshKey(tempDir, `agentbox-box-${req.name}-${stamp}`);
    const boxTag = `agentbox-${sanitizeTag(req.name)}-${stamp}`;

    let firewallId: string | null = null;
    let dropletId: number | null = null;
    try {
      // 4. Firewall — created with the per-box tag BEFORE the droplet, so
      // DigitalOcean auto-applies it the moment the droplet boots.
      const firewall = await createPerBoxFirewall(c, {
        name: `agentbox-${sanitizeTag(req.name)}-${stamp}`,
        sourceCidr: source,
        tag: boxTag,
      });
      firewallId = firewall.id;

      // 5. Cloud-init for the box: vscode user, pubkey, /etc/hosts alias,
      // optional box.env passthrough from req.env. The relay/bridge secrets are
      // stripped here (cloud-init writes box.env 0644) and reach the in-box ctl
      // via the daemon's 0600 relay.env / process env instead.
      const boxEnv = cloudInitBoxEnv(req.env);
      const cloudInit = generateBoxCloudInit({
        sshPubkey: key.publicKey,
        boxName: req.name,
        boxEnv: Object.keys(boxEnv).length > 0 ? boxEnv : undefined,
      });

      // 6. Create the droplet (tagged so the firewall applies). Map late DO
      // provision errors (droplet limit, out-of-capacity) to actionable
      // guidance while preserving the original.
      progress(`creating droplet '${req.name}' from image ${String(imageRef)} (${size} / ${region})`);
      let created;
      try {
        created = await withDigitalOceanRetry(
          { method: 'createDroplet', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
          () =>
            c.createDroplet({
              name: `agentbox-${sanitizeTag(req.name)}-${stamp}`,
              region,
              size,
              image: imageRef,
              user_data: cloudInit,
              tags: [boxTag, 'agentbox'],
              ipv6: false,
            }),
        );
      } catch (createErr) {
        throw mapDigitalOceanProvisionError(createErr, choice);
      }
      dropletId = created.droplet.id;
      progress(`droplet ${String(dropletId)} created; waiting for it to boot`);

      // 7. Poll until the droplet is active AND has a public IPv4 (DigitalOcean
      // returns neither at create time).
      const droplet = await pollUntil(
        `droplet ${String(dropletId)} active`,
        async () => {
          const d = await c.getDroplet(dropletId as number);
          return d && d.status === 'active' && publicIpv4(d) ? d : null;
        },
        { deadlineMs: PROVISION_DROPLET_DEADLINE_MS, intervalMs: 3_000, maxIntervalMs: 10_000 },
      );
      const vpsIp = publicIpv4(droplet);
      if (!vpsIp) {
        throw new Error(`digitalocean: droplet ${String(dropletId)} came up without a public IPv4`);
      }
      progress(`droplet ${String(dropletId)} at ${vpsIp}; waiting for ssh`);

      // 8. Move the freshly-minted key into the sandboxId-keyed final dir.
      const sandboxId = String(dropletId);
      const state = await ensurePerBoxState(sandboxId);
      await rename(key.privatePath, state.identity);
      await rename(key.publicPath, `${state.identity}.pub`);
      await rm(key.dir, { recursive: true, force: true });
      const pendingParent = resolvePath(key.dir, '..');
      await rm(pendingParent, { recursive: true, force: true });

      // 9. Wait for sshd to accept the new key.
      const up = await waitForSsh(buildSshTarget(state, vpsIp), PROVISION_SSH_DEADLINE_MS);
      if (!up) {
        throw new Error(
          `digitalocean: ssh on ${vpsIp} did not come up within ${String(PROVISION_SSH_DEADLINE_MS / 1000)}s; ` +
            `the droplet has been deleted. This is usually transient — just retry the create. ` +
            `If it keeps failing, check that your host's egress IP is stable (the box firewall is ` +
            `locked to it, so a mid-provision IP change blocks ssh).`,
        );
      }

      // 10. Open ControlMaster.
      await ensureTunnel(sandboxId, state, vpsIp);
      progress('ssh up; ControlMaster open');

      // Report the real resources for the chosen plan (DO reports memory in MB;
      // the cloud scaffold's `provisioned …` log line + the box record read
      // these). `plan` is present whenever the size validated against the
      // catalog above.
      return plan
        ? {
            sandboxId,
            resources: {
              cpu: plan.vcpus,
              memory: Math.round(plan.memory / 1024),
              disk: plan.disk,
            },
          }
        : { sandboxId };
    } catch (err) {
      // Cleanup on failure: droplet + firewall + temp ssh dir.
      if (dropletId !== null) {
        progress(`cleanup — deleting droplet ${String(dropletId)} after provision failure`);
        try {
          await c.deleteDroplet(dropletId);
        } catch (cleanupErr) {
          onLog(
            `digitalocean: WARN — failed to delete droplet ${String(dropletId)}; check the DigitalOcean dashboard. ${
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            }`,
          );
        }
      }
      if (firewallId !== null) {
        try {
          await deletePerBoxFirewall(c, firewallId, { tags: [boxTag] });
        } catch {
          // best-effort
        }
      }
      try {
        if (existsSync(key.dir)) await rm(key.dir, { recursive: true, force: true });
        if (dropletId !== null) {
          const finalDir = perBoxDir(String(dropletId));
          if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
      throw err;
    }
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const id = Number.parseInt(sandboxId, 10);
    if (!Number.isFinite(id)) return null;
    const droplet = await client().getDroplet(id);
    return droplet ? { sandboxId } : null;
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const droplets = await client().listDroplets({ tag_name: 'agentbox' });
    return droplets.map((d) => ({
      sandboxId: String(d.id),
      name: d.name,
      createdAt: d.created_at,
      state: mapState(d.status),
    }));
  },

  async start(h: CloudHandle): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    const c = client();
    const action = await c.powerOn(id);
    await waitAction(c, action.id, `droplet ${h.sandboxId} power_on`, ACTION_DEADLINE_MS);
    // The action completing implies `active`, but sshd accepts connections a
    // little later — wait for it so the provider's relaunch exec doesn't hit
    // `Connection refused`. Mirrors the provision flow.
    const droplet = await pollUntil(
      `droplet ${h.sandboxId} active`,
      async () => {
        const d = await c.getDroplet(id);
        return d && d.status === 'active' && publicIpv4(d) ? d : null;
      },
      { deadlineMs: ACTION_DEADLINE_MS, intervalMs: 2_000, maxIntervalMs: 8_000 },
    );
    const vpsIp = publicIpv4(droplet);
    if (!vpsIp) {
      throw new Error(`digitalocean: droplet ${h.sandboxId} has no public IPv4 after start`);
    }
    const state = await ensurePerBoxState(h.sandboxId);
    const up = await waitForSsh(buildSshTarget(state, vpsIp), PROVISION_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(
        `digitalocean: ssh on ${vpsIp} did not come up within ${String(PROVISION_SSH_DEADLINE_MS / 1000)}s after start. ` +
          `This is usually transient — retry (\`agentbox start\` / \`agentbox recover\`). If it persists, check ` +
          `that your host's egress IP is stable (the box firewall is locked to it, so an IP change blocks ssh).`,
      );
    }
  },

  async stop(h: CloudHandle): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    const c = client();
    // Try graceful shutdown first; fall back to hard power-off on timeout.
    try {
      const action = await c.shutdown(id);
      await waitAction(c, action.id, `droplet ${h.sandboxId} shutdown`, 90_000);
    } catch {
      const action = await c.powerOff(id);
      await waitAction(c, action.id, `droplet ${h.sandboxId} power_off`, ACTION_DEADLINE_MS);
    }
    await tunnels.close(h.sandboxId);
  },

  async pause(h: CloudHandle): Promise<void> {
    // DigitalOcean has no archive primitive. Pause ≡ stop (power off).
    await this.stop(h);
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    await tunnels.close(h.sandboxId);
    const c = client();
    // Discover the per-box firewall via the droplet's tags BEFORE we delete
    // the droplet (after deletion the droplet_ids match is gone).
    let firewallId: string | undefined;
    let firewallTags: readonly string[] | undefined;
    try {
      const droplet = await c.getDroplet(id);
      if (droplet) {
        const fw = await findFirewallForDroplet(c, id, droplet.tags);
        firewallId = fw?.id;
        // The firewall carries only the unique per-box tag (never the shared
        // `agentbox` tag), so this is the safe set to delete alongside it.
        firewallTags = fw?.tags;
      }
    } catch {
      // ignore — we'll still try to delete the droplet
    }
    try {
      await c.deleteDroplet(id);
    } catch (err) {
      if (!(err instanceof DigitalOceanApiError && (err.statusCode === 404 || err.code === 'not_found'))) {
        throw err;
      }
    }
    if (firewallId) {
      await deletePerBoxFirewall(c, firewallId, { tags: firewallTags });
    }
    const dir = perBoxDir(h.sandboxId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const id = Number.parseInt(h.sandboxId, 10);
    const d = await client().getDroplet(id);
    return d ? mapState(d.status) : 'missing';
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
      timeout: opts?.attemptTimeoutMs ?? 120_000,
      env: { ...process.env, ...(opts?.env ?? {}) },
    });
    return {
      exitCode: typeof res.exitCode === 'number' ? res.exitCode : 1,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      stderr: typeof res.stderr === 'string' ? res.stderr : '',
    };
  },

  async uploadFile(h, localPath, remotePath): Promise<void> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    const argv = [...sshOptArgs(target), localPath, `${target.user}@${target.host}:${remotePath}`];
    const res = await execa('scp', argv, { reject: false, timeout: 300_000 });
    if (res.exitCode !== 0) {
      throw new Error(`digitalocean: scp upload failed (exit ${String(res.exitCode)}): ${res.stderr || ''}`);
    }
  },

  async downloadFile(h, remotePath, localPath): Promise<void> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    const argv = [...sshOptArgs(target), `${target.user}@${target.host}:${remotePath}`, localPath];
    const res = await execa('scp', argv, { reject: false, timeout: 300_000 });
    if (res.exitCode !== 0) {
      throw new Error(`digitalocean: scp download failed (exit ${String(res.exitCode)}): ${res.stderr || ''}`);
    }
  },

  async listFiles(h, remoteDir): Promise<CloudFileEntry[]> {
    const res = await this.exec(
      h,
      `find ${shellQuote(remoteDir)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n'`,
    );
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, kind] = line.split('\t');
        return { name: name ?? line, isDir: kind === 'd' };
      });
  },

  async previewUrl(h, port): Promise<CloudPreviewUrl> {
    await ensureLiveTarget(h.sandboxId);
    const localPort = await tunnels.forward(h.sandboxId, port);
    // Plain loopback URL — the SSH local forward is already auth-gated by the
    // tunnel. The cloud-provider layer adds the Portless alias.
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  async signedPreviewUrl(h, port, _ttl): Promise<CloudPreviewUrl> {
    void _ttl;
    return this.previewUrl(h, port);
  },

  async refreshPreviewUrl(h, port): Promise<CloudPreviewUrl> {
    // Tear down the (likely dead) ControlMaster + cached `-L` forwards and
    // re-open from scratch. Called by the host poller after ECONNREFUSED on
    // the local port (host sleep/wake, network blip).
    const { state, vpsIp } = await ensureLiveTarget(h.sandboxId);
    await tunnels.refresh({
      boxId: h.sandboxId,
      vpsHost: vpsIp,
      identity: state.identity,
    });
    const localPort = await tunnels.forward(h.sandboxId, port);
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  async startInBoxPortless(h, opts): Promise<void> {
    // Bring up a `portless` proxy inside the droplet mirroring the host's mode
    // so `<boxName>.localhost:<P>` resolves identically on both sides. The
    // `portless` CLI is baked into the base snapshot by install-box.sh.
    // Idempotent + best-effort. Mirrors the Hetzner backend.
    const tlsFlag = opts.tls ? '' : '--no-tls';
    const startCmd = `sudo portless proxy start ${tlsFlag} -p ${String(opts.proxyPort)}`.replace(/\s+/g, ' ');
    const aliasCmd = `sudo portless alias ${shellQuote(opts.boxName)} ${String(opts.webPort)}`;
    const cmds = [startCmd, aliasCmd];
    if (opts.tls) {
      cmds.push(
        'sudo agentbox-portless-trust /root/.portless/ca.pem >/dev/null 2>&1 || true',
        `echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/agentbox-portless-ca.crt' | sudo tee /etc/profile.d/agentbox-portless-ca.sh >/dev/null || true`,
      );
    }
    await this.exec(h, cmds.join('; '));
  },

  async attachArgv(h): Promise<string[]> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    // Reuse the ControlMaster via `-S <sock>` — no new auth handshake. Callers
    // append `-t '<cmd>'` in the `buildAttach` helper.
    return ['ssh', ...sshOptArgs(target), `${target.user}@${target.host}`];
  },

  async createSnapshot(h, name): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    const c = client();
    const action = await withDigitalOceanRetry(
      { method: 'snapshotDroplet', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
      () => c.snapshotDroplet(id, name),
    );
    await waitAction(c, action.id, `droplet ${h.sandboxId} snapshot`, SNAPSHOT_DEADLINE_MS);
  },

  async deleteSnapshot(name): Promise<void> {
    const c = client();
    const snap = (await c.listSnapshots()).find((s) => s.name === name);
    if (!snap) return;
    try {
      await c.deleteSnapshot(snap.id);
    } catch (err) {
      if (err instanceof DigitalOceanApiError && (err.statusCode === 404 || err.code === 'not_found')) return;
      throw err;
    }
  },
};

/** Exposed for the CLI's `firewall sync` / `show` subcommands. */
export { tunnels as _digitaloceanTunnels };
