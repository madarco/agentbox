/**
 * Hetzner `CloudBackend` — maps the provider-neutral cloud primitives onto
 * OpenSSH + the Hetzner Cloud REST API.
 *
 * Design rationale + the safety/tunneling model live in the plan at
 * `~/.claude/plans/how-to-safely-create-parallel-pebble.md` and the live
 * provider notes in `docs/cloud-providers.md`. The short version:
 *
 *   - 1:1 VPS-per-box. Each box gets a per-box ed25519 keypair (private key
 *     never leaves the host) and a per-box Hetzner Cloud Firewall locked to
 *     the host's egress IP.
 *   - All comms (exec, file I/O, port forwards for bridge / web / VNC) flow
 *     over one persistent `ssh` ControlMaster owned by `SshTunnelManager`.
 *   - `previewUrl(port)` mints an `ssh -L 127.0.0.1:<localPort>:127.0.0.1:<remote>`
 *     on demand. The cloud-provider scaffolding (`createCloudProvider`) then
 *     decorates those URLs with Portless aliases for symmetric
 *     `<box-name>.localhost` semantics — handled provider-side rather than
 *     here so the backend stays focused on plumbing.
 *   - Checkpoints map to Hetzner `create_image` snapshots; default no-pause,
 *     opt-in pause via `createSnapshot({pause: true})`.
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
import { parseSwapSpec } from '@agentbox/sandbox-cloud';
import { generateBoxCloudInit } from './cloud-init.js';
import {
  HetznerApiError,
  makeHetznerClient,
  type HetznerClient,
  type HetznerImage,
  type HetznerServer,
  type HetznerServerStatus,
} from './client.js';
import {
  CREATE_EGRESS_HINT,
  INBOUND_EGRESS_HINT,
  REPAIR_EGRESS_HINT,
  detectEgressCidr,
} from './egress-ip.js';
import {
  boxFirewallSources,
  createPerBoxFirewall,
  decodeBoxFirewall,
  deletePerBoxFirewall,
  normalizeSourceCidr,
  sshSourcesOf,
  writeBoxFirewall,
  type BoxFirewallSsh,
} from './firewall.js';
import { hetznerLabelValue, hetznerResourceName } from './naming.js';
import { pollUntil } from './poll.js';
import { mapHetznerProvisionError, validateServerChoice } from './preflight.js';
import { createWithLocationFailover, fetchLocationPlanInputs, planLocations } from './failover.js';
import { preparedEntryFor, readPreparedState } from './prepared-state.js';
import { ensureHetznerBaseSnapshot } from './prepare.js';
import { mintSshKey } from './ssh-key.js';
import {
  ADMIN_DEVICE_KEY,
  agentSetArg,
  createTimeSelf,
  withInboundPolicy,
  describeInbound,
  detectDeviceCidrs,
  deviceEntryNeedsUpdate,
  firewallBlockedHint,
  repairOutcome,
  isControlBoxProcess,
  localMachineKey,
  normalizeAgentSet,
  parseInboundSpec,
  selfDeviceEntry,
  staticInboundSources,
  upsertDeviceEntry,
  type DeviceAllowEntry,
} from '@agentbox/sandbox-core';
import type { InboundPolicy } from '@agentbox/core';
import { waitForSsh, sshOptArgs, type SshTargetArgs } from './ssh-cli.js';
import { SshTunnelManager, defaultBoxSshDir } from './ssh-tunnel.js';
import { withHetznerRetry } from './retry.js';

export const HETZNER_DEFAULT_BOX_IMAGE_REF = 'agentbox-base';

/**
 * The cloud-provider scaffolding defaults `req.image` to `'agentbox/box:dev'`
 * (the docker provider's local image tag) when nothing else is specified.
 * That value is meaningless on Hetzner — we recognize it (alongside our own
 * sentinel + plain undefined) as "use the hetzner base snapshot."
 */
const SCAFFOLDING_FALLBACK_IMAGE = 'agentbox/box:dev';
const VPS_USER = 'vscode';
const PROVISION_SSH_DEADLINE_MS = 10 * 60_000;
const ACTION_DEADLINE_MS = 5 * 60_000;
const SNAPSHOT_DEADLINE_MS = 20 * 60_000;
// `cx22` was deprecated by Hetzner in early 2026; `cx23` is the drop-in
// replacement with the same 2 vCPU / 4 GB / 40 GB shape on x86.
export const HETZNER_DEFAULT_SERVER_TYPE = 'cx23';
const HETZNER_DEFAULT_LOCATION = 'nbg1';

