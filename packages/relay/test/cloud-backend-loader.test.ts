import { afterEach, describe, expect, it } from 'vitest';
import type { CloudBackend } from '@agentbox/core';
import {
  isModuleNotFound,
  resolveCloudBackend,
  setCloudBackendLoader,
} from '../src/host-actions.js';

/**
 * The injected cloud-backend seam. Before it existed the relay resolved
 * `@agentbox/sandbox-<name>` by bare specifier at run time, which only ever
 * worked in the pnpm dev tree — every npm install failed with
 * ERR_MODULE_NOT_FOUND on the first cloud git push.
 */
describe('cloud backend loader injection', () => {
  const fake = { name: 'fake', exec: async () => ({ exitCode: 0 }) } as unknown as CloudBackend;

  afterEach(() => {
    setCloudBackendLoader(undefined);
  });

  it('prefers the injected loader over the bare-specifier fallback', async () => {
    setCloudBackendLoader({
      id: 'test',
      resolveBackend: async (name) => (name === 'digitalocean' ? fake : null),
      loadCloudCp: () => Promise.reject(new Error('not used')),
    });
    await expect(resolveCloudBackend('digitalocean')).resolves.toBe(fake);
  });

  it('falls through when the loader returns null (unknown provider still throws)', async () => {
    setCloudBackendLoader({
      id: 'test',
      resolveBackend: async () => null,
      loadCloudCp: () => Promise.reject(new Error('not used')),
    });
    await expect(resolveCloudBackend('not-a-provider')).rejects.toThrow(
      /no host executor for cloud backend 'not-a-provider'/,
    );
  });

  it('restores the un-injected behavior when cleared', async () => {
    setCloudBackendLoader({
      id: 'test',
      resolveBackend: async () => fake,
      loadCloudCp: () => Promise.reject(new Error('not used')),
    });
    setCloudBackendLoader(undefined);
    await expect(resolveCloudBackend('not-a-provider')).rejects.toThrow(/no host executor/);
  });
});

describe('isModuleNotFound', () => {
  it("matches Node's ESM wording, which says 'package' not 'module'", () => {
    // The exact error the published CLI produced on a cloud git push.
    const err = Object.assign(
      new Error(
        "Cannot find package '@agentbox/sandbox-digitalocean' imported from /opt/x/chunk.js",
      ),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    expect(isModuleNotFound(err)).toBe(true);
    expect(isModuleNotFound(new Error(err.message))).toBe(true);
  });

  it('matches the CJS wording and its code', () => {
    expect(isModuleNotFound(new Error("Cannot find module '@agentbox/sandbox-cloud'"))).toBe(true);
    expect(isModuleNotFound(Object.assign(new Error('boom'), { code: 'MODULE_NOT_FOUND' }))).toBe(
      true,
    );
  });

  it('leaves unrelated failures alone', () => {
    expect(isModuleNotFound(new Error('ECONNREFUSED'))).toBe(false);
    expect(isModuleNotFound(null)).toBe(false);
  });
});
