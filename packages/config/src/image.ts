/**
 * Resolve the effective box image ref for a given provider.
 *
 * Precedence (highest wins):
 *   1. `box.image<Provider>` — per-provider override
 *      (`imageDocker` / `imageDaytona` / `imageHetzner` / `imageVercel`).
 *   2. `box.image` — generic fallback (defaults to `agentbox/box:dev`,
 *      which cloud backends recognize as a sentinel meaning "boot from
 *      the provider's prepared base snapshot").
 *
 * Each `agentbox prepare --provider X` writes its result into its own
 * per-provider key, so cross-provider prepares can no longer poison
 * creates on other providers.
 */
import type { EffectiveConfig, ProviderKind } from './types.js';

export function resolveBoxImage(cfg: EffectiveConfig, provider: ProviderKind | string): string {
  // Unknown provider names fall into the docker bucket — a stray value in
  // argv or config shouldn't crash before the validation layer.
  const perProvider =
    provider === 'daytona'
      ? cfg.box.imageDaytona
      : provider === 'hetzner'
        ? cfg.box.imageHetzner
        : provider === 'vercel'
          ? cfg.box.imageVercel
          : cfg.box.imageDocker;
  if (perProvider && perProvider.length > 0) return perProvider;
  return cfg.box.image;
}

/**
 * Flat KEY_REGISTRY key for `agentbox prepare --provider X` to pin the
 * resulting image into the right per-provider slot; mirrors
 * `defaultCheckpointConfigKey` / `boxSizeConfigKey`. Unknown provider →
 * generic `box.image` (legacy callers).
 */
export function boxImageConfigKey(
  provider: ProviderKind | string | undefined,
):
  | 'box.image'
  | 'box.imageDocker'
  | 'box.imageDaytona'
  | 'box.imageHetzner'
  | 'box.imageVercel' {
  if (provider === 'docker') return 'box.imageDocker';
  if (provider === 'daytona') return 'box.imageDaytona';
  if (provider === 'hetzner') return 'box.imageHetzner';
  if (provider === 'vercel') return 'box.imageVercel';
  return 'box.image';
}
