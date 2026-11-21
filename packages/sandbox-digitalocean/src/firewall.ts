/**
 * DigitalOcean Cloud Firewall provisioning + drift sync.
 *
 * Defense-in-depth model (mirrors the Hetzner provider's safety model):
 *
 *   1. In-VPS services bind to loopback (the load-bearing layer).
 *   2. DigitalOcean Cloud Firewall locks SSH to the host's egress IP — created
 *      here at provision time *before* the droplet boots and attached to it
 *      via a unique per-box tag, so there is never an unprotected window.
 *      Everything else is denied inbound.
 *   3. sshd hardening (PasswordAuthentication no, AllowUsers vscode, …)
 *      written by cloud-init at first boot.
 *
 * Two DigitalOcean-specific wrinkles vs. Hetzner:
 *   - Firewall ids are UUID strings, not numbers.
 *   - A DO firewall with *only* inbound rules blocks ALL egress. We must add
 *     explicit allow-all outbound rules or the box can't `git clone` / `npm i`.
 *
 * The firewall is per-box (1:1 with the droplet) so an egress-IP drift on one
 * box doesn't affect siblings, and a destroy cleanly removes everything.
 */

import {
  DigitalOceanApiError,
  type CreateFirewallRequest,
  type DigitalOceanClient,
  type DigitalOceanFirewall,
  type DigitalOceanInboundRule,
  type DigitalOceanOutboundRule,
} from './client.js';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import {
  allowedSourcesOf,
  cidrKey,
  expandIpv6,
  legacyEntryFor,
  type DeviceAllowEntry,
} from '@agentbox/sandbox-core';
import { withDigitalOceanRetry } from './retry.js';

/**
 * A box firewall's SSH allowlist: the static policy part (`open` / whitelist)
 * plus one entry per machine. The SSH rule itself is the flat union. A
 * DigitalOcean rule has no description and a firewall carries at most 5 tags,
 * so the entries ride the DROPLET's tags (see {@link encodeDeviceTag}), which
 * every PC reading the box sees.
 */
export interface BoxFirewallSsh {
  staticSources: string[];
  entries: DeviceAllowEntry[];
}

export const DEVICE_TAG_PREFIX = 'abdev:';

/** The droplet facts a device-tag read/write needs. */
export interface DropletTagsRef {
  id: number;
  tags: string[];
}

/**
 * Short per-box discriminator for device tags, derived from the box's own tag.
 * DO tags are account-global; without it, two boxes repaired by the same
 * machine in the same second would share a tag, and deleting it on one box's
 * destroy would strip the other box's entry.
 */
export function firewallDiscriminator(boxTag: string): string {
  return createHash('sha256').update(boxTag).digest('hex').slice(0, 8);
}

/** The box's own tag on its firewall (the tag the droplet also carries). */
export function boxTagOf(fw: Pick<DigitalOceanFirewall, 'tags' | 'id'>): string {
  return fw.tags.find((t) => !t.startsWith(DEVICE_TAG_PREFIX)) ?? fw.id;
}

function encodeCidr(cidr: string): string | null {
  const [addr = '', lenRaw] = cidr.trim().split('/');
  if (isIPv4(addr)) {
    const hex = addr
      .split('.')
      .map((o) => Number.parseInt(o, 10).toString(16).padStart(2, '0'))
      .join('');
    return `4${hex}p${lenRaw ?? '32'}`;
  }
  const groups = expandIpv6(addr);
  if (!groups) return null;
  const len = Number.parseInt(lenRaw ?? '128', 10);
  const full = groups.map((g) => g.padStart(4, '0')).join('');
  return `6${full.slice(0, Math.max(1, Math.ceil(len / 4)))}p${String(len)}`;
}

function decodeCidr(enc: string): string | null {
  const m = /^([46])([0-9a-f]+)p(\d{1,3})$/.exec(enc);
  if (!m) return null;
  const [, fam, hex = '', len = ''] = m;
  if (fam === '4') {
    if (hex.length !== 8) return null;
    const octets = (hex.match(/../g) ?? []).map((x) => String(Number.parseInt(x, 16)));
    return `${octets.join('.')}/${len}`;
  }
  const groups = (hex.padEnd(32, '0').match(/.{4}/g) ?? []).map((g) =>
    Number.parseInt(g, 16).toString(16),
  );
  // Same shape `ipv6Prefix64` writes: the prefix's groups, then `::`.
  const n = Math.min(8, Math.max(1, Math.ceil(Number.parseInt(len, 10) / 16)));
  return `${groups.slice(0, n).join(':')}${n < 8 ? '::' : ''}/${len}`;
}

