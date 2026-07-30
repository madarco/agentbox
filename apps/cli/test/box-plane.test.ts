import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '@agentbox/core';

// `resolveBoxPromptSource` resolves the LOCAL hub target (URL + API key) for a
// docker / no-plane box; stub that seam so the unit test needs no running hub.
// The cloud-plane path builds its target straight from the box record + env, so
// the stub is only consulted for the local/no-token cases.
const resolveHubApiTarget =
  vi.fn<
    (
      urlFlag: string | undefined,
      opts?: { quiet?: boolean; preferLocal?: boolean },
    ) => Promise<{ url: string; apiKey: string } | null>
  >();
vi.mock('../src/commands/control-plane.js', () => ({ resolveHubApiTarget }));

// `apps/cli` has no vitest setup file to isolate $HOME; the config + control-plane
// env reads hit the real one. Redirect it per test.

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
  const originalKey = process.env['AGENTBOX_HUB_API_KEY'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-plane-test-'));
    process.env['HOME'] = home;
    delete process.env['AGENTBOX_HUB_API_KEY'];
    resolveHubApiTarget.mockReset();
    // Default local hub for the docker / no-token fallbacks.
    resolveHubApiTarget.mockResolvedValue({ url: 'http://127.0.0.1:8787', apiKey: 'localtok' });
    vi.resetModules();
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    if (originalKey === undefined) delete process.env['AGENTBOX_HUB_API_KEY'];
    else process.env['AGENTBOX_HUB_API_KEY'] = originalKey;
    await rm(home, { recursive: true, force: true });
  });

  it('sends a docker box to the local hub, with the local hub key', async () => {
    const { resolveBoxPromptSource } = await import('../src/control-plane/box-plane.js');
    const { HubApiClient } = await import('../src/control-plane/hub-api-client.js');
    const source = await resolveBoxPromptSource(
      box({ provider: 'docker', container: 'agentbox-b1', cloud: undefined }),
    );
    expect(source).not.toBeNull();
    expect(source?.remote).toBe(false);
    expect(source?.baseUrl).toBe('http://127.0.0.1:8787');
    expect(source?.apiKey).toBe('localtok');
    expect(source?.client).toBeInstanceOf(HubApiClient);
    // Docker never consults the plane: it resolves straight to the local hub.
    expect(resolveHubApiTarget).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ preferLocal: true }),
    );
  });

  it('sends a cloud box with no control box to the local hub', async () => {
    const { resolveBoxPromptSource } = await import('../src/control-plane/box-plane.js');
    const source = await resolveBoxPromptSource(box());
    expect(source?.remote).toBe(false);
    expect(source?.baseUrl).toBe('http://127.0.0.1:8787');
    expect(source?.unauthenticatedPlane).toBeUndefined();
  });

  it("uses the plane named on the box's own record, keyed by the hub API key", async () => {
    process.env['AGENTBOX_HUB_API_KEY'] = 'apikey';
    const { resolveBoxPromptSource } = await import('../src/control-plane/box-plane.js');
    const { HubApiClient } = await import('../src/control-plane/hub-api-client.js');
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
    expect(source?.remote).toBe(true);
    expect(source?.baseUrl).toBe('https://plane.example');
    expect(source?.apiKey).toBe('apikey');
    expect(source?.client).toBeInstanceOf(HubApiClient);
    // A remote plane resolves from the box record, not the local-hub seam.
    expect(resolveHubApiTarget).not.toHaveBeenCalled();
  });

  it('flags a known plane we have no key for, falling back to the local hub', async () => {
    const { resolveBoxPromptSource } = await import('../src/control-plane/box-plane.js');
    const source = await resolveBoxPromptSource(
      box({
        cloud: { backend: 'e2b', sandboxId: 'sbx_1', controlPlaneUrl: 'https://plane.example' },
      } as Partial<BoxRecord>),
    );
    expect(source?.baseUrl).toBe('http://127.0.0.1:8787');
    expect(source?.remote).toBe(false);
    expect(source?.unauthenticatedPlane).toBe('https://plane.example');
  });

  it('returns null when even the local hub cannot be resolved', async () => {
    resolveHubApiTarget.mockResolvedValue(null);
    const { resolveBoxPromptSource } = await import('../src/control-plane/box-plane.js');
    const source = await resolveBoxPromptSource(
      box({ provider: 'docker', container: 'agentbox-b1', cloud: undefined }),
    );
    expect(source).toBeNull();
  });
});
