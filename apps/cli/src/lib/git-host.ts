/**
 * Which GitHub host a remote authenticates against.
 *
 * The hostname in a remote URL is not always the host that answers: an
 * `~/.ssh/config` alias (`git@github.com-work:owner/repo`, the usual
 * multiple-accounts setup) names a config entry, not a server. ssh, git and
 * `gh` all resolve it through `ssh -G` before doing anything with it, so
 * anything asking "which host do I need a credential for" has to do the same —
 * otherwise an alias user gets asked for a credential for a host that does not
 * exist, where a plain `gh auth token` used to hand back the right one.
 *
 * The relay does the same expansion for the `gh` proxy (`resolveGhTarget` in
 * `@agentbox/relay`); this is the host-CLI side of it.
 */

import { ghHostFromRemote } from '@agentbox/relay';
import { resolveSshConfigTarget } from '@agentbox/sandbox-core';

/**
 * The GitHub host `origin` really points at, with ssh aliases expanded.
 * Defaults to github.com for a missing, unparseable or non-GitHub remote —
 * the same assumption every caller made before there was a choice.
 */
export async function resolveOriginGitHost(origin: string | undefined): Promise<string> {
  const derived = ghHostFromRemote(origin);
  // null means github.com (or nothing usable) — no expansion to do either way.
  if (!derived) return 'github.com';
  // An https URL has no aliasing layer between it and the request it makes.
  if (!derived.aliasable) return derived.host;
  const expanded = await resolveSshConfigTarget(derived.host).catch(() => null);
  const host = expanded?.host.trim().toLowerCase() ?? '';
  return host.length > 0 ? host : derived.host;
}
