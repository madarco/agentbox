/**
 * The per-device SSH allowlist on a VPS box's firewall (hetzner, digitalocean).
 *
 * A box's firewall used to hold ONE host egress, rewritten by whichever machine
 * repaired it last, so attaching from a second PC locked the first one out. The
 * allowed set is now additive: every machine owns one entry, keyed by a stable
 * per-machine key, holding its own egress CIDRs. A machine only ever replaces
 * its own entry; the others are carried over untouched. The set is bounded by
 * {@link DEVICE_ALLOWLIST_CAP}: past it, the least recently written entries go
 * first. The newest entry written by the control box (`hub`) is never evicted,
 * because the hub must keep reaching the boxes it manages.
 *
 * The entries live ON the provider (Hetzner rule descriptions, DigitalOcean
 * droplet tags), not host-side, so a second PC reading the box sees who owns
 * which address. Pure apart from {@link localMachineKey} and the detector: the
 * providers encode/decode and do the API I/O.
 */

import { getMachineId, getMachineLabel } from '@agentbox/config';
import {
  cidrKey,
  detectEgressCidr,
  detectEgressIpv6,
  type DetectEgressIpOptions,
} from './egress-ip.js';

export interface DeviceAllowEntry {
  /** Stable per-machine key (see {@link localMachineKey}). */
  key: string;
  /** That machine's egress CIDRs: an IPv4 `/32`, optionally an IPv6 `/64`. */
  cidrs: string[];
  /** When the owning machine last wrote the entry, epoch seconds. 0 = unknown. */
  seen: number;
  /**
   * Written by the control box: the newest such entry is never evicted by the
   * cap. Sticky: a non-hub writer on the same key (the CLI on a `hub expose`
   * Mac) keeps it.
   */
  hub?: boolean;
  /**
   * The CIDRs were set by hand (`AGENTBOX_<PROVIDER>_FIREWALL_SOURCE` at create,
   * `firewall sync --source`), not detected — e.g. a split-tunnel VPN. Automatic
   * repairs (the egress watcher, the connect-failure repair) leave a pinned
   * entry alone; only `firewall sync` without `--source` re-detects it.
   */
  pinned?: boolean;
  /** Human label (the sanitized hostname) for `firewall show`; not identity. */
  label?: string;
}

/** Most entries a box firewall keeps. */
export const DEVICE_ALLOWLIST_CAP = 10;

/** Key for addresses found on a firewall written before per-device entries. */
export const LEGACY_DEVICE_KEY = 'legacy';

/** Key for the admin PC CIDR a control box adds when it creates a box. */
export const ADMIN_DEVICE_KEY = 'admin';

/**
 * This machine's key on box firewalls: `getMachineId()` (`~/.agentbox/machine-id`,
 * the identity every other multi-PC record uses) without its hyphens — 32 hex
 * chars, which fits the `[a-z0-9-]{1,32}` a Hetzner description and a
 * DigitalOcean tag field allow. Throws like `getMachineId()` when no id can be
 * read or minted (an unwritable `$HOME`): a firewall write under a made-up key
 * would add a new entry on every run. The hostname rides along as a label only.
 *
 * Entries written under an earlier key (a hostname, or a `~/.agentbox/device-key`
 * id from before the machine id) are not migrated: this machine writes a fresh
 * entry and the old one ages out through the cap like any stale entry.
 */
export function localMachineKey(): string {
  return getMachineId().replace(/-/g, '');
}

