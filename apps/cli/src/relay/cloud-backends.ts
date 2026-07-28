/**
 * The CLI's built-in cloud-backend loader, side-loaded by the spawned relay bin.
 *
 * This file is a SECOND tsup entry (`dist/cloud-backends.js`, see
 * apps/cli/tsup.config.ts). `spawnRelay` points `AGENTBOX_CLOUD_BACKENDS` at it
 * and `@agentbox/relay`'s bin imports it lazily on the first cloud host action.
 *
 * Why a hand-off at all: the relay bin is bundled from `@agentbox/relay` alone
 * (no provider packages — that would close a dependency cycle), so it used to
 * resolve `@agentbox/sandbox-<name>` from `node_modules` at run time. Those are
 * private workspace packages bundled into this CLI, so an npm install has
 * nothing to resolve and every cloud git push / download failed. Here they ARE
 * inlined (tsup `noExternal: [/^@agentbox\//]`), so the relay borrows ours.
 */
import type { CloudBackendLoader, CloudCpModule } from '@agentbox/relay';
import { cloudBackendForProvider } from '../provider/cloud-backend.js';

/** Marker the build-time wiring check greps for in `dist/cloud-backends.js`. */
export const CLOUD_BACKEND_LOADER_ID = 'agentbox:builtin-cloud-backends';

export const cloudBackendLoader: CloudBackendLoader = {
  id: CLOUD_BACKEND_LOADER_ID,
  // Built-ins only. `cloudBackendForProvider` returns null for docker (no cloud
  // backend) and for any non-built-in name, which leaves provider PLUGINS on the
  // relay's own registry path — the one place that enforces the SDK-version gate.
  resolveBackend: (name) => cloudBackendForProvider(name),
  // Dynamic on purpose: `@agentbox/sandbox-cloud` statically imports
  // sandbox-docker → relay, so a static import here would load a second copy of
  // the relay graph inside the relay process. This way it lands in its own lazy
  // chunk, loaded only by a `download.*` action.
  loadCloudCp: async (): Promise<CloudCpModule> => import('@agentbox/sandbox-cloud'),
};
