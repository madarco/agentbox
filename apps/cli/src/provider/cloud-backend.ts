/**
 * Lazily resolve a cloud `CloudBackend` by provider name via the provider
 * loader (`loaders.ts`), which keeps the heavy provider SDKs off the docker hot
 * path. Returns `null` for `docker` (no cloud backend) and any unknown name.
 */
import type { CloudBackend, ProviderName } from '@agentbox/core';
import { isProviderKind } from '@agentbox/config';
import { loadProviderModule } from './loaders.js';

export async function cloudBackendForProvider(
  provider: ProviderName,
): Promise<CloudBackend | null> {
  if (!isProviderKind(provider)) return null;
  return (await loadProviderModule(provider)).backend ?? null;
}

/**
 * Compute the CURRENT build-context fingerprint for a cloud provider's base
 * image / snapshot via the provider's `providerModule.currentBaseFingerprintLive`.
 *
 * Returns `undefined` for docker (its base self-heals via `ensureImage`) and
 * any provider whose live computation fails (typically a dev tree without
 * `pnpm -w build` — callers degrade to "can't tell, don't nag").
 */
export async function currentCloudBaseFingerprintLive(
  provider: ProviderName,
  claudeInstall?: 'native' | 'npm',
): Promise<string | undefined> {
  if (!isProviderKind(provider)) return undefined;
  const mod = await loadProviderModule(provider);
  return mod.currentBaseFingerprintLive?.(claudeInstall);
}
