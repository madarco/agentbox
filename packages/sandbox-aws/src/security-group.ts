/**
 * Per-box EC2 security group — the AWS equivalent of the hetzner/digitalocean
 * Cloud Firewall. Same three-layer model:
 *
 *   1. In-instance services bind to loopback (load-bearing — the SG only
 *      guards what is exposed).
 *   2. This security group allows inbound SSH (tcp/22) from the host's egress
 *      IP /32 and nothing else.
 *   3. sshd itself is hardened by `install-box.sh` (`PasswordAuthentication no`,
 *      `AllowUsers vscode`).
 *
 * Two differences from DigitalOcean worth knowing:
 *
 *   - **Egress is allow-all by default.** A fresh EC2 SG carries an implicit
 *     "all traffic out" rule, so — unlike DO, where an inbound-only firewall
 *     silently blocks all egress — we add no outbound rules at all.
 *   - **Deleting an SG races the ENI.** `DeleteSecurityGroup` throws
 *     `DependencyViolation` until the terminated instance's network interface
 *     has actually detached, which lags `terminated` by up to a couple of
 *     minutes. Hence `deletePerBoxSecurityGroup`'s deadline loop.
 *
 * The SG is created BEFORE the instance and passed to `RunInstances`, so there
 * is never a window where the box is up but unprotected. Its id is recorded on
 * the instance tag `agentbox.firewall` (the Hetzner label trick) so destroy and
 * `firewall sync` can find it again.
 */

import { UserFacingError } from '@agentbox/core';
import { AwsApiError, type AwsClient, type AwsSecurityGroup } from './client.js';
import { detectEgressIp } from './egress-ip.js';

/** Tag keys we stamp on every resource we own. */
export const TAG_MANAGED = 'agentbox.managed';
export const TAG_ROLE = 'agentbox.role';
export const TAG_BOX = 'agentbox.box';
export const TAG_FIREWALL = 'agentbox.firewall';

/** How long to keep retrying a DeleteSecurityGroup that is blocked by its ENI. */
const SG_DELETE_DEADLINE_MS = 3 * 60_000;
const SG_DELETE_INTERVAL_MS = 5_000;

/**
 * Normalize a user-supplied source into a CIDR. A bare v4 becomes `/32`, a bare
 * v6 becomes `/128`, an explicit CIDR passes through. Anything else throws —
 * we must never silently widen the rule.
 */
export function normalizeSourceCidr(source: string): string {
  const s = source.trim();
  if (s.length === 0) throw new UserFacingError('firewall source must not be empty');
  if (s.includes('/')) return s;
  if (s.includes(':')) return `${s}/128`;
  return `${s}/32`;
}

/** The SSH source CIDRs currently allowed by this security group. */
export function allowedSshSources(sg: AwsSecurityGroup): string[] {
  const out: string[] = [];
  for (const perm of sg.ipPermissions) {
    if (perm.IpProtocol !== 'tcp') continue;
    if (perm.FromPort !== 22 || perm.ToPort !== 22) continue;
    for (const r of perm.IpRanges ?? []) {
      if (typeof r.CidrIp === 'string') out.push(r.CidrIp);
    }
  }
  return out;
}

/**
 * True when the group's SSH rule no longer matches the host's current egress IP
 * and should be re-synced.
 *
 * `0.0.0.0/0` is an explicit opt-in to a dynamic/unknown IP (set via
 * `AGENTBOX_AWS_FIREWALL_SOURCE`) and is never "fixed" out from under the user.
 */
export function securityGroupNeedsSync(
  allowedSources: readonly string[],
  currentEgress: string,
): boolean {
  if (allowedSources.includes('0.0.0.0/0')) return false;
  return !allowedSources.includes(currentEgress);
}

/**
 * Resolve the CIDR that SSH should be allowed from: an explicit override
 * (`AGENTBOX_AWS_FIREWALL_SOURCE`, from the box env or the process env) or the
 * host's detected egress IP. `detectEgressIp` fails loud rather than falling
 * back to `0.0.0.0/0` — an undetectable IP must not silently open the box up.
 */
