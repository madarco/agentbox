/**
 * Resolve the effective default checkpoint ref for a given provider.
 *
 * Precedence (highest wins):
 *   1. `box.defaultCheckpoint<Provider>` — per-provider override
 *      (`defaultCheckpointDocker` / `defaultCheckpointDaytona` /
 *      `defaultCheckpointHetzner`).
 *   2. `box.defaultCheckpoint` — global fallback (back-compat shape: every
 *      pre-cloud config has this; no flag was needed).
 *   3. '' — no default.
 *
 * Returning the empty string (instead of undefined) matches the
 * `EffectiveConfig.box.defaultCheckpoint` shape so call sites that already
 * test `.length > 0` keep working unchanged.
 */
import type { EffectiveConfig, ProviderKind } from './types.js';
import { isProviderKind, perProviderConfigKey } from './providers.js';
import { perProviderValue } from './image.js';

export function resolveDefaultCheckpoint(
  cfg: EffectiveConfig,
  provider: ProviderKind | string,
): string {
  // Unknown provider names fall back to the global default — a stray value in
  // config or argv shouldn't crash before the validation layer.
  const perProvider = perProviderValue(cfg, 'defaultCheckpoint', provider);
  if (perProvider.length > 0) return perProvider;
  return cfg.box.defaultCheckpoint;
}

/**
 * Config key (one of the flat KEY_REGISTRY entries) used by `agentbox
 * checkpoint set-default [--provider X]` to write the right field. Passing
 * an unknown provider falls back to the global key (legacy callers).
 */
export function defaultCheckpointConfigKey(provider: ProviderKind | string | undefined): string {
  if (provider && isProviderKind(provider)) {
    return perProviderConfigKey('defaultCheckpoint', provider);
  }
  return 'box.defaultCheckpoint';
}
