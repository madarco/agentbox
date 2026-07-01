import { describe, expect, it } from 'vitest';
import { makeMockCloudBackend } from '../src/mock-backend.js';
import { createCloudSyncTransport } from '../src/sync-transport.js';

describe('CloudSyncTransport', () => {
  it('applyTarball uploads the tarball then extracts it with the byte-identical flags', async () => {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 't', image: 'img' });
    backend.clearCalls();
    const t = createCloudSyncTransport({ backend, handle });

    await t.applyTarball('/host/stage/envfiles.tar', '/workspace', { uid: 1000 });

    const ups = backend.calls.filter((c) => c.method === 'uploadFile');
    expect(ups).toHaveLength(1);
    expect(ups[0]!.args[1]).toBe('/host/stage/envfiles.tar'); // localPath
    expect(ups[0]!.args[2]).toBe('/tmp/agentbox-apply-0.tar'); // remotePath

    const execs = backend.calls.filter((c) => c.method === 'exec');
    expect(execs).toHaveLength(1);
    expect(execs[0]!.args[1]).toBe(
      'tar -xf /tmp/agentbox-apply-0.tar -C /workspace --no-same-permissions --no-same-owner -m && rm -f /tmp/agentbox-apply-0.tar',
    );
  });

  it('reports volume-backend caps and exposes ensureVolume when the backend has one', () => {
    const backend = makeMockCloudBackend(); // has ensureVolume
    const t = createCloudSyncTransport({ backend, handle: { sandboxId: 's' } });
    expect(t.caps).toEqual({ persistentVolumes: true, helperContainer: false, ephemeralFs: false });
    expect(typeof t.ensureVolume).toBe('function');
    expect(t.seedVolumeFromHost).toBeUndefined(); // cloud bakes static at prepare time
  });

  it('reports ephemeral caps and omits ensureVolume for a backend without a volume API', () => {
    const base = makeMockCloudBackend();
    // Strip the volume primitive to model e2b/vercel/hetzner.
    const ephemeral = { ...base, ensureVolume: undefined } as typeof base;
    const t = createCloudSyncTransport({ backend: ephemeral, handle: { sandboxId: 's' } });
    expect(t.caps).toEqual({ persistentVolumes: false, helperContainer: false, ephemeralFs: true });
    expect(t.ensureVolume).toBeUndefined();
  });
});
