import { resolveBoxSize, resolveDaytonaClass, type EffectiveConfig } from '@agentbox/config';
import { resolveProviderDescriptor } from '@agentbox/sandbox-core';

/**
 * `--size` / `--location`, declared once and added by `agentbox create` and the
 * agent commands (`claude`, `codex`, `opencode`, `pi`, `openclaw`), so the two
 * surfaces cannot drift.
 */
export const SIZE_OPTION = {
  flags: '--size <spec>',
  description:
    'VM size for cloud providers. Hetzner: server type (e.g. cx33). DigitalOcean: Droplet size slug (e.g. s-4vcpu-8gb). Daytona: cpu-mem-disk GB (e.g. 4-8-20). Vercel: vCPUs (1, 2, 4, 8). E2B: baked at prepare time. Overrides box.size / box.size<Provider>.',
} as const;

export const LOCATION_OPTION = {
  flags: '--location <name>',
  description:
    'Datacenter/region for the new box, on providers that have one. Hetzner: nbg1, fsn1, hel1, ash, hil, sin (overrides box.hetznerLocation; a --location given here pins the box, while a configured location fails over to another location in the same zone when Hetzner has no capacity). DigitalOcean: nyc3, sfo3, ams3, fra1, ... (overrides box.digitaloceanRegion). Also community providers that declare regions. Ignored, with a warning, on other providers.',
} as const;

/** `--size` / `--location` as typed (trimmed); a key is absent when not given. */
export function cloudSizingFlags(opts: { size?: unknown; location?: unknown }): {
  size?: string;
  location?: string;
} {
  const size = typeof opts.size === 'string' ? opts.size.trim() : '';
  const location = typeof opts.location === 'string' ? opts.location.trim() : '';
  return { ...(size ? { size } : {}), ...(location ? { location } : {}) };
}

/** True when `--location` means something for this provider. */
export function providerTakesLocation(providerName: string): boolean {
  if (providerName === 'hetzner' || providerName === 'digitalocean') return true;
  return (resolveProviderDescriptor(providerName)?.regions?.length ?? 0) > 0;
}

/** The warning for a `--location` this provider ignores, or null. */
export function locationIgnoredWarning(
  providerName: string,
  location: string | undefined,
): string | null {
  if (!location?.trim() || providerTakesLocation(providerName)) return null;
  return `--location applies to providers with datacenters/regions (hetzner, digitalocean); ignored for provider ${providerName}`;
}

/** Per-create overrides from the CLI; each wins over the resolved config value. */
export interface CloudSizingFlags {
  /** `--size <spec>` */
  size?: string;
  /** `--location <name>` (hetzner / digitalocean) */
  location?: string;
  /**
   * Whether `location` is a pin. Defaults to "a location flag was given"; the
   * queue worker passes it explicitly, since its `location` may be a replayed
   * configured value rather than a typed flag.
   */
  locationPinned?: boolean;
  /** `--inbound <spec>` (hetzner / digitalocean) */
  inbound?: string;
  /**
   * `--remote-host <dest>`, or the host half of a `docker:<host>` provider spec
   * (remote-docker). The flag wins; the caller resolves the spec.
   */
  remoteHost?: string;
}

/**
 * Per-provider sizing / session-lifetime overrides threaded through
 * `CreateBoxRequest.providerOptions`. The cloud scaffold
 * (`packages/sandbox-cloud/src/cloud-provider.ts`) reads these; providers that
 * don't recognise a key ignore it.
 *
 * - **all providers**: `size` — the generic VM-size string, `--size` flag first,
 *   else `box.size<Provider>` / `box.size`. Each backend interprets it natively
 *   (hetzner: server type; daytona: `cpu-mem-disk` GB; vercel: vCPU count;
 *   e2b: baked at prepare time; docker: ignored).
 * - **hetzner**: `location` — datacenter, `--location` flag first, else
 *   `box.hetznerLocation`.
 * - **digitalocean**: `location` — region, `--location` flag first, else
 *   `box.digitaloceanRegion`.
 * - **any provider with a location**: `locationPinned: true` when the location
 *   came from the `--location` flag rather than config. Hetzner fails over to
 *   another location on a capacity refusal unless pinned.
 * - **digitalocean**: `project` — the DO Project the box is placed in (name or
 *   UUID), from `box.digitaloceanProject`. Config-only, no flag. Absent = the
 *   account's default project.
 * - **hetzner, digitalocean**: `swap` — `box.swap` (`auto` | `off` | a size),
 *   config-only, emitted only when not `auto`.
 * - **any provider declaring `capabilities.inbound`** (hetzner + digitalocean
 *   today): `inbound` — per-box firewall access policy (`locked`/`open`/CIDR
 *   list), `--inbound` flag first, else `box.inbound`.
 * - **any provider declaring `regions`**: an explicit `--location`. The built-in
 *   arms above take precedence since they also read a per-provider config key;
 *   this is the flag-only path a community provider gets.
 * - **vercel**: `timeoutMs` (session length before auto-snapshot), `networkPolicy`.
 * - **e2b**: `timeoutMs` — the session timeout the box is created with (and
 *   records as `cloud.sessionTimeoutMs`, which seeds the host keepalive loop so
 *   it can push the deadline forward while the agent is working).
 * - **daytona**: `timeoutMs` (auto-stop inactivity window, same keepalive rail
 *   as e2b), `sandboxClass` (`linux-vm` | `container`) and `location` (region).
 *   `location` carries only an EXPLICIT `box.daytonaRegion` — the class-derived
 *   region (`linux-vm` ⇒ `us-east-1`, the only region with VM runners) is left
 *   to the backend, which derives it from the class it actually boots. That's
 *   the class the base snapshot was BAKED as, which is not always the one asked
 *   for.
 *
 * Shared by `agentbox create`, the agent-create commands (`claude` / `codex`
 * / `opencode`) and the queued-job worker so a box gets the same size and
 * lifetime regardless of how it was made.
 */
