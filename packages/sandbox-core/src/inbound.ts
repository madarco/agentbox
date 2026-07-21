/**
 * Provider-neutral parsing/resolution for the `--inbound` / `box.inbound`
 * surface — the per-box firewall inbound-access policy shared by the VPS
 * backends (hetzner, digitalocean). Pure (no network); the backend supplies the
 * detected host-egress CIDR.
 *
 * Modes:
 *   - `locked` (default) — SSH reachable only from the host's egress IP.
 *   - `open`            — SSH reachable from anywhere (0.0.0.0/0 + ::/0). For
 *                         driving a box from a phone / other device with the
 *                         laptop off. sshd is key-only (baked hardening), so
 *                         this is the standard hardened-VPS posture.
 *   - `whitelist`       — the host egress IP PLUS explicit CIDRs.
 *
 * The persisted `InboundPolicy.sources` holds only the extra whitelist CIDRs;
 * the host egress is re-detected and merged on every apply so a host-IP drift
 * never clobbers the whitelist.
 */

import type { InboundPolicy } from '@agentbox/core';

/** Open-to-the-world source set (IPv4 + IPv6). */
export const OPEN_INBOUND_SOURCES: readonly string[] = ['0.0.0.0/0', '::/0'];

/**
 * Normalize a source spec into a CIDR. Bare IPv4 → `/32`, bare IPv6 → `/128`,
 * anything already containing `/` → returned trimmed. Does not validate the
 * address (the cloud API rejects a bad one). Mirrors the providers' historic
 * `normalizeSourceCidr`.
 */
export function normalizeInboundCidr(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('/')) return trimmed;
  if (trimmed.includes(':')) return `${trimmed}/128`;
  return `${trimmed}/32`;
}

/**
 * Parse a raw `--inbound` / `box.inbound` spec into a policy. Accepts:
 *   - '' / undefined / 'locked' / 'lock'  → locked
 *   - 'open'                              → open
 *   - 'whitelist:1.2.3.4/32,5.6.7.8'      → whitelist (prefix stripped)
 *   - bare CIDR list '1.2.3.4/32 5.6.7.8' → whitelist
 * Throws on `whitelist` with no CIDRs.
 */
export function parseInboundSpec(spec: string | undefined): InboundPolicy {
  let s = (spec ?? '').trim();
  if (s === '' || /^lock(ed)?$/i.test(s)) return { mode: 'locked', sources: [] };
  if (/^open$/i.test(s)) return { mode: 'open', sources: [] };
  if (/^whitelist\b:?/i.test(s)) s = s.replace(/^whitelist\b:?/i, '').trim();
  const sources = s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map(normalizeInboundCidr);
  if (sources.length === 0) {
    throw new Error(
      "inbound 'whitelist' needs at least one CIDR, e.g. `--inbound 203.0.113.5/32` or `--inbound whitelist:203.0.113.0/24`",
    );
  }
  return { mode: 'whitelist', sources };
}

/**
 * Resolve a policy + the detected host-egress CIDR into the actual list of
 * inbound source CIDRs for the firewall rule. `open` ignores the host egress;
 * `locked`/`whitelist` always include it (so the laptop's tunnel keeps working)
 * plus any whitelist CIDRs, de-duplicated. A null/empty `hostEgressCidr` is
 * tolerated (e.g. open mode) — but for locked/whitelist the caller should pass
 * a real egress or the box would be unreachable.
 */
export function resolveInboundSources(
  policy: InboundPolicy,
  hostEgressCidr: string | null | undefined,
): string[] {
  if (policy.mode === 'open') return [...OPEN_INBOUND_SOURCES];
  const out = new Set<string>();
  if (hostEgressCidr && hostEgressCidr.trim().length > 0) {
    out.add(normalizeInboundCidr(hostEgressCidr));
  }
  if (policy.mode === 'whitelist') {
    for (const s of policy.sources) out.add(normalizeInboundCidr(s));
  }
  return [...out];
}

/** One-line human description of a policy for logs / `--show`. */
export function describeInbound(policy: InboundPolicy): string {
  switch (policy.mode) {
    case 'open':
      return 'open (SSH reachable from anywhere — 0.0.0.0/0, key-only)';
    case 'whitelist':
      return `whitelist (host egress + ${policy.sources.join(', ')})`;
    default:
      return 'locked (SSH reachable only from the host egress IP)';
  }
}