/**
 * `abdev:<disc>:<key>:<label|->:<seen>:<h|n>:<cidr>_<cidr>` — CIDRs
 * hex-encoded with a family digit and `p<prefix>`, because DO tags allow only
 * `[A-Za-z0-9_:-]`. Null when the entry can't be represented (a CIDR that
 * isn't IPv4/IPv6, or a tag over DO's 255-char limit).
 */
export function encodeDeviceTag(disc: string, e: DeviceAllowEntry): string | null {
  const cidrs = e.cidrs.map(encodeCidr);
  if (cidrs.length === 0 || cidrs.some((c) => c === null)) return null;
  const tag =
    `${DEVICE_TAG_PREFIX}${disc}:${e.key}:${e.label || '-'}:${String(e.seen)}:` +
    `${e.hub ? 'h' : 'n'}:${cidrs.join('_')}`;
  return tag.length <= 255 ? tag : null;
}

export function decodeDeviceTag(tag: string): DeviceAllowEntry | null {
  const m = /^abdev:[0-9a-f]{8}:([a-z0-9-]+):([a-z0-9-]+):(\d+):([hn]):([0-9a-fp_]+)$/.exec(tag);
  if (!m) return null;
  const cidrs = (m[5] as string).split('_').map(decodeCidr);
  if (cidrs.some((c) => c === null)) return null;
  return {
    key: m[1] as string,
    cidrs: cidrs as string[],
    seen: Number.parseInt(m[3] as string, 10),
    ...(m[4] === 'h' ? { hub: true } : {}),
    ...(m[2] !== '-' ? { label: m[2] as string } : {}),
  };
}

/** This box's device tags among a droplet's tags (other boxes' never match). */
function ownDeviceTags(dropletTags: readonly string[], disc: string): string[] {
  return dropletTags.filter((t) => t.startsWith(`${DEVICE_TAG_PREFIX}${disc}:`));
}

/**
 * Read a box back into static sources + device entries (from the droplet's
 * tags). SSH addresses no entry owns are static when they belong to the
 * policy; on a box written before device entries the rest (the creating host's
 * egress) becomes a `legacy` entry. Once any entry exists, every unowned
 * address is static, so a PC whose record lacks the whitelist doesn't demote it.
 */
export function decodeBoxFirewall(
  fw: Pick<DigitalOceanFirewall, 'tags' | 'id' | 'inbound_rules'>,
  dropletTags: readonly string[],
  policyStatic: readonly string[],
): BoxFirewallSsh {
  const disc = firewallDiscriminator(boxTagOf(fw));
  const entries = ownDeviceTags(dropletTags, disc)
    .map(decodeDeviceTag)
    .filter((e): e is DeviceAllowEntry => e !== null);
  const sources = sshSourcesOf(fw.inbound_rules);
  const owned = new Set(entries.flatMap((e) => e.cidrs).map(cidrKey));
  const unowned = sources.filter((s) => !owned.has(cidrKey(s)));
  if (entries.length > 0) return { staticSources: unowned, entries };
  const policySet = new Set(policyStatic.map(cidrKey));
  const legacy = legacyEntryFor(unowned, policyStatic);
  return {
    staticSources: unowned.filter((s) => policySet.has(cidrKey(s))),
    entries: legacy ? [legacy] : [],
  };
}

/** Every SSH source a firewall admits (all inbound tcp/22 rules). */
export function sshSourcesOf(rules: readonly DigitalOceanInboundRule[]): string[] {
  return [
    ...new Set(rules.filter((r) => r.ports === '22').flatMap((r) => r.sources.addresses ?? [])),
  ];
}

/**
 * `ssh` restricted to entries a tag can carry, with their tags. An entry that
 * can't be encoded is dropped from the rule too: written without its tag, its
 * addresses would read back as unowned static sources that no cap ever evicts.
 */
export function encodeBoxDevices(
  boxTag: string,
  ssh: BoxFirewallSsh,
): { ssh: BoxFirewallSsh; tags: string[] } {
  const disc = firewallDiscriminator(boxTag);
  const kept: DeviceAllowEntry[] = [];
  const tags: string[] = [];
  for (const e of ssh.entries) {
    const t = encodeDeviceTag(disc, e);
    if (t === null) continue;
    kept.push(e);
    tags.push(t);
  }
  return { ssh: { staticSources: ssh.staticSources, entries: kept }, tags };
}

/** Flat SSH source list of a decoded firewall. */
export function boxFirewallSources(fw: BoxFirewallSsh): string[] {
  return allowedSourcesOf(fw.entries, fw.staticSources);
}

