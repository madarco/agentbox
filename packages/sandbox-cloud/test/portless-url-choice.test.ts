import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoxRecord,
  CloudBackend,
  CloudExecResult,
  CloudHandle,
  CloudPreviewUrl,
  CloudState,
} from '@agentbox/core';

// The proxy probe and the on-demand start are the only Portless calls under
// test; stub them so the answer is the test's, not the machine's.
const { live } = vi.hoisted(() => ({ live: { value: false } }));
vi.mock('@agentbox/sandbox-docker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbox/sandbox-docker')>();
  return {
    ...actual,
    ensurePortlessForUrl: vi.fn(async () => live.value),
    portlessProxyLive: vi.fn(async () => live.value),
    portlessGetUrl: vi.fn(async (name: string) => `https://${name}.localhost`),
  };
});

import { createCloudProvider } from '../src/cloud-provider.js';

function makeBackend(): CloudBackend {
  return {
    name: 'hetzner-like',
    provision: async () => ({ sandboxId: 'sb-1' }),
    get: async () => null,
    start: async () => {},
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    destroy: async () => {},
    state: async (): Promise<CloudState> => 'running',
    exec: async (): Promise<CloudExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }),
    uploadFile: async () => {},
    downloadFile: async () => {},
    listFiles: async () => [],
    previewUrl: async (_h: CloudHandle, port: number): Promise<CloudPreviewUrl> => ({
      url: `http://127.0.0.1:4${String(port)}`,
    }),
    // A loopback SSH forward, the shape hetzner/digitalocean hand back.
    signedPreviewUrl: async (_h: CloudHandle, port: number) => ({
      url: `http://127.0.0.1:4${String(port)}`,
    }),
  };
}

const box: BoxRecord = {
  id: 'b1',
  name: 'b1',
  container: 'cloud:sb-1',
  image: 'img',
  workspacePath: '/tmp',
  createdAt: new Date().toISOString(),
  portlessAlias: 'b1',
  portlessUrl: 'https://b1.localhost',
  cloud: {
    backend: 'hetzner-like',
    sandboxId: 'sb-1',
    webPort: 8080,
    previewUrls: { 8080: 'http://127.0.0.1:48080' },
  },
};

describe('cloud box URL: Portless alias vs loopback by proxy liveness', () => {
  beforeEach(() => {
    live.value = false;
  });

  it('resolveUrl hands out the alias while a proxy serves it', async () => {
    live.value = true;
    const p = createCloudProvider(makeBackend());
    expect(await p.resolveUrl(box, { kind: 'web' })).toBe('https://b1.localhost');
  });

  it('resolveUrl falls back to the loopback forward when the proxy is down', async () => {
    const p = createCloudProvider(makeBackend());
    expect(await p.resolveUrl(box, { kind: 'web' })).toBe('http://127.0.0.1:48080');
  });

  it('inspect advertises the alias only while the proxy is live', async () => {
    const p = createCloudProvider(makeBackend());
    const web = async () =>
      (await p.inspect(box)).endpoints.endpoints.find((e) => e.name === 'web')?.url;
    expect(await web()).toBe('http://127.0.0.1:48080');
    live.value = true;
    expect(await web()).toBe('https://b1.localhost');
  });
});