export async function resolveFirewallSource(env?: Record<string, string>): Promise<string> {
  const override = env?.AGENTBOX_AWS_FIREWALL_SOURCE ?? process.env.AGENTBOX_AWS_FIREWALL_SOURCE;
  if (typeof override === 'string' && override.trim().length > 0) {
    return normalizeSourceCidr(override);
  }
  return normalizeSourceCidr(await detectEgressIp());
}

export interface CreateSecurityGroupOptions {
  /** SG name — must be unique per VPC. */
  name: string;
  vpcId: string;
  sourceCidr: string;
  /** Extra tags merged over the managed set (e.g. `agentbox.box`). */
  tags?: Record<string, string>;
}

/**
 * Create the per-box security group with a single inbound SSH rule. Returns the
 * group id. On any failure after the group exists, the group is deleted before
 * rethrowing — a half-made SG would block a retry (the name would collide).
 */
export async function createPerBoxSecurityGroup(
  client: AwsClient,
  opts: CreateSecurityGroupOptions,
): Promise<string> {
  const groupId = await client.createSecurityGroup(
    opts.name,
    'AgentBox per-box security group (SSH from the host egress IP only)',
    opts.vpcId,
    { [TAG_MANAGED]: 'true', [TAG_ROLE]: 'box', ...opts.tags },
  );
  try {
    await client.authorizeSshIngress(groupId, opts.sourceCidr);
  } catch (err) {
    await client.deleteSecurityGroup(groupId).catch(() => {});
    throw err;
  }
  return groupId;
}

/**
 * Point the group's SSH rule at `nextCidr`. Authorize first, then revoke the
 * stale rules: doing it in that order means a failure halfway through leaves the
 * box *reachable* from both the old and new IP rather than from neither.
 */
export async function syncSecurityGroupSource(
  client: AwsClient,
  groupId: string,
  nextCidr: string,
): Promise<{ added: string; removed: string[] }> {
  const sg = await client.describeSecurityGroup(groupId);
  if (!sg) {
    throw new UserFacingError(
      `aws: security group ${groupId} no longer exists — the box's firewall was deleted out of band.`,
    );
  }
  const current = allowedSshSources(sg);
  await client.authorizeSshIngress(groupId, nextCidr);
  const stale = current.filter((c) => c !== nextCidr);
  for (const c of stale) {
    await client.revokeSshIngress(groupId, c);
  }
  return { added: nextCidr, removed: stale };
}

/** The per-box SG id recorded on the instance's `agentbox.firewall` tag. */
export function securityGroupIdFromTags(tags: Record<string, string>): string | undefined {
  const id = tags[TAG_FIREWALL];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Delete the per-box security group, waiting out the ENI detach.
 *
 * After `TerminateInstances` the instance reaches `terminated` while its network
 * interface is still being reclaimed, and until that finishes EC2 rejects the
 * delete with `DependencyViolation`. Retrying until a deadline is the documented
 * approach; the alternative (deleting before terminate) is impossible, since the
 * group is in use.
 *
 * Best-effort by design: if the deadline elapses we warn rather than throw, so a
 * stuck ENI can't fail an otherwise-successful `destroy`. The group is tagged
 * and `agentbox prune` will surface it.
 */
export async function deletePerBoxSecurityGroup(
  client: AwsClient,
  groupId: string,
  opts: { deadlineMs?: number; intervalMs?: number; onLog?: (line: string) => void } = {},
): Promise<{ deleted: boolean; detail?: string }> {
  const deadline = Date.now() + (opts.deadlineMs ?? SG_DELETE_DEADLINE_MS);
  const intervalMs = opts.intervalMs ?? SG_DELETE_INTERVAL_MS;
  let lastErr: unknown;

  while (true) {
    try {
      await client.deleteSecurityGroup(groupId);
      return { deleted: true };
    } catch (err) {
      lastErr = err;
      const code = err instanceof AwsApiError ? err.code : '';
      if (code !== 'DependencyViolation') break;
      if (Date.now() >= deadline) break;
      opts.onLog?.(
        `aws: security group ${groupId} still attached to a network interface; retrying delete`,
      );
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  opts.onLog?.(
    `aws: WARN could not delete security group ${groupId} (${detail}). ` +
      "It is tagged `agentbox.managed`; `agentbox prune --provider aws` will surface it.",
  );
  return { deleted: false, detail };
}
