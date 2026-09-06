import type { BoxStatus } from '@agentbox/ctl';

/**
 * The one-line warning for a box whose in-box web forwarder could not bind.
 *
 * A box in this state is the worst kind of broken: `create` reports ready, the
 * service is genuinely healthy on its loopback port, and the URL we hand out
 * belongs to whatever else won the port — so it answers, with the wrong thing.
 * The bind failure used to reach only `/var/log/agentbox/web-proxy.log`.
 *
 * Returns null when the forwarder is healthy AND when the snapshot predates the
 * field: absent means "no information", never "fine".
 */
export function webProxyWarning(status: BoxStatus | null | undefined): string | null {
  const err = status?.webProxy?.error;
  if (err === undefined || err.length === 0) return null;
  return `the box's web forwarder is not listening (${err}) — the URL above will not reach the service`;
}
