/**
 * Hetzner Cloud Firewall provisioning + drift sync.
 *
 * Defense-in-depth model (recapped from
 * ~/.claude/plans/how-to-safely-create-parallel-pebble.md §"The safety model"):
 *
 *   1. In-VPS services bind to loopback (the load-bearing layer).
 *   2. Hetzner Cloud Firewall locks SSH to the host's egress IP — applied
 *      here at provision time, before the VPS first boots. Everything else
 *      is denied inbound; outbound is unrestricted.
 *   3. sshd hardening (PasswordAuthentication no, AllowUsers vscode, …)
 *      written by cloud-init at first boot.
 *
 * Layer 2 is what this module provisions. The firewall is per-box (1:1 with
 * the VPS) so an egress-IP-drift on one box doesn't affect siblings, and a
 * destroy cleanly removes everything we created.
 */

import { HetznerApiError, type HetznerClient, type HetznerFirewall, type HetznerFirewallRule } from './client.js';
import { withHetznerRetry } from './retry.js';

/**
 * Build the SSH-only inbound rule for one or more source CIDRs. Hetzner's
 * `source_ips` is a list, so all allowed CIDRs ride a single tcp/22 rule (host
 * egress for `locked`, `0.0.0.0/0`+`::/0` for `open`, host egress + the
 * whitelist for `whitelist`). Outbound is left unrestricted (empty rules array
 * = "no inbound besides this one"). Accepts a bare string for back-compat.
 */
export function sshOnlyInboundRule(sources: string | string[]): HetznerFirewallRule[] {
  const source_ips = Array.isArray(sources) ? sources : [sources];
  return [
    {
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      source_ips,
      description: 'agentbox: SSH inbound',
    },
  ];
}

/**
 * Inbound rules for a control-plane VPS: SSH locked to the host's egress IP,
 * but HTTP(S) open to the world (cloud boxes from arbitrary IPs reach the plane,
 * and Caddy needs :80/:443 for the Let's Encrypt ACME challenge + serving). The
 * Next app's own port is never exposed — Caddy fronts it on the compose network.
 */
export function controlPlaneInboundRules(hostCidr: string): HetznerFirewallRule[] {
  return [
    {
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      source_ips: [hostCidr],
      description: 'agentbox control plane: SSH from host egress IP only',
    },
    {
      direction: 'in',
      protocol: 'tcp',
      port: '80',
      source_ips: ['0.0.0.0/0', '::/0'],
      description: 'agentbox control plane: HTTP (ACME challenge + redirect)',
    },
    {
      direction: 'in',
      protocol: 'tcp',
      port: '443',
      source_ips: ['0.0.0.0/0', '::/0'],
      description: 'agentbox control plane: HTTPS',
    },
  ];
}

export interface CreateFirewallOptions {
  /** Human-readable name persisted with the firewall (visible in the Hetzner dashboard). */
  name: string;
  /** Inbound source CIDRs (already normalized/resolved by the caller). */
  sources: string[];
  /** Labels merged onto the firewall (we always add `agentbox.managed=true`). */
  labels?: Record<string, string>;
}

/**
 * Provision a fresh per-box firewall locked to the given source CIDR.
 * Returns the created `HetznerFirewall` so the caller can persist
 * `firewallId` on the box record.
 */
export async function createPerBoxFirewall(
  client: HetznerClient,
  opts: CreateFirewallOptions,
): Promise<HetznerFirewall> {
  return withHetznerRetry(
    { method: 'createFirewall', retryOnAmbiguous: false, attemptTimeoutMs: 60_000 },
    () =>
      client.createFirewall({
        name: opts.name,
        rules: sshOnlyInboundRule(opts.sources),
        labels: {
          'agentbox.managed': 'true',
          'agentbox.role': 'box',
          ...opts.labels,
        },
      }),
  );
}

/**
 * Re-detect the egress IP and replace the firewall's rule set with the new
 * source. Used by `agentbox hetzner firewall sync <box>` after the host
 * laptop moves networks. Cheap operation — no VPS restart involved.
 *
 * Idempotent on the API: setting the same rules again is a no-op from the
 * user's point of view (the API still returns an action handle, but it
 * resolves instantly).
 */
export async function syncFirewallSource(
  client: HetznerClient,
  firewallId: number,
  sources: string | string[],
): Promise<void> {
  await withHetznerRetry(
    { method: 'setFirewallRules', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.setFirewallRules(firewallId, sshOnlyInboundRule(sources)),
  );
}

/**
 * Delete a per-box firewall. Idempotent on 404 (the API surfaces it as a
 * `not_found` error which the retry classifier won't retry; we swallow it
 * here so destroy paths don't need a special-case).
 *
 * Hetzner returns 409 `conflict` if the firewall is still attached to a
 * server when we try to delete it — `deleteServer()` returns as soon as the
 * delete action is *enqueued*, not after the server's firewall attachment
 * is torn down, so a quick subsequent `deleteFirewall()` will collide.
 * We poll for a short window (default 60s, intervals doubled to 8s) to
 * cover the typical 5–15s detach lag before giving up.
 */
export async function deletePerBoxFirewall(
  client: HetznerClient,
  firewallId: number,
  opts: { detachWaitMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.detachWaitMs ?? 60_000);
  let interval = 1_000;
  while (true) {
    try {
      await withHetznerRetry(
        { method: 'deleteFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 30_000 },
        () => client.deleteFirewall(firewallId),
      );
      return;
    } catch (err) {
      if (err instanceof HetznerApiError && (err.statusCode === 404 || err.code === 'not_found')) {
        return;
      }
      const stillAttached =
        err instanceof HetznerApiError &&
        (err.statusCode === 409 ||
          err.code === 'conflict' ||
          err.code === 'resource_in_use');
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
 * Whether the firewall's allowed SSH sources need re-syncing to include the
 * current egress: true when the current egress isn't already allowed AND the
 * firewall isn't wide-open (`0.0.0.0/0`, the `open` policy / dynamic-IP opt-in).
 * Pure so the hint + auto-sync decision is unit-testable without the Hetzner
 * API. Empty sources (no SSH rule) counts as a mismatch worth syncing. Accepts
 * a bare string for back-compat callers.
 */
export function firewallNeedsSync(
  allowedSources: string | string[] | undefined,
  currentEgress: string,
): boolean {
  const list = Array.isArray(allowedSources)
    ? allowedSources
    : allowedSources
      ? [allowedSources]
      : [];
  if (list.includes('0.0.0.0/0')) return false;
  return !list.includes(currentEgress);
}

/**
 * Normalize a source spec into a CIDR. Accepts:
 *   - bare IPv4 → appends `/32`
 *   - bare IPv6 → appends `/128`
 *   - already-CIDR (anything with `/`) → returned as-is
 *
 * Whitespace is trimmed. Does **not** validate the address itself — that's
 * either the API's job (it'll reject bad CIDRs with a clear `validation`
 * error) or `detectEgressIp`'s job (it only returns valid IPv4/IPv6).
 */
export function normalizeSourceCidr(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('/')) return trimmed;
  if (trimmed.includes(':')) return `${trimmed}/128`;
  return `${trimmed}/32`;
}
