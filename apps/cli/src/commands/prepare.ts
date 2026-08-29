/**
 * `agentbox prepare` — provider-neutral "build the base image" command.
 *
 * Three modes:
 *
 *   - `agentbox prepare`               → status only: show the inventory of
 *                                        prepared base images / shared
 *                                        volumes across all providers, plus
 *                                        the project's pinned `box.image`.
 *   - `agentbox prepare --provider X`  → run prepare for X, then re-print
 *                                        the relevant status section.
 *   - `agentbox prepare --status`      → status only (explicit; same as
 *                                        no-args, but useful when scripted).
 *
 * Docker `prepare` builds `agentbox/box:dev` locally. Daytona `prepare`
 * builds a layered `Image` (Dockerfile.box + the three agent static tarballs)
 * and registers it via `daytona.snapshot.create({ name, image })`, then pins
 * `box.image: <name>` into the project config.
 *
 * Replaces the old `agentbox daytona publish-snapshot` (which used the
 * broken `_experimental_createSnapshot` API).
 */

import { intro, log, spinner } from '@clack/prompts';
import { loadEffectiveConfig, unsetConfigValue } from '@agentbox/config';
import {
  DEFAULT_BOX_IMAGE,
  SHARED_CLAUDE_VOLUME,
  SHARED_CODEX_VOLUME,
  SHARED_OPENCODE_VOLUME,
  imageInfo,
  volumeExists,
  type ImageInfo,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { UserFacingError } from '@agentbox/core';
import type { Provider } from '@agentbox/core';
import { getProvider, isKnownProvider } from '../provider/registry.js';
import { getRuntimeProviderNames } from '../provider/loaders.js';
import { parseProviderSpec } from '../provider/spec.js';
import { deadlineFetch, hostReachable } from '@agentbox/sandbox-cloud';
import { controlBoxKnowsHost } from '../control-plane/remote-docker-share.js';
import { bakeViaHub } from '../control-plane/hub-prepare.js';
import { dockerProviderRefusal } from '../control-plane/remote-hub.js';
import { HubApiClient } from '../control-plane/hub-api-client.js';
import {
  localExposedLoopbackUrl,
  resolveCustodyTarget,
  resolveHubApiClient,
  resolveHubApiTarget,
} from './control-plane.js';

interface PrepareOptions {
  provider?: string;
  force?: boolean;
  yes?: boolean;
  status?: boolean;
  claudeInstall?: string;
  agents?: string;
  build?: boolean;
  name?: string;
  location?: string;
  size?: string;
}

interface DockerStatus {
  daemon: 'reachable' | 'unreachable';
  image?: ImageInfo;
  volumes: Array<{ name: string; exists: boolean }>;
}

async function dockerStatus(): Promise<DockerStatus> {
  let img: ImageInfo;
  try {
    img = await imageInfo(DEFAULT_BOX_IMAGE);
  } catch {
    return { daemon: 'unreachable', volumes: [] };
  }
  const names = [SHARED_CLAUDE_VOLUME, SHARED_CODEX_VOLUME, SHARED_OPENCODE_VOLUME];
  const volumes = await Promise.all(
    names.map(async (name) => ({ name, exists: await volumeExists(name).catch(() => false) })),
  );
  return { daemon: 'reachable', image: img, volumes };
}

function humanBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${String(n)} B`;
}

function humanAge(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const ageSec = Math.max(0, (Date.now() - t) / 1000);
  if (ageSec < 60) return `${ageSec.toFixed(0)}s ago`;
  if (ageSec < 3600) return `${(ageSec / 60).toFixed(0)}m ago`;
  if (ageSec < 86400) return `${(ageSec / 3600).toFixed(1)}h ago`;
  return `${(ageSec / 86400).toFixed(1)}d ago`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function renderDocker(status: DockerStatus): Promise<string[]> {
  const out: string[] = ['docker:'];
  if (status.daemon === 'unreachable') {
    out.push('  docker daemon unreachable (is Docker running?)');
    return out;
  }
  if (!status.image?.exists) {
    out.push(
      `  image  ${DEFAULT_BOX_IMAGE}  (not built — run \`agentbox prepare --provider docker\`)`,
    );
  } else {
    out.push(
      `  image  ${pad(DEFAULT_BOX_IMAGE, 30)} ${pad(humanBytes(status.image.sizeBytes), 10)} built ${humanAge(status.image.createdAt)}`,
    );
  }
  for (const v of status.volumes) {
    if (v.exists) {
      out.push(`  vol    ${pad(v.name, 30)} present`);
    } else {
      out.push(
        `  vol    ${pad(v.name, 30)} (none — seeded lazily on first \`agentbox claude/codex/opencode\`)`,
      );
    }
  }
  return out;
}

