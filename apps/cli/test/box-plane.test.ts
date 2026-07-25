import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '@agentbox/core';

// Reads the layered config + ~/.agentbox/control-plane/control-plane.env, and
// `apps/cli` has no vitest setup file to isolate $HOME. Redirect it per test.

const box = (over: Partial<BoxRecord> = {}): BoxRecord =>
  ({
    id: 'b1',
    name: 'b1',
    provider: 'e2b',
    container: 'cloud:sbx_1',
    image: 'tmpl',
    workspacePath: '/workspace',
    relayToken: 't',
    createdAt: '2026-07-20T00:00:00.000Z',
    cloud: { backend: 'e2b', sandboxId: 'sbx_1' },
    ...over,
  }) as unknown as BoxRecord;

describe('resolveBoxPromptSource', () => {
  let home: string;
  const originalHome = process.env['HOME'];
  const originalToken = process.env['AGENTBOX_RELAY_ADMIN_TOKEN'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-plane-test-'));
    process.env['HOME'] = home;
    delete process.env['AGENTBOX_RELAY_ADMIN_TOKEN'];
    vi.resetModules();
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    if (originalToken === undefined) delete process.env['AGENTBOX_RELAY_ADMIN_TOKEN'];
    else process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = originalToken;
    await rm(home, { recursive: true, force: true });
  });

  it('sends a docker box to the local relay, with no bearer', async () => {
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { resolveBoxPromptSource, LOCAL_RELAY_URL } = await import(
      '../src/control-plane/box-plane.js'
    );
    const source = await resolveBoxPromptSource(
      box({ provider: 'docker', container: 'agentbox-b1', cloud: undefined }),
    );
    expect(source).toEqual({ baseUrl: LOCAL_RELAY_URL, remote: false });
  });

  it('sends a cloud box with no control box to the local relay', async () => {
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { resolveBoxPromptSource, LOCAL_RELAY_URL } = await import(
      '../src/control-plane/box-plane.js'
    );
    const source = await resolveBoxPromptSource(box());
    expect(source).toEqual({ baseUrl: LOCAL_RELAY_URL, remote: false });
  });

  it("uses the plane named on the box's own record, with the bearer", async () => {
    process.env['AGENTBOX_RELAY_ADMIN_TOKEN'] = 'tok';
    const { resolveBoxPromptSource } = await import('../src/control-plane/box-plane.js');
    const source = await resolveBoxPromptSource(
      box({
        cloud: {
          backend: 'e2b',
          sandboxId: 'sbx_1',
          controlPlaneUrl: 'https://plane.example/',
        },
      } as Partial<BoxRecord>),
    );
    // Trailing slash trimmed so URL joins don't double up.
    expect(source).toEqual({
      baseUrl: 'https://plane.example',
      authToken: 'tok',
      remote: true,
    });
  });

  it('flags a known plane we have no token for, rather than silently going local', async () => {
    const { resolveBoxPromptSource, LOCAL_RELAY_URL } = await import(
      '../src/control-plane/box-plane.js'
    );
    const source = await resolveBoxPromptSource(
      box({
        cloud: { backend: 'e2b', sandboxId: 'sbx_1', controlPlaneUrl: 'https://plane.example' },
      } as Partial<BoxRecord>),
    );
    expect(source.baseUrl).toBe(LOCAL_RELAY_URL);
    expect(source.remote).toBe(false);
    expect(source.unauthenticatedPlane).toBe('https://plane.example');
  });
});
