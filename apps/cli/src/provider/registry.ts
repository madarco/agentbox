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
import { parseProviderSpec } from './spec.js';

/** A built-in `ProviderKind` OR a registered plugin provider name. */
export type KnownProviderName = ProviderKind | (string & {});

/**
 * True for a built-in provider, a registered plugin provider, or a
 * host-qualified spec (`docker:<host>`). Every `--provider` validation goes
 * through here, so a spec is accepted everywhere a bare name is.
 */
export function isKnownProvider(name: string): boolean {
  try {
    return isRuntimeProvider(parseProviderSpec(name).name);
  } catch {
    // A malformed spec (`docker:` with no host) is not a known provider; the
    // caller's error message names it.
    return false;
  }
}

/**
 * Resolve a `Provider` by name or spec, running its first-run credential gate
 * first. Each provider package's `providerModule.ensureCredentials` walks the
 * user through `agentbox <provider> login` on first use (a no-op for docker and
 * remote-docker, which have no credential, and for non-TTY callers). The
 * base-snapshot gate lives inside `backend.provision`, not here, so `agentbox
 * prepare` can build the snapshot without tripping it. Built-ins load through
 * the bundle-inlined map; unknown names fall back to the plugin registry.
 */
export async function getProvider(name: ProviderName): Promise<Provider> {
  const mod = await loadProviderModule(parseProviderSpec(name).name);
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
/** Lazy: keeps the env-file read off every `getProvider` call. */
async function loadControlPlaneEnvLazily(): Promise<void> {
  const { loadControlPlaneEnv } = await import('../control-plane/env-file.js');
  loadControlPlaneEnv();
}

export async function providerForCreate(choice: CreateProviderChoice): Promise<Provider> {
  const flag = choice.flag?.trim();
  const spec = (flag && flag.length > 0 ? flag : choice.config.box.provider) as ProviderName;
  if (typeof spec !== 'string' || spec.length === 0 || !isKnownProvider(spec)) {
    throw new Error(
      `unknown sandbox provider "${String(spec)}" (known: ${getRuntimeProviderNames().join(', ')})`,
    );
  }
  // A control-plane create needs the admin bearer in `process.env` — the
  // provider registers the box on the plane and pushes seed material with it.
  // The token lives in the setup-written env file, and nothing on the create
  // path was loading it, so in an ordinary shell (where the user has not
  // sourced it) every PC create silently skipped registration: the box came up
  // with `topology: control-plane` but the plane never heard of it, its seed was
  // never stored, and its `git push` had no token to lease with.
  //
  // Every create path resolves its provider through here, so this is the one
  // place that covers create / claude / codex / opencode / queued jobs.
  // Optional-chained: a real EffectiveConfig always carries `relay` (defaults
  // fill it), but callers/tests hand this a narrower object.
  if (choice.config.relay?.controlPlaneUrl) await loadControlPlaneEnvLazily();
  return getProvider(spec);
}
