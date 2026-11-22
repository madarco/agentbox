import type { BoxRecord, Provider } from '@agentbox/core';
import { FIREWALL_PROVIDERS } from '@agentbox/sandbox-core';

export interface FirewallRepairOptions {
  /** When false, skip repair entirely (the `--no-firewall-sync` opt-out). */
  enabled: boolean;
  /** Surface what the repair did (e.g. "firewall updated: …"). */
  onLog: (line: string) => void;
}

/**
 * Run a connection-ESTABLISHMENT attempt with one self-heal retry: if it throws
 * and `provider.repairReachability` reports it changed something (today: this
 * machine's egress was missing from a hetzner/digitalocean box's per-device
 * firewall allowlist — a new IP, or a box first created from another PC — and
 * its own entry was added), retry once. The relay's egress watcher does the
 * same repair proactively on an IP change; this covers the gap before it runs.
 * When nothing changed (or repair is unsupported/disabled) the original error
 * is rethrown — a non-IP failure isn't masked.
 *
 * Use this ONLY at establish sites (`recover`, the initial attach connect),
 * never around a mid-session reconnect: a checkpoint stops the box and drops the
 * connection, and that must not be mistaken for an IP change.
 */
export async function withFirewallRepair<T>(
  provider: Provider,
  box: BoxRecord,
  opts: FirewallRepairOptions,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!opts.enabled || !provider.repairReachability) throw err;
    const repair = await provider.repairReachability(box).catch(() => null);
    if (!repair?.changed) throw err;
    opts.onLog(repair.detail ?? 'firewall synced to current egress IP');
    return await attempt();
  }
}

/**
 * The cheap ESTABLISH probe for a box behind a per-box firewall (hetzner,
 * digitalocean): a `true` over SSH, wrapped in {@link withFirewallRepair}, so a
 * machine that isn't allowed yet (a box created on another PC, or this
 * machine's IP changed) is added before the real work — a one-shot `shell`
 * command, an interactive attach, a `cp`. Over an already-open ControlMaster it
 * costs one round trip and touches no provider API. No-op for every other
 * provider. Never call it around a mid-session reconnect (see above).
 */
export async function ensureFirewallReach(
  provider: Provider,
  box: BoxRecord,
  opts: FirewallRepairOptions,
): Promise<void> {
  if (!FIREWALL_PROVIDERS.has(box.provider ?? '')) return;
  await withFirewallRepair(provider, box, opts, () => provider.exec(box, ['true']));
}
