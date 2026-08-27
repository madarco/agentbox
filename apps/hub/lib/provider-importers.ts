/**
 * The ONE place the hub enumerates the `@agentbox/sandbox-<name>` packages
 * (an app can't reach apps/cli's provider registry, so this mirrors
 * `apps/cli/src/provider/loaders.ts`).
 *
 * The `import()` specifiers are LITERAL — one arm per provider — on purpose:
 * the hub's standalone build bundles every `@agentbox/*` package in, which
 * requires esbuild to resolve each specifier statically. A computed specifier
 * would stay a runtime `node_modules` lookup and fail in the published bundle,
 * which ships no node_modules. `Record<ProviderKind, …>` keeps the map
 * exhaustive: a new provider in the config `PROVIDERS` table forces an entry.
 */
import { pathToFileURL } from 'node:url';
import { isProviderKind, type ProviderKind } from '@agentbox/config';
import type { CloudBackendLoader, CloudCpModule } from '@agentbox/relay';
import {
  isSupportedApiVersion,
  pluginForProvider,
  pluginProviderNames,
  type ProviderModule,
} from '@agentbox/sandbox-core';

export const IMPORTERS: Record<ProviderKind, () => Promise<{ providerModule: ProviderModule }>> = {
  docker: () => import('@agentbox/sandbox-docker'),
  daytona: () => import('@agentbox/sandbox-daytona'),
  hetzner: () => import('@agentbox/sandbox-hetzner'),
  vercel: () => import('@agentbox/sandbox-vercel'),
  e2b: () => import('@agentbox/sandbox-e2b'),
  digitalocean: () => import('@agentbox/sandbox-digitalocean'),
  'remote-docker': () => import('@agentbox/sandbox-remote-docker'),
};

/** Marker the build-time wiring check greps for in the standalone bundle. */
export const CLOUD_BACKEND_LOADER_ID = 'agentbox:hub-builtin-cloud-backends';

/**
 * Registered with the relay (see server.ts) so its host executors — cloud
 * `git.push`, `download.*`, the `gh pr create` head probe — resolve backends
 * from this bundle instead of from `node_modules`, which the published hub
 * doesn't have.
 */
export const cloudBackendLoader: CloudBackendLoader = {
  id: CLOUD_BACKEND_LOADER_ID,
  // Built-ins only: docker has no cloud backend, and returning null for unknown
  // names leaves provider PLUGINS on the relay's own registry path, which is
  // where the SDK-version gate lives.
  resolveBackend: async (name) => {
    if (!isProviderKind(name)) return null;
    return (await IMPORTERS[name]()).providerModule.backend ?? null;
  },
  loadCloudCp: async (): Promise<CloudCpModule> => import('@agentbox/sandbox-cloud'),
};

/**
 * `import()` no bundler can see. Turbopack rewrites every literal `import()` in
 * this app into its own module registry, which resolves the plugin's specifier
 * to a bundle entry that does not exist; building the function at runtime keeps
 * the specifier on Node's own resolver.
 */
const runtimeImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Resolve a provider module by name, built-in OR registered plugin.
 *
 * Built-ins go through the literal-specifier `IMPORTERS` map above. A plugin
 * name falls back to the on-disk registry and a TRUE variable `import()` of the
 * externally-installed package — the same extension seam the CLI uses
 * (`apps/cli/src/provider/loaders.ts`). The import goes through `runtimeImport`
 * so the bundler never sees an `import()` it would try to resolve — the path
 * only exists in the user's global node_modules.
 */
export async function loadProviderModuleByName(name: string): Promise<ProviderModule> {
  if (isProviderKind(name)) return (await IMPORTERS[name]()).providerModule;
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
  const mod = (await runtimeImport(pathToFileURL(plugin.resolvedEntry).href)) as {
    providerModule?: ProviderModule;
    providerModules?: ProviderModule[];
  };
  const all = mod.providerModules ?? (mod.providerModule ? [mod.providerModule] : []);
  const picked = all.find((pm) => pm.provider?.name === name);
  if (!picked) {
    throw new Error(
      `plugin "${plugin.packageName}" does not export a providerModule for "${name}"`,
    );
  }
  return picked;
}

/** True if `name` is a built-in provider or a registered plugin provider. */
export function isRuntimeProviderName(name: string): boolean {
  return isProviderKind(name) || pluginProviderNames().includes(name);
}
