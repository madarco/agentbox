import { describe, expect, it } from 'vitest';
import { CLOUD_BACKEND_LOADER_ID, cloudBackendLoader } from '../src/relay/cloud-backends.js';

/**
 * `dist/cloud-backends.js` is the module the spawned relay side-loads through
 * AGENTBOX_CLOUD_BACKENDS. Its contract: built-in backends only, `null` for
 * everything else (so provider plugins stay on the relay's own gated path).
 */
// Resolving a provider pulls the sandbox-cloud → sandbox-docker → relay graph
// through vitest's TS transform — import-bound, and well past the 5s default on
// a cold CI runner.
const IMPORT_TIMEOUT_MS = 60_000;

describe('CLI cloud-backend loader entry', () => {
  it(
    'resolves a built-in cloud provider',
    async () => {
      // hetzner + digitalocean are plain REST backends — no heavy SDK to import.
      expect(typeof (await cloudBackendLoader.resolveBackend('hetzner'))?.exec).toBe('function');
      expect(typeof (await cloudBackendLoader.resolveBackend('digitalocean'))?.exec).toBe(
        'function',
      );
    },
    IMPORT_TIMEOUT_MS,
  );

  it(
    'returns null for docker and for non-built-in names',
    async () => {
      expect(await cloudBackendLoader.resolveBackend('docker')).toBeNull();
      expect(await cloudBackendLoader.resolveBackend('definitely-not-a-provider')).toBeNull();
    },
    IMPORT_TIMEOUT_MS,
  );

  it(
    'exposes the sandbox-cloud cp helpers and the wiring marker',
    async () => {
      expect(typeof (await cloudBackendLoader.loadCloudCp()).pullCloudDirContents).toBe('function');
      expect(cloudBackendLoader.id).toBe(CLOUD_BACKEND_LOADER_ID);
    },
    IMPORT_TIMEOUT_MS,
  );
});
