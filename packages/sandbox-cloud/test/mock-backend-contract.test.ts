/**
 * Backend contract tests — exercise every required + optional method on
 * `CloudBackend` against `makeMockCloudBackend`. Future cloud-backend
 * implementations can adapt this suite (replace the import + the factory)
 * to validate compliance.
 */
import { describe, expect, it } from 'vitest';
import { createCloudProvider } from '../src/cloud-provider.js';
import { makeMockCloudBackend } from '../src/mock-backend.js';
import type { CloudHandle } from '@agentbox/core';

describe('CloudBackend contract (mock)', () => {
  it('records every method invocation in the order it happens', async () => {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b1', image: 'mock/img' });
    await backend.start(handle);
    await backend.pause(handle);
    await backend.resume(handle);
    await backend.exec(handle, 'echo hi');
    await backend.uploadFile(handle, '/tmp/host.txt', '/tmp/box.txt');
    await backend.downloadFile(handle, '/tmp/box.txt', '/tmp/host.txt');
    await backend.destroy(handle);

    const methods = backend.calls.map((c) => c.method);
    expect(methods).toEqual([
      'provision',
      'start',
      'pause',
      'resume',
      'exec',
      'uploadFile',
      'downloadFile',
      'destroy',
    ]);
  });

  it('state transitions: provision → start → pause → resume → stop → destroy', async () => {
    const backend = makeMockCloudBackend();
    const h = await backend.provision({ name: 'b', image: 'i' });
    expect(await backend.state(h)).toBe('running');
    await backend.pause(h);
    expect(await backend.state(h)).toBe('paused');
    await backend.resume(h);
    expect(await backend.state(h)).toBe('running');
    await backend.stop(h);
    expect(await backend.state(h)).toBe('stopped');
    await backend.destroy(h);
    expect(await backend.state(h)).toBe('missing');
    expect(await backend.get(h.sandboxId)).toBeNull();
  });

  it('list() reports preloaded sandboxes + post-provision additions', async () => {
    const backend = makeMockCloudBackend({
      preloaded: [{ id: 'pre-1', name: 'pre', state: 'running' }],
    });
    const initial = await backend.list!();
    expect(initial.map((s) => s.sandboxId)).toEqual(['pre-1']);

    await backend.provision({ name: 'new', image: 'i' });
    const later = await backend.list!();
    expect(later).toHaveLength(2);
  });

  it('previewUrl / signedPreviewUrl produce stable per-handle URLs', async () => {
    const backend = makeMockCloudBackend();
    const h = await backend.provision({ name: 'b', image: 'i' });
    const p1 = await backend.previewUrl!(h, 8080);
    const p2 = await backend.previewUrl!(h, 8080);
    expect(p1.url).toBe(p2.url);
    const s = await backend.signedPreviewUrl!(h, 8080, 60);
    expect(s.url).toContain('signed60');
  });

  it('createSnapshot + deleteSnapshot are accepted and recorded', async () => {
    const backend = makeMockCloudBackend();
    const h = await backend.provision({ name: 'b', image: 'i' });
    await backend.createSnapshot!(h, 'snap-1');
    expect(backend.calls.some((c) => c.method === 'createSnapshot')).toBe(true);
    await backend.deleteSnapshot!('snap-1');
  });

  it('ensureVolume returns a deterministic id', async () => {
    const backend = makeMockCloudBackend();
    const v1 = await backend.ensureVolume!('shared-claude');
    const v2 = await backend.ensureVolume!('shared-claude');
    expect(v1.volumeId).toBe(v2.volumeId);
  });

  it('beforeCall hook can inject failures for retry-wrapper tests', async () => {
    let count = 0;
    const backend = makeMockCloudBackend({
      beforeCall: (method) => {
        if (method === 'provision') {
          count += 1;
          if (count === 1) throw new Error('inject: transient 503');
        }
      },
    });
    await expect(backend.provision({ name: 'fail', image: 'i' })).rejects.toThrow(/transient 503/);
    const ok = await backend.provision({ name: 'ok', image: 'i' });
    expect(ok.sandboxId).toMatch(/^mock-/);
  });

  it('composes into a full Provider via createCloudProvider', async () => {
    const backend = makeMockCloudBackend();
    // Provision the sandbox the BoxRecord references — the mock backend
    // requires the sandbox to exist before exec / previewUrl land on it.
    const h = await backend.provision({ name: 'b1', image: 'img' });
    const provider = createCloudProvider(backend);
    expect(provider.name).toBe('mock');
    const record = {
      id: 'b1',
      name: 'b1',
      provider: 'mock' as const,
      container: `cloud:${h.sandboxId}`,
      image: 'img',
      workspacePath: '/tmp',
      createdAt: new Date().toISOString(),
      cloud: { backend: 'mock', sandboxId: h.sandboxId, webPort: 8080 },
    };
    // resolveUrl prefers signedPreviewUrl and produces a usable URL.
    const url = await provider.resolveUrl(record, { kind: 'web' });
    expect(url).toContain('signed');
    // buildAttach uses attachArgv when present.
    const spec = await provider.buildAttach!(record, 'shell');
    expect(spec.argv[0]).toBe('ssh');
  });

  it('exec / listFiles / preview all refuse missing sandboxes', async () => {
    const backend = makeMockCloudBackend();
    const ghost: CloudHandle = { sandboxId: 'does-not-exist' };
    await expect(backend.exec(ghost, 'true')).rejects.toThrow(/not found/);
    await expect(backend.listFiles(ghost, '/tmp')).rejects.toThrow(/not found/);
    await expect(backend.previewUrl(ghost, 80)).rejects.toThrow(/not found/);
  });
});