/**
 * Secrets that must never land in the world-readable (0644) cloud-init
 * `/etc/agentbox/box.env`. The relay token reaches in-box ctl via the daemon's
 * 0600 `relay.env`; the bridge token stays in the daemon's process env.
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
 * Map Hetzner's per-server status onto the four-value `CloudState` everyone
 * else consumes. Transitional ones ('starting', 'rebuilding', …) are reported
 * as 'running' so callers don't ping-pong; 'off' maps to 'paused' because
 * Hetzner's stop = power off (vs Daytona's archive).
 */
function mapState(s: HetznerServerStatus | string | undefined): CloudState {
  switch (s) {
    case 'running':
      return 'running';
    case 'starting':
    case 'initializing':
    case 'stopping':
    case 'migrating':
    case 'rebuilding':
      return 'running';
    case 'off':
      return 'paused';
    case 'deleting':
    case 'unknown':
    default:
      return 'missing';
  }
}

function client(): HetznerClient {
  return makeHetznerClient();
}

async function getServerStrict(id: number): Promise<HetznerServer> {
  const s = await client().getServer(id);
  if (!s) {
    throw new Error(`hetzner: server ${String(id)} not found (already destroyed?)`);
  }
  return s;
}

/** Lookup an image by description ("snapshot name" in user-facing terms). */
async function findImageByDescription(
  c: HetznerClient,
  description: string,
): Promise<HetznerImage | null> {
  const all = await c.listImages({ type: 'snapshot' });
  return all.find((i) => i.description === description) ?? null;
}

/**
 * Resolve a `CloudProvisionRequest.image|snapshot` into a Hetzner image id.
 * Precedence: `req.snapshot` → `req.image`:
 *   - the sentinel `agentbox-base` → load id from `hetzner-prepared.json`.
 *   - a numeric string → use as-is.
 *   - any other string → treated as a snapshot description (checkpoint name)
 *     and looked up via the API.
 */
async function resolveImageId(
  c: HetznerClient,
  req: CloudProvisionRequest,
): Promise<number | string> {
  const ref = req.snapshot ?? req.image;
  // `box.imageHetzner` is pinned to the base's own description by every bake, so
  // by the time we get here `ref` usually NAMES OUR OWN BASE rather than being
  // the sentinel. Treat that as "no explicit choice": otherwise the pin silently
  // defeats variant selection and every box boots the agentless base. A ref
  // naming anything else (a checkpoint, a stock slug, an explicit --image) is a
  // real choice and wins.
  // Read before `ensureHetznerBaseSnapshot()` (which may bake and rewrite the
  // file) purely to answer "does ref name our base?"; the branch below re-reads.
  const pinned = preparedEntryFor(readPreparedState(), '');
  const refIsOurBase =
    !req.snapshot &&
    pinned !== undefined &&
    (ref === pinned.description || ref === String(pinned.imageId));
  if (
    !ref ||
    ref === HETZNER_DEFAULT_BOX_IMAGE_REF ||
    ref === SCAFFOLDING_FALLBACK_IMAGE ||
    refIsOurBase
  ) {
    await ensureHetznerBaseSnapshot();
    const state = readPreparedState();
    // Prefer the derived snapshot baked for exactly this agent set — it already
    // carries the agent, so the box skips the per-box install. Falling back to
    // the agentless base is not a failure: `ensureAgentInstalled` puts the agent
    // in at first use, which is also what an un-re-prepared older base does.
    const variant = preparedEntryFor(state, agentSetArg(normalizeAgentSet(req.agents)));
    if (variant) return variant.imageId;
    if (!state.base) {
      throw new Error(
        'no Hetzner base snapshot found — run `agentbox prepare --provider hetzner` to bake one.',
      );
    }
    return state.base.imageId;
  }
  if (/^\d+$/.test(ref)) {
    return Number.parseInt(ref, 10);
  }
  // Try snapshot-by-description first (checkpoints use that), then fall through
  // to Hetzner stock images (the user passed e.g. `ubuntu-24.04`).
  const snap = await findImageByDescription(c, ref);
  if (snap) return snap.id;
  return ref;
}

/**
 * Capture per-box state we need across method calls. Lives on disk under
 * `~/.agentbox/hetzner/boxes/<sandboxId>/` and is the source of truth for
 * the SSH identity + firewall id + cached IP.
 */
