import type { BoxRecord, Provider } from '@agentbox/core';

export interface FirewallRepairOptions {
  /** When false, skip repair entirely (the `--no-firewall-sync` opt-out). */
  enabled: boolean;
  /** Surface what the repair did (e.g. "firewall updated: …"). */
  onLog: (line: string) => void;
}

/**
 * Run a connection-ESTABLISHMENT attempt with one self-heal retry: if it throws
 * and `provider.repairReachability` reports it changed something (today: a
 * Hetzner host egress-IP change that locked the per-box firewall), retry once.
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
