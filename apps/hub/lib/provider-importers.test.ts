import { describe, expect, it } from 'vitest';
import { PROVIDER_NAMES } from '@agentbox/config';
import { CLOUD_BACKEND_LOADER_ID, IMPORTERS, cloudBackendLoader } from './provider-importers';

/**
 * The hub registers this loader with the relay (server.ts) so cloud host
 * actions — git push, download, the gh pr head probe — resolve backends from
 * the standalone bundle instead of from node_modules, which it doesn't ship.
 */
// The tests that actually resolve a provider are import-bound, not logic-bound:
// they pull the sandbox-cloud → sandbox-docker → relay graph through vitest's TS
// transform, which blows past the 5s default on a cold CI runner.
const IMPORT_TIMEOUT_MS = 60_000;

describe('hub provider importers', () => {
  it('covers every configured provider', () => {
    expect(Object.keys(IMPORTERS).sort()).toEqual([...PROVIDER_NAMES].sort());
  });

  it(
    'resolves a built-in cloud provider, null for docker and unknown names',
    async () => {
      expect(typeof (await cloudBackendLoader.resolveBackend('hetzner'))?.exec).toBe('function');
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
