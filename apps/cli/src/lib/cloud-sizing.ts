import {
  resolveBoxSize,
  resolveDaytonaClass,
  type EffectiveConfig,
} from '@agentbox/config';

/** Per-create overrides from the CLI; each wins over the resolved config value. */
export interface CloudSizingFlags {
  /** `--size <spec>` */
  size?: string;
  /** `--location <name>` (hetzner / digitalocean) */
  location?: string;
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
 * - **digitalocean**: `project` — the DO Project the box is placed in (name or
 *   UUID), from `box.digitaloceanProject`. Config-only, no flag. Absent = the
 *   account's default project.
 * - **hetzner + digitalocean**: `inbound` — per-box firewall access policy
 *   (`locked`/`open`/CIDR list), `--inbound` flag first, else `box.inbound`.
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
  // VPS-only inbound-access policy (`--inbound` / `box.inbound`). Passed through
  // to the backend's per-box firewall; other providers ignore it. Only emitted
  // when non-default — the backend treats an absent value as `locked`, so the
  // common case carries nothing.
  if (providerName === 'hetzner' || providerName === 'digitalocean') {
    const inbound = (flags.inbound?.trim() || cfg.box.inbound || '').trim();
    if (inbound.length > 0 && !/^lock(ed)?$/i.test(inbound)) out.inbound = inbound;
  }
  if (providerName === 'vercel') {
    out.timeoutMs = cfg.box.vercelTimeoutMs;
    out.networkPolicy = cfg.box.vercelNetworkPolicy;
  }
  if (providerName === 'e2b') {
    out.timeoutMs = cfg.box.e2bTimeoutMs;
  }
  if (providerName === 'tenki') {
    // Session lifetime the box is created with (maps to Tenki's maxDurationMs)
    // and records as `cloud.sessionTimeoutMs` so the host keepalive loop can
    // push the deadline forward (via `session.extend`) while the agent works.
    out.timeoutMs = cfg.box.tenkiTimeoutMs;
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