interface DaytonaStatusUnknown {
  configured: false;
  reason?: string;
}
interface DaytonaStatusOk {
  configured: true;
  snapshots: Array<{
    name: string;
    state?: string;
    sizeGb?: number;
    createdAt?: string;
    errorReason?: string;
  }>;
  volumes: Array<{ name: string; state?: string; lastUsedAt?: string }>;
  reason?: string;
}
type DaytonaStatusResult = DaytonaStatusUnknown | DaytonaStatusOk;

async function daytonaStatus(): Promise<DaytonaStatusResult> {
  try {
    const mod = await import('@agentbox/sandbox-daytona');
    return (await mod.getDaytonaStatus()) as DaytonaStatusResult;
  } catch (err) {
    return {
      configured: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

interface E2bStatusUnknown {
  configured: false;
  reason?: string;
}
interface E2bStatusOk {
  configured: true;
  templateId?: string;
  templateName?: string;
  createdAt?: string;
  cliVersion?: string;
  contextSha256?: string;
  /** Per-agent-set derived templates, `''` (the base) excluded. */
  variants?: Array<{ agents: string; templateName?: string; createdAt?: string }>;
}
type E2bStatusResult = E2bStatusUnknown | E2bStatusOk;

async function e2bStatus(): Promise<E2bStatusResult> {
  try {
    const mod = await import('@agentbox/sandbox-e2b');
    const cred = mod.readE2bCredStatus();
    if (cred.auth === 'none') {
      return { configured: false, reason: 'not configured — run `agentbox e2b login`' };
    }
    const prepared = mod.readPreparedState();
    if (!prepared.base) return { configured: true };
    return {
      configured: true,
      templateId: prepared.base.templateId,
      templateName: prepared.base.templateName,
      createdAt: prepared.base.createdAt,
      cliVersion: prepared.base.cliVersion,
      contextSha256: prepared.base.contextSha256,
      variants: Object.entries(prepared.variants ?? {})
        .filter(([agents]) => agents !== '')
        .map(([agents, v]) => ({
          agents,
          templateName: v.templateName ?? v.templateId,
          createdAt: v.createdAt,
        })),
    };
  } catch (err) {
    return {
      configured: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

function renderE2b(status: E2bStatusResult): string[] {
  const out: string[] = ['e2b:'];
  if (!status.configured) {
    out.push(`  ${status.reason ?? '(not configured)'}`);
    return out;
  }
  if (!status.templateId) {
    out.push('  no agentbox template — run `agentbox prepare --provider e2b`');
    return out;
  }
  // No pin marker: like vercel, the e2b backend never reads `req.image`, so
  // `box.imageE2b` is written by every bake and never consulted. Printing
  // "(pinned in project)" for it claimed a control the user does not have.
  out.push(
    `  base   ${pad(status.templateName ?? status.templateId, 40)} ${pad(status.cliVersion ?? '—', 10)}  ${humanAge(status.createdAt)}`,
  );
  for (const v of status.variants ?? []) {
    out.push(
      `  ${pad(v.agents, 6)} ${pad(v.templateName ?? '—', 40)} ${pad('—', 10)}  ${humanAge(v.createdAt)}`,
    );
  }
  return out;
}

interface VercelStatusUnknown {
  configured: false;
  reason?: string;
}
interface VercelStatusOk {
  configured: true;
  snapshotId?: string;
  createdAt?: string;
  cliVersion?: string;
  /** Per-agent-set derived snapshots, `''` (the base) excluded. */
  variants?: Array<{ agents: string; snapshotId?: string; createdAt?: string }>;
}
type VercelStatusResult = VercelStatusUnknown | VercelStatusOk;

async function vercelStatus(): Promise<VercelStatusResult> {
  try {
    const mod = await import('@agentbox/sandbox-vercel');
    const prepared = mod.readPreparedState();
    if (!prepared.base) return { configured: true };
    return {
      configured: true,
      snapshotId: prepared.base.snapshotId,
      createdAt: prepared.base.createdAt,
      cliVersion: prepared.base.cliVersion,
      variants: Object.entries(prepared.variants ?? {})
        .filter(([agents]) => agents !== '')
        .map(([agents, v]) => ({ agents, snapshotId: v.snapshotId, createdAt: v.createdAt })),
    };
  } catch (err) {
    return {
      configured: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

function renderVercel(status: VercelStatusResult): string[] {
  const out: string[] = ['vercel:'];
  if (!status.configured) {
    out.push(`  ${status.reason ?? '(not configured)'}`);
    return out;
  }
  if (!status.snapshotId) {
    out.push('  no base snapshot — run `agentbox prepare --provider vercel`');
    return out;
  }
  out.push(
    `  base   ${pad(status.snapshotId, 40)} ${pad(status.cliVersion ?? '—', 10)}  ${humanAge(status.createdAt)}`,
  );
  for (const v of status.variants ?? []) {
    out.push(
      `  ${pad(v.agents, 6)} ${pad(v.snapshotId ?? '—', 40)} ${pad('—', 10)}  ${humanAge(v.createdAt)}`,
    );
  }
  return out;
}

interface HetznerStatusUnknown {
  configured: false;
  reason?: string;
}
interface HetznerStatusOk {
  configured: true;
  imageId?: number;
  description?: string;
  createdAt?: string;
  cliVersion?: string;
  variants?: Array<{ agents: string; description?: string; createdAt?: string }>;
}
type HetznerStatusResult = HetznerStatusUnknown | HetznerStatusOk;

async function hetznerStatus(): Promise<HetznerStatusResult> {
  try {
    const mod = await import('@agentbox/sandbox-hetzner');
    const prepared = mod.readPreparedState();
    if (!prepared.base) return { configured: true };
    return {
      configured: true,
      imageId: prepared.base.imageId,
      description: prepared.base.description,
      createdAt: prepared.base.createdAt,
      cliVersion: prepared.base.cliVersion,
      variants: Object.entries(prepared.variants ?? {})
        .filter(([agents]) => agents !== '')
        .map(([agents, v]) => ({ agents, description: v.description, createdAt: v.createdAt })),
    };
  } catch (err) {
    return {
      configured: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

function renderHetzner(status: HetznerStatusResult, pinnedImage?: string): string[] {
  const out: string[] = ['hetzner:'];
  if (!status.configured) {
    out.push(`  ${status.reason ?? '(not configured)'}`);
    return out;
  }
  if (status.imageId === undefined) {
    out.push('  no base snapshot — run `agentbox prepare --provider hetzner`');
    return out;
  }
  const pinned =
    pinnedImage && (pinnedImage === status.description || pinnedImage === String(status.imageId))
      ? '  (pinned in project)'
      : '';
  out.push(
    `  base   ${pad(status.description ?? String(status.imageId), 40)} ${pad(status.cliVersion ?? '—', 10)}  ${humanAge(status.createdAt)}${pinned}`,
  );
  for (const v of status.variants ?? []) {
    out.push(
      `  ${pad(v.agents, 6)} ${pad(v.description ?? '—', 40)} ${pad('—', 10)}  ${humanAge(v.createdAt)}`,
    );
  }
  return out;
}

interface DigitalOceanStatusUnknown {
  configured: false;
  reason?: string;
}
interface DigitalOceanStatusOk {
  configured: true;
  imageId?: number;
  description?: string;
  createdAt?: string;
  cliVersion?: string;
  /** Per-agent-set derived snapshots, `''` (the base) excluded. */
  variants?: Array<{ agents: string; description?: string; createdAt?: string }>;
}
type DigitalOceanStatusResult = DigitalOceanStatusUnknown | DigitalOceanStatusOk;

async function digitalOceanStatus(): Promise<DigitalOceanStatusResult> {
  try {
    const mod = await import('@agentbox/sandbox-digitalocean');
    if (mod.readDigitalOceanCredStatus().source === 'none') {
      return { configured: false, reason: 'not configured — run `agentbox digitalocean login`' };
    }
    const prepared = mod.readPreparedState();
    if (!prepared.base) return { configured: true };
    return {
      configured: true,
      imageId: prepared.base.imageId,
      description: prepared.base.description,
      createdAt: prepared.base.createdAt,
      cliVersion: prepared.base.cliVersion,
      variants: Object.entries(prepared.variants ?? {})
        .filter(([agents]) => agents !== '')
        .map(([agents, v]) => ({ agents, description: v.description, createdAt: v.createdAt })),
    };
  } catch (err) {
    return {
      configured: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

function renderDigitalOcean(status: DigitalOceanStatusResult, pinnedImage?: string): string[] {
  const out: string[] = ['digitalocean:'];
  if (!status.configured) {
    out.push(`  ${status.reason ?? '(not configured)'}`);
    return out;
  }
  if (status.imageId === undefined) {
    out.push('  no base snapshot — run `agentbox prepare --provider digitalocean`');
    return out;
  }
  const pinned =
    pinnedImage && (pinnedImage === status.description || pinnedImage === String(status.imageId))
      ? '  (pinned in project)'
      : '';
  out.push(
    `  base   ${pad(status.description ?? String(status.imageId), 40)} ${pad(status.cliVersion ?? '—', 10)}  ${humanAge(status.createdAt)}${pinned}`,
  );
  for (const v of status.variants ?? []) {
    out.push(
      `  ${pad(v.agents, 6)} ${pad(v.description ?? '—', 40)} ${pad('—', 10)}  ${humanAge(v.createdAt)}`,
    );
  }
  return out;
}

function renderDaytona(status: DaytonaStatusResult, pinnedImage?: string): string[] {
  const out: string[] = ['daytona:'];
  if (!status.configured) {
    out.push(
      `  (not configured — \`agentbox daytona login\` to set up${status.reason ? `; ${status.reason}` : ''})`,
    );
    return out;
  }
  if (status.reason) out.push(`  warn: ${status.reason}`);
  if (status.snapshots.length === 0) {
    out.push('  no agentbox snapshots — run `agentbox prepare --provider daytona`');
  } else {
    for (const s of status.snapshots) {
      const sizeStr = s.sizeGb !== undefined ? `${s.sizeGb.toFixed(2)} GB` : '—';
      const pinned = pinnedImage && pinnedImage === s.name ? '  (pinned in project)' : '';
      const tail =
        s.state === 'error' && s.errorReason
          ? `  error: ${s.errorReason.slice(0, 80)}`
          : `  ${humanAge(s.createdAt)}`;
      out.push(
        `  snap   ${pad(s.name, 40)} ${pad(s.state ?? '—', 10)} ${pad(sizeStr, 10)}${tail}${pinned}`,
      );
    }
  }
  if (status.volumes.length === 0) {
    out.push('  no agentbox volumes — created lazily on first cloud `agentbox create`');
  } else {
    for (const v of status.volumes) {
      const last = v.lastUsedAt ? `  last used ${humanAge(v.lastUsedAt)}` : '';
      out.push(`  vol    ${pad(v.name, 40)} ${pad(v.state ?? '—', 10)}${last}`);
    }
  }
  return out;
}

/**
 * Bound on the control-box status read. `?freshness=1` makes the hub hash its
 * own build context, so it is not instant — but this is an interactive status
 * command, and an unreachable box must cost a fixed, small amount of time.
 */
const CONTROL_BOX_STATUS_MS = 5000;

/**
 * The control box's own provider inventory, or nothing when none is configured
 * (or it can't be reached — a status command must never hang or fail on it).
 *
 * Only shown for a GENUINELY remote control box: a co-located hub (a local hub,
 * or `hub expose` on this machine) bakes on this same machine, so the local
 * provider rows already describe it and a second "control box" section would just
 * mislabel it. Exported so `agentbox doctor` shows the same section.
 */
export async function renderControlBoxProviders(): Promise<string[]> {
  if (await hubIsCoLocated().catch(() => true)) return [];
  const target = await resolveHubApiTarget(undefined, { quiet: true }).catch(() => null);
  if (!target) return [];
  // Probe with a socket we own before spending the budget: a fetch to an
  // unreachable host can't be cancelled, and this is a status command.
  if (!(await hostReachable(target.url, CONTROL_BOX_STATUS_MS))) {
    return ['', 'control box: unreachable — could not read its baked providers'];
  }
  const client = new HubApiClient({
    ...target,
    fetchImpl: deadlineFetch(AbortSignal.timeout(CONTROL_BOX_STATUS_MS)),
  });
  const providers = await client.listProviders({ freshness: true }).catch(() => null);
  if (!providers) return ['', 'control box: unreachable — could not read its baked providers'];
  const cloud = providers.filter((p) => p.id !== 'docker' && p.id !== 'remote-docker');
  if (cloud.length === 0) return [];
  const out = ['', 'control box (where cloud boxes are built):'];
  for (const p of cloud) {
    const state = !p.hasCredentials
      ? 'no credentials'
      : !p.configured
        ? 'not baked'
        : (p.baseStatus ?? 'baked');
    out.push(`  ${pad(p.id, 16)} ${state}`);
  }
  return out;
}

async function showStatus(opts: { onlyProvider?: string }): Promise<void> {
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const pinnedRaw = cfg?.effective.box.image;
  // Only treat as "user-pinned" if it differs from the docker default tag
  // — that one is just the fallback ref the docker provider builds locally.
  const pinned =
    typeof pinnedRaw === 'string' && pinnedRaw.length > 0 && pinnedRaw !== DEFAULT_BOX_IMAGE
      ? pinnedRaw
      : undefined;
  const lines: string[] = [];

  const wantDocker = !opts.onlyProvider || opts.onlyProvider === 'docker';
  const wantDaytona = !opts.onlyProvider || opts.onlyProvider === 'daytona';
  const wantE2b = !opts.onlyProvider || opts.onlyProvider === 'e2b';
  const wantDigitalOcean = !opts.onlyProvider || opts.onlyProvider === 'digitalocean';
  const wantHetzner = !opts.onlyProvider || opts.onlyProvider === 'hetzner';
  const wantVercel = !opts.onlyProvider || opts.onlyProvider === 'vercel';

  if (wantDocker) {
    const status = await dockerStatus();
    lines.push(...(await renderDocker(status)));
  }
  if (wantDaytona) {
    if (lines.length > 0) lines.push('');
    const status = await daytonaStatus();
    lines.push(...renderDaytona(status, pinned));
  }
  if (wantE2b) {
    if (lines.length > 0) lines.push('');
    const status = await e2bStatus();
    lines.push(...renderE2b(status));
  }
  if (wantDigitalOcean) {
    if (lines.length > 0) lines.push('');
    const status = await digitalOceanStatus();
    const doPinned =
      typeof cfg?.effective.box.imageDigitalocean === 'string' &&
      cfg.effective.box.imageDigitalocean.length > 0
        ? cfg.effective.box.imageDigitalocean
        : undefined;
    lines.push(...renderDigitalOcean(status, doPinned));
  }
  if (wantHetzner) {
    if (lines.length > 0) lines.push('');
    const hetznerPinned =
      typeof cfg?.effective.box.imageHetzner === 'string' &&
      cfg.effective.box.imageHetzner.length > 0
        ? cfg.effective.box.imageHetzner
        : undefined;
    lines.push(...renderHetzner(await hetznerStatus(), hetznerPinned));
  }
  if (wantVercel) {
    if (lines.length > 0) lines.push('');
    // No pin marker: the vercel backend never reads `req.image`, so
    // `box.imageVercel` is written by the bake but never consulted.
    lines.push(...renderVercel(await vercelStatus()));
  }
  if (pinned) {
    lines.push('');
    lines.push(`project pin:  box.image = ${pinned}`);
  }
  // With a control box configured, ITS bakes are the ones a cloud create boots —
  // so an inventory that only ever showed this machine's was describing the
  // wrong host. Appended, never substituted: the local rows still matter for
  // docker (always built on this machine) and for the co-located-hub case.
  if (!opts.onlyProvider) lines.push(...(await renderControlBoxProviders()));
  process.stdout.write(lines.join('\n') + '\n');
}

export interface RunPrepareOptions {
  /** Rebuild even if the image / snapshot already exists. */
  force?: boolean;
  /** Skip the Daytona cost-notice. */
  yes?: boolean;
  /** Host workspace dir (defaults to `process.cwd()`). */
  cwd?: string;
  /** Suppress the post-prepare status block. */
  suppressStatus?: boolean;
  /**
   * How the bake installs Claude Code (`native` | `npm`). CLI override of the
   * `box.claudeInstall` config key; falls back to the effective config.
   */
  claudeInstall?: 'native' | 'npm';
  /** Agents to bake into the base. Omitted = agentless. */
  agents?: string[];
  /**
   * Bake INPUTS (not routing) threaded to the hub bake. Each is a per-invocation
   * override; when absent the hub worker fills it from its effective config.
   *   - `build`: force a local docker build instead of pulling the registry base.
   *   - `size`: bake-time VM size (daytona `cpu-mem-disk`, e2b `cpu-mem`).
   *   - `location`: bake datacenter / region (hetzner / digitalocean / daytona).
   *   - `name`: snapshot name (daytona).
   */
  build?: boolean;
  size?: string;
  location?: string;
  name?: string;
}

/**
 * Whether the hub the bake will run on is THIS machine (a local hub, or a control
 * box exposed on loopback via `hub expose`). Decides whether the prepared-state
 * the worker writes is already here (co-located → nothing to adopt) or on a remote
 * control box's disk (adopt the record back from custody).
 */
async function hubIsCoLocated(): Promise<boolean> {
  // Lazy import mirrors resolveHubApiTarget's cycle-avoidance (hub.ts <->
  // control-plane.ts). `hub expose` on this machine reports mode 'remote' but is
  // still co-located, so the loopback check is the second half of the answer.
  const { resolveHubTarget } = await import('./hub.js');
  const target = await resolveHubTarget(undefined).catch(() => null);
  if (target?.mode === 'local') return true;
  return (await localExposedLoopbackUrl().catch(() => null)) !== null;
}

/**
 * Pure decision: does a bake target the LOCAL hub (`local: true`) or the remote
 * control box (`false`)? This is target selection only — the bake always runs
 * through the same `POST /api/v1/providers/:id/prepare` (or `/hosts/:alias/bake`)
 * route; there is NO inline `provider.prepare` path, which is exactly the second
 * implementation this consolidation exists to delete. The choice is only ever
 * WHICH base URL the one client points at.
 *
 * Extracted pure (IO done by {@link shouldPreferLocalHub}) so the routing is
 * unit-testable — the deleted `resolvePrepareRouting` had this same shape, and
 * dropping it is what regressed the `cloud.viaHub` and remote-docker fallbacks.
 *
 * Local wins when:
 *   - the hub is already co-located (no control box, or `hub expose` here);
 *   - `cloud.viaHub=false` — the user keeps builds on their own machine even with
 *     a control plane configured (the config KEY survives; only the `--local` /
 *     `--via-hub` flags were dropped);
 *   - `docker`, whose base is an image on THIS machine — baking it on the control
 *     box would produce an image on the wrong host;
 *   - `remote-docker` whose host alias the control box doesn't know, but the local
 *     hub (this machine's `~/.ssh`) does.
 * Otherwise the control box is the target (the default for cloud bakes).
 */
export function resolvePrepareTargetKind(input: {
  /** The default hub is already on this machine (local, or `hub expose` here). */
  coLocated: boolean;
  /** `relay.controlPlaneUrl` — a genuine remote control box is configured. */
  controlPlaneUrl: string | undefined;
  /** `cloud.viaHub` — build cloud boxes / bases on the control box by default. */
  viaHub: boolean;
  providerName: string;
  remoteHost?: string;
  /** remote-docker only: whether the control box has the host alias registered. */
  controlBoxKnowsHost?: boolean;
}): { local: boolean; reason?: string } {
  if (input.coLocated) return { local: true };
  if (!input.controlPlaneUrl) return { local: true };
  if (!input.viaHub) return { local: true, reason: 'cloud.viaHub is off — baking on this machine' };
  if (input.providerName === 'docker') return { local: true };
  if (input.providerName === 'remote-docker' && input.remoteHost && !input.controlBoxKnowsHost) {
    return {
      local: true,
      reason: `the control box has no \`${input.remoteHost}\` host registered — baking on this machine's hub`,
    };
  }
  return { local: false };
}

/**
 * IO wrapper around {@link resolvePrepareTargetKind}: resolves co-location, the
 * effective config, and — only for a remote-docker host that could actually
 * target the control box — the alias check.
 */
async function shouldPreferLocalHub(
  providerName: string,
  remoteHost: string | undefined,
): Promise<{ local: boolean; reason?: string }> {
  const coLocated = await hubIsCoLocated();
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const eff = cfg?.effective;
  const controlPlaneUrl = eff?.relay.controlPlaneUrl;
  const viaHub = eff?.cloud.viaHub ?? true;
  // The alias check is the only networked input, and only remote-docker needs it.
  // Skip it whenever an earlier rule already forces local (no control box,
  // co-located, or cloud.viaHub off) so a normal bake makes no extra round-trip.
  const knowsHost =
    providerName === 'remote-docker' && remoteHost && controlPlaneUrl && viaHub && !coLocated && eff
      ? await controlBoxKnowsHost(remoteHost, eff)
      : undefined;
  return resolvePrepareTargetKind({
    coLocated,
    controlPlaneUrl,
    viaHub,
    providerName,
    remoteHost,
    controlBoxKnowsHost: knowsHost,
  });
}

/**
 * Bake `providerName` THROUGH the hub — the one prepare path (local hub or remote
 * control box). Throws on failure so internal callers (`install`, the create
 * wizard's stale-base rebuild) can catch it; the top-level command surfaces it.
 * The failure path deliberately does NOT fall back to a local bake: a hub bake
 * that failed for a real reason (no credentials there, a broken build context)
 * would fail the same way here.
 */
async function runPrepareViaHub(args: {
  providerName: string;
  provider: Provider;
  force?: boolean;
  claudeInstall: 'native' | 'npm';
  agents?: string[];
  build?: boolean;
  size?: string;
  location?: string;
  name?: string;
  remoteHost?: string;
  suppressStatus?: boolean;
}): Promise<void> {
  // WHICH hub: the local hub on this machine, or the remote control box. Same
  // route either way — target selection, never an inline bake.
  const target = await shouldPreferLocalHub(args.providerName, args.remoteHost);
  if (target.reason) log.info(target.reason);
  // Auto-starts a local hub when that is the target (Step 0). A remote control
  // box with no API key returns null after printing why.
  const client = await resolveHubApiClient(undefined, { preferLocal: target.local });
  // resolveHubApiClient already printed why (no API key, hub wouldn't start).
  if (!client) throw new UserFacingError('could not reach a hub to run the bake');
  // The local hub's worker writes the prepared-state straight to this machine, so
  // choosing local IS the co-located signal — no custody round-trip to adopt.
  const coLocated = target.local;
  // Custody is only the remote-adopt channel; a co-located hub wrote the record
  // straight to this machine, so skip resolving it (and its error path) there.
  const custody = coLocated ? null : await resolveCustodyTarget(undefined, { quiet: true });
  const where = coLocated ? 'hub' : 'control box';
  const what = args.remoteHost ? `${args.providerName} host ${args.remoteHost}` : args.providerName;
  const sp = spinner();
  sp.start(`preparing ${what} on the ${where}…`);
  const outcome = await bakeViaHub({
    client,
    providerName: args.providerName,
    provider: args.provider,
    force: args.force,
    claudeInstall: args.claudeInstall,
    ...(args.agents ? { agents: args.agents } : {}),
    build: args.build,
    size: args.size,
    location: args.location,
    name: args.name,
    custody,
    coLocated,
    remoteHost: args.remoteHost,
    onLog: (line) => sp.message(line.slice(0, 80)),
  });
  if (outcome.status === 'failed') {
    sp.stop(`prepare failed on the ${where}: ${outcome.detail}`);
    throw new Error(outcome.detail);
  }
  sp.stop(`prepared ${what} on the ${where}`);
  if (outcome.status === 'baked-not-adopted') {
    // The hub can now create with it; this machine just can't verify it locally.
    log.warn(`${outcome.detail} — cloud creates route to the control box, so this is not fatal`);
  } else if (coLocated) {
    log.success(`prepared ${args.providerName}`);
  } else {
    log.success(
      args.remoteHost
        ? `baked ${args.remoteHost} from the control box — the image is on that host, so this machine sees it too`
        : `adopted the control box's ${args.providerName} base — this machine is current too`,
    );
  }
  // One-shot migration of a stale generic `box.image`. Pre-fix builds wrote every
  // cloud prepare's snapshot id into the shared key, so any non-default value
  // still there poisons every provider that doesn't recognize it. Best-effort —
  // never fail the command on it.
  try {
    const projectCfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
    const projectImage = projectCfg?.layers.project.values.box?.image;
    if (
      typeof projectImage === 'string' &&
      projectImage.length > 0 &&
      projectImage !== DEFAULT_BOX_IMAGE
    ) {
      const cleared = await unsetConfigValue('project', 'box.image', process.cwd());
      if (cleared.existed) {
        log.warn(
          `migrated stale \`box.image\` from a previous prepare (was \`${projectImage}\`); ` +
            `re-set manually if you actually meant it: \`agentbox config set --project box.image <ref>\``,
        );
      }
    }
  } catch (err) {
    log.warn(
      `could not migrate stale box.image (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!args.suppressStatus) {
    process.stdout.write('\n');
    await showStatus({ onlyProvider: args.providerName });
  }
}

/**
 * Prepare `providerName`'s base — the single entry point the `prepare` command,
 * the install wizard, and the create-time stale-base rebuild all share. The bake
 * ALWAYS runs on the hub (Step 1 of the `/api/v1` consolidation): a local hub is
 * co-located so the artifact lands here, a remote control box is where cloud boxes
 * are built and the record is adopted back. Caller owns any `intro(...)` framing;
 * this manages its own spinner.
 */
export async function runPrepare(
  providerSpec: string,
  opts: RunPrepareOptions = {},
): Promise<void> {
  // Throw, never exit: `runPrepare` is called from the install wizard, the
  // create-time stale-base rebuild and `remote-docker add` — a bare exit would
  // kill those mid-flow instead of letting them report. The `prepare` command
  // itself is unchanged: printCliError renders a UserFacingError's message bare
  // and exits 1, exactly what these did.
  if (!isKnownProvider(providerSpec)) {
    throw new UserFacingError(
      `error: --provider must be one of: ${getRuntimeProviderNames().join(', ')}`,
    );
  }
  // `--provider docker:<host>` bakes the image on that machine's engine. Split
  // the spec: the bare name drives every provider lookup, the host is baked via
  // the hub's per-host endpoint.
  const { name: providerName, remoteHost } = parseProviderSpec(providerSpec);

  if (providerName === 'daytona' && !opts.yes && process.stdin.isTTY) {
    process.stdout.write(
      'This will trigger a Daytona image build (~7 min cold, ~seconds with cache) and ' +
        'register a named snapshot in your org.\n' +
        'Re-run with --yes to skip this notice.\n',
    );
  }

  const provider = await getProvider(providerName);
  if (typeof provider.prepare !== 'function') {
    throw new UserFacingError(`provider '${providerName}' does not implement prepare`);
  }

  const cwd = opts.cwd ?? process.cwd();
  const cfg = await loadEffectiveConfig(cwd).catch(() => null);
  // Docker off under a remote hub (Step 12): don't bake a local docker/remote-docker
  // image when a control box owns the fleet. `local` mode (or no cfg) keeps it on.
  if (cfg) {
    const refusal = await dockerProviderRefusal(cfg.effective, providerName, remoteHost, 'prepare');
    if (refusal) throw new UserFacingError(refusal);
  }
  // Bake-time Claude install method: CLI flag wins over the config key. The
  // remaining bake INPUTS (`build` / `size` / `location` / `name`) are passed
  // through only when the user set the corresponding flag; the hub worker fills
  // any that are absent from ITS effective config (size/region/sandbox class),
  // so one route body serves every bake shape (plan Step 1).
  const claudeInstall = opts.claudeInstall ?? cfg?.effective.box.claudeInstall ?? 'native';
  // remote-docker: the `docker:<host>` spec first, else the configured default.
  const host =
    providerName === 'remote-docker'
      ? remoteHost || cfg?.effective.box.remoteDockerHost || undefined
      : undefined;

  await runPrepareViaHub({
    providerName,
    provider,
    force: opts.force,
    claudeInstall,
    ...(opts.agents ? { agents: opts.agents } : {}),
    build: opts.build,
    size: opts.size,
    location: opts.location,
    name: opts.name,
    remoteHost: host,
    suppressStatus: opts.suppressStatus,
  });
}

/**
 * Agents `--agents` accepts. Kept as a literal rather than derived from
 * AGENT_SYNC_SPECS so the CLI's arg parsing doesn't pull the sync registry into
 * its startup path; the drift is guarded by a test.
 */
const PREPARE_AGENTS = ['claude', 'codex', 'opencode'];

export const prepareCommand = new Command('prepare')
  .description(
    'Build base sandbox images / snapshots, or show what is already prepared across providers. ' +
      'The bake always runs on the hub — a local hub is this machine; with a control box configured, ' +
      'it runs there (where cloud boxes are built) and the record is adopted back.',
  )
  .option(
    '-p, --provider <name>',
    'provider to prepare (docker | daytona | hetzner | vercel | e2b | digitalocean). Omit for status-only.',
  )
  .option('-n, --name <name>', 'snapshot name (Daytona only; default: agentbox-base-<timestamp>)')
  .option('-f, --force', 'rebuild even if the image / snapshot already exists')
  .option(
    '--build',
    'docker: build the base image locally instead of pulling the prebuilt one from the registry',
  )
  .option('-y, --yes', 'skip confirmation prompts (cost / time warnings)')
  .option('--status', 'show status without preparing anything')
  .option(
    '--claude-install <mode>',
    'install Claude Code into the base image via the native installer (default) or npm (native | npm)',
  )
  .option(
    '--agents <list>',
    'comma-separated agents to bake into the base (claude,codex,opencode). Default: none — agents are added as a derived layer or on demand.',
  )
  .option(
    '--location <name>',
    'Datacenter/region the bake VPS runs in. Hetzner: nbg1, fsn1, hel1, ash (overrides box.hetznerLocation). DigitalOcean: nyc3, sfo3, ams3, fra1 (overrides box.digitaloceanRegion). Hetzner/DigitalOcean-only.',
  )
  .option(
    '--size <spec>',
    'bake-time VM size. daytona: cpu-memory-disk GB (e.g. 4-8-20). e2b: cpu-memory GB (e.g. 4-8). Overrides box.size / box.size<Provider>. Ignored by docker/hetzner/vercel.',
  )
  .action(async (opts: PrepareOptions) => {
    // Status-only path: no provider, or explicit --status.
    if (!opts.provider || opts.status) {
      await showStatus({});
      return;
    }

    let claudeInstall: 'native' | 'npm' | undefined;
    if (opts.claudeInstall !== undefined) {
      if (opts.claudeInstall !== 'native' && opts.claudeInstall !== 'npm') {
        process.stderr.write('error: --claude-install must be one of: native, npm\n');
        process.exit(1);
      }
      claudeInstall = opts.claudeInstall;
    }

    let agents: string[] | undefined;
    if (opts.agents !== undefined) {
      const parsed = opts.agents
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const unknown = parsed.filter((a) => !PREPARE_AGENTS.includes(a));
      if (unknown.length > 0) {
        process.stderr.write(
          `error: --agents got unknown agent(s): ${unknown.join(', ')} (known: ${PREPARE_AGENTS.join(', ')})\n`,
        );
        process.exit(1);
      }
      agents = parsed;
    }

    const providerName = opts.provider.trim();
    intro(`preparing ${providerName} base image`);
    // Errors propagate to `program.parseAsync().catch` so they reach the user
    // via `console.error` — a bare `catch { process.exit(1) }` here would
    // silently swallow getProvider() failures (e.g. an ensureCredentials cancel)
    // that fall outside runPrepare's inner spinner error handler.
    await runPrepare(providerName, {
      force: opts.force,
      yes: opts.yes,
      claudeInstall,
      agents,
      build: opts.build,
      size: opts.size,
      location: opts.location,
      name: opts.name,
    });
  });
