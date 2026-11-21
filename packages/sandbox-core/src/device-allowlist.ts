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
 * The entries live ON the provider (Hetzner rule descriptions, DigitalOcean
 * droplet tags), not host-side, so a second PC reading the box sees who owns
 * which address. Pure apart from {@link localMachineKey} and the detector: the
 * providers encode/decode and do the API I/O.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  cidrKey,
  detectEgressCidr,
  detectEgressIpv6,
  type DetectEgressIpOptions,
} from './egress-ip.js';
import { STATE_DIR } from './state.js';

export interface DeviceAllowEntry {
  /** Stable per-machine key (see {@link localMachineKey}). */
  key: string;
  /** That machine's egress CIDRs: an IPv4 `/32`, optionally an IPv6 `/64`. */
  cidrs: string[];
  /** When the owning machine last wrote the entry, epoch seconds. 0 = unknown. */
  seen: number;
  /** Written by the control box: never evicted by the cap. */
  hub?: boolean;
  /** Human label (the sanitized hostname) for `firewall show`; not identity. */
  label?: string;
}

/** Most entries a box firewall keeps. */
export const DEVICE_ALLOWLIST_CAP = 10;

/** Key for addresses found on a firewall written before per-device entries. */
export const LEGACY_DEVICE_KEY = 'legacy';

/** Key for the admin PC CIDR a control box adds when it creates a box. */
export const ADMIN_DEVICE_KEY = 'admin';

export const DEVICE_KEY_FILE = join(STATE_DIR, 'device-key');

/**
 * This machine's key on box firewalls. The single seam for machine identity:
 * once `getMachineId()` (`~/.agentbox/machine-id`, branch `feat/machine-id`)
 * lands, derive the key from it here and nothing else changes.
 *
 * Until then: a random id minted once into `~/.agentbox/device-key`. Not the
 * hostname — two Macs both named `MacBook-Pro` would share a key and replace
 * each other's entry, and macOS hostnames flip (`-2` suffix, DHCP names),
 * which would pile up entries. The hostname rides along as a label only.
 */
export function localMachineKey(file: string = DEVICE_KEY_FILE): string {
  try {
    const existing = sanitizeDeviceKey(readFileSync(file, 'utf8'));
    if (existing) return existing;
  } catch {
    // first use on this machine
  }
  const minted = randomBytes(6).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, minted + '\n', { mode: 0o600 });
  } catch {
    // unwritable home: the key is per-process then, and the extra entry ages out
  }
  return minted;
}

/** The label shown next to this machine's entry. */
export function localMachineLabel(): string {
  return sanitizeDeviceKey(hostname()).slice(0, 24).replace(/-+$/, '') || 'host';
}

/**
 * Restrict a key/label to `[a-z0-9-]`, at most 32 chars: it has to fit a
 * Hetzner rule description and a DigitalOcean tag (`[A-Za-z0-9_:-]`, where `:`
 * is our field separator).
 */
export function sanitizeDeviceKey(raw: string): string {
  return raw
    .trim()
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

const DETECT_MEMO_MS = 15_000;
let detectMemo: { at: number; cidrs: string[] } | null = null;

/**
 * This machine's egress CIDRs for its firewall entry: the IPv4 `/32` (required,
 * throws like {@link detectEgressCidr}) plus the IPv6 `/64` when the host has
 * one. IPv4 alone reaches the box (it is dialled on its public IPv4); the IPv6
 * prefix is added so a later dual-stack dial is not blocked.
 *
 * Memoized for a few seconds so the egress watcher's probe is reused by the
 * per-box repairs it triggers right after, instead of probing once per box.
 */
export async function detectDeviceCidrs(
  opts: Pick<DetectEgressIpOptions, 'onLog' | 'overrideHint'> & { fresh?: boolean } = {},
): Promise<string[]> {
  if (!opts.fresh && detectMemo && Date.now() - detectMemo.at < DETECT_MEMO_MS) {
    return [...detectMemo.cidrs];
  }
  const [v4, v6] = await Promise.all([
    detectEgressCidr(opts),
    detectEgressIpv6({ onLog: opts.onLog }).catch(() => null),
  ]);
  const cidrs = v6 ? [v4, v6] : [v4];
  detectMemo = { at: Date.now(), cidrs };
  return [...cidrs];
}

/** The IPv4 CIDRs of a list — what decides reachability (boxes are dialled on IPv4). */
export function ipv4Cidrs(cidrs: readonly string[]): string[] {
  return cidrs.filter((c) => !c.includes(':'));
}

/** This machine's entry for the given egress CIDRs, stamped now. */
export function selfDeviceEntry(
  cidrs: string[],
  opts: { key?: string; nowSec?: number; hub?: boolean; label?: string } = {},
): DeviceAllowEntry {
  const hub = opts.hub ?? isControlBoxProcess();
  return {
    key: opts.key ?? localMachineKey(),
    cidrs: dedupe(cidrs),
    seen: opts.nowSec ?? Math.floor(Date.now() / 1000),
    ...(hub ? { hub: true } : {}),
    label: opts.label ?? localMachineLabel(),
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
 * Whether this machine must (re)write its entry: it has none; its IPv4 set
 * differs; the probe found an IPv6 prefix the entry lacks; or its `hub` flag is
 * wrong. A probe that found NO IPv6 does not count as a change — the IPv6 probe
 * is best-effort, and a flaky miss must not rewrite every firewall. A firewall
 * open to the world never needs it.
 */
export function deviceEntryNeedsUpdate(
  entries: readonly DeviceAllowEntry[],
  staticSources: readonly string[],
  key: string,
  cidrs: readonly string[],
  hub: boolean = isControlBoxProcess(),
): boolean {
  if (staticSources.includes('0.0.0.0/0')) return false;
  const mine = entries.find((e) => e.key === key);
  if (!mine) return true;
  if (Boolean(mine.hub) !== hub) return true;
  if (!sameSet(ipv4Cidrs(mine.cidrs), ipv4Cidrs(cidrs))) return true;
  const have = new Set(mine.cidrs.map(cidrKey));
  return cidrs.some((c) => c.includes(':') && !have.has(cidrKey(c)));
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
  const knownSet = new Set(known.map(cidrKey));
  const orphan = dedupe(sources.filter((s) => !knownSet.has(cidrKey(s))));
  return orphan.length > 0 ? { key: LEGACY_DEVICE_KEY, cidrs: orphan, seen: 0 } : null;
}

function dedupe(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = cidrKey(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a.map(cidrKey));
  const sb = new Set(b.map(cidrKey));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}
