/**
 * Resolve the effective bake datacenter / region for a provider whose base
 * snapshot has a placement fixed at prepare time.
 *
 * Precedence (highest wins):
 *   1. an explicit value (a `--location` flag threaded through the prepare job).
 *   2. the provider's config pin — `box.hetznerLocation` / `box.digitaloceanRegion`
 *      / `box.daytonaRegion`.
 *   3. undefined — the provider bakes in its own default location.
 *
 * Only hetzner, digitalocean, and daytona place a base at bake time; every other
 * provider ignores location (their base has no per-region placement).
 */
import type { EffectiveConfig } from './types.js';

export function resolvePrepareLocation(
  provider: string,
  explicit: string | undefined,
  cfg: EffectiveConfig | undefined,
): string | undefined {
  const configured =
    provider === 'hetzner'
      ? cfg?.box.hetznerLocation
      : provider === 'digitalocean'
        ? cfg?.box.digitaloceanRegion
        : provider === 'daytona'
          ? cfg?.box.daytonaRegion
          : undefined;
  return explicit?.trim() || configured || undefined;
}