interface PerBoxState {
  dir: string;
  identity: string;
  knownHosts: string;
  firewallId?: number;
  firewallSource?: string;
  vpsIp?: string;
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

/**
 * The per-box firewall as the per-device allowlist (static policy part + one
 * entry per machine). Read on demand: on a connection failure, a repair, an
 * inbound change — never on the happy path. Null when the server or its
 * firewall is gone.
 */
interface BoxFirewallState {
  firewallId: number;
  ssh: BoxFirewallSsh;
  /** Every SSH source the firewall admits right now. */
  allowedSources: string[];
  /** Friendly box ref for the `firewall sync` hint (the `agentbox.box` label). */
  boxRef: string;
}

async function readBoxFirewall(
  sandboxId: string,
  policy: InboundPolicy | undefined,
): Promise<BoxFirewallState | null> {
  const id = Number.parseInt(sandboxId, 10);
  if (!Number.isFinite(id)) return null;
  const server = await client().getServer(id);
  if (!server) return null;
  const firewallId = Number.parseInt(server.labels['agentbox.firewall'] ?? '', 10);
  if (!Number.isFinite(firewallId)) return null;
  const firewall = await client().getFirewall(firewallId);
  if (!firewall) return null;
  return {
    firewallId,
    ssh: decodeBoxFirewall(firewall.rules, staticInboundSources(policy)),
    allowedSources: sshSourcesOf(firewall.rules),
    // `||`, not `??`: a name with nothing label-legal in it sanitizes to ''.
    boxRef: server.labels['agentbox.box'] || sandboxId,
  };
}

/**
 * This machine's entry for an `inbound` change: none for `open`, the existing
 * one untouched when it is pinned to a hand-set source, else a fresh detect.
 */
async function inboundSelf(
  entries: readonly DeviceAllowEntry[],
  policy: InboundPolicy,
): Promise<DeviceAllowEntry | undefined> {
  if (policy.mode === 'open') return undefined;
  const mine = entries.find((e) => e.key === localMachineKey());
  if (mine?.pinned) return undefined;
  return selfDeviceEntry(await detectDeviceCidrs({ overrideHint: INBOUND_EGRESS_HINT }));
}

/** Pause before re-reading a firewall we just wrote (lets a racing write land). */
const VERIFY_SETTLE_MS = 1_500;

/**
 * Upsert this machine's entry with read → write → re-read. Hetzner has no
 * conditional update, so two machines repairing one box at once can each
 * overwrite the other's entry; the re-read catches a lost write and redoes
 * it (bounded). Null firewall (server/firewall gone) is nothing to repair.
 */
async function ensureSelfOnFirewall(
  sandboxId: string,
  policy: InboundPolicy | undefined,
  cidrs: string[],
): Promise<{ changed: boolean; detail?: string }> {
  const key = localMachineKey();
  const hub = isControlBoxProcess();
  let wrote = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fw = await readBoxFirewall(sandboxId, policy);
    if (!fw) return { changed: false };
    if (!deviceEntryNeedsUpdate(fw.ssh.entries, fw.ssh.staticSources, key, cidrs, hub)) {
      return repairOutcome({
        entries: fw.ssh.entries,
        staticSources: fw.ssh.staticSources,
        key,
        cidrs,
        wrote,
      });
    }
    const next: BoxFirewallSsh = {
      staticSources: fw.ssh.staticSources,
      entries: upsertDeviceEntry(fw.ssh.entries, selfDeviceEntry(cidrs, { key, hub })),
    };
    await writeBoxFirewall(client(), fw.firewallId, next);
    wrote = true;
    await new Promise((r) => setTimeout(r, VERIFY_SETTLE_MS));
  }
  throw new Error(
    `hetzner: this machine's firewall entry on server ${sandboxId} kept being overwritten by a concurrent update`,
  );
}

async function ensureTunnel(sandboxId: string, state: PerBoxState, vpsIp: string): Promise<void> {
  if (tunnels.has(sandboxId)) return;
  try {
    await tunnels.open({
      boxId: sandboxId,
      vpsHost: vpsIp,
      vpsUser: VPS_USER,
      identity: state.identity,
    });
  } catch (err) {
    // A host egress-IP change locks us out of the per-box firewall, surfacing as
    // an opaque SSH connect timeout. Best-effort: detect the mismatch and enrich
    // the error with the fix. Never let the diagnostic mask the original error
    // on a match (box is just down) or a probe failure.
    // A FRESH probe, not a cached one: a stale value could read the new IP as
    // "unchanged" and hide the very mismatch this diagnostic exists for.
    const s = await readBoxFirewall(sandboxId, undefined).catch(() => null);
    const currentEgress = s
      ? await detectEgressCidr({ overrideHint: REPAIR_EGRESS_HINT }).catch(() => null)
      : null;
    const hint =
      s && currentEgress
        ? firewallBlockedHint({
            provider: 'hetzner',
            boxRef: s.boxRef,
            entries: s.ssh.entries,
            staticSources: s.ssh.staticSources,
            key: localMachineKey(),
            currentEgress,
          })
        : null;
    if (hint) throw new Error(`${(err as Error).message}\n\n${hint}`);
    throw err;
  }
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
    throw new Error(`hetzner: invalid sandboxId ${sandboxId}`);
  }
  const server = await getServerStrict(id);
  const vpsIp = server.public_net.ipv4?.ip;
  if (!vpsIp) {
    throw new Error(`hetzner: server ${String(id)} has no IPv4 address`);
  }
  const state = await ensurePerBoxState(sandboxId);
  if (!existsSync(state.identity)) {
    throw new Error(
      `hetzner: per-box SSH key missing for sandbox ${sandboxId} (expected at ${state.identity}). ` +
        `If this box was created by a different host, you'll need to re-create it on this host.`,
    );
  }
  await ensureTunnel(sandboxId, state, vpsIp);
  const controlPath = tunnels.controlPath(sandboxId);
  return { target: buildSshTarget(state, vpsIp, controlPath), state, vpsIp };
}