async function createTags(client: DigitalOceanClient, tags: readonly string[]): Promise<void> {
  for (const t of tags) {
    await withDigitalOceanRetry(
      { method: 'createTag', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
      () => client.createTag(t),
    );
  }
}

/**
 * Build the SSH-only inbound rule for one or more source CIDRs. DigitalOcean's
 * `sources.addresses` is a list, so all allowed CIDRs ride a single tcp/22 rule
 * (host egress for `locked`, `0.0.0.0/0`+`::/0` for `open`, host egress + the
 * whitelist for `whitelist`). Accepts a bare string for back-compat callers.
 */
export function sshInboundRules(sources: string | string[]): DigitalOceanInboundRule[] {
  const addresses = Array.isArray(sources) ? sources : [sources];
  return [
    {
      protocol: 'tcp',
      ports: '22',
      sources: { addresses },
    },
  ];
}

/**
 * Inbound rules for a control-plane Droplet: SSH locked to the host's egress IP,
 * but HTTP(S) open to the world (cloud boxes from arbitrary IPs reach the plane,
 * and Caddy needs :80/:443 for the Let's Encrypt ACME challenge + serving). The
 * Next app's own port is never exposed — Caddy fronts it on the compose network.
 * Mirrors the Hetzner `controlPlaneInboundRules`.
 */
export function controlPlaneInboundRules(hostCidr: string): DigitalOceanInboundRule[] {
  const everywhere = { addresses: ['0.0.0.0/0', '::/0'] };
  return [
    { protocol: 'tcp', ports: '22', sources: { addresses: [hostCidr] } },
    { protocol: 'tcp', ports: '80', sources: everywhere },
    { protocol: 'tcp', ports: '443', sources: everywhere },
  ];
}

/**
 * Whether the firewall's allowed SSH sources need re-syncing to include the
 * current egress: true when the current egress isn't already allowed AND the
 * firewall isn't wide-open (`0.0.0.0/0`). Pure so the auto-sync decision on
 * `hub update` is unit-testable without the DigitalOcean API. Empty sources (no
 * SSH rule) counts as a mismatch worth syncing.
 */
export function firewallNeedsSync(
  allowedSources: readonly string[] | undefined,
  currentEgress: string,
): boolean {
  const list = allowedSources ?? [];
  if (list.includes('0.0.0.0/0')) return false;
  return !list.includes(currentEgress);
}

/**
 * Allow-all outbound rules. A DigitalOcean firewall with inbound rules but no
 * outbound rules blocks ALL egress — so we explicitly permit everything
 * outbound (the box needs to reach github / npm / pypi / the agentbox relay).
 * Egress locking is out of scope for the per-box SSH firewall.
 */
export function allowAllOutboundRules(): DigitalOceanOutboundRule[] {
  const everywhere = { addresses: ['0.0.0.0/0', '::/0'] };
  return [
    { protocol: 'tcp', ports: '1-65535', destinations: everywhere },
    { protocol: 'udp', ports: '1-65535', destinations: everywhere },
    // icmp takes no ports in DigitalOcean's API.
    { protocol: 'icmp', destinations: everywhere },
  ];
}

export interface CreateFirewallOptions {
  /** Human-readable name (visible in the DigitalOcean dashboard). Must be unique-ish. */
  name: string;
  /** The SSH allowlist the firewall is born with (static policy + device entries). */
  ssh: BoxFirewallSsh;
  /**
   * Per-box tag the firewall is bound to. The droplet is created with the
   * same tag so DigitalOcean auto-applies this firewall the moment the
   * droplet boots — no unprotected window.
   */
  tag: string;
}

/**
 * Provision a fresh per-box firewall bound to `opts.tag`, its SSH rule the
 * union of `opts.ssh`. Also creates the device tags, which the caller puts on
 * the droplet create (`deviceTags`) — a droplet can't be tagged before it
 * exists, and tagging it at create leaves no window without its entries.
 */
export async function createPerBoxFirewall(
  client: DigitalOceanClient,
  opts: CreateFirewallOptions,
): Promise<DigitalOceanFirewall & { deviceTags: string[] }> {
  // DigitalOcean rejects a firewall (or droplet) referencing a tag that does
  // not exist yet — the tag must be created first. Create it before the
  // firewall so the tag-bound auto-apply still happens with no unprotected
  // window (the droplet is created with the same tag later).
  const enc = encodeBoxDevices(opts.tag, opts.ssh);
  await createTags(client, [opts.tag, ...enc.tags]);
  const body: CreateFirewallRequest = {
    name: opts.name,
    inbound_rules: sshInboundRules(boxFirewallSources(enc.ssh)),
    outbound_rules: allowAllOutboundRules(),
    tags: [opts.tag],
  };
  const fw = await withDigitalOceanRetry(
    { method: 'createFirewall', retryOnAmbiguous: false, attemptTimeoutMs: 60_000 },
    () => client.createFirewall(body),
  );
  return { ...fw, deviceTags: enc.tags };
}

/**
 * Write `ssh` to a box: the firewall's SSH rule becomes the flat union and the
 * droplet's device tags for this box are replaced (new ones created and
 * applied first, so the entry exists before its address does; dropped ones
 * deleted afterwards, best-effort — they are unique to this box). The
 * firewall's name, attachments, box tag and outbound rules are preserved.
 */
export async function writeBoxFirewall(
  client: DigitalOceanClient,
  firewall: DigitalOceanFirewall,
  droplet: DropletTagsRef,
  ssh: BoxFirewallSsh,
): Promise<void> {
  const boxTag = boxTagOf(firewall);
  const enc = encodeBoxDevices(boxTag, ssh);
  const before = new Set(ownDeviceTags(droplet.tags, firewallDiscriminator(boxTag)));
  const added = enc.tags.filter((t) => !before.has(t));
  await createTags(client, added);
  for (const t of added) {
    await withDigitalOceanRetry(
      { method: 'tagDroplet', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
      () => client.tagDroplet(t, droplet.id),
    );
  }
  const body: CreateFirewallRequest = {
    name: firewall.name,
    inbound_rules: sshInboundRules(boxFirewallSources(enc.ssh)),
    outbound_rules: allowAllOutboundRules(),
    droplet_ids: firewall.droplet_ids,
    tags: firewall.tags,
  };
  await withDigitalOceanRetry(
    { method: 'updateFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.updateFirewall(firewall.id, body),
  );
  const after = new Set(enc.tags);
  for (const t of before) {
    if (!after.has(t)) await client.deleteTag(t).catch(() => undefined);
  }
}

/**
 * Find the per-box firewall for a droplet. DigitalOcean firewalls have no
 * server-side filter, so we list and match on either the explicit
 * `droplet_ids` attachment or an overlapping tag. Returns null if none.
 */
export async function findFirewallForDroplet(
  client: DigitalOceanClient,
  dropletId: number,
  dropletTags: string[],
): Promise<DigitalOceanFirewall | null> {
  const tagSet = new Set(dropletTags);
  const all = await client.listFirewalls();
  return (
    all.find(
      (fw) =>
        fw.droplet_ids.includes(dropletId) ||
        fw.tags.some((t) => !t.startsWith(DEVICE_TAG_PREFIX) && tagSet.has(t)),
    ) ?? null
  );
}

/**
 * Delete a per-box firewall. Idempotent on 404. DigitalOcean returns 409 /
 * `conflict` while the firewall is still detaching from a just-deleted
 * droplet, so we poll for a short window (default 60s) before giving up.
 */
export async function deletePerBoxFirewall(
  client: DigitalOceanClient,
  firewallId: string,
  opts: { detachWaitMs?: number; tags?: readonly string[] } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.detachWaitMs ?? 60_000);
  let interval = 1_000;
  // Delete the per-box tag(s) `createPerBoxFirewall` minted, once the firewall
  // (the last referencing resource) is gone — otherwise they leak as empty tags.
  // Best-effort: a failure here must not fail destroy. Never touches the shared
  // `agentbox` / `agentbox-prepare` tags (those aren't passed in — only the
  // unique per-box tag the firewall carried).
  const cleanupTags = async () => {
    for (const t of opts.tags ?? []) {
      try {
        await client.deleteTag(t);
      } catch {
        // best-effort — leaked tags are harmless (empty labels, no cost)
      }
    }
  };
  while (true) {
    try {
      await withDigitalOceanRetry(
        { method: 'deleteFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 30_000 },
        () => client.deleteFirewall(firewallId),
      );
      await cleanupTags();
      return;
    } catch (err) {
      if (
        err instanceof DigitalOceanApiError &&
        (err.statusCode === 404 || err.code === 'not_found')
      ) {
        await cleanupTags();
        return;
      }
      const stillAttached =
        err instanceof DigitalOceanApiError &&
        (err.statusCode === 409 || err.code === 'conflict' || err.code === 'resource_in_use');
      if (stillAttached && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        interval = Math.min(interval * 2, 8_000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Normalize a source spec into a CIDR. Accepts:
 *   - bare IPv4 → appends `/32`
 *   - bare IPv6 → appends `/128`
 *   - already-CIDR (anything with `/`) → returned as-is
 *
 * Whitespace is trimmed. Does **not** validate the address itself — that's
 * either the API's job or `detectEgressIp`'s job.
 */
export function normalizeSourceCidr(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('/')) return trimmed;
  if (trimmed.includes(':')) return `${trimmed}/128`;
  return `${trimmed}/32`;
}
