/**
 * Pure resolver for a box's {@link SyncTopology} — the "resolved ONCE per box
 * (from the provider name + whether a control-plane URL is configured)" step the
 * `SyncTopology` doc describes. No fs/exec — string logic only — so it's shared
 * by the provider (persists it on the record) and any host/box consumer.
 */
import type { SyncTopology } from './types.js';

/**
 * Resolve a box's federation topology from its provider name and whether a
 * hosted control-plane URL is configured for it.
 *
 * - docker → always `'docker'` (bind-mounted `.git`, host relay loopback; never
 *   a control-plane target).
 * - any cloud provider + a non-empty control-plane URL → `'control-plane'`
 *   (the box's live relay is the plane; git push-back leases a token directly).
 * - any cloud provider without one → `'cloud'` (host-side sync via the backend).
 */
export function resolveSyncTopology(providerName: string, controlPlaneUrl?: string): SyncTopology {
  if (providerName === 'docker') return 'docker';
  return controlPlaneUrl && controlPlaneUrl.length > 0 ? 'control-plane' : 'cloud';
}
