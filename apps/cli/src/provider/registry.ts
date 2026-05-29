/**
 * Provider registry — resolves a `Provider` for either an existing box (from
 * its `provider` discriminator) or a fresh `create` (from --provider flag /
 * config / default). Lazy `import()` keeps the Daytona SDK out of the Docker
 * hot path.
 */

import type { EffectiveConfig } from '@agentbox/config';
import type { BoxRecord, Provider, ProviderName } from '@agentbox/core';

export type KnownProviderName = 'docker' | 'daytona' | 'hetzner' | 'vercel';

const KNOWN: readonly KnownProviderName[] = ['docker', 'daytona', 'hetzner', 'vercel'];

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
      // Single lazy import covers both the first-run prompt gate and the
      // provider itself — keeps the Daytona SDK off the Docker hot path.
      // The prompt is a no-op when env is already configured or stdin isn't
      // a TTY (scripted callers get the SDK's "not configured" error instead
      // of a hung prompt).
      const mod = await import('@agentbox/sandbox-daytona');
      await mod.ensureDaytonaCredentials();
      return mod.daytonaProvider;
    }
    case 'hetzner': {
      // Same lazy-import pattern as daytona. `ensureHetznerCredentials` walks
      // the user through `agentbox hetzner login` on first use. The base-
      // snapshot gate (`ensureHetznerBaseSnapshot`) is deliberately *not*
      // called here: it would chicken-and-egg `agentbox prepare --provider
      // hetzner` (which exists precisely to BUILD the snapshot). The gate
      // lives inside `backend.provision` instead — `prepare` calls the REST
      // client directly, never `provision`, so it slips past the gate while
      // `create`/`claude`/etc. still trip it.
      const mod = await import('@agentbox/sandbox-hetzner');
      await mod.ensureHetznerCredentials();
      return mod.hetznerProvider;
    }
    case 'vercel': {
      // Same lazy-import pattern. `ensureVercelCredentials` walks the user
      // through `agentbox vercel login` (OIDC or token trio) on first use. The
      // base-snapshot gate lives inside `backend.provision` (so `prepare` can
      // build it without tripping the gate), matching the hetzner shape.
      const mod = await import('@agentbox/sandbox-vercel');
      await mod.ensureVercelCredentials();
      return mod.vercelProvider;
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
