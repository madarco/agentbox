/**
 * Per-provider lazy module loaders — the ONE place the CLI enumerates the
 * `@agentbox/sandbox-<name>` packages.
 *
 * Each package exposes a uniform `providerModule` (see `ProviderModule` in
 * `@agentbox/sandbox-core`); the create / doctor / install / checkpoint code
 * all resolve a provider through `loadProviderModule` and drive it generically,
 * so those call sites carry no per-provider `switch`.
 *
 * The `import()` specifiers are LITERAL — one arm per provider — on purpose.
 * The CLI's tsup build inlines every `@agentbox/sandbox-*` package
 * (`noExternal: [/^@agentbox\//]`), which requires esbuild to statically
 * resolve each specifier; a runtime-variable `import('@agentbox/sandbox-' +
 * name)` would not inline and would `MODULE_NOT_FOUND` in the published CLI.
 * `Record<ProviderKind, …>` makes this map exhaustive: adding a provider to the
 * config `PROVIDERS` table forces a matching entry here (a TS error otherwise).
 */

import { pathToFileURL } from 'node:url';
import { PROVIDER_NAMES, isProviderKind, type ProviderKind } from '@agentbox/config';
import {
  pluginForProvider,
  pluginProviderNames,
  isSupportedApiVersion,
  type ProviderModule,
} from '@agentbox/sandbox-core';

const IMPORTERS: Record<ProviderKind, () => Promise<{ providerModule: ProviderModule }>> = {
  docker: () => import('@agentbox/sandbox-docker'),
  daytona: () => import('@agentbox/sandbox-daytona'),
  hetzner: () => import('@agentbox/sandbox-hetzner'),
  vercel: () => import('@agentbox/sandbox-vercel'),
  e2b: () => import('@agentbox/sandbox-e2b'),
  digitalocean: () => import('@agentbox/sandbox-digitalocean'),
  'remote-docker': () => import('@agentbox/sandbox-remote-docker'),
};

/**
 * Extract the `providerModule` matching `name` from an already-imported plugin
 * package. A plugin may export a single `providerModule` or a `providerModules`
 * array (multi-provider package).
 */
function pickProviderModule(mod: unknown, name: string): ProviderModule | null {
  const m = mod as { providerModule?: ProviderModule; providerModules?: ProviderModule[] };
  const all = m.providerModules ?? (m.providerModule ? [m.providerModule] : []);
  // Strict match on provider.name — never fall back to all[0], or a package
  // could serve the WRONG provider for a mismatched `--provider` name.
  return all.find((pm) => pm.provider?.name === name) ?? null;
}

/**
 * Lazily import a provider package and return its uniform `providerModule`.
 *
 * Built-in providers resolve through the literal-specifier `IMPORTERS` map
 * (bundle-inlined). An unknown name falls back to the plugin registry: a TRUE
 * variable `import(resolvedEntry)` of the externally-installed package — NOT
 * inlined at build time, resolved from wherever the user installed it.
 */
export async function loadProviderModule(name: string): Promise<ProviderModule> {
  if (isProviderKind(name)) {
    return (await IMPORTERS[name]()).providerModule;
  }
  const plugin = pluginForProvider(name);
  if (!plugin) {
    throw new Error(
      `unknown provider "${name}" — not built in and no registered plugin provides it (run \`agentbox plugin list\`)`,
    );
  }
  if (!isSupportedApiVersion(plugin.apiVersion)) {
    throw new Error(
      `plugin "${plugin.packageName}" targets provider SDK v${String(plugin.apiVersion)}, which this AgentBox does not support — update the plugin or AgentBox`,
    );
  }
  // Variable specifier on purpose: this is the extension seam. esbuild leaves it
  // as a runtime import so an externally-installed package resolves at run time.
  // Convert to a file:// URL — a bare absolute path is not a valid ESM dynamic
  // import specifier on Windows / some Node setups.
  const mod = (await import(pathToFileURL(plugin.resolvedEntry).href)) as unknown;
  const providerModule = pickProviderModule(mod, name);
  if (!providerModule) {
    throw new Error(
      `plugin "${plugin.packageName}" does not export a providerModule for "${name}"`,
    );
  }
  return providerModule;
}

/** Built-in + registered-plugin provider names (deduped). */
export function getRuntimeProviderNames(): string[] {
  return [...new Set<string>([...PROVIDER_NAMES, ...pluginProviderNames()])];
}

/** True if `name` is a built-in provider or a registered plugin provider. */
export function isRuntimeProvider(name: string): boolean {
  return isProviderKind(name) || pluginProviderNames().includes(name);
}
