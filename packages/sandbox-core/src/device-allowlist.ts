/**
 * The per-device SSH allowlist on a VPS box's firewall (hetzner, digitalocean).
 *
 * A box's firewall used to hold ONE host egress, rewritten by whichever machine
 * repaired it last, so attaching from a second PC locked the first one out. The
 * allowed set is now additive: every machine owns one entry, keyed by a stable
 * per-machine key, holding its own egress CIDRs. A machine only ever replaces
 * its own entry; the others are carried over untouched. The set is bounded by
 * {@link DEVICE_ALLOWLIST_CAP}: past it, the least recently written entries go
 * first. An entry written by the control box (`hub`) is never evicted, because
 * the hub must keep reaching the boxes it manages.
 *
 * The entries live ON the provider firewall (Hetzner rule descriptions,
 * DigitalOcean firewall tags), not host-side, so a second PC reading the box
 * sees who owns which address. Pure: the providers encode/decode and do the I/O.
 */

import { hostname } from 'node:os';
import { detectEgressCidr, detectEgressIpv6, type DetectEgressIpOptions } from './egress-ip.js';

export interface DeviceAllowEntry {
  /** Stable per-machine key (see {@link localMachineKey}). */
  key: string;
  /** That machine's egress CIDRs: an IPv4 `/32`, optionally an IPv6 `/64`. */
  cidrs: string[];
  /** When the owning machine last wrote the entry, epoch seconds. 0 = unknown. */
  seen: number;
  /** Written by the control box: never evicted by the cap. */
  hub?: boolean;
}

/** Most entries a box firewall keeps. */
export const DEVICE_ALLOWLIST_CAP = 10;

/** Key for addresses found on a firewall written before per-device entries. */
export const LEGACY_DEVICE_KEY = 'legacy';

/** Key for the admin PC CIDR a control box adds when it creates a box. */
export const ADMIN_DEVICE_KEY = 'admin';

/**
 * This machine's key on box firewalls. The single seam for machine identity:
 * once `getMachineId()` (`~/.agentbox/machine-id`) lands, return that here.
 * Until then it is the sanitized hostname, which means a renamed host (or a
 * macOS `-2` Bonjour suffix) writes a second entry and the old one ages out
 * through the cap rather than being replaced.
 */
export function localMachineKey(): string {
  return sanitizeDeviceKey(hostname()) || 'host';
}

/**
 * Restrict a key to `[a-z0-9-]`, at most 32 chars: it has to fit a Hetzner rule
 * description and a DigitalOcean tag (`[A-Za-z0-9_:-]`, where `:` is our
 * field separator).
 */
export function sanitizeDeviceKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** True when this process is the control box (its resident create worker is on). */
export function isControlBoxProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTBOX_HUB_WORKER === 'on';
}

/**
 * This machine's egress CIDRs for its firewall entry: the IPv4 `/32` (required,
 * throws like {@link detectEgressCidr}) plus the IPv6 `/64` when the host has
 * one. IPv4 only is enough to reach the box (it is dialled on its public IPv4);
 * the IPv6 prefix is added so a later dual-stack dial is not blocked.
 */
export async function detectDeviceCidrs(
  opts: Pick<DetectEgressIpOptions, 'onLog' | 'overrideHint'> = {},
): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    detectEgressCidr(opts),
    detectEgressIpv6({ onLog: opts.onLog }).catch(() => null),
  ]);
  return v6 ? [v4, v6] : [v4];
}

/** This machine's entry for the given egress CIDRs, stamped now. */
export function selfDeviceEntry(
  cidrs: string[],
  opts: { key?: string; nowSec?: number; hub?: boolean } = {},
): DeviceAllowEntry {
  const hub = opts.hub ?? isControlBoxProcess();
  return {
    key: opts.key ?? localMachineKey(),
    cidrs: dedupe(cidrs),
    seen: opts.nowSec ?? Math.floor(Date.now() / 1000),
    ...(hub ? { hub: true } : {}),
  };
}

/**
 * Put `self` into `entries`: its old entry (same key) is replaced, every other
 * key is kept as is, then the cap is applied. Eviction order: oldest `seen`
 * first, never `self` and never a `hub` entry. Returns a new array.
 */
export function upsertDeviceEntry(
  entries: readonly DeviceAllowEntry[],
  self: DeviceAllowEntry,
  cap: number = DEVICE_ALLOWLIST_CAP,
): DeviceAllowEntry[] {
  const others = entries.filter((e) => e.key !== self.key);
  const out = [...others, self];
  const evictable = others
    .filter((e) => !e.hub)
    .sort((a, b) => a.seen - b.seen || a.key.localeCompare(b.key));
  while (out.length > cap && evictable.length > 0) {
    const victim = evictable.shift();
    const i = out.indexOf(victim as DeviceAllowEntry);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/**
 * Whether this machine must (re)write its entry: true when it has none, or its
 * entry holds different CIDRs than `cidrs`. A firewall open to the world never
 * needs it.
 */
export function deviceEntryNeedsUpdate(
  entries: readonly DeviceAllowEntry[],
  staticSources: readonly string[],
  key: string,
  cidrs: readonly string[],
): boolean {
  if (staticSources.includes('0.0.0.0/0')) return false;
  const mine = entries.find((e) => e.key === key);
  if (!mine) return true;
  return !sameSet(mine.cidrs, cidrs);
}

/** The flat SSH source list a firewall rule set has to admit. */
export function allowedSourcesOf(
  entries: readonly DeviceAllowEntry[],
  staticSources: readonly string[],
): string[] {
  return dedupe([...staticSources, ...entries.flatMap((e) => e.cidrs)]);
}

/**
 * Attribute addresses on a firewall that carries no entries for them (one
 * written before per-device entries existed) to a single `legacy` entry with
 * `seen: 0`, so they survive the first rewrite but are the first to go once the
 * cap is reached. `known` = addresses already owned by the static policy or by
 * an entry.
 */
export function legacyEntryFor(
  sources: readonly string[],
  known: readonly string[],
): DeviceAllowEntry | null {
  const knownSet = new Set(known);
  const orphan = dedupe(sources.filter((s) => !knownSet.has(s)));
  return orphan.length > 0 ? { key: LEGACY_DEVICE_KEY, cidrs: orphan, seen: 0 } : null;
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}
