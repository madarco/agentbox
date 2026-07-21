/**
 * DigitalOcean Cloud Firewall provisioning + drift sync.
 *
 * Defense-in-depth model (mirrors the Hetzner provider's safety model):
 *
 *   1. In-VPS services bind to loopback (the load-bearing layer).
 *   2. DigitalOcean Cloud Firewall locks SSH to the host's egress IP — created
 *      here at provision time *before* the droplet boots and attached to it
 *      via a unique per-box tag, so there is never an unprotected window.
 *      Everything else is denied inbound.
 *   3. sshd hardening (PasswordAuthentication no, AllowUsers vscode, …)
 *      written by cloud-init at first boot.
 *
 * Two DigitalOcean-specific wrinkles vs. Hetzner:
 *   - Firewall ids are UUID strings, not numbers.
 *   - A DO firewall with *only* inbound rules blocks ALL egress. We must add
 *     explicit allow-all outbound rules or the box can't `git clone` / `npm i`.
 *
 * The firewall is per-box (1:1 with the droplet) so an egress-IP drift on one
 * box doesn't affect siblings, and a destroy cleanly removes everything.
 */

import {
  DigitalOceanApiError,
  type CreateFirewallRequest,
  type DigitalOceanClient,
  type DigitalOceanFirewall,
  type DigitalOceanInboundRule,
  type DigitalOceanOutboundRule,
} from './client.js';
import { withDigitalOceanRetry } from './retry.js';

/**
 * Build the SSH-only inbound rule for one or more source CIDRs. DigitalOcean's
 * `sources.addresses` is a list, so all allowed CIDRs ride a single tcp/22 rule
 * (host egress for `locked`, `0.0.0.0/0`+`::/0` for `open`, host egress + the
 * whitelist for `whitelist`). Accepts a bare string for back-compat callers.
 */
export function sshInboundRules(sources: string | string[]): DigitalOceanInboundRule[] {
  const addresses = Array.isArray(sources) ? sources : [sources];
  return [
    {
      protocol: 'tcp',
      ports: '22',
      sources: { addresses },
    },
  ];
}

/**
 * Allow-all outbound rules. A DigitalOcean firewall with inbound rules but no
 * outbound rules blocks ALL egress — so we explicitly permit everything
 * outbound (the box needs to reach github / npm / pypi / the agentbox relay).
 * Egress locking is out of scope for the per-box SSH firewall.
 */
export function allowAllOutboundRules(): DigitalOceanOutboundRule[] {
  const everywhere = { addresses: ['0.0.0.0/0', '::/0'] };
  return [
    { protocol: 'tcp', ports: '1-65535', destinations: everywhere },
    { protocol: 'udp', ports: '1-65535', destinations: everywhere },
    // icmp takes no ports in DigitalOcean's API.
    { protocol: 'icmp', destinations: everywhere },
  ];
}

export interface CreateFirewallOptions {
  /** Human-readable name (visible in the DigitalOcean dashboard). Must be unique-ish. */
  name: string;
  /** Inbound source CIDRs (already normalized/resolved by the caller). */
  sources: string[];
  /**
   * Per-box tag the firewall is bound to. The droplet is created with the
   * same tag so DigitalOcean auto-applies this firewall the moment the
   * droplet boots — no unprotected window.
   */
  tag: string;
}

/**
 * Provision a fresh per-box firewall locked to the given source CIDR and
 * bound to `opts.tag`. Returns the created `DigitalOceanFirewall` (its `id`
 * is a UUID string).
 */
