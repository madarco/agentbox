import { resolveBoxSize, type EffectiveConfig } from '@agentbox/config';

/** Per-create overrides from the CLI; each wins over the resolved config value. */
export interface CloudSizingFlags {
  /** `--size <spec>` */
  size?: string;
  /** `--location <name>` (hetzner / digitalocean / aws) */
  location?: string;
  /** `--inbound <spec>` (hetzner / digitalocean / aws) */
  inbound?: string;
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
  if (providerName === 'aws') {
    // AMIs are region-scoped, so this also decides which base AMI can boot.
    const location = (flags.location?.trim() || cfg.box.awsRegion || '').trim();
    if (location.length > 0) out.location = location;
    // Config-only (no flag): the escape hatch for an account with no default VPC.
    const subnetId = (cfg.box.awsSubnetId || '').trim();
    if (subnetId.length > 0) out.subnetId = subnetId;
    if (cfg.box.awsDiskGb > 0) out.diskGb = cfg.box.awsDiskGb;
  }
  // VPS-only inbound-access policy (`--inbound` / `box.inbound`). Passed through
  // to the backend's per-box firewall; other providers ignore it. Only emitted
  // when non-default — the backend treats an absent value as `locked`, so the
  // common case carries nothing.
  if (providerName === 'hetzner' || providerName === 'digitalocean' || providerName === 'aws') {
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
  return out;
}
