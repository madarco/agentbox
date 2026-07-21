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

export function resolveDefaultCheckpoint(
  cfg: EffectiveConfig,
  provider: ProviderKind | string,
): string {
  // Treat unknown provider names like 'docker' for back-compat — a stray
  // value in config or argv shouldn't crash before the validation layer.
  const perProvider =
    provider === 'daytona'
      ? cfg.box.defaultCheckpointDaytona
      : provider === 'hetzner'
        ? cfg.box.defaultCheckpointHetzner
        : provider === 'vercel'
          ? cfg.box.defaultCheckpointVercel
          : provider === 'e2b'
            ? cfg.box.defaultCheckpointE2b
            : provider === 'tenki'
              ? cfg.box.defaultCheckpointTenki
              : cfg.box.defaultCheckpointDocker;
  if (perProvider && perProvider.length > 0) return perProvider;
  return cfg.box.defaultCheckpoint;
}

/**
 * Config key (one of the flat KEY_REGISTRY entries) used by `agentbox
 * checkpoint set-default [--provider X]` to write the right field. Passing
 * an unknown provider falls back to the global key (legacy callers).
 */
export function defaultCheckpointConfigKey(
  provider: ProviderKind | string | undefined,
):
  | 'box.defaultCheckpoint'
  | 'box.defaultCheckpointDocker'
  | 'box.defaultCheckpointDaytona'
  | 'box.defaultCheckpointHetzner'
  | 'box.defaultCheckpointVercel'
  | 'box.defaultCheckpointE2b'
  | 'box.defaultCheckpointTenki' {
  if (provider === 'docker') return 'box.defaultCheckpointDocker';
  if (provider === 'daytona') return 'box.defaultCheckpointDaytona';
  if (provider === 'hetzner') return 'box.defaultCheckpointHetzner';
  if (provider === 'vercel') return 'box.defaultCheckpointVercel';
  if (provider === 'e2b') return 'box.defaultCheckpointE2b';
  if (provider === 'tenki') return 'box.defaultCheckpointTenki';
  return 'box.defaultCheckpoint';
}
