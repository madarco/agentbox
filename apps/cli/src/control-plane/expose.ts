/**
 * `agentbox hub expose` — upgrade the ONE local hub into the control box.
 *
 * The control box is not a second machine: it is the same `apps/hub` process
 * `agentbox hub` already spawns, flipped to the deployed `hetzner` profile
 * (password auth + SQLite store + resident create worker) and made reachable to
 * boxes. This module owns the flip: assemble the deploy record, (optionally)
 * bring up a tunnel, write the record, restart the hub in exposed mode, and
 * point the CLI at it. `ensureHub()` reads the record back on every start, so
 * autostart / restart reconstruct the mode from disk — nothing here has to run
 * again for the hub to come back exposed.
 *
 * Precondition: `~/.agentbox/control-plane/control-plane.env` already carries
 * the admin token, API key, git credential AND the auth block (secret + admin
 * login) — the command layer mints those (`ensureControlPlaneEnv` +
 * `ensureLocalHubAuth`) before calling in here, so this stays UI-free.
 */
import { networkInterfaces } from 'node:os';
import { setConfigValue, unsetConfigValue } from '@agentbox/config';
import {
  buildExposedHubEnv,
  type ControlPlaneDeployRecord,
} from '@agentbox/sandbox-core';
import { detectEgressIp } from '@agentbox/sandbox-hetzner';
import { ensureHub, getHubStatus, stopHub, type HubEndpoint } from '@agentbox/sandbox-docker';
import { AGENTBOX_VERSION } from '../version.js';
import { readControlPlaneEnvMap, setControlPlaneEnvKey } from './env-file.js';
import { persistDeployRecord, purgeLocalControlPlaneState } from './deploy-hetzner.js';
import { startTunnel, stopTunnel, type TunnelKind } from './tunnel.js';
import { installAutostart, removeAutostart, type AutostartResult } from '../lib/autostart.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CP_DIR = join(homedir(), '.agentbox', 'control-plane');
const DEFAULT_HUB_PORT = 8787;

export interface ExposeOptions {
  /** Bind address: `0.0.0.0` (LAN, default) or `127.0.0.1` (loopback + tunnel only). */
  bind?: string;
  port?: number;
  tunnel?: TunnelKind;
  /** Named Cloudflare tunnel token (stable hostname). Stored in control-plane.env. */
  tunnelToken?: string;
  /** Supply the box-facing URL yourself (own proxy/DNS); skips tunnel URL scraping. */
  publicUrl?: string;
  autostart?: boolean;
  onLog?: (line: string) => void;
}

export interface ExposeResult {
  endpoint: HubEndpoint;
  record: ControlPlaneDeployRecord;
  /** The box-facing URL (LAN or tunnel). */
  publicUrl: string;
  /** The CLI-facing loopback URL (the local shortcut). */
  localUrl: string;
  /** False when a cloud box could NOT reach the hub (loopback-only, no tunnel). */
  cloudReachable: boolean;
  autostart: AutostartResult | null;
}

