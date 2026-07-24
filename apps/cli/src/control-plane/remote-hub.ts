import type { EffectiveConfig } from '@agentbox/config';

/**
 * True when a remote control box (hub) is configured — i.e. `relay.controlPlaneUrl`
 * is set. The canonical predicate for "there is a remote hub to route to", so the
 * cloud-create routing, `ls -g`, and by-name auto-adopt all agree on the condition.
 *
 * Kept dependency-light (type-only import) so any control-plane module can use it
 * without an import cycle.
 */
export function remoteHubConfigured(effective: EffectiveConfig): boolean {
  return Boolean(effective.relay.controlPlaneUrl);
}
