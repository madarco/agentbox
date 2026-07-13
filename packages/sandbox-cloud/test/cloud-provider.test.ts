import { describe, expect, it } from 'vitest';
import type {
  CloudBackend,
  CloudExecResult,
  CloudHandle,
  CloudPreviewUrl,
  CloudState,
} from '@agentbox/core';
import { createCloudProvider } from '../src/cloud-provider.js';
import { NotAuthenticatedError } from '../src/auth-error.js';

/**
 * Composition-level smoke tests for `createCloudProvider`. We don't exercise
 * the full `create()` flow (it requires a host workspace + git + writable
 * state.json), but we verify the surface area is wired correctly:
 *
 * - `name` matches the backend's name.
 * - `buildAttach` requires `attachArgv` and surfaces a clean error when the
 *   backend lacks it.
 * - `resolveUrl` prefers `signedPreviewUrl` when available.
 * - `inspect` surfaces per-service preview URLs as `service-<port>` rows.
 */
function makeBackend(overrides: Partial<CloudBackend> = {}): CloudBackend {
  const base: CloudBackend = {
    name: 'test-backend',
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
      url: `https://${String(port)}.example`,
    }),
  };
  return { ...base, ...overrides };
}

describe('createCloudProvider composition', () => {
  it('takes its name from the backend', () => {
    const p = createCloudProvider(makeBackend());
    expect(p.name).toBe('test-backend');
  });

  it('buildAttach throws when the backend has no attachArgv', async () => {
    const p = createCloudProvider(makeBackend());
    await expect(
      p.buildAttach!(
        {
          id: 'b1',
          name: 'b1',
          container: 'cloud:sb-1',
          image: 'img',
          workspacePath: '/tmp',
          createdAt: new Date().toISOString(),
          cloud: { backend: 'test-backend', sandboxId: 'sb-1' },
        },
        'shell',
      ),
    ).rejects.toThrow(/does not implement attachArgv/);
  });

  it('inspect surfaces a service-<port> endpoint for every previewUrls entry', async () => {
    const p = createCloudProvider(makeBackend());
    const insp = await p.inspect({
      id: 'b1',
      name: 'b1',
      container: 'cloud:sb-1',
      image: 'img',
      workspacePath: '/tmp',
      createdAt: new Date().toISOString(),
      cloud: {
        backend: 'test-backend',
        sandboxId: 'sb-1',
        webPort: 8080,
        previewUrls: {
          8080: 'https://8080.example',
          3000: 'https://3000.example',
          5432: 'https://5432.example',
        },
      },
    });
    const ports = insp.endpoints.endpoints.map((e) => e.containerPort).sort((a, b) => a - b);
    expect(ports).toEqual([3000, 5432, 8080]);
    const main = insp.endpoints.endpoints.find((e) => e.containerPort === 8080);
    expect(main?.name).toBe('web');
    const svc = insp.endpoints.endpoints.find((e) => e.containerPort === 3000);
    expect(svc?.name).toBe('service-3000');
  });

  it('resolveUrl falls back to previewUrl error when no signedPreviewUrl is supplied', async () => {
    const p = createCloudProvider(makeBackend());
    await expect(
      p.resolveUrl(
        {
          id: 'b1',
          name: 'b1',
          container: 'cloud:sb-1',
          image: 'img',
          workspacePath: '/tmp',
          createdAt: new Date().toISOString(),
          cloud: {
            backend: 'test-backend',
            sandboxId: 'sb-1',
            webPort: 8080,
            previewUrls: { 8080: 'https://8080.example' },
          },
        },
        { kind: 'web' },
      ),
    ).rejects.toThrow(/does not support signed preview URLs/);
  });

  it('resolveUrl uses signedPreviewUrl when available', async () => {
    const backend = makeBackend({
      signedPreviewUrl: async (_h, port, ttl) => ({
        url: `https://signed-${String(port)}-${String(ttl)}.example`,
      }),
    });
    const p = createCloudProvider(backend);
    const url = await p.resolveUrl(
      {
        id: 'b1',
        name: 'b1',
        container: 'cloud:sb-1',
        image: 'img',
        workspacePath: '/tmp',
        createdAt: new Date().toISOString(),
        cloud: { backend: 'test-backend', sandboxId: 'sb-1', webPort: 8080 },
      },
      { kind: 'web', ttl: 1234 },
    );
    expect(url).toBe('https://signed-8080-1234.example');
  });
});

/**
 * `probeState` must distinguish "the cloud says the box is gone" from "the
 * cloud would not talk to me". Reporting the second as `missing` is what made
 * an expired SSO token render every healthy box as destroyed (the hub maps
 * missing -> stopped), which reads as "someone deleted my boxes".
 */
describe('probeState credential handling', () => {
  const box = {
    id: 'b1',
    name: 'b1',
    container: 'cloud:sb-1',
    image: 'img',
    workspacePath: '/tmp',
    createdAt: new Date().toISOString(),
    cloud: { backend: 'test-backend', sandboxId: 'sb-1' },
  };

  it('rethrows a credential failure as NotAuthenticatedError instead of claiming missing', async () => {
    const authErr = new Error('Token is expired. To refresh this SSO session run `aws sso login`.');
    const p = createCloudProvider(
      makeBackend({
        state: async (): Promise<CloudState> => {
          throw authErr;
        },
      }),
    );
    await expect(p.probeState(box)).rejects.toMatchObject({
      name: 'NotAuthenticatedError',
      provider: 'test-backend',
    });
  });

  it('preserves an already-typed NotAuthenticatedError (does not double-wrap)', async () => {
    const original = new NotAuthenticatedError('aws', 'AWS rejected the credentials', 'run `aws sso login`');
    const p = createCloudProvider(
      makeBackend({
        state: async (): Promise<CloudState> => {
          throw original;
        },
      }),
    );
    await expect(p.probeState(box)).rejects.toBe(original);
  });

  it('still reports a genuine not-found as missing (the behavior everything else relies on)', async () => {
    const gone = new Error('The instance ID i-0123 does not exist') as Error & { code: string };
    gone.code = 'InvalidInstanceID.NotFound';
    const p = createCloudProvider(
      makeBackend({
        state: async (): Promise<CloudState> => {
          throw gone;
        },
      }),
    );
    await expect(p.probeState(box)).resolves.toBe('missing');
  });

  it('a transient network error is still missing, not an auth failure', async () => {
    const p = createCloudProvider(
      makeBackend({
        state: async (): Promise<CloudState> => {
          throw new Error('connect ETIMEDOUT');
        },
      }),
    );
    await expect(p.probeState(box)).resolves.toBe('missing');
  });
});
