/**
 * The CLI bundle's cloud backends, handed to the spawned relay.
 *
 * Built as its own tsup entry (`dist/cloud-backends.js`) and side-loaded by the
 * relay bin through AGENTBOX_CLOUD_BACKENDS, which `spawnRelay` points at the
 * file next to the CLI entry. The relay can't import `@agentbox/sandbox-*`
 * itself — those are private workspace packages, absent from a published
 * install's `node_modules` — so the resolution has to happen HERE, where
 * `loadProviderModule`'s literal specifiers let esbuild inline every provider
 * (`noExternal: [/^@agentbox\//]`).
 */
import { isProviderKind } from '@agentbox/config';
import type { CloudBackend } from '@agentbox/core';
import type { CloudBackendLoader, CloudCpModule } from '@agentbox/relay';
import { loadProviderModule } from '../provider/loaders.js';

export const cloudBackendLoader: CloudBackendLoader = {
  id: 'agentbox:cli-builtin-cloud-backends',
  // Built-ins only: docker has no cloud backend, and returning null for anything
  // else leaves provider PLUGINS on the relay's own registry path, which is
  // where the SDK-version gate lives.
  resolveBackend: async (name: string): Promise<CloudBackend | null> => {
    if (!isProviderKind(name)) return null;
    return (await loadProviderModule(name)).backend ?? null;
  },
  loadCloudCp: (): Promise<CloudCpModule> => import('@agentbox/sandbox-cloud'),
};

export default cloudBackendLoader;
