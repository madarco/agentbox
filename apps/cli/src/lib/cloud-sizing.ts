import { resolveBoxSize, type EffectiveConfig } from '@agentbox/config';

/** Per-create overrides from the CLI; each wins over the resolved config value. */
export interface CloudSizingFlags {
  /** `--size <spec>` */
  size?: string;
  /** `--location <name>` (hetzner only) */
  location?: string;
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
 * - **vercel**: `timeoutMs` (session length before auto-snapshot), `networkPolicy`.
 * - **e2b**: `timeoutMs` — the session timeout the box is created with (and
 *   records as `cloud.sessionTimeoutMs`, which seeds the host keepalive loop so
 *   it can push the deadline forward while the agent is working).
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
    const location = flags.location?.trim() || cfg.box.hetznerLocation;
    if (location.length > 0) out.location = location;
  }
  if (providerName === 'digitalocean') {
    const location = flags.location?.trim() || cfg.box.digitaloceanRegion;
    if (location.length > 0) out.location = location;
  }
  if (providerName === 'vercel') {
    out.timeoutMs = cfg.box.vercelTimeoutMs;
    out.networkPolicy = cfg.box.vercelNetworkPolicy;
  }
  if (providerName === 'e2b') {
    out.timeoutMs = cfg.box.e2bTimeoutMs;
  }
  return out;
}