export const hetznerBackend: CloudBackend = {
  name: 'hetzner',

  /**
   * The in-box WebProxy binds 8080, not the reserved :80.
   *
   * A hetzner box runs its OWN portless proxy (see `startInBoxPortless`) so
   * `https://<box>.localhost` resolves identically on the host and inside the
   * box. That proxy owns :443 and holds :80 for the http->https redirect, so
   * ctl's WebProxy lost the race for :80 and logged `EADDRINUSE` — leaving
   * `agentbox url` printing a URL that redirected into portless and 404'd,
   * with the box still reporting ready. Docker never hits this: there portless
   * runs on the HOST, and the container's :80 is free.
   *
   * 8080 rather than some other port because vercel and e2b already bind it —
   * one in-box convention across every provider that cannot use :80.
   */
  webProxyPort: 8080,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const c = client();
    const onLog = req.onLog ?? (() => {});
    const progress = (s: string) => onLog(`hetzner: ${s}`);

    // 1. Gate on the base snapshot existing (lifts the Phase-2 placeholder).
    await ensureHetznerBaseSnapshot();
    const imageRef = await resolveImageId(c, req);

    // 1b. Preflight the server-type + location choice against the live catalog
    // BEFORE creating any billable resources (firewall, SSH key, server). A bad
    // `--size cax31` / `--size cx99` / `--location atlantis` fails fast here with
    // a clear message instead of a late, opaque API error after cleanup churn.
    // Validate `box.swap` before any billable resource exists.
    const swap = parseSwapSpec(req.swap);
    const serverType = (req.size && req.size.trim()) || HETZNER_DEFAULT_SERVER_TYPE;
    const location = (req.location && req.location.trim()) || HETZNER_DEFAULT_LOCATION;
    const choice = { serverType, location };
    // The base image's disk_size gates the min server disk. We only have it for
    // numeric snapshot refs; stock string refs (e.g. `ubuntu-24.04`) skip the
    // disk check (image null).
    const image = typeof imageRef === 'number' ? await c.getImage(imageRef) : null;
    const catalog = await c.listServerTypes();
    validateServerChoice(choice, catalog, image);
    // Where to go when `location` has no capacity for the type. A `--location`
    // typed for this create pins it; a configured or default one fails over
    // within its network zone (see failover.ts).
    const pinned = req.locationPinned === true;
    const plan = planLocations({
      serverType,
      location,
      pinned,
      catalog,
      ...(await fetchLocationPlanInputs(c, pinned)),
    });

    // 2. Resolve the inbound-access policy (`--inbound` / `box.inbound`) into
    // the firewall's source CIDRs. `locked`/`whitelist` need the host egress IP
    // (env override wins, else detect); `open` (0.0.0.0/0) skips detection.
    const inboundPolicy = parseInboundSpec(req.inbound);
    const egressOverride =
      req.env?.AGENTBOX_HETZNER_FIREWALL_SOURCE ?? process.env.AGENTBOX_HETZNER_FIREWALL_SOURCE;
    const entries: DeviceAllowEntry[] = [];
    const extraStatic: string[] = [];
    if (inboundPolicy.mode !== 'open') {
      // This machine's own entry (pinned when the source was set by hand). On a
      // control box it carries `hub`, so a PC adding itself later can never
      // evict the hub's reach to its own box.
      const self = await createTimeSelf(egressOverride, () =>
        detectDeviceCidrs({ onLog, overrideHint: CREATE_EGRESS_HINT }),
      );
      entries.push(...self.entries);
      extraStatic.push(...self.extraStatic);
      // Control-plane-topology creates: the admin PC's CIDR(s) so direct PC→box
      // SSH works before that PC has written its own entry.
      const admin = (req.extraInboundCidrs ?? []).map(normalizeSourceCidr);
      if (admin.length > 0) {
        entries.push({ key: ADMIN_DEVICE_KEY, cidrs: admin, seen: entries[0]?.seen ?? 0 });
      }
    }
    const firewallSsh: BoxFirewallSsh = {
      staticSources: [...staticInboundSources(inboundPolicy), ...extraStatic],
      entries,
    };
    progress(
      `firewall inbound: ${describeInbound(inboundPolicy)} -> ${boxFirewallSources(firewallSsh).join(', ')}`,
    );

    // 3. Mint per-box SSH key into a temp dir keyed by a fresh uuid; we
    // rename it to `~/.agentbox/hetzner/boxes/<sandboxId>/ssh/` once the
    // server id is known.
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const tempDir = resolvePath(
      process.env.HOME ?? process.cwd(),
      '.agentbox',
      'hetzner',
      `pending-${stamp}`,
      'ssh',
    );
    const key = await mintSshKey(tempDir, `agentbox-box-${req.name}-${stamp}`);

    // Hetzner rejects a label value or resource name over 63 chars (or one not
    // starting/ending alphanumeric), and a box name can exceed that — see naming.ts.
    const boxLabel = hetznerLabelValue(req.name);
    const resourceName = hetznerResourceName('agentbox', req.name, stamp);

    let firewallId: number | null = null;
    let serverId: number | null = null;
    try {
      // 4. Firewall.
      const firewall = await createPerBoxFirewall(c, {
        name: resourceName,
        ssh: firewallSsh,
        labels: {
          'agentbox.box': boxLabel,
          'agentbox.role': 'box',
        },
      });
      firewallId = firewall.id;

      // 5. Cloud-init for the box: vscode user, pubkey, /etc/hosts alias,
      // optional box.env passthrough from req.env. The relay/bridge tokens are
      // deliberately excluded — cloud-init writes box.env world-readable (0644),
      // and these secrets reach the in-box ctl via the daemon's 0600 relay.env
      // (relay token) and its process env (bridge token) instead.
      const boxEnv = cloudInitBoxEnv(req.env);
      const cloudInit = generateBoxCloudInit({
        sshPubkey: key.publicKey,
        boxName: req.name,
        boxEnv: Object.keys(boxEnv).length > 0 ? boxEnv : undefined,
        swap,
      });

      // 6. Create the server, failing over to the next location on a capacity
      // refusal. A refused create makes no server, and the firewall, key and
      // image are not location-bound, so each attempt only changes `location`.
      // Other late errors (account limit) map to actionable guidance.
      for (const sk of plan.skipped) progress(`skipping ${sk.location}: ${sk.reason}`);
      const { result: created, location: landed } = await createWithLocationFailover({
        serverType,
        plan,
        pinned,
        catalog,
        onLog,
        mapError: (err) => mapHetznerProvisionError(err),
        attempt: (loc) => {
          progress(
            `creating VPS '${req.name}' from image ${String(imageRef)} (${serverType} / ${loc})`,
          );
          return withHetznerRetry(
            { method: 'createServer', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
            () =>
              c.createServer({
                name: resourceName,
                server_type: serverType,
                image: imageRef,
                location: loc,
                user_data: cloudInit,
                firewalls: [{ firewall: firewall.id }],
                labels: {
                  'agentbox.managed': 'true',
                  'agentbox.role': 'box',
                  'agentbox.box': boxLabel,
                  'agentbox.firewall': String(firewall.id),
                },
                start_after_create: true,
              }),
          );
        },
      });
      if (landed !== location)
        progress(`landed in ${landed} (no ${serverType} capacity in ${location})`);
      serverId = created.server.id;
      const provisioned = created.server.server_type;
      const vpsIp = created.server.public_net.ipv4?.ip;
      if (!vpsIp) {
        throw new Error(`hetzner: server ${String(serverId)} came up without an IPv4 address`);
      }
      progress(`server ${String(serverId)} provisioned at ${vpsIp}; waiting for ssh`);

      // 7. Move the freshly-minted key from its temp location into the
      // sandboxId-keyed final dir, then rm the temp parent. We move file-
      // by-file rather than renaming the whole dir because `ensurePerBoxState`
      // had to mkdir the final dir before we knew the sandbox id (so the
      // tunnel manager + state-restoration paths can find it later).
      const sandboxId = String(serverId);
      const state = await ensurePerBoxState(sandboxId);
      await rename(key.privatePath, state.identity);
      await rename(key.publicPath, `${state.identity}.pub`);
      // Drop the now-empty temp dir + its `pending-XXX` parent.
      await rm(key.dir, { recursive: true, force: true });
      const pendingParent = resolvePath(key.dir, '..');
      await rm(pendingParent, { recursive: true, force: true });

      // 8. Wait for sshd to accept the new key.
      const up = await waitForSsh(buildSshTarget(state, vpsIp), PROVISION_SSH_DEADLINE_MS);
      if (!up) {
        throw new Error(
          `hetzner: ssh on ${vpsIp} did not come up within ${String(PROVISION_SSH_DEADLINE_MS / 1000)}s; ` +
            `the server has been deleted. This is usually transient — just retry the create. ` +
            `If it keeps failing, check that your host's egress IP is stable (the box firewall is ` +
            `locked to it, so a mid-provision IP change blocks ssh).`,
        );
      }

      // 9. Open ControlMaster.
      await ensureTunnel(sandboxId, state, vpsIp);
      progress('ssh up; ControlMaster open');

      // Agent credentials are seeded by `createCloudProvider`'s unified
      // post-provision step (`seedAgentVolumesIfFresh`) via `uploadFile` +
      // `exec` over the live ControlMaster — the symlinks baked into
      // install-box.sh route ~/.claude/.credentials.json etc. through to
      // `~/.agentbox-creds/<agent>/`.
      //
      // Report the REAL resources from the create response (the plan's
      // cores/memory/disk), not our static defaults — the record + the cloud
      // scaffold's `provisioned …` log line read this.
      return {
        sandboxId,
        inbound: inboundPolicy,
        publicHost: vpsIp,
        location: landed,
        resources: {
          cpu: provisioned.cores,
          memory: provisioned.memory,
          disk: provisioned.disk,
        },
      };
    } catch (err) {
      // Cleanup on failure: server + firewall + temp ssh dir.
      if (serverId !== null) {
        progress(`cleanup — deleting server ${String(serverId)} after provision failure`);
        try {
          await c.deleteServer(serverId);
        } catch (cleanupErr) {
          onLog(
            `hetzner: WARN — failed to delete server ${String(serverId)}; check the Hetzner dashboard manually. ${
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            }`,
          );
        }
      }
      if (firewallId !== null) {
        try {
          await deletePerBoxFirewall(c, firewallId);
        } catch {
          // best-effort
        }
      }
      // Clean the temp ssh dir (or its renamed location if we got that far).
      try {
        if (existsSync(key.dir)) await rm(key.dir, { recursive: true, force: true });
        if (serverId !== null) {
          const finalDir = perBoxDir(String(serverId));
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
    const server = await client().getServer(id);
    // Report the live IP: it can change across a stop/start, and the resume
    // re-registration re-publishes it for PC adoption.
    return server ? { sandboxId, publicHost: server.public_net.ipv4?.ip } : null;
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const servers = await client().listServers({ label_selector: 'agentbox.managed=true' });
    return servers.map((s) => ({
      sandboxId: String(s.id),
      name: s.labels['agentbox.box'] || s.name,
      createdAt: s.created,
      state: mapState(s.status),
    }));
  },

  async start(h: CloudHandle): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    await client().powerOn(id);
    // The API reports `running` ~10-30s before sshd actually accepts
    // connections. Callers (the provider's `reEnsureCloudBox` relaunch) SSH-exec
    // immediately after start()/resume(), so wait for the API state AND for ssh
    // to be ready — otherwise the first exec hits `Connection refused` and the
    // daemons never get relaunched. Mirrors the provision flow's waitForSsh.
    await pollUntil(
      `server ${h.sandboxId} running`,
      async () => {
        const s = await client().getServer(id);
        return s?.status === 'running' ? s : null;
      },
      { deadlineMs: ACTION_DEADLINE_MS, intervalMs: 2_000, maxIntervalMs: 8_000 },
    );
    const server = await getServerStrict(id);
    const vpsIp = server.public_net.ipv4?.ip;
    if (!vpsIp) {
      throw new Error(`hetzner: server ${h.sandboxId} has no IPv4 address after start`);
    }
    const state = await ensurePerBoxState(h.sandboxId);
    const up = await waitForSsh(buildSshTarget(state, vpsIp), PROVISION_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(
        `hetzner: ssh on ${vpsIp} did not come up within ${String(PROVISION_SSH_DEADLINE_MS / 1000)}s after start. ` +
          `This is usually transient — retry (\`agentbox start\` / \`agentbox recover\`). If it persists, check ` +
          `that your host's egress IP is stable (the box firewall is locked to it, so an IP change blocks ssh).`,
      );
    }
  },

  async stop(h: CloudHandle): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    // Try graceful shutdown first; fall back to power-off after a short wait.
    try {
      await client().shutdown(id);
      await pollUntil(
        `server ${h.sandboxId} off`,
        async () => {
          const s = await client().getServer(id);
          return s?.status === 'off' ? s : null;
        },
        { deadlineMs: 60_000, intervalMs: 2_000, maxIntervalMs: 8_000 },
      );
    } catch {
      await client().powerOff(id);
    }
    await tunnels.close(h.sandboxId);
  },

  async pause(h: CloudHandle): Promise<void> {
    // Hetzner has no archive primitive. Pause ≡ stop.
    await this.stop(h);
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    await tunnels.close(h.sandboxId);
    // Discover the per-box firewall via labels so we don't need to
    // round-trip through the server's `firewalls[]` (which is absent from
    // our typed slice anyway).
    const c = client();
    let firewallId: number | undefined;
    try {
      const server = await c.getServer(id);
      firewallId = server
        ? Number.parseInt(server.labels['agentbox.firewall'] ?? '', 10)
        : undefined;
    } catch {
      // ignore — we'll still try to delete the server
    }
    try {
      await c.deleteServer(id);
    } catch (err) {
      if (
        !(err instanceof HetznerApiError && (err.statusCode === 404 || err.code === 'not_found'))
      ) {
        throw err;
      }
    }
    if (firewallId && Number.isFinite(firewallId)) {
      await deletePerBoxFirewall(c, firewallId);
    }
    // Clean the per-box ssh dir.
    const dir = perBoxDir(h.sandboxId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const id = Number.parseInt(h.sandboxId, 10);
    const s = await client().getServer(id);
    return s ? mapState(s.status) : 'missing';
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
      throw new Error(
        `hetzner: scp upload failed (exit ${String(res.exitCode)}): ${res.stderr || ''}`,
      );
    }
  },

  async downloadFile(h, remotePath, localPath): Promise<void> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    const argv = [...sshOptArgs(target), `${target.user}@${target.host}:${remotePath}`, localPath];
    const res = await execa('scp', argv, { reject: false, timeout: 300_000 });
    if (res.exitCode !== 0) {
      throw new Error(
        `hetzner: scp download failed (exit ${String(res.exitCode)}): ${res.stderr || ''}`,
      );
    }
  },

  async listFiles(h, remoteDir): Promise<CloudFileEntry[]> {
    const res = await this.exec(
      h,
      // -L for nicer dir-detection on symlinks; `--printf` is non-portable so
      // use a small awk wrap that prints `<name>\t<d|f>` per entry.
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
    const { state, vpsIp } = await ensureLiveTarget(h.sandboxId);
    void state;
    void vpsIp;
    const localPort = await tunnels.forward(h.sandboxId, port);
    // Plain loopback URL — no preview-token here (SSH local forward is
    // already auth-gated by the tunnel itself). The cloud-provider layer
    // adds the Portless alias for symmetric `<box-name>.localhost` URLs.
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  async signedPreviewUrl(h, port, _ttl): Promise<CloudPreviewUrl> {
    // SSH tunnels have no signed-URL primitive — they're already loopback-
    // only and the cloud-provider layer's bridge-token enforces auth. The
    // signed form is functionally equivalent to the unsigned one here.
    void _ttl;
    return this.previewUrl(h, port);
  },

  async refreshPreviewUrl(h, port): Promise<CloudPreviewUrl> {
    // Tear down the (likely dead) ControlMaster + every cached `-L` forward
    // for this box and re-open from scratch. Called by the host
    // CloudBoxPoller when ECONNREFUSED on the local port shows that the
    // master died (host sleep/wake, transient network blip). Without this
    // the poller would back off forever against a stale localPort.
    const { state, vpsIp } = await ensureLiveTarget(h.sandboxId);
    void state;
    void vpsIp;
    await tunnels.refresh({
      boxId: h.sandboxId,
      vpsHost: vpsIp,
      identity: state.identity,
    });
    const localPort = await tunnels.forward(h.sandboxId, port);
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  async repairReachability(h): Promise<{ changed: boolean; detail?: string }> {
    // Make sure THIS machine's current egress is in the box firewall, adding or
    // replacing only its own entry — every other machine's entry is carried
    // over, so attaching from a second PC never locks the first one out.
    // Called on a connection-establishment failure (`recover`, the initial
    // attach connect) and by the relay's egress watcher on an IP change, never
    // on a mid-session drop. An `open` box is already reachable: no-op. API
    // errors propagate (the watcher must not record a failed read as healed).
    const policy: InboundPolicy = h.inbound ?? { mode: 'locked', sources: [] };
    if (policy.mode === 'open') {
      return {
        changed: false,
        detail: 'firewall: open to the world (inbound open); nothing to add',
      };
    }
    const cidrs = await detectDeviceCidrs({ overrideHint: REPAIR_EGRESS_HINT });
    return ensureSelfOnFirewall(h.sandboxId, policy, cidrs);
  },

  async setInbound(h: CloudHandle, policy: InboundPolicy): Promise<{ sources: string[] }> {
    // Apply an inbound-access policy to the box's firewall (`agentbox inbound`).
    // The static part becomes exactly the policy's and every source no real
    // machine owns (`legacy`, a world-open CIDR an old firewall carried) is
    // dropped, so `inbound locked` really locks; other machines' entries
    // survive. `locked`/`whitelist` also refresh this machine's entry (unless
    // it is pinned to a hand-set source); `open` skips egress detection.
    const fw = await readBoxFirewall(h.sandboxId, h.inbound);
    if (!fw) throw new Error(`hetzner: no per-box firewall found for server ${h.sandboxId}`);
    const next: BoxFirewallSsh = withInboundPolicy(
      fw.ssh,
      staticInboundSources(policy),
      await inboundSelf(fw.ssh.entries, policy),
    );
    await writeBoxFirewall(client(), fw.firewallId, next);
    return { sources: boxFirewallSources(next) };
  },

  async startInBoxPortless(h, opts): Promise<void> {
    // Bring up a `portless` proxy *inside the VPS* mirroring the host's
    // mode so `<boxName>.localhost:<P>` resolves to the same content on
    // both sides. The `portless` CLI is baked into the base snapshot by
    // install-box.sh:316. Idempotent — `portless proxy start` exits 0 if a
    // proxy is already running on the port. Best-effort: a failure here
    // just means the in-box symmetric URL won't resolve; the host URL
    // still works.
    //
    // Run as root (vscode has NOPASSWD sudo): portless's :443/:80 TLS
    // proxy self-elevates to root anyway, and its state lands in
    // /root/.portless. A subsequent `portless alias` from vscode would
    // write to /home/vscode/.portless and the proxy wouldn't see it —
    // the two state dirs are disjoint. Using sudo for both keeps them
    // pointed at the same `/root/.portless`.
    const tlsFlag = opts.tls ? '' : '--no-tls';
    const startCmd = `sudo portless proxy start ${tlsFlag} -p ${String(opts.proxyPort)}`.replace(
      /\s+/g,
      ' ',
    );
    const aliasCmd = `sudo portless alias ${shellQuote(opts.boxName)} ${String(opts.webPort)}`;
    const cmds = [startCmd, aliasCmd];
    if (opts.tls) {
      // The TLS mirror serves its own self-signed CA at /root/.portless/ca.pem.
      // `portless proxy start` only trusts it in the system store — not the box
      // user's NSS db, which Chrome / Chromium / Playwright read — so the VNC browser and
      // Playwright fail with a cert error on `https://<box>.localhost`. Trust it
      // everywhere (system store + vscode NSS db) and point Node at it via
      // NODE_EXTRA_CA_CERTS. Best-effort: the helper never exits non-zero.
      cmds.push(
        // Where the CA landed depends on whether the VPS's sudo resets HOME:
        // `sudo portless proxy start` wrote it under /root on some images and
        // under the box user's home on others (measured on DigitalOcean, where
        // the /root-only lookup left NODE_EXTRA_CA_CERTS pointing at nothing and
        // every in-box node process warning "Ignoring extra certs"). Try both.
        `sudo sh -c 'for ca in /root/.portless/ca.pem /home/${VPS_USER}/.portless/ca.pem; do if [ -r "$ca" ]; then agentbox-portless-trust "$ca" >/dev/null 2>&1; break; fi; done' || true`,
        `echo 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/agentbox-portless-ca.crt' | sudo tee /etc/profile.d/agentbox-portless-ca.sh >/dev/null || true`,
      );
    }
    await this.exec(h, cmds.join('; '));
  },

  async attachArgv(h): Promise<string[]> {
    const { target } = await ensureLiveTarget(h.sandboxId);
    // Reuse the ControlMaster via `-S <sock>` — no new auth handshake, no
    // SSH-token mint pressure (unlike Daytona). Callers append `-t '<cmd>'`
    // or similar in the `buildAttach` helper.
    return ['ssh', ...sshOptArgs(target), `${target.user}@${target.host}`];
  },

  async createSnapshot(h, name): Promise<void> {
    const id = Number.parseInt(h.sandboxId, 10);
    const c = client();
    const { image } = await withHetznerRetry(
      { method: 'createImage', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
      () =>
        c.createImage(id, {
          type: 'snapshot',
          description: name,
          labels: { 'agentbox.role': 'ckpt', 'agentbox.box': h.sandboxId },
        }),
    );
    await pollUntil(
      `image ${String(image.id)} availability`,
      async () => {
        const img = await c.getImage(image.id);
        return img?.status === 'available' ? img : null;
      },
      { deadlineMs: SNAPSHOT_DEADLINE_MS, intervalMs: 3_000, maxIntervalMs: 10_000 },
    );
  },

  async deleteSnapshot(name): Promise<void> {
    const c = client();
    const img = await findImageByDescription(c, name);
    if (!img) return;
    try {
      await c.deleteImage(img.id);
    } catch (err) {
      if (err instanceof HetznerApiError && (err.statusCode === 404 || err.code === 'not_found'))
        return;
      throw err;
    }
  },
};

/** Exposed for the CLI's `firewall sync` / `show` subcommands. */
export { tunnels as _hetznerTunnels };
