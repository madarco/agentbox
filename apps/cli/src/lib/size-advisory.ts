/**
 * "That size won't take effect" — surfaced EARLY.
 *
 * Some backends fix CPU/memory/disk when the base image is baked and reject
 * per-create resources (daytona on the snapshot path, e2b always). Their
 * backends already warn at provision, but a detached `-i` create writes that to
 * `~/.agentbox/logs/queue-<id>.log`, which nobody opens for a box that came up
 * fine — so the setting looks silently ignored. Asking the provider here puts
 * the same warning in the terminal of whoever set or requested the size.
 *
 * Advisory only: a mismatched size is legal (the box comes up baked-size), so
 * every failure path degrades to silence rather than blocking the command.
 */

import { PROVIDER_NAMES, perProviderConfigKey } from '@agentbox/config';
import { loadProviderModule } from '../provider/loaders.js';

/**
 * Reason `size` is ignored on `providerName`, or null. Never throws: an
 * unknown provider, a plugin that fails to import, or a provider without the
 * hook all mean "nothing to say".
 */
export async function sizeIgnoredReason(
  providerName: string,
  size: string | undefined,
): Promise<string | null> {
  const spec = size?.trim();
  if (!spec) return null;
  try {
    const mod = await loadProviderModule(providerName);
    return mod.sizeIgnoredReason?.(spec) ?? null;
  } catch {
    return null;
  }
}

/**
 * The provider a `box.size…` key targets: `box.sizeDaytona` -> daytona;
 * the generic `box.size` -> null, meaning "ask the effective provider", so
 * setting a global default doesn't warn about backends the user never uses.
 * Returns undefined for keys that are not a size key at all.
 */
export function providerForSizeKey(key: string): string | null | undefined {
  if (key === 'box.size') return null;
  for (const name of PROVIDER_NAMES) {
    if (perProviderConfigKey('size', name) === key) return name;
  }
  return undefined;
}
