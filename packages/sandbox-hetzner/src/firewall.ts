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

import { allowedSourcesOf, legacyEntryFor, type DeviceAllowEntry } from '@agentbox/sandbox-core';
import {
  HetznerApiError,
  type HetznerClient,
  type HetznerFirewall,
  type HetznerFirewallRule,
} from './client.js';
import { withHetznerRetry } from './retry.js';

const STATIC_RULE_DESCRIPTION = 'agentbox: SSH inbound';
const DEVICE_RULE_RE = /^agentbox-device key=([a-z0-9-]+) seen=(\d+)( hub)?$/;

/**
 * A box firewall's SSH rules split into the static policy part (`open` /
 * whitelist CIDRs, the `agentbox: SSH inbound` rule) and the per-device
 * entries (one rule each, metadata in the rule `description`, which every PC
 * reading the firewall sees).
 */
export interface BoxFirewallSsh {
  staticSources: string[];
  entries: DeviceAllowEntry[];
}

/** The description that carries a device entry's metadata on its rule. */
export function deviceRuleDescription(e: DeviceAllowEntry): string {
  return `agentbox-device key=${e.key} seen=${String(e.seen)}${e.hub ? ' hub' : ''}`;
}

/**
 * Read a box firewall's inbound tcp/22 rules back into static sources + device
 * entries. A rule with no device description is the static rule; on a firewall
 * written before per-device entries that rule also holds the creating host's
 * egress, so whatever in it is not part of `policyStatic` (the whitelist /
 * open CIDRs the box record knows about) becomes a `legacy` entry.
 */
export function decodeBoxFirewall(
  rules: readonly HetznerFirewallRule[],
  policyStatic: readonly string[],
): BoxFirewallSsh {
  const entries: DeviceAllowEntry[] = [];
  const unlabeled: string[] = [];
  for (const r of rules) {
    if (r.direction !== 'in' || r.port !== '22') continue;
    const m = DEVICE_RULE_RE.exec(r.description ?? '');
    if (m) {
      entries.push({
        key: m[1] as string,
        cidrs: r.source_ips ?? [],
        seen: Number.parseInt(m[2] as string, 10),
        ...(m[3] ? { hub: true } : {}),
      });
    } else {
      unlabeled.push(...(r.source_ips ?? []));
    }
  }
  // Once any device rule exists the firewall is in the per-device format, and
  // its unlabeled rule holds only policy sources — keep it whole, so a PC whose
  // record lacks the whitelist doesn't demote it to `legacy`.
  if (entries.length > 0) return { staticSources: [...new Set(unlabeled)], entries };
  const policySet = new Set(policyStatic);
  const staticSources = [...new Set(unlabeled.filter((s) => policySet.has(s)))];
  const legacy = legacyEntryFor(unlabeled, policyStatic);
  if (legacy) entries.push(legacy);
  return { staticSources, entries };
}

/** Every SSH source a firewall admits today (all inbound tcp/22 rules). */
export function sshSourcesOf(rules: readonly HetznerFirewallRule[]): string[] {
  return [
    ...new Set(
      rules
        .filter((r) => r.direction === 'in' && r.port === '22')
        .flatMap((r) => r.source_ips ?? []),
    ),
  ];
}

/**
 * Build a box firewall's rule set: one static rule (only when it has sources)
 * and one rule per device entry. Order is stable (static, then by key) so a
 * re-apply of the same set is a no-op diff in the dashboard.
 */
export function boxFirewallRules(fw: BoxFirewallSsh): HetznerFirewallRule[] {
  const rules: HetznerFirewallRule[] = [];
  if (fw.staticSources.length > 0) {
    rules.push({
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      source_ips: [...fw.staticSources],
      description: STATIC_RULE_DESCRIPTION,
    });
  }
  for (const e of [...fw.entries].sort((a, b) => a.key.localeCompare(b.key))) {
    if (e.cidrs.length === 0) continue;
    rules.push({
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      source_ips: [...e.cidrs],
      description: deviceRuleDescription(e),
    });
  }
  return rules;
}

/** Flat SSH source list of a decoded firewall. */
export function boxFirewallSources(fw: BoxFirewallSsh): string[] {
  return allowedSourcesOf(fw.entries, fw.staticSources);
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
  /** The SSH allowlist the firewall is born with (static policy + device entries). */
  ssh: BoxFirewallSsh;
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
  // retryOnAmbiguous: true — unlike a server/image create (billable, a hidden
  // success on retry duplicates a paid resource), a firewall is free and a
  // duplicate is a harmless, easily-reaped orphan. A transient 502/504/429 here
  // should not abort the whole box create.
  return withHetznerRetry(
    { method: 'createFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () =>
      client.createFirewall({
        name: opts.name,
        rules: boxFirewallRules(opts.ssh),
        labels: {
          'agentbox.managed': 'true',
          'agentbox.role': 'box',
          ...opts.labels,
        },
      }),
  );
}

/**
 * Replace a box firewall's rules with `ssh` (static policy + device entries).
 * Callers read the firewall, change only their own entry (or the static part),
 * and write the whole set back — the Hetzner API has no per-rule update.
 * No VPS restart involved; setting the same rules again is a no-op.
 */
export async function writeBoxFirewall(
  client: HetznerClient,
  firewallId: number,
  ssh: BoxFirewallSsh,
): Promise<void> {
  await withHetznerRetry(
    { method: 'setFirewallRules', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () => client.setFirewallRules(firewallId, boxFirewallRules(ssh)),
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
 * error) or `detectEgressIp`'s job (it only returns a valid IPv4).
 */
export function normalizeSourceCidr(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('/')) return trimmed;
  if (trimmed.includes(':')) return `${trimmed}/128`;
  return `${trimmed}/32`;
}
