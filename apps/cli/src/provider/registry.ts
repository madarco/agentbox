/**
 * Provider registry — resolves a `Provider` for either an existing box (from
 * its `provider` discriminator) or a fresh `create` (from --provider flag /
 * config / default). Lazy `import()` keeps the Daytona SDK out of the Docker
 * hot path.
 */

import type { EffectiveConfig } from '@agentbox/config';
import type { BoxRecord, Provider, ProviderName } from '@agentbox/core';

export type KnownProviderName = 'docker' | 'daytona';

const KNOWN: readonly KnownProviderName[] = ['docker', 'daytona'];

export function isKnownProvider(name: string): name is KnownProviderName {
  return (KNOWN as readonly string[]).includes(name);
}

export async function getProvider(name: ProviderName): Promise<Provider> {
  switch (name) {
    case 'docker': {
      const mod = await import('@agentbox/sandbox-docker');
      return mod.dockerProvider;
    }
    case 'daytona': {
      const mod = await import('@agentbox/sandbox-daytona');
      return mod.daytonaProvider;
    }
    default:
      throw new Error(`unknown sandbox provider: ${String(name)}`);
  }
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
      `unknown sandbox provider "${String(name)}" (known: ${KNOWN.join(', ')})`,
    );
  }
  return getProvider(name);
}
