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
import { isProviderKind, type ProviderKind } from '@agentbox/config';
import type { CloudBackendLoader, CloudCpModule } from '@agentbox/relay';
import type { ProviderModule } from '@agentbox/sandbox-core';

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