export async function createPerBoxFirewall(
  client: DigitalOceanClient,
  opts: CreateFirewallOptions,
): Promise<DigitalOceanFirewall> {
  // DigitalOcean rejects a firewall (or droplet) referencing a tag that does
  // not exist yet — the tag must be created first. Create it before the
  // firewall so the tag-bound auto-apply still happens with no unprotected
  // window (the droplet is created with the same tag later).
  await withDigitalOceanRetry(
    { method: 'createTag', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.createTag(opts.tag),
  );
  const body: CreateFirewallRequest = {
    name: opts.name,
    inbound_rules: sshInboundRules(opts.sources),
    outbound_rules: allowAllOutboundRules(),
    tags: [opts.tag],
  };
  return withDigitalOceanRetry(
    { method: 'createFirewall', retryOnAmbiguous: false, attemptTimeoutMs: 60_000 },
    () => client.createFirewall(body),
  );
}

/**
 * Re-detect the egress IP and replace the firewall's inbound rule with the
 * new source (preserving its name, tags, droplet attachments, and the
 * allow-all outbound rules). Used by `agentbox digitalocean firewall sync
 * <box>` after the host laptop moves networks. Cheap — no droplet restart.
 */
export async function syncFirewallSource(
  client: DigitalOceanClient,
  firewall: DigitalOceanFirewall,
  sources: string | string[],
): Promise<void> {
  const body: CreateFirewallRequest = {
    name: firewall.name,
    inbound_rules: sshInboundRules(sources),
    outbound_rules: allowAllOutboundRules(),
    droplet_ids: firewall.droplet_ids,
    tags: firewall.tags,
  };
  await withDigitalOceanRetry(
    { method: 'updateFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.updateFirewall(firewall.id, body),
  );
}

/**
 * Find the per-box firewall for a droplet. DigitalOcean firewalls have no
 * server-side filter, so we list and match on either the explicit
 * `droplet_ids` attachment or an overlapping tag. Returns null if none.
 */
export async function findFirewallForDroplet(
  client: DigitalOceanClient,
  dropletId: number,
  dropletTags: string[],
): Promise<DigitalOceanFirewall | null> {
  const tagSet = new Set(dropletTags);
  const all = await client.listFirewalls();
  return (
    all.find(
      (fw) =>
        fw.droplet_ids.includes(dropletId) || fw.tags.some((t) => tagSet.has(t)),
    ) ?? null
  );
}

/**
 * Delete a per-box firewall. Idempotent on 404. DigitalOcean returns 409 /
 * `conflict` while the firewall is still detaching from a just-deleted
 * droplet, so we poll for a short window (default 60s) before giving up.
 */
export async function deletePerBoxFirewall(
  client: DigitalOceanClient,
  firewallId: string,
  opts: { detachWaitMs?: number; tags?: readonly string[] } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.detachWaitMs ?? 60_000);
  let interval = 1_000;
  // Delete the per-box tag(s) `createPerBoxFirewall` minted, once the firewall
  // (the last referencing resource) is gone — otherwise they leak as empty tags.
  // Best-effort: a failure here must not fail destroy. Never touches the shared
  // `agentbox` / `agentbox-prepare` tags (those aren't passed in — only the
  // unique per-box tag the firewall carried).
  const cleanupTags = async () => {
    for (const t of opts.tags ?? []) {
      try {
        await client.deleteTag(t);
      } catch {
        // best-effort — leaked tags are harmless (empty labels, no cost)
      }
    }
  };
  while (true) {
    try {
      await withDigitalOceanRetry(
        { method: 'deleteFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 30_000 },
        () => client.deleteFirewall(firewallId),
      );
      await cleanupTags();
      return;
    } catch (err) {
      if (err instanceof DigitalOceanApiError && (err.statusCode === 404 || err.code === 'not_found')) {
        await cleanupTags();
        return;
      }
      const stillAttached =
        err instanceof DigitalOceanApiError &&
        (err.statusCode === 409 || err.code === 'conflict' || err.code === 'resource_in_use');
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
 * Normalize a source spec into a CIDR. Accepts:
 *   - bare IPv4 → appends `/32`
 *   - bare IPv6 → appends `/128`
 *   - already-CIDR (anything with `/`) → returned as-is
 *
 * Whitespace is trimmed. Does **not** validate the address itself — that's
 * either the API's job or `detectEgressIp`'s job.
 */
export function normalizeSourceCidr(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('/')) return trimmed;
  if (trimmed.includes(':')) return `${trimmed}/128`;
  return `${trimmed}/32`;
}