export function cloudSizingProviderOptions(
  providerName: string,
  cfg: EffectiveConfig,
  flags: CloudSizingFlags = {},
): Record<string, unknown> {
  const size = flags.size?.trim() || resolveBoxSize(cfg, providerName);
  const out: Record<string, unknown> = size.length > 0 ? { size } : {};
  const descriptor = resolveProviderDescriptor(providerName);
  if (providerName === 'hetzner') {
    const location = (flags.location?.trim() || cfg.box.hetznerLocation || '').trim();
    if (location.length > 0) out.location = location;
  }
  if (providerName === 'digitalocean') {
    const location = (flags.location?.trim() || cfg.box.digitaloceanRegion || '').trim();
    if (location.length > 0) out.location = location;
    // DigitalOcean Project (name or UUID). Config-only — there is no flag, since
    // "project" already means the host repo in AgentBox and the layered config
    // (workspace > project > global) already gives per-repo control. Absent = the
    // account's default project, which is DO's own behavior, so the common case
    // emits nothing.
    const project = (cfg.box.digitaloceanProject || '').trim();
    if (project.length > 0) out.project = project;
  }
  // Swap (`box.swap`), for the VPS providers that make it at boot. Only emitted
  // when not the default; the backend treats absent as `auto`.
  if (providerName === 'hetzner' || providerName === 'digitalocean') {
    const swap = (cfg.box.swap || '').trim();
    if (swap.length > 0 && swap.toLowerCase() !== 'auto') out.swap = swap;
  }
  // An explicit `--location` for a provider with no per-provider region config
  // key of its own — i.e. a community provider that declares `regions`. The
  // built-in arms above win because they also read their config key; this is the
  // flag-only path, so a plugin isn't silently denied a region it supports.
  if (out.location === undefined && descriptor?.regions?.length) {
    const location = flags.location?.trim() ?? '';
    if (location.length > 0) out.location = location;
  }
  // Per-box inbound-access policy (`--inbound` / `box.inbound`), for providers
  // whose backend implements `setInbound`. Passed through to the per-box
  // firewall; other providers ignore it. Only emitted when non-default — the
  // backend treats an absent value as `locked`, so the common case carries
  // nothing.
  if (descriptor?.capabilities.inbound) {
    const inbound = (flags.inbound?.trim() || cfg.box.inbound || '').trim();
    if (inbound.length > 0 && !/^lock(ed)?$/i.test(inbound)) out.inbound = inbound;
  }
  // A `--location` typed for this create is a pin: a backend that fails over on
  // a capacity refusal (hetzner) must not move the box. One from config or the
  // provider default carries no pin, so the backend may place it elsewhere.
  const pinned = flags.locationPinned ?? (flags.location?.trim() ?? '') !== '';
  if (typeof out.location === 'string' && (flags.location?.trim() ?? '') !== '' && pinned) {
    out.locationPinned = true;
  }
  if (providerName === 'vercel') {
    out.timeoutMs = cfg.box.vercelTimeoutMs;
    out.networkPolicy = cfg.box.vercelNetworkPolicy;
  }
  if (providerName === 'e2b') {
    out.timeoutMs = cfg.box.e2bTimeoutMs;
  }
  if (providerName === 'remote-docker') {
    // Which machine runs the container. Unlike every other provider's options
    // this one is mandatory — there is no sensible default engine — so resolve
    // it here and fail with a pointer rather than deep inside `provision`.
    const host = (flags.remoteHost?.trim() || cfg.box.remoteDockerHost || '').trim();
    if (host.length === 0) {
      throw new Error(
        'remote-docker needs an SSH destination: use `agentbox docker:<host> …`, pass `--remote-host <host>`, ' +
          'or set a default with `agentbox config set box.remoteDockerHost <user@host>`',
      );
    }
    out.remoteHost = host;
  }
  if (providerName === 'daytona') {
    // `timeoutMs` rides the same rail vercel/e2b use: cloud-provider records it
    // as `cloud.sessionTimeoutMs`, which seeds the host keepalive loop. Daytona
    // reads it as an *inactivity* window (auto-stop) rather than an absolute
    // TTL, so the loop's `refreshActivity` renewals hold a working box open and
    // only a genuinely idle one lapses.
    out.timeoutMs = cfg.box.daytonaTimeoutMs;
    out.sandboxClass = resolveDaytonaClass(cfg);
    // Only an EXPLICIT region, never the class-derived one. The backend derives
    // the region from the class it actually boots — which is the class the base
    // snapshot was BAKED as, not the one config asks for (they diverge whenever
    // a linux-vm bake fell back to a container). Pre-deriving `us-east-1` here
    // sent container-base lookups to the one region with no container runners,
    // where the snapshot reads as missing.
    const region = (cfg.box.daytonaRegion ?? '').trim();
    if (region.length > 0) out.location = region;
  }
  return out;
}
