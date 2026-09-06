import { agentsRejectProxyHeaders } from '@agentbox/sandbox-core';

/**
 * Whether this box must publish its web port directly, with no reverse proxy.
 *
 * Decided inside the provider so every caller inherits it, the same shape as
 * {@link resolveAgentIsolation}. The mechanism is a subtraction rather than an
 * addition: skipping the Portless WEB alias is enough, because every producer
 * of a box's web URL already falls back to the directly published port when no
 * alias is registered, and the in-box browser falls back to the service's own
 * loopback port. Nothing downstream needs to know why.
 *
 * Reads `agents` — what the box was created FOR — never `lastAgent`; see
 * `agentsRejectProxyHeaders`.
 */
export function skipWebProxyAlias(
  agents: readonly string[] | undefined,
  log: (line: string) => void,
): boolean {
  if (!agentsRejectProxyHeaders(agents)) return false;
  log(
    'portless: web alias skipped — this box hosts a daemon that refuses proxied ' +
      'requests, so its URL points at the published port directly',
  );
  return true;
}
