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
import { isProviderKind, perProviderConfigKey } from './providers.js';

/**
 * Read a per-provider `box.<base><P>` string field off the effective config.
 * Only BUILT-IN providers have such a key; any other name — a stray value, or
 * an external plugin provider — returns '' so the caller falls through to the
 * generic `box.<base>`. For a plugin that generic is the image sentinel
 * (`agentbox/box:dev`), which the plugin's own backend maps to its prepared
 * snapshot — so a plugin never accidentally reads docker's per-provider value.
 */
function perProviderValue(
  cfg: EffectiveConfig,
  base: 'image' | 'size' | 'defaultCheckpoint',
  provider: ProviderKind | string,
): string {
  if (!isProviderKind(provider)) return '';
  const field = perProviderConfigKey(base, provider).slice('box.'.length);
  const val = (cfg.box as Record<string, unknown>)[field];
  return typeof val === 'string' ? val : '';
}

export function resolveBoxImage(cfg: EffectiveConfig, provider: ProviderKind | string): string {
  // Unknown provider names fall back to the generic `box.image` — a stray
  // value in argv or config shouldn't crash before the validation layer.
  const perProvider = perProviderValue(cfg, 'image', provider);
  if (perProvider.length > 0) return perProvider;
  return cfg.box.image;
}

export { perProviderValue };

/**
 * Flat KEY_REGISTRY key for `agentbox prepare --provider X` to pin the
 * resulting image into the right per-provider slot; mirrors
 * `defaultCheckpointConfigKey`. Unknown provider → generic `box.image`
 * (legacy callers).
 */
export function boxImageConfigKey(provider: ProviderKind | string | undefined): string {
  if (provider && isProviderKind(provider)) return perProviderConfigKey('image', provider);
  return 'box.image';
}
