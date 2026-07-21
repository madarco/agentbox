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
 *   - daytona: `cpu-memory-disk` GB spec (e.g. `4-8-20`), baked at prepare time
 *     on the snapshot path.
 *   - vercel: vCPU count — `1`, `2`, `4` or `8` (RAM is coupled at 2 GB/vCPU).
 *   - e2b: `cpu-memory` GB spec (e.g. `4-8`), baked at prepare time.
 *   - docker: reserved (docker uses memory/cpus/disk). The key exists for
 *     surface uniformity.
 *
 * Returning '' (rather than undefined) mirrors how `resolveDefaultCheckpoint`
 * shapes its result, so call sites can `.length > 0` test uniformly.
 */
import type { EffectiveConfig, ProviderKind } from './types.js';
import { perProviderValue } from './image.js';

export function resolveBoxSize(cfg: EffectiveConfig, provider: ProviderKind | string): string {
  // Unknown provider names fall back to the generic `box.size` — a stray value
  // in argv or config shouldn't crash before the validation layer.
  const perProvider = perProviderValue(cfg, 'size', provider);
  if (perProvider.length > 0) return perProvider;
  return cfg.box.size;
}
