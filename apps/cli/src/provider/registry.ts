/**
 * Provider registry — resolves a `Provider` for either an existing box (from
 * its `provider` discriminator) or a fresh `create` (from --provider flag /
 * config / default). Lazy `import()` keeps the Daytona SDK out of the Docker
 * hot path.
 */

import type { EffectiveConfig } from '@agentbox/config';
import type { ProviderKind } from '@agentbox/config';
import type { BoxRecord, Provider, ProviderName } from '@agentbox/core';
import { getRuntimeProviderNames, isRuntimeProvider, loadProviderModule } from './loaders.js';

/** A built-in `ProviderKind` OR a registered plugin provider name. */
export type KnownProviderName = ProviderKind | (string & {});

/** True for a built-in provider or a registered plugin provider. */
export function isKnownProvider(name: string): boolean {
  return isRuntimeProvider(name);
}

/**
 * Resolve a `Provider` by name, running its first-run credential gate first.
 * Each provider package's `providerModule.ensureCredentials` walks the user
 * through `agentbox <provider> login` on first use (a no-op for docker, and
 * for scripted/non-TTY callers). The base-snapshot gate lives inside
 * `backend.provision`, not here, so `agentbox prepare` can build the snapshot
 * without tripping it. Built-ins load through the bundle-inlined map; unknown
 * names fall back to the plugin registry (`loaders.ts`).
 */
export async function getProvider(name: ProviderName): Promise<Provider> {
  const mod = await loadProviderModule(name);
  if (mod.ensureCredentials) await mod.ensureCredentials();
  return mod.provider;
}

/** Provider for an existing box record. Defaults to 'docker' for legacy records. */
export async function providerForBox(box: BoxRecord): Promise<Provider> {
  return getProvider(box.provider ?? 'docker');
}

export interface CreateProviderChoice {
  /** Explicit --provider flag, if the command exposed one. */
  flag?: string;
  /** Effective config (carries box.provider for the layered default). */
  config: EffectiveConfig;
}

/**
 * Provider for a fresh `agentbox create`. Precedence: --provider flag >
 * box.provider config > 'docker'. Throws if the resolved name isn't registered.
 */
export async function providerForCreate(choice: CreateProviderChoice): Promise<Provider> {
  const flag = choice.flag?.trim();
  const name = (flag && flag.length > 0 ? flag : choice.config.box.provider) as ProviderName;
  if (typeof name !== 'string' || name.length === 0 || !isKnownProvider(name)) {
    throw new Error(
      `unknown sandbox provider "${String(name)}" (known: ${getRuntimeProviderNames().join(', ')})`,
    );
  }
  return getProvider(name);
}
