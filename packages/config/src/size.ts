/**
 * Resolve the effective default VM size for a given cloud provider.
 *
 * Precedence (highest wins):
 *   1. `box.size<Provider>` — per-provider override
 *      (`sizeDocker` / `sizeDaytona` / `sizeHetzner` / `sizeVercel`).
 *   2. `box.size` — generic fallback.
 *   3. '' — no preference; backend uses its built-in default.
 *
 * Interpretation is provider-specific:
 *   - hetzner: server type string (e.g. `cx33`).
 *   - daytona: `cpu-memory-disk` GB spec (e.g. `4-8-20`).
 *   - docker / vercel: reserved (docker uses memory/cpus/disk; vercel uses
 *     vercelVcpus). The keys exist for surface uniformity.
 *
 * Returning '' (rather than undefined) mirrors how `resolveDefaultCheckpoint`
 * shapes its result, so call sites can `.length > 0` test uniformly.
 */
import type { EffectiveConfig, ProviderKind } from './types.js';

export function resolveBoxSize(cfg: EffectiveConfig, provider: ProviderKind | string): string {
  // Unknown provider names fall into the docker bucket — a stray value in
  // argv or config shouldn't crash before the validation layer.
  const perProvider =
    provider === 'daytona'
      ? cfg.box.sizeDaytona
      : provider === 'hetzner'
        ? cfg.box.sizeHetzner
        : provider === 'vercel'
          ? cfg.box.sizeVercel
          : provider === 'e2b'
            ? cfg.box.sizeE2b
            : provider === 'tenki'
              ? cfg.box.sizeTenki
              : cfg.box.sizeDocker;
  if (perProvider && perProvider.length > 0) return perProvider;
  return cfg.box.size;
}