/** The label shown next to this machine's entry. */
export function localMachineLabel(): string {
  return sanitizeDeviceKey(getMachineLabel()).slice(0, 24).replace(/-+$/, '') || 'host';
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

/**
 * True for a world-open CIDR (`0.0.0.0/0`, `::/0`). Such a source is the
 * `open` policy, never a machine: it must not land in a device or `legacy`
 * entry, where `inbound locked` would not remove it.
 */
export function isOpenCidr(cidr: string): boolean {
  const k = cidrKey(cidr);
  return k === '0.0.0.0/0' || k === cidrKey('::/0');
}

/**
 * Normalize a decoded firewall: open CIDRs are moved out of entries into the
 * static part (whatever wrote them, e.g. the old `firewall sync --source
 * 0.0.0.0/0` opt-in), and entries left with no CIDR are dropped. Providers run
 * every decode through this.
 */
export function normalizeDecoded<
  T extends { staticSources: string[]; entries: DeviceAllowEntry[] },
>(fw: T): T {
  const opened: string[] = [];
  const entries: DeviceAllowEntry[] = [];
  for (const e of fw.entries) {
    const open = e.cidrs.filter(isOpenCidr);
    opened.push(...open);
    const rest = e.cidrs.filter((c) => !isOpenCidr(c));
    if (rest.length > 0) entries.push(open.length > 0 ? { ...e, cidrs: rest } : e);
  }
  return { ...fw, staticSources: dedupe([...fw.staticSources, ...opened]), entries };
}

/**
 * The rule set for a new inbound policy (`agentbox inbound`): the static part
 * becomes exactly the policy's, and everything not owned by a real machine is
 * dropped — `legacy` included, so a world-open or whitelisted address carried
 * over from an old firewall cannot survive `inbound locked`. Device entries
 * (other machines) are kept; `self`, when given, is upserted.
 */
export function withInboundPolicy<
  T extends { staticSources: string[]; entries: DeviceAllowEntry[] },
>(fw: T, policyStatic: readonly string[], self?: DeviceAllowEntry): T {
  const kept = fw.entries.filter((e) => e.key !== LEGACY_DEVICE_KEY);
  return {
    ...fw,
    staticSources: [...policyStatic],
    entries: self ? upsertDeviceEntry(kept, self) : kept,
  };
}

/**
 * The create-time allowlist for this machine: with a hand-set source
 * (`AGENTBOX_<PROVIDER>_FIREWALL_SOURCE`) a `pinned` entry — or, for a
 * world-open source, no entry and the source as static (that is the `open`
 * opt-in, not a machine); without one, a detected entry.
 */
export async function createTimeSelf(
  override: string | undefined,
  detect: () => Promise<string[]>,
  opts: { key?: string } = {},
): Promise<{ entries: DeviceAllowEntry[]; extraStatic: string[] }> {
  const raw = override?.trim();
  if (raw) {
    const cidr = raw.includes('/') ? raw : raw.includes(':') ? `${raw}/128` : `${raw}/32`;
    if (isOpenCidr(cidr)) return { entries: [], extraStatic: [cidr] };
    return { entries: [selfDeviceEntry([cidr], { ...opts, pinned: true })], extraStatic: [] };
  }
  return { entries: [selfDeviceEntry(await detect(), opts)], extraStatic: [] };
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
  opts: { key?: string; nowSec?: number; hub?: boolean; label?: string; pinned?: boolean } = {},
): DeviceAllowEntry {
  const hub = opts.hub ?? isControlBoxProcess();
  return {
    key: opts.key ?? localMachineKey(),
    cidrs: dedupe(cidrs),
    seen: opts.nowSec ?? Math.floor(Date.now() / 1000),
    ...(hub ? { hub: true } : {}),
    ...(opts.pinned ? { pinned: true } : {}),
    label: opts.label ?? localMachineLabel(),
  };
}

/**
 * Put `self` into `entries`: its old entry (same key) is replaced, every other
 * key is kept as is, then the cap is applied. Eviction order: oldest `seen`
 * first, never `self` and never the NEWEST `hub` entry. A box answers to one
 * control box, so an older `hub` entry is that control box under a previous key
 * (before the machine id) and ages out like any stale entry instead of being
 * protected forever. A `hub` flag already on the old entry is kept (sticky;
 * pass `clearHub` to drop it on purpose). Returns a new array.
 */
export function upsertDeviceEntry(
  entries: readonly DeviceAllowEntry[],
  self: DeviceAllowEntry,
  cap: number = DEVICE_ALLOWLIST_CAP,
  opts: { clearHub?: boolean } = {},
): DeviceAllowEntry[] {
  const prev = entries.find((e) => e.key === self.key);
  const mine = prev?.hub && !self.hub && !opts.clearHub ? { ...self, hub: true } : self;
  const others = entries.filter((e) => e.key !== self.key);
  const out = [...others, mine];
  const hubs = out.filter((e) => e.hub);
  const currentHub = hubs.reduce<DeviceAllowEntry | undefined>(
    (best, e) => (best && best.seen >= e.seen ? best : e),
    undefined,
  );
  const evictable = others
    .filter((e) => e !== currentHub)
    .sort((a, b) => a.seen - b.seen || a.key.localeCompare(b.key));
  while (out.length > cap && evictable.length > 0) {
    const victim = evictable.shift();
    const i = out.indexOf(victim as DeviceAllowEntry);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/**
 * Whether an automatic repair must (re)write this machine's entry: it has none;
 * its IPv4 set differs; the probe found an IPv6 prefix the entry lacks; or the
 * control box finds its entry without the `hub` flag. A probe that found NO
 * IPv6 does not count as a change — the IPv6 probe is best-effort, and a flaky
 * miss must not rewrite every firewall. Never for a world-open firewall, and
 * never for a `pinned` entry (a hand-set source the user chose over detection).
 * A non-hub writer finding `hub` set is not a change: the flag is sticky.
 */
export function deviceEntryNeedsUpdate(
  entries: readonly DeviceAllowEntry[],
  staticSources: readonly string[],
  key: string,
  cidrs: readonly string[],
  hub: boolean = isControlBoxProcess(),
): boolean {
  if (staticSources.some(isOpenCidr)) return false;
  const mine = entries.find((e) => e.key === key);
  if (!mine) return true;
  if (mine.pinned) return false;
  if (hub && !mine.hub) return true;
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

/** Providers whose boxes carry a per-box firewall pinned to host egress IPs. */
export const FIREWALL_PROVIDERS: ReadonlySet<string> = new Set(['hetzner', 'digitalocean']);

/**
 * The explanation appended to an SSH connect failure when the box firewall is
 * what blocks this machine, or null when this machine's egress is allowed (the
 * failure is something else — leave the original error alone). Three cases,
 * each with the fix that actually works for it:
 *   - no entry for this machine: it was never added (the box came from another
 *     PC) — `firewall sync` / `recover` adds it;
 *   - an entry pinned to a hand-set source: `recover` would leave it alone, so
 *     only `firewall sync` (no `--source`) re-detects and unpins it;
 *   - an entry with a different address: this machine's IP changed.
 */
export function firewallBlockedHint(o: {
  provider: string;
  boxRef: string;
  entries: readonly DeviceAllowEntry[];
  staticSources: readonly string[];
  key: string;
  currentEgress: string;
}): string | null {
  const allowed = allowedSourcesOf(o.entries, o.staticSources);
  if (allowed.some(isOpenCidr)) return null;
  if (allowed.some((c) => cidrKey(c) === cidrKey(o.currentEgress))) return null;
  const sync = `agentbox ${o.provider} firewall sync ${o.boxRef}`;
  const list = allowed.join(', ') || '(nothing)';
  const mine = o.entries.find((e) => e.key === o.key);
  if (!mine) {
    return (
      `${o.provider}: SSH is blocked by the box firewall — this machine is not allowed on it yet ` +
      `(it allows ${list}; this machine's egress is ${o.currentEgress}). ` +
      `The box was likely created or last opened from another machine. Add this machine with:\n` +
      `  ${sync}\n(or \`agentbox recover ${o.boxRef}\`, which adds it too).`
    );
  }
  if (mine.pinned) {
    return (
      `${o.provider}: SSH is blocked by the box firewall — this machine's entry is pinned to ` +
      `${mine.cidrs.join(', ')} (set by hand with --source), but its egress is now ${o.currentEgress}. ` +
      `Automatic repairs leave a pinned entry alone; re-detect this machine's address and unpin it with:\n` +
      `  ${sync}`
    );
  }
  return (
    `${o.provider}: SSH is blocked by the box firewall — this machine's entry allows ` +
    `${mine.cidrs.join(', ')}, but its egress IP is now ${o.currentEgress}. Your IP changed; run:\n` +
    `  ${sync}\n(or \`agentbox recover ${o.boxRef}\`, which auto-syncs).`
  );
}

/**
 * What a repair did, worded for the user (`recover`, attach, `shell` print it).
 * `changed` is true only when this call wrote the firewall. An unchanged result
 * still carries a `detail` saying why — already allowed (possibly by the relay's
 * egress watcher a moment earlier), pinned, or world-open — so a caller can
 * always report the outcome instead of staying silent.
 */
export function repairOutcome(o: {
  entries: readonly DeviceAllowEntry[];
  staticSources: readonly string[];
  key: string;
  cidrs: readonly string[];
  wrote: boolean;
}): { changed: boolean; detail: string } {
  const n = o.entries.length;
  const mine = o.entries.find((e) => e.key === o.key);
  const who = `this machine (${mine?.label ? `${mine.label}, ` : ''}${o.key.slice(0, 8)})`;
  if (o.wrote) {
    return {
      changed: true,
      detail: `firewall updated: SSH allowed from ${who} at ${o.cidrs.join(', ')} (${String(n)} device entr${n === 1 ? 'y' : 'ies'})`,
    };
  }
  if (o.staticSources.some(isOpenCidr)) {
    return { changed: false, detail: 'firewall: open to the world (inbound open); nothing to add' };
  }
  if (mine?.pinned) {
    return {
      changed: false,
      detail: `firewall: ${who} is pinned to ${mine.cidrs.join(', ')} (set with --source); left as is — \`firewall sync <box>\` re-detects and unpins it`,
    };
  }
  return {
    changed: false,
    detail: `firewall: ${who} is already allowed at ${(mine?.cidrs ?? o.cidrs).join(', ')}`,
  };
}