/** The first non-internal IPv4 address, or `127.0.0.1` when there is none. */
export function detectLanIp(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Resolve the box-facing URL for the requested exposure. Impure only for the
 * tunnel, which is injectable so the ordering is testable.
 *
 * `--tunnel` decides whether a tunnel RUNS; `--public-url` only decides what URL
 * is advertised. Those were conflated: an explicit URL returned before the
 * tunnel was started, so the documented named-Cloudflare flow
 * (`--tunnel cloudflare --tunnel-token X --public-url Y`) wrote the record and
 * reported success with **no tunnel process running** — boxes could not reach
 * the hub until the next `hub start` happened to bring it up.
 */
export async function resolvePublicUrl(
  opts: ExposeOptions,
  port: number,
  log: (l: string) => void,
  deps: { startTunnel: typeof startTunnel } = { startTunnel },
): Promise<{ publicUrl: string; cloudReachable: boolean }> {
  const explicit = opts.publicUrl?.replace(/\/$/, '');
  if (opts.tunnel) {
    // A named tunnel's hostname is configured on Cloudflare's side, so nothing
    // here can discover it — it has to be supplied.
    if (opts.tunnel === 'cloudflare' && opts.tunnelToken && !explicit) {
      throw new Error(
        'a named Cloudflare tunnel (--tunnel-token) has a hostname only you know — pass it with --public-url.',
      );
    }
    const handle = await deps.startTunnel({
      kind: opts.tunnel,
      port,
      ...(opts.tunnelToken ? { token: opts.tunnelToken } : {}),
      onLog: log,
    });
    // An explicit URL wins: for a named tunnel it IS the hostname, and there is
    // nothing useful to scrape.
    return { publicUrl: explicit ?? handle.publicUrl.replace(/\/$/, ''), cloudReachable: true };
  }
  // No tunnel, but a URL you terminate yourself — reachable, nothing to start.
  if (explicit) return { publicUrl: explicit, cloudReachable: true };
  // Neither: the LAN address (or loopback when bound to 127.0.0.1). A cloud box
  // can't reach either, so cloudReachable is false — the caller warns loudly.
  const bind = opts.bind ?? '0.0.0.0';
  const host = bind === '127.0.0.1' ? '127.0.0.1' : detectLanIp();
  return { publicUrl: `http://${host}:${String(port)}`, cloudReachable: false };
}

/**
 * Flip this machine's hub into the exposed control box. See the module doc for
 * the precondition on `control-plane.env`.
 */
export async function runExpose(opts: ExposeOptions): Promise<ExposeResult> {
  const log = opts.onLog ?? (() => {});
  const port = opts.port ?? DEFAULT_HUB_PORT;
  const bind = opts.bind ?? '0.0.0.0';

  // A named-tunnel token is a secret, so it rides control-plane.env (not the
  // record) — that's also how a restart re-runs the named tunnel unattended.
  //
  // Written as an upsert-or-REMOVE, not an append: the token has to describe the
  // expose that is happening now. Left behind, it survives
  // `unexpose --keep-credentials`, and a later quick-tunnel expose would then
  // find it on the next `hub start` and bring up a NAMED tunnel on a hostname
  // the record knows nothing about.
  setControlPlaneEnvKey('AGENTBOX_TUNNEL_TOKEN', opts.tunnelToken ?? null);

  const { publicUrl, cloudReachable } = await resolvePublicUrl(opts, port, log);

  // The admin PC's egress CIDR, so a hetzner box this hub creates still admits
  // SSH from here. Best-effort — a failure just omits it (documented).
  let adminCidr: string | undefined;
  try {
    const ip = await detectEgressIp();
    adminCidr = ip.includes('/') ? ip : `${ip}/32`;
  } catch {
    /* omit — a hetzner box's firewall then won't auto-admit this machine */
  }

  const record: ControlPlaneDeployRecord = {
    provider: 'local',
    url: publicUrl,
    publicUrl,
    port,
    bind,
    ...(opts.tunnel ? { tunnel: opts.tunnel } : {}),
    autostart: opts.autostart !== false,
    ...(adminCidr ? { adminCidr } : {}),
    // The build this control box runs IS this CLI's, so record it for
    // `describeRemoteHubBuild` / `hub status`.
    source: { kind: 'package', spec: AGENTBOX_VERSION },
  };
  await persistDeployRecord(record);
  // Wire the config alongside the record, BEFORE the restart. Both describe the
  // intent, and `hub start` can finish the job from them — so a restart that
  // fails leaves a machine that is merely stopped, not one that is half-exposed
  // with a record and a tunnel but no config pointing at either.
  //
  // The box-facing URL is what a locally-created cloud box is told to call home
  // on (relay.controlPlaneUrl keeps its box-facing meaning); the CLI reaches the
  // hub via the loopback local shortcut.
  await setConfigValue('global', 'relay.controlPlaneUrl', publicUrl, homedir());
  log('wrote exposed control-box record');

  // Restart cleanly into exposed mode: stop any localhost hub, then ensureHub
  // (which self-resolves the exposed env from the record just written).
  await stopHub();
  const endpoint = await ensureHub({ onLog: log });

  let autostart: AutostartResult | null = null;
  if (opts.autostart !== false) {
    autostart = await installAutostart(
      { execPath: process.execPath, cliEntry: process.argv[1] ?? 'agentbox' },
      { logFile: join(homedir(), '.agentbox', 'hub.log') },
    );
  }

  return {
    endpoint,
    record,
    publicUrl,
    localUrl: `http://127.0.0.1:${String(port)}`,
    cloudReachable,
    autostart,
  };
}

/**
 * (Re)start the tunnel for an exposed record on `hub start` / autostart, and
 * reconcile a changed ephemeral hostname back into the record + config. No-op
 * when the record has no tunnel. Returns the (possibly updated) record.
 */
export async function ensureTunnelForRecord(
  record: ControlPlaneDeployRecord,
  log: (l: string) => void = () => {},
): Promise<ControlPlaneDeployRecord> {
  if (!record.tunnel) return record;
  const kind = record.tunnel as TunnelKind;
  const env = readControlPlaneEnvMap();
  // Stop whatever is recorded first. This runs on every `hub start` / `restart`
  // / local update, and `hub stop` used to leave the tunnel up — so starting
  // unconditionally spawned a second `cloudflared`, overwrote tunnel.pid with
  // the new one, and orphaned the old process where no teardown could reach it.
  // stopTunnel is idempotent and a no-op when nothing is recorded.
  await stopTunnel().catch(() => {});
  const handle = await startTunnel({
    kind,
    port: record.port ?? DEFAULT_HUB_PORT,
    ...(env.AGENTBOX_TUNNEL_TOKEN ? { token: env.AGENTBOX_TUNNEL_TOKEN } : {}),
    onLog: log,
  });
  // A named cloudflare tunnel (token) keeps the record's publicUrl; a quick
  // tunnel / tailscale reports the live URL, which can differ across restarts.
  const fresh = handle.publicUrl ? handle.publicUrl.replace(/\/$/, '') : record.publicUrl;
  if (fresh && fresh !== record.publicUrl) {
    log(`tunnel URL changed → ${fresh}`);
    const updated: ControlPlaneDeployRecord = { ...record, publicUrl: fresh, url: fresh };
    await persistDeployRecord(updated);
    await setConfigValue('global', 'relay.controlPlaneUrl', fresh, homedir());
    return updated;
  }
  return record;
}

/**
 * Bring the exposed hub up for `hub start` when the machine is a local control
 * box: (re)establish the tunnel first (so the hub boots knowing its public URL),
 * then ensureHub (which reads the exposed record from disk).
 */
export async function bringUpExposedHub(
  record: ControlPlaneDeployRecord,
  log: (l: string) => void = () => {},
): Promise<HubEndpoint> {
  await ensureTunnelForRecord(record, log);
  return ensureHub({ onLog: log });
}

/** Restart the exposed hub in place (the `hub update` local path). */
export async function runLocalUpdate(log: (l: string) => void = () => {}): Promise<HubEndpoint> {
  await stopHub();
  const record = await readLocalRecord();
  if (record) await ensureTunnelForRecord(record, log);
  return ensureHub({ onLog: log });
}

/**
 * Tear down the local control box: stop the tunnel, remove the autostart unit,
 * stop the exposed hub, purge the control-plane state, and unset the config —
 * leaving the plain localhost hub available on the next `hub start`. Does NOT
 * touch the shared `~/.agentbox` (store.db / auth.db / custody live there).
 */
export async function runLocalDestroy(
  opts: { keepCredentials?: boolean; log?: (l: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  await stopTunnel().catch(() => {});
  await removeAutostart().catch(() => {});
  await stopHub();
  log('stopped the exposed hub + tunnel');
  await purgeLocalControlPlaneState({ dir: CP_DIR, keepCredentials: Boolean(opts.keepCredentials) });
  await unsetConfigValue('global', 'relay.controlPlaneUrl', process.cwd()).catch(() => {});
  await unsetConfigValue('project', 'relay.controlPlaneUrl', process.cwd()).catch(() => {});
}

/**
 * On `hub stop`: take the tunnel down with the hub it fronts. No-op when this
 * machine isn't exposed or has no tunnel. Best-effort — failing to stop a tunnel
 * must not make `hub stop` fail.
 */
export async function stopTunnelIfExposed(log: (l: string) => void = () => {}): Promise<void> {
  const record = await readLocalRecord();
  if (!record?.tunnel) return;
  log('stopping the tunnel');
  await stopTunnel().catch(() => {});
}

/**
 * On `hub start` / autostart: if this machine is a local control box with a
 * tunnel, (re)establish it before the hub boots so the hub knows its public URL.
 * No-op otherwise. Best-effort — a tunnel failure must not block the hub.
 */
export async function restoreTunnelIfExposed(log: (l: string) => void = () => {}): Promise<void> {
  const record = await readLocalRecord();
  if (!record?.tunnel) return;
  try {
    const updated = await ensureTunnelForRecord(record, log);
    // A quick tunnel's hostname is ephemeral, so a restart can rotate it. The
    // record and config now carry the new URL, but the hub advertises
    // AGENTBOX_HUB_PUBLIC_URL from the env it was SPAWNED with — and ensureHub
    // returns early when a healthy hub of the right profile already holds the
    // port. Without this the running hub keeps telling boxes to call home on a
    // hostname that no longer resolves, while the CLI uses the new one.
    if (updated.publicUrl !== record.publicUrl) {
      log('tunnel URL rotated — restarting the hub so boxes get the new one');
      await stopHub();
    }
  } catch (e: unknown) {
    // The restart is stop-then-start and cannot be made atomic: a tailscale
    // funnel is a daemon toggle rather than a second process, so there is no
    // "bring the new one up first" for both kinds. That makes a failure here
    // leave NO tunnel while the record and the hub still advertise the old
    // hostname — boxes silently lose the hub. Say so plainly; a terse log line
    // scrolls past inside a spinner and reads like a warning about nothing.
    const reason = e instanceof Error ? e.message : String(e);
    log(`WARNING: the ${record.tunnel} tunnel did not come back (${reason}).`);
    log(
      `The hub is running but cloud boxes cannot reach it at ${record.publicUrl ?? 'its recorded URL'} — ` +
        're-run `agentbox hub start` to retry, or `agentbox hub expose --tunnel ' +
        `${record.tunnel}\` to re-establish it.`,
    );
  }
}

/** The local deploy record if this machine is exposed, else null. */
async function readLocalRecord(): Promise<ControlPlaneDeployRecord | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { controlPlaneDeployPath } = await import('@agentbox/sandbox-core');
    const rec = JSON.parse(await readFile(controlPlaneDeployPath(), 'utf8')) as ControlPlaneDeployRecord;
    return rec.provider === 'local' ? rec : null;
  } catch {
    return null;
  }
}

/** Whether a local exposed hub is currently the running mode (for status). */
export async function isLocallyExposed(): Promise<boolean> {
  const rec = await readLocalRecord();
  return rec !== null;
}

/** A hint if a hub is holding the port but not in the exposed profile yet. */
export async function exposedHubProfileOk(): Promise<boolean> {
  const s = await getHubStatus();
  return s.profile === 'hetzner';
}

/** Re-export for callers assembling the exposed env in tests / status. */
export { buildExposedHubEnv };
